#!/usr/bin/env node
/**
 * Migrate vec_exchanges from float32 to int8 quantized vectors.
 *
 * Why: int8 uses 4× less storage and ~2× faster KNN with no measured recall@10
 * loss (50K-exchange benchmark: 73.6MB→18.4MB, KNN p50 19.1ms→8.7ms, recall
 * identical). Distances scale ×127 — all readers already normalize via
 * getVecQuant()/normalizeVecDistance() (search.ts / repeat-detector.ts).
 *
 * Safety:
 *  - refuses to run while reembed-worker is active (its lockfile pid is alive)
 *  - pid lockfile ('wx' atomic) — no concurrent migration runs
 *  - scratch table built WITHOUT blocking writers, then the swap runs under
 *    BEGIN IMMEDIATE (write lock) with a DELTA RECONCILIATION inside the lock:
 *      (a) rows INSERTED during the build → quantized + added
 *      (b) rows DELETED during the build → removed from scratch
 *      (c) rows whose VECTOR WAS UPDATED during the build (same id — re-index
 *          or re-embed) → re-quantized from live, detected via
 *          exchanges.last_indexed >= build start (all vector writers stamp it)
 *    Without this pass, anything written mid-build would be lost or stale
 *    forever (embedding_version is already current, so reembed-worker would
 *    never repair it).
 *  - counts are verified INSIDE the write lock before any destructive step
 *  - the swap (DROP old / CREATE int8 / copy) is the SAME transaction — crash
 *    at any point leaves either the old float32 table or the completed int8
 *    table. No mixed state is observable (dtype is derived from the actual
 *    schema in sqlite_master, not a flag).
 *  - reads during migration keep working (WAL); writers are blocked only for
 *    the duration of the swap transaction.
 *
 * CLI:
 *   node scripts/migrate-vec-int8.mjs [--db /path/to/db.sqlite] [--dry-run]
 *
 * Library (tests): the exported migrateVecInt8() accepts an onBeforeSwap
 * callback to exercise the race window — reachable only via direct import,
 * never via CLI/env.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddingToVecBlob, VEC_INT8_SCALE } from '../dist/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// Delegate to the canonical quantizer (VEC_INT8_SCALE, single source of truth
// in src/db.ts). A hardcoded copy here would silently corrupt the vector space
// if the live-insert scale is ever tuned — the migration would re-quantize on a
// different scale than every subsequent write.
// vec_exchanges never records a scale, so its int8 scale is the legacy
// VEC_INT8_SCALE (getVecQuant reads the same constant when no row exists).
const quant = (f32) => embeddingToVecBlob(Array.from(f32), { dtype: 'int8', scale: VEC_INT8_SCALE });

function pidAlive(lockPath) {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dbPath
 * @param {{ dryRun?: boolean, log?: (msg: string) => void, onBeforeSwap?: (db: import('better-sqlite3').Database) => void|Promise<void> }} [opts]
 * @returns {Promise<{migrated: boolean, rows: number, reason?: string}>}
 */
