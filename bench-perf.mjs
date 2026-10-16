#!/usr/bin/env node
// READ-ONLY performance benchmark for memory-bank: search / storage(embedding) / ontology prompt cost.
// No writes to production DB. Uses built dist modules where possible.
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';

const DB_PATH = process.env.MEMORY_BANK_DB_PATH ||
  path.join(os.homedir(), '.config/superpowers/conversation-index/db.sqlite');

function openRO() {
  const db = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(db);
  db.pragma('busy_timeout = 5000');
  return db;
}
const ms = (a, b) => Number((b - a).toFixed(1));
function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, min: s[0], p50: p(0.5), p95: p(0.95), max: s[s.length - 1],
           mean: Number((s.reduce((x, y) => x + y, 0) / s.length).toFixed(1)) };
}

const QUERIES = [
  'supabase RLS 정책 설정 방법',
  'how to fix typescript import error',
  '벡터 검색 성능 최적화',
  'git push adversarial review gate',
  'ontology classification fallback',
];

async function main() {
  const { initEmbeddings, generateEmbedding, EMBEDDING_VERSION } = await import('./dist/embeddings.js');
  const out = {};

  // --- 0. coverage / shape ---
  const db = openRO();
  out.db_size_mb = Number((db.prepare("SELECT page_count*page_size/1048576.0 s FROM pragma_page_count(), pragma_page_size()").get().s).toFixed(0));
  out.exchanges = db.prepare('SELECT count(*) c FROM exchanges').get().c;
  out.facts_active = db.prepare('SELECT count(*) c FROM facts WHERE is_active=1').get().c;
  const ev = db.prepare('SELECT embedding_version v, count(*) c FROM exchanges GROUP BY v').all();
  out.exchange_embedding_versions = ev;
  out.current_embedding_version = EMBEDDING_VERSION;
  const stale = ev.filter(r => String(r.v) !== String(EMBEDDING_VERSION)).reduce((s, r) => s + r.c, 0);
  out.exchanges_stale_version = stale;
  // TRUE invisibility to vector search = the search JOINs vec_exchanges and filters
  // embedding_version, so a row is unreachable if it is stale-version OR has NO
  // vec row at all. Counting only stale (the old metric) reported 0 while ~90k
  // current-version rows sat vector-less and unsearchable — the same missing-vector
  // blind spot fixed in the re-embed selector (iter 34).
  out.exchanges_invisible_to_vector_search = db.prepare(`
    SELECT count(*) c FROM exchanges e
    WHERE e.embedding_version != ?
       OR NOT EXISTS (SELECT 1 FROM vec_exchanges_rowids v WHERE v.id = e.id)
  `).get(EMBEDDING_VERSION).c;
  out.ontology = {
    domains: db.prepare('SELECT count(*) c FROM ontology_domains').get().c,
    categories: db.prepare('SELECT count(*) c FROM ontology_categories').get().c,
    relations: db.prepare('SELECT count(*) c FROM ontology_relations').get().c,
  };

  // --- 1. embedding generation (per-query / per-fact storage cost) ---
  await initEmbeddings();
  await generateEmbedding('warmup', 'query'); // warm the model
  const embT = [];
  for (const q of QUERIES) { const a = performance.now(); await generateEmbedding(q, 'query'); embT.push(ms(a, performance.now())); }
  out.embedding_gen_ms = stats(embT);

  // pre-embed queries for search benches
  const qEmb = [];
  for (const q of QUERIES) qEmb.push(Buffer.from(new Float32Array(await generateEmbedding(q, 'query')).buffer));

  // --- 2. vector search on exchanges (k=10, version-filtered JOIN — real search.ts path) ---
  const { getVecQuant, embeddingToVecBlob, vecParamSql } = await import('./dist/db.js');
  const exDt = getVecQuant(db, 'vec_exchanges');
  const vecStmt = db.prepare(`
    SELECT e.id, vec.distance FROM vec_exchanges AS vec
    JOIN exchanges AS e ON vec.id = e.id
    WHERE vec.embedding MATCH ${vecParamSql(exDt)} AND k = ? AND e.embedding_version = ?
    ORDER BY vec.distance ASC`);
  const qBlobs = [];
  for (const q of QUERIES) qBlobs.push(embeddingToVecBlob(await generateEmbedding(q, 'query'), exDt));
  const vecT = [];
  for (let r = 0; r < 3; r++) for (const b of qBlobs) { const a = performance.now(); vecStmt.all(b, 10, EMBEDDING_VERSION); vecT.push(ms(a, performance.now())); }
  out.vector_search_exchanges_ms = stats(vecT);

  // --- 3. text LIKE search on exchanges (mode 'both' always runs this — no FTS) ---
  const likeStmt = db.prepare(`
    SELECT e.id FROM exchanges AS e
    WHERE (e.user_message LIKE ? ESCAPE '\\' OR e.assistant_message LIKE ? ESCAPE '\\')
    ORDER BY e.timestamp DESC LIMIT 10`);
  const likeT = [];
  for (const q of QUERIES) { const p = `%${q.replace(/%/g,'\\%').replace(/_/g,'\\_')}%`; const a = performance.now(); likeStmt.all(p, p); likeT.push(ms(a, performance.now())); }
  out.text_like_search_exchanges_ms = stats(likeT);

  // --- 3b. text FTS5 search (new BM25 path) ---
  const ftsStmt = db.prepare(`
    SELECT e.id FROM exchanges_fts AS fts
    JOIN exchanges AS e ON e.rowid = fts.rowid
    WHERE exchanges_fts MATCH ? ORDER BY rank LIMIT 10`);
  const ftsT = [];
  for (let r = 0; r < 3; r++) for (const q of QUERIES) {
    const expr = q.split(/\s+/).map(t => t.replace(/"/g,'').trim()).filter(Boolean).map(t => `"${t}"`).join(' ');
    const a = performance.now(); try { ftsStmt.all(expr); } catch {} ftsT.push(ms(a, performance.now()));
  }
  out.text_fts_search_exchanges_ms = stats(ftsT);

  // --- 4. fact vector search (REAL searchSimilarFacts path — dtype-aware,
  // works on float32 and int8 fact tables alike) ---
  const { searchSimilarFacts } = await import('./dist/fact-db.js');
  const qFloat = [];
  for (const q of QUERIES) qFloat.push(await generateEmbedding(q, 'query'));
  const factT = [];
  for (let r = 0; r < 3; r++) for (const e of qFloat) {
    const a = performance.now();
    searchSimilarFacts(db, e, null, 5, 0.5);
    factT.push(ms(a, performance.now()));
  }
  out.fact_vector_search_ms = stats(factT);

  // --- 5. ontology classify prompt cost (the O(categories) prompt sent to Haiku per fact) ---
  const domains = db.prepare('SELECT * FROM ontology_domains ORDER BY name').all();
  const categories = db.prepare('SELECT * FROM ontology_categories ORDER BY name').all();
  const domainList = domains.map(d => `- ${d.name}: ${d.description ?? '(no description)'}`).join('\n');
  const categoryList = categories.map(c => {
    const d = domains.find(x => x.id === c.domain_id);
    return `- ${d?.name ?? '?'} / ${c.name}: ${c.description ?? '(no description)'}`;
  }).join('\n');
  const classifyPromptChars = domainList.length + categoryList.length;
  out.ontology_classify_prompt_OLD_full = {
    domains: domains.length, categories: categories.length,
    prompt_chars: classifyPromptChars,
    approx_tokens: Math.round(classifyPromptChars / 3.5),
  };

  // NEW: candidate-retrieval prompt — top-20 nearest categories for a sample fact
  const sampleFact = db.prepare('SELECT embedding FROM facts WHERE is_active=1 AND embedding IS NOT NULL LIMIT 1').get();
  let candChars = 0, candCount = 0;
  if (sampleFact?.embedding) {
    // dtype-aware: facts.embedding column is canonical float32; the vec table may be int8.
    const catDt = getVecQuant(db, 'vec_categories');
    const f32 = new Float32Array(sampleFact.embedding.buffer, sampleFact.embedding.byteOffset, 384);
    const hits = db.prepare(`SELECT id, distance FROM vec_categories WHERE embedding MATCH ${vecParamSql(catDt)} ORDER BY distance LIMIT 20`)
      .all(embeddingToVecBlob(Array.from(f32), catDt));
    const catById = new Map(categories.map(c => [c.id, c]));
    const lines = hits.map(h => { const c = catById.get(h.id); const d = domains.find(x => x.id === c?.domain_id);
      return c ? `- ${d?.name ?? '?'} / ${c.name}: ${c.description ?? '(no description)'}` : ''; }).filter(Boolean);
    candChars = domainList.length + lines.join('\n').length;
    candCount = lines.length;
  }
  out.ontology_classify_prompt_NEW_candidates = {
    candidate_categories: candCount,
    prompt_chars: candChars,
    approx_tokens: Math.round(candChars / 3.5),
    reduction_vs_old: classifyPromptChars > 0 ? `${(100 * (1 - candChars / classifyPromptChars)).toFixed(1)}%` : 'n/a',
    llm_calls_per_fact_NEW: 'classify ×1 + detectRelations ×0..2 = up to 3 Haiku calls/fact (was up to 6)',
  };

  db.close();
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
