#!/usr/bin/env node
/**
 * Migrate the fact-side vec0 tables (vec_facts / vec_facts_kr / vec_categories)
 * from float32 to int8 at FACT_VEC_INT8_SCALE (600) — or back (--restore).
 *
 * Why 600, not the exchanges' 127: e5 components are small (measured max |x|
 * 0.206 over the live fact vectors), so 127 used only ±26 levels and the
 * injection gate's pass set matched exact float32 in 28/48 measured cases.
 * 600 never clips (127/600 = 0.2117) and keeps per-table top-10 overlap with
 * exact float32 at 0.975. The scale is recorded per table (vec_int8_scale) in
 * the same transaction as the swap; readers decode with getVecQuant().
 *
 * Order, each step fail-loud (exit ≠ 0). Steps 1–3 change nothing:
 *   1. refuse while the reembed worker or another migration runs;
 *   2. refuse while any OTHER process holding the DB — or running memory-bank
 *      code that may open it later — runs code older than
 *      VEC_SCALE_MIN_VERSION (it would decode the new tables at 127) — see
 *      src/vec-migrate-guard.ts. Wait for live-apply or restart those sessions;
 *   3. back up every float32 table that will change (gzip JSONL, re-read and
 *      verified: per-table counts + sha256), then repeat step 2 — the backup
 *      takes seconds and a session can start meanwhile;
 *   4. swap each table in ONE BEGIN IMMEDIATE transaction (src/vec-compact.ts
 *      rebuildVecTable — holes are dropped by the same rebuild). Tables swap
 *      one after another: if a later swap fails, the earlier ones stay int8@600
 *      (every reader decodes them by their recorded scale); re-running
 *      migrates the rest, --restore reverts them.
 * Not guarded: installing ≤1.7.6 again after the migration — that code reads
 * the scale-600 tables at 127. Run --restore before downgrading.
 * Legacy int8@127 tables are left alone: requantizing int8 cannot bring back
 * precision that is already gone.
 *
 * Step 2 also requires every installed memory-bank plugin dir to carry new
 * code: a hook or worker that opens the DB after the holder snapshot is
 * spawned from one of those dirs.
 *
 * --restore rebuilds float32 tables from a backup, inside the swap
 * transaction. A row takes its backup bytes only when its current int8 value
 * is exactly the backup vector quantized at the table's scale (= not rewritten
 * since); rows added or rewritten since are dequantized from int8, and ids
 * deleted since are not resurrected. Each table swaps in its own transaction —
 * a failure leaves the earlier tables restored; re-running finishes the rest.
 *
 * Usage:
 *   node scripts/migrate-vec-facts-int8.mjs [--db PATH] [--backup-dir DIR] [--dry-run]
 *   node scripts/migrate-vec-facts-int8.mjs --restore BACKUP.jsonl.gz [--db PATH] [--allow-other-db]
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { embeddingToVecBlob, getVecQuant, FACT_VEC_INT8_SCALE, FACT_VEC_TABLES, factVecTableDdl } from '../dist/db.js';
import { rebuildVecTable } from '../dist/vec-compact.js';
import { listDbHolders, listMemoryBankProcesses, assessDbHolders, staleInstallDirs, VEC_SCALE_MIN_VERSION } from '../dist/vec-migrate-guard.js';
import { getIndexDir } from '../dist/paths.js';
import { parseCliArgs, assertOnlyArgs } from '../dist/cli-args.js';

const TARGET = { dtype: 'int8', scale: FACT_VEC_INT8_SCALE };
const BACKUP_FORMAT = 'memory-bank-vec-backup/1';

/** Copy into an aligned buffer — a Buffer slice from SQLite may sit at an odd offset. */
function asFloat32(blob) {
  if (blob.length !== 384 * 4) throw new Error(`expected a 1536-byte float32 vector, got ${blob.length} bytes`);
  return new Float32Array(Uint8Array.from(blob).buffer);
}

function quantize(float32Blob, quant) {
  return embeddingToVecBlob(Array.from(asFloat32(float32Blob)), quant);
}

function dequantize(blob, scale) {
  if (blob.length !== 384) throw new Error(`expected a 384-byte int8 vector, got ${blob.length} bytes`);
  const q = new Int8Array(Uint8Array.from(blob).buffer);
  return Buffer.from(Float32Array.from(q, (x) => x / scale).buffer);
}

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

