#!/usr/bin/env node
/**
 * Compact the fact-side vec0 tables (vec_facts / vec_facts_kr / vec_categories):
 * rebuild each table below --min-ratio fill from its live rows so the
 * brute-force KNN stops scanning deleted slots. Same ids, same stored bytes,
 * same dtype and scale — results do not change, and old plugin versions read
 * the rebuilt tables exactly as before. SessionStart maintenance runs the same
 * compaction automatically (throttled); this is the manual entry point.
 *
 * Usage: node scripts/compact-vec-tables.mjs [--db PATH] [--min-ratio 0.8] [--dry-run]
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { getIndexDir } from '../dist/paths.js';
import { FACT_VEC_TABLES } from '../dist/db.js';
import { vecTableFill, compactSparseVecTables } from '../dist/vec-compact.js';
import { ensureNativeAbi } from '../dist/node-abi.js';
import { parseCliArgs } from '../dist/cli-args.js';

ensureNativeAbi('compact-vec-tables');

const fmt = (f) => (f ? `${f.rows} rows / ${f.slots} slots in ${f.chunks} chunks (fill ${(f.ratio * 100).toFixed(1)}%)` : 'absent');

let args;
try {
  args = parseCliArgs(process.argv.slice(2), { values: ['--db', '--min-ratio'], flags: ['--dry-run'] });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const dbPath = args.values['--db'] || process.env.MEMORY_BANK_DB_PATH || path.join(getIndexDir(), 'db.sqlite');
const minRatio = args.values['--min-ratio'] === undefined ? 0.8 : Number(args.values['--min-ratio']);
if (!fs.existsSync(dbPath)) { console.error(`no database at ${dbPath}`); process.exit(1); }
if (!Number.isFinite(minRatio) || minRatio <= 0 || minRatio > 1) { console.error(`--min-ratio must be in (0, 1], got ${args.values['--min-ratio']}`); process.exit(1); }

const db = new Database(dbPath);
sqliteVec.load(db);
db.pragma('busy_timeout = 15000');
try {
  console.log('db:', dbPath);
  for (const t of FACT_VEC_TABLES) console.log(`${t}: ${fmt(vecTableFill(db, t))}`);
  const outcomes = args.flags.has('--dry-run') ? [] : compactSparseVecTables(db, { minRatio });
  for (const r of outcomes) {
    if (r.action === 'compacted') {
      console.log(`${r.table}: ✅ compacted ${r.before.chunks} → ${r.after.chunks} chunks (fill ${(r.before.ratio * 100).toFixed(1)}% → ${(r.after.ratio * 100).toFixed(1)}%)`);
    } else if (r.action === 'failed') {
      console.error(`${r.table}: ❌ compaction failed — ${r.error}`);
      process.exitCode = 1;
    } else {
      console.log(`${r.table}: skipped — ${r.reason}`);
    }
  }
} finally {
  db.close();
}
