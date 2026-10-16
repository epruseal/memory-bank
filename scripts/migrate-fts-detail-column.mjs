#!/usr/bin/env node
/**
 * Migrate exchanges_fts from detail=full to detail=column.
 *
 * Why: our search only issues single-token matches (no phrase/NEAR), and
 * detail=column stores no positional data — the production index shrank
 * 2,953MB → 407MB (-86%) with identical match coverage. BM25 ranking under
 * detail=column re-reads document text (search.ts rank-budgets for this).
 *
 * Safety:
 *  - pid lockfile ('wx' atomic)
 *  - the entire swap (flag off → DROP → CREATE detail=column → rebuild →
 *    flag on) runs in ONE BEGIN IMMEDIATE transaction: concurrent writers
 *    (whose triggers reference exchanges_fts) block instead of crashing on
 *    "no such table", and a crash at any point rolls back to the intact old
 *    index. Readers keep working (WAL).
 *  - already-column DBs exit as a no-op (idempotent).
 *
 * Usage: node scripts/migrate-fts-detail-column.mjs [--db /path/to/db.sqlite] [--dry-run]
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const DRY = args.flags.has('--dry-run');

const { getDbPath, getIndexDir } = await import(path.join(REPO, 'dist/paths.js'));
const DB_PATH = getDbPath();
const LOCK = path.join(getIndexDir(), 'migrate-fts-detail.lock');

try {
  fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
} catch {
  try {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf-8'), 10);
    process.kill(pid, 0);
    console.error(`another FTS migration is running (pid ${pid}) — abort`);
    process.exit(1);
  } catch {
    fs.unlinkSync(LOCK);
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  }
}
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch { /* gone */ } });

const db = new Database(DB_PATH);
sqliteVec.load(db);
db.pragma('busy_timeout = 60000');

const schema = db.prepare(
  `SELECT sql FROM sqlite_master WHERE name='exchanges_fts'`
).get()?.sql;
if (!schema) { console.error('exchanges_fts missing — run initDatabase first'); process.exit(2); }
if (/detail\s*=\s*column/i.test(schema)) { console.log('already detail=column — nothing to do'); process.exit(0); }

const rows = db.prepare('SELECT count(*) c FROM exchanges').get().c;
console.log(`db: ${DB_PATH}`);
console.log(`exchanges: ${rows} rows, FTS detail=full → column`);
if (DRY) { console.log('dry-run — no changes'); process.exit(0); }

const t0 = Date.now();
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(`INSERT OR REPLACE INTO fts_meta(key,value) VALUES('exchanges_fts_built','0')`).run();
  db.exec('DROP TABLE exchanges_fts');
  db.exec(`
    CREATE VIRTUAL TABLE exchanges_fts USING fts5(
      user_message, assistant_message,
      content='exchanges', content_rowid='rowid',
      tokenize='porter unicode61',
      detail=column
    )
  `);
  db.exec(`INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')`);
  db.prepare(`INSERT OR REPLACE INTO fts_meta(key,value) VALUES('exchanges_fts_built','1')`).run();
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('🛑 swap failed, rolled back (old index intact):', e.message);
  process.exit(2);
}

const probe = db.prepare(
  `SELECT count(*) c FROM exchanges_fts WHERE exchanges_fts MATCH ?`
).get('"the"').c;
console.log(`✅ detail=column rebuild: ${((Date.now() - t0) / 1000).toFixed(1)}s (probe "the" → ${probe} hits). Run VACUUM to reclaim disk.`);
db.close();