function takeLocks(indexDir) {
  const REEMBED_LOCK = path.join(indexDir, 'reembed.lock');
  const LOCK = path.join(indexDir, 'migrate-vec-int8.lock');
  if (pidAlive(REEMBED_LOCK)) throw new Error('reembed-worker is running — stop it before migrating');
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    if (pidAlive(LOCK)) throw new Error('another migration is running');
    fs.unlinkSync(LOCK);
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  }
  process.on('exit', () => {
    try { if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK); } catch { /* ignore */ }
  });
}

function lineDigest(lines) {
  const h = crypto.createHash('sha256');
  for (const l of lines) h.update(l + '\n');
  return h.digest('hex');
}

/** Parse + verify a backup: header counts match the rows, sha256 matches. */
function readBackup(file) {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  if (header.format !== BACKUP_FORMAT) throw new Error(`${file}: not a ${BACKUP_FORMAT} file`);
  const body = lines.slice(1);
  if (lineDigest(body) !== header.sha256) throw new Error(`${file}: sha256 mismatch — backup is damaged`);
  const rows = new Map();
  for (const l of body) {
    const r = JSON.parse(l);
    if (!rows.has(r.t)) rows.set(r.t, new Map());
    rows.get(r.t).set(r.id, Buffer.from(r.b, 'base64'));
  }
  for (const [t, meta] of Object.entries(header.tables)) {
    const n = rows.get(t)?.size ?? 0;
    if (n !== meta.rows) throw new Error(`${file}: ${t} has ${n} rows, header says ${meta.rows}`);
  }
  return { header, rows };
}

function writeBackup(db, dbPath, tables, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `vec-facts-float32-${stamp}.jsonl.gz`);
  const body = [];
  const meta = {};
  const live = {};
  // One read transaction: the rows and the counts they are verified against
  // come from the same snapshot, whatever other sessions write meanwhile.
  db.transaction(() => {
    for (const t of tables) {
      const rows = db.prepare(`SELECT id, embedding FROM ${t}`).all();
      meta[t] = { dtype: 'float32', rows: rows.length };
      live[t] = db.prepare(`SELECT count(*) AS n FROM ${t}_rowids`).get().n;
      for (const r of rows) {
        asFloat32(r.embedding); // shape check before it becomes the only copy
        body.push(JSON.stringify({ t, id: r.id, b: Buffer.from(r.embedding).toString('base64') }));
      }
    }
  })();
  const header = { format: BACKUP_FORMAT, created_at: new Date().toISOString(), db: realDbPath(dbPath), tables: meta, sha256: lineDigest(body) };
  fs.writeFileSync(file, zlib.gzipSync([JSON.stringify(header), ...body].join('\n') + '\n'), { flag: 'wx' });
  const check = readBackup(file); // re-read from disk: counts + sha256
  for (const t of tables) {
    if (check.rows.get(t)?.size !== live[t]) throw new Error(`backup verify: ${t} ${check.rows.get(t)?.size}/${live[t]}`);
  }
  return file;
}

/** One spelling per DB file: relative paths and symlinked dirs (macOS /var → /private/var) compare equal. */
function realDbPath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function openDb(dbPath) {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('busy_timeout = 15000');
  return db;
}

/** Processes (DB holders + memory-bank code not holding it yet) and install dirs that run code older than VEC_SCALE_MIN_VERSION. */
function oldCodeBlockers(dbPath) {
  for (const v of ['MEMORY_BANK_PROCESS_SCAN_ROOT', 'MEMORY_BANK_PLUGIN_CACHE_DIR']) {
    if (process.env[v]) console.log(`note: ${v}=${process.env[v]} narrows this check (test seam)`);
  }
  const byPid = new Map();
  for (const h of [...listDbHolders(dbPath), ...listMemoryBankProcesses()]) byPid.set(h.pid, h);
  const verdicts = assessDbHolders([...byPid.values()]);
  for (const v of verdicts) console.log(`process ${v.pid}: ${v.ok ? 'ok' : 'BLOCKS'} — ${v.reason} — ${v.command.slice(0, 140)}`);
  const staleDirs = staleInstallDirs();
  for (const d of staleDirs) console.log(`install dir ${d.dir}: BLOCKS — carries ${d.version ?? 'no readable version'} < ${VEC_SCALE_MIN_VERSION}`);
  return { processes: verdicts.filter((v) => !v.ok).length, dirs: staleDirs.length };
}

function refuseOldCode({ processes, dirs }) {
  if (processes === 0 && dirs === 0) return false;
  console.error(`refused: ${processes} process(es) and ${dirs} installed plugin dir(s) do not run ≥${VEC_SCALE_MIN_VERSION} code — `
    + 'they would decode (or write) the new tables at scale 127. Wait for live-apply to rotate them (or restart those sessions) and re-run.');
  return true;
}

