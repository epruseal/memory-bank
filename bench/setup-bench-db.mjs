#!/usr/bin/env node
// One-time bench DB builder for the autoresearch loop.
//
// Copies a fixed 50K-exchange subset (embedding_version=3, most recent) from the
// production DB (opened READ-ONLY) into .autoresearch/bench-db.sqlite, including
// their vec_exchanges embeddings, and generates a deterministic self-retrieval
// query set (.autoresearch/queries.json). The production DB is never written.
//
// Usage: node bench/setup-bench-db.mjs [--size 50000] [--queries 120]

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PROD_DB = path.join(os.homedir(), '.config/superpowers/conversation-index/db.sqlite');
const BENCH_DIR = path.join(REPO, '.autoresearch');
const BENCH_DB = path.join(BENCH_DIR, 'bench-db.sqlite');
const QUERIES_PATH = path.join(BENCH_DIR, 'queries.json');

const argN = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? parseInt(process.argv[i + 1], 10) : dflt;
};
const SUBSET = argN('--size', 50000);
const N_QUERIES = argN('--queries', 120);

fs.mkdirSync(BENCH_DIR, { recursive: true });
if (fs.existsSync(BENCH_DB)) {
  console.log('bench DB already exists — delete it to rebuild:', BENCH_DB);
  process.exit(0);
}

// 1) Create bench DB with the project's own schema (initDatabase).
process.env.MEMORY_BANK_DB_PATH = BENCH_DB;
const { initDatabase } = await import(path.join(REPO, 'dist/db.js'));
const bench = initDatabase();

// 2) Open prod READ-ONLY.
const prod = new Database(PROD_DB, { readonly: true });
sqliteVec.load(prod);

const COLS = [
  'id','project','timestamp','user_message','assistant_message','archive_path',
  'line_start','line_end','last_indexed','parent_uuid','is_sidechain','session_id',
  'cwd','git_branch','claude_version','thinking_level','thinking_disabled',
  'thinking_triggers','coding_agent','embedding_version',
];

console.log(`Copying ${SUBSET} most recent v3 exchanges (streaming)...`);
const ins = bench.prepare(
  `INSERT OR REPLACE INTO exchanges (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`
);
const insertMany = bench.transaction((batch) => {
  for (const r of batch) ins.run(...COLS.map((c) => r[c]));
});
// Stream row-by-row: a 50K .all() materializes multi-GB of message text → OOM.
const wanted = new Set();
let exBatch = [];
let nCopied = 0;
// Stratified across the full timeline (rowid % k): the most-recent window is
// dominated by automated-worker sessions; a whole-history sample keeps human
// message diversity for the self-retrieval eval.
const total = prod.prepare(
  `SELECT COUNT(*) c FROM exchanges WHERE embedding_version = 3 AND is_sidechain = 0`
).get().c;
const stride = Math.max(1, Math.floor(total / SUBSET));
console.log(`  total v3: ${total}, stride: ${stride}`);
for (const r of prod.prepare(`
  SELECT ${COLS.join(',')} FROM exchanges
  WHERE embedding_version = 3 AND is_sidechain = 0 AND (rowid % ${stride}) = 0
  LIMIT ?
`).iterate(SUBSET)) {
  wanted.add(r.id);
  exBatch.push(COLS.map((c) => r[c]));
  if (exBatch.length >= 1000) {
    const b = exBatch; exBatch = [];
    insertMany(b.map((vals) => Object.fromEntries(COLS.map((c, i) => [c, vals[i]]))));
    nCopied += b.length;
    process.stdout.write(`\r  exchanges ${nCopied}`);
  }
}
if (exBatch.length) {
  insertMany(exBatch.map((vals) => Object.fromEntries(COLS.map((c, i) => [c, vals[i]]))));
  nCopied += exBatch.length;
}
console.log(`\r  exchanges ${nCopied}`);

// FTS: the AFTER INSERT triggers indexed every row above; the fresh-DB flag was
// initialized to '1' (empty at creation), so FTS is authoritative here.
const flag = bench.prepare(`SELECT value FROM fts_meta WHERE key='exchanges_fts_built'`).get();
console.log('fts_built flag:', flag?.value);

// 3) Copy matching vec embeddings (stream prod vec table, filter by id set).
console.log('Copying vec embeddings (streaming prod vec_exchanges)...');
// dtype-aware: raw blob copy only works when both tables share a dtype, and
// int8 params must be wrapped in vec_int8() (vec0 treats a bare blob param as
// float32 otherwise). Prod migrated to int8 on 2026-07-11.
const { getVecQuant, vecParamSql } = await import(path.join(REPO, 'dist/db.js'));
const prodQuant = getVecQuant(prod, 'vec_exchanges');
const benchQuant = getVecQuant(bench, 'vec_exchanges');
if (prodQuant.dtype !== benchQuant.dtype || prodQuant.scale !== benchQuant.scale) {
  throw new Error(`vec quant mismatch: prod=${JSON.stringify(prodQuant)} bench=${JSON.stringify(benchQuant)} — align before regenerating`);
}
const vecIns = bench.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(benchQuant)})`);
let copied = 0;
let batch = [];
const flush = bench.transaction((b) => { for (const [id, emb] of b) vecIns.run(id, emb); });
for (const v of prod.prepare('SELECT id, embedding FROM vec_exchanges').iterate()) {
  if (!wanted.has(v.id)) continue;
  batch.push([v.id, v.embedding]);
  if (batch.length >= 2000) { flush(batch); copied += batch.length; batch = []; process.stdout.write(`\r  vecs ${copied}`); }
}
if (batch.length) { flush(batch); copied += batch.length; }
console.log(`\r  vecs ${copied}`);

// 4) Deterministic query set: spread across the subset, prefer substantive
// human-authored user messages (skip command wrappers/caveats/short lines).
console.log('Generating query set...');
const candidates = bench.prepare(`
  SELECT id, substr(user_message, 1, 300) AS user_message FROM exchanges
  WHERE LENGTH(user_message) >= 80
    AND user_message NOT LIKE '<%'
    AND user_message NOT LIKE 'Caveat:%'
    AND user_message NOT LIKE '[Request interrupted%'
  ORDER BY id
`).all();
const step = Math.max(1, Math.floor(candidates.length / N_QUERIES));
const queries = [];
for (let i = 0; i < candidates.length && queries.length < N_QUERIES; i += step) {
  const c = candidates[i];
  const q = c.user_message.replace(/\s+/g, ' ').trim().slice(0, 150);
  if (q.length >= 40) queries.push({ id: c.id, query: q });
}
fs.writeFileSync(QUERIES_PATH, JSON.stringify(queries, null, 1));
console.log(`queries: ${queries.length} → ${QUERIES_PATH}`);

prod.close();
bench.close();
const mb = (fs.statSync(BENCH_DB).size / 1048576).toFixed(1);
console.log(`DONE. bench DB ${mb}MB at ${BENCH_DB}`);