export async function migrateVecInt8(dbPath, opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const { getIndexDir } = await import(path.join(REPO, 'dist/paths.js'));
  const LOCK = path.join(getIndexDir(), 'migrate-vec-int8.lock');
  const REEMBED_LOCK = path.join(getIndexDir(), 'reembed.lock');

  // Concurrent vector writers with their own lifecycle are refused up front —
  // reembed-worker rewrites vectors in bulk and would race the whole build.
  if (pidAlive(REEMBED_LOCK)) {
    throw new Error('reembed-worker is running — finish/stop it before migrating');
  }

  // pid lockfile ('wx' atomic acquire; stale-pid takeover)
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    if (pidAlive(LOCK)) throw new Error(`another migration is running (pid in ${LOCK})`);
    fs.unlinkSync(LOCK); // stale
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  }

  const db = new Database(dbPath);
  try {
    sqliteVec.load(db);
    db.pragma('busy_timeout = 30000');

    // dtype from the ACTUAL schema (single source of truth — no flag divergence)
    const schemaSql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_exchanges'`
    ).get()?.sql;
    if (!schemaSql) throw new Error('vec_exchanges table missing');
    if (/int8\s*\[/i.test(schemaSql)) {
      log('already int8 — nothing to do');
      return { migrated: false, rows: 0, reason: 'already-int8' };
    }

    const srcCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges').get().c;
    log(`db: ${dbPath}`);
    log(`vec_exchanges rows: ${srcCount} (float32)`);
    if (opts.dryRun) { log('dry-run — no changes'); return { migrated: false, rows: srcCount, reason: 'dry-run' }; }

    // 5s clock margin: catching a few extra rows re-quantizes them harmlessly;
    // missing one loses its update.
    const buildStartMs = Date.now() - 5000;

    // --- 1) build scratch int8 table (non-destructive, resumable by drop+rebuild) ---
    db.exec('DROP TABLE IF EXISTS vec_exchanges_migr');
    db.exec('CREATE VIRTUAL TABLE vec_exchanges_migr USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');

    const rdb = new Database(dbPath, { readonly: true });
    sqliteVec.load(rdb);
    const ins = db.prepare('INSERT INTO vec_exchanges_migr (id, embedding) VALUES (?, vec_int8(?))');
    const tx = db.transaction((rows) => { for (const [id, buf] of rows) ins.run(id, buf); });
    let n = 0, batch = [];
    for (const r of rdb.prepare('SELECT id, embedding FROM vec_exchanges').iterate()) {
      batch.push([r.id, quant(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 384))]);
      if (batch.length >= 2000) { tx(batch); n += batch.length; batch = []; if (n % 20000 === 0) log(`  quantized ${n}/${srcCount}`); }
    }
    if (batch.length) { tx(batch); n += batch.length; }
    rdb.close();
    log(`quantized: ${n}`);

    // Race-window injection point for tests (direct import only — no CLI/env path).
    if (opts.onBeforeSwap) await opts.onBeforeSwap(db);

    // --- 2) atomic swap under a WRITE LOCK with delta reconciliation ---
    // BEGIN IMMEDIATE acquires the write lock up front: no other writer can
    // touch vectors from here to COMMIT (they block on busy_timeout).
    let finalExpected = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      // materialize ids into regular temp b-trees (cross-virtual-table
      // subqueries on vec0 are unreliable)
      db.exec('CREATE TEMP TABLE migr_ids AS SELECT id FROM vec_exchanges_migr');
      db.exec('CREATE TEMP TABLE live_ids AS SELECT id FROM vec_exchanges');

      // (a) rows inserted after the scratch scan → quantize + add
      const newRows = db.prepare(`
        SELECT v.id, v.embedding FROM vec_exchanges v
        WHERE v.id IN (SELECT id FROM live_ids WHERE id NOT IN (SELECT id FROM migr_ids))
      `).all();
      for (const r of newRows) {
        ins.run(r.id, quant(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 384)));
      }

      // (b) rows deleted after the scratch scan → remove from scratch
      const goneIds = db.prepare(
        'SELECT id FROM migr_ids WHERE id NOT IN (SELECT id FROM live_ids)'
      ).all();
      const delMigr = db.prepare('DELETE FROM vec_exchanges_migr WHERE id = ?');
      for (const r of goneIds) delMigr.run(r.id);

      // (c) same-id vector UPDATES during the build (re-index / re-embed):
      // id-diff can't see them — detect via exchanges.last_indexed, which every
      // vector writer stamps (insertExchange, reembed-worker). Re-quantize from
      // live. Freshly inserted ids may reappear here; re-quantizing is idempotent.
      db.exec(`CREATE TEMP TABLE upd_ids AS
        SELECT e.id FROM exchanges e
        JOIN live_ids l ON l.id = e.id
        WHERE e.last_indexed >= ${Math.floor(buildStartMs)}`);
      const updRows = db.prepare(`
        SELECT v.id, v.embedding FROM vec_exchanges v
        WHERE v.id IN (SELECT id FROM upd_ids)
      `).all();
      for (const r of updRows) {
        delMigr.run(r.id);
        ins.run(r.id, quant(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 384)));
      }
      if (newRows.length || goneIds.length || updRows.length) {
        log(`delta reconciled inside write lock: +${newRows.length} / -${goneIds.length} / ~${updRows.length} updated`);
      }

      // (d) authoritative count verify INSIDE the lock, before anything destructive
      const liveCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges').get().c;
      const migrCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges_migr').get().c;
      if (liveCount !== migrCount) {
        throw new Error(`count mismatch inside lock: live ${liveCount} vs migr ${migrCount}`);
      }
      finalExpected = liveCount;

      db.exec('DROP TABLE vec_exchanges');
      db.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');
      db.exec('INSERT INTO vec_exchanges (id, embedding) SELECT id, vec_int8(embedding) FROM vec_exchanges_migr');
      db.exec('DROP TABLE vec_exchanges_migr');
      db.exec('DROP TABLE migr_ids');
      db.exec('DROP TABLE live_ids');
      db.exec('DROP TABLE upd_ids');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`swap failed, rolled back (float32 table intact): ${e.message}`);
    }

    // --- 3) post-verify (dtype from actual schema) ---
    const finalCount = db.prepare('SELECT COUNT(*) c FROM vec_exchanges').get().c;
    const finalSql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_exchanges'`
    ).get().sql;
    if (finalCount !== finalExpected || !/int8\s*\[/i.test(finalSql)) {
      throw new Error(`post-verify failed: ${finalCount} rows (expected ${finalExpected})`);
    }
    log(`final: ${finalCount} rows, dtype=int8`);
    log('✅ migration complete. Run VACUUM to reclaim disk space (optional, requires free space).');
    return { migrated: true, rows: finalCount };
  } finally {
    db.close();
    try { fs.unlinkSync(LOCK); } catch { /* gone */ }
  }
}

// --- CLI entry (only when executed directly) ---
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  // Strict: `--db=PATH` or a typo like `--dryrun` must fail, not run against the live DB.
  const { parseCliArgs } = await import(path.join(REPO, 'dist/cli-args.js'));
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2), { values: ['--db'], flags: ['--dry-run'] });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (args.values['--db']) process.env.MEMORY_BANK_DB_PATH = path.resolve(args.values['--db']);
  const { getDbPath } = await import(path.join(REPO, 'dist/paths.js'));
  try {
    await migrateVecInt8(getDbPath(), { dryRun: args.flags.has('--dry-run') });
  } catch (e) {
    console.error('🛑', e.message);
    process.exit(2);
  }
}