function migrate(dbPath, dryRun, backupDir) {
  const db = openDb(dbPath);
  try {
    const todo = [];
    for (const t of FACT_VEC_TABLES) {
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      if (!exists) { console.log(`${t}: absent — skip`); continue; }
      const q = getVecQuant(db, t);
      const n = db.prepare(`SELECT count(*) AS n FROM ${t}_rowids`).get().n;
      if (q.dtype === 'float32') { todo.push(t); console.log(`${t}: float32, ${n} rows → int8@${TARGET.scale}`); }
      else if (q.scale === TARGET.scale) console.log(`${t}: already int8@${q.scale} — skip`);
      else console.log(`${t}: int8@${q.scale} — kept (requantizing int8 cannot restore precision)`);
    }

    const first = oldCodeBlockers(dbPath);
    if (dryRun) {
      console.log(`dry-run: ${todo.length} table(s) would change, ${first.processes} blocking process(es), ${first.dirs} stale install dir(s)`);
      return 0;
    }
    if (todo.length === 0) { console.log('nothing to migrate.'); return 0; }
    if (refuseOldCode(first)) return 2;

    const backup = writeBackup(db, dbPath, todo, backupDir);
    console.log(`backup: ${backup} (verified)`);
    // A session may have started during the backup — check again right before the swap.
    if (refuseOldCode(oldCodeBlockers(dbPath))) return 2;
    for (const t of todo) {
      const r = rebuildVecTable(db, t, {
        ddl: factVecTableDdl(t, 'int8'),
        quant: TARGET,
        convert: (blob) => quantize(blob, TARGET),
      });
      console.log(`${t}: ✅ ${r.after.rows} rows → int8@${TARGET.scale} (chunks ${r.before.chunks} → ${r.after.chunks})`);
    }
    console.log('done.');
    return 0;
  } finally {
    db.close();
  }
}

function restore(dbPath, file, allowOtherDb) {
  const { header, rows } = readBackup(file);
  console.log(`backup ${file}: ${Object.entries(header.tables).map(([t, m]) => `${t}=${m.rows}`).join(' ')} (verified)`);
  if (realDbPath(header.db) !== realDbPath(dbPath) && !allowOtherDb) {
    console.error(`refused: backup was taken from ${header.db}, not ${dbPath} (--allow-other-db to restore it here anyway)`);
    return 2;
  }
  const db = openDb(dbPath);
  try {
    for (const t of Object.keys(header.tables)) {
      const q = getVecQuant(db, t); // stable: the migration lock excludes a concurrent swap
      const backed = rows.get(t) ?? new Map();
      const n = { fromBackup: 0, rewritten: 0, added: 0 };
      const res = rebuildVecTable(db, t, {
        ddl: factVecTableDdl(t, 'FLOAT'),
        quant: { dtype: 'float32', scale: 1 },
        // Runs inside the swap transaction, over the rows that exist right now.
        convert: (blob, id) => {
          const b = backed.get(id);
          if (b) {
            const unchanged = q.dtype === 'int8' ? quantize(b, q).equals(blob) : b.equals(blob);
            if (unchanged) { n.fromBackup++; return b; }
            n.rewritten++;
          } else {
            n.added++;
          }
          return q.dtype === 'int8' ? dequantize(blob, q.scale) : Buffer.from(blob);
        },
      });
      console.log(`${t}: ✅ float32 ${res.after.rows} rows (from backup ${n.fromBackup}, rewritten since ${n.rewritten} ` +
        `and added since ${n.added} dequantized, ${backed.size - n.fromBackup - n.rewritten} deleted since not restored)`);
    }
    return 0;
  } finally {
    db.close();
  }
}

function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    values: ['--db', '--backup-dir', '--restore'],
    flags: ['--dry-run', '--allow-other-db'],
  });
  const restoreFile = args.values['--restore'];
  // Each mode rejects the other mode's arguments: `--restore F --dry-run` must not restore for real.
  if (restoreFile) assertOnlyArgs(args, ['--restore', '--db', '--allow-other-db'], '--restore (it has no preview)');
  else assertOnlyArgs(args, ['--db', '--backup-dir', '--dry-run'], 'a migration');
  const dbPath = args.values['--db'] || process.env.MEMORY_BANK_DB_PATH || path.join(getIndexDir(), 'db.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  console.log('db:', dbPath);
  takeLocks(getIndexDir());
  if (restoreFile) return restore(dbPath, restoreFile, args.flags.has('--allow-other-db'));
  const backupDir = args.values['--backup-dir'] || path.join(getIndexDir(), 'backups');
  return migrate(dbPath, args.flags.has('--dry-run'), backupDir);
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
