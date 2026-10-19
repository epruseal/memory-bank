#!/usr/bin/env node
// Injection replay bench — sample, snapshot, replay (plan docs/plans/2026-10-19-memorilla-applicability.md).
//
//   node bench/inject-replay.mjs --build               sample (inject log ∩ exchanges ∩ current gate) + snapshot DB
//   node bench/inject-replay.mjs --replay              every variant over the sample → lines-<variant>.jsonl
//   node bench/inject-replay.mjs --check-determinism   two separate replays per variant, byte-compared with each other and with the lines files
//   node bench/inject-replay.mjs --add-revisions       copy fact rewrites (fact_revisions) into a snapshot built before --build did
//
// The live DB is only ever opened read-only. Prompt and fact text stay under
// .bench-out/ (gitignored); only aggregates leave it (inject-judge.mjs --report).
// Run `npm run build` first: the selection is the dist/ code the live hook runs.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  VARIANTS, REL_VARIANTS, alignWindow, buildFactIndex, extractIdentifiers, foldSample, kwLines, makeAsOf, searchedLogRows,
} from './inject-bench-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const dist = (m) => path.join(REPO, 'dist', m);
const { parseCliArgs, assertOnlyArgs } = await import(dist('cli-args.js'));

let args;
try {
  args = parseCliArgs(process.argv.slice(2), {
    values: ['--out', '--db', '--log', '--suffix', '--variants'],
    flags: ['--build', '--replay', '--check-determinism', '--add-revisions'],
  });
} catch (e) {
  console.error(`inject-replay: ${e.message}`);
  process.exit(2);
}
const modes = ['--build', '--replay', '--check-determinism', '--add-revisions'].filter((m) => args.flags.has(m));
if (modes.length !== 1) {
  console.error('inject-replay: give exactly one of --build, --replay, --check-determinism, --add-revisions');
  process.exit(2);
}
const mode = modes[0];
try {
  assertOnlyArgs(args, {
    '--build': ['--build', '--out', '--db', '--log'],
    '--replay': ['--replay', '--out', '--suffix', '--variants'],
    '--check-determinism': ['--check-determinism', '--out'],
    '--add-revisions': ['--add-revisions', '--out', '--db'],
  }[mode], mode);
} catch (e) {
  console.error(`inject-replay: ${e.message}`);
  process.exit(2);
}

const OUT = path.resolve(args.values['--out'] ?? path.join(REPO, '.bench-out', 'inject-replay'));
const LIVE_DB = args.values['--db'] ?? path.join(os.homedir(), '.config', 'superpowers', 'conversation-index', 'db.sqlite');
const LOG = args.values['--log'] ?? path.join(os.homedir(), '.config', 'superpowers', 'conversation-index', 'logs', 'inject-context.jsonl');
const SNAPSHOT = path.join(OUT, 'snapshot.sqlite');
const fail = (msg) => { console.error(`inject-replay: ${msg}`); process.exit(1); };
const stamp = (p) => { const s = fs.statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 1) + '\n');

// ------------------------------------------------------------------ build

async function build() {
  if (!fs.existsSync(LIVE_DB)) fail(`no database at ${LIVE_DB}`);
  fs.mkdirSync(OUT, { recursive: true });
  const before = stamp(LIVE_DB);

  const logRows = [];
  for (const file of [`${LOG}.old`, LOG]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { logRows.push(JSON.parse(line)); } catch { /* torn line — counted below */ }
    }
  }
  const searched = searchedLogRows(logRows);

  const live = new Database(LIVE_DB, { readonly: true, fileMustExist: true });
  sqliteVec.load(live);
  const { getVecQuant, vecParamSql } = await import(dist('db.js'));
  const aligned = [];
  live.exec('BEGIN'); // one read snapshot for alignment and every copied table
  try {
    const find = live.prepare(`
      SELECT id, session_id, timestamp, user_message FROM exchanges
      WHERE timestamp BETWEEN ? AND ? AND cwd = ? AND length(user_message) = ?
      ORDER BY timestamp, id LIMIT 1`);
    for (const r of searched) {
      const [lo, hi] = alignWindow(r.ts);
      const ex = find.get(lo, hi, r.project, r.prompt_len);
      if (ex) aligned.push({ project: r.project, ts: ex.timestamp, sessionId: ex.session_id, exchangeId: ex.id, message: ex.user_message });
    }
    const { injectionQuery } = await import(dist('prompt-gate.js'));
    const { sample, dropped } = foldSample(aligned, injectionQuery);
    if (sample.length === 0) fail(`no log row aligned with an indexed prompt (log rows ${logRows.length}, searched ${searched.length})`);

    // Snapshot: a fresh schema (the code's own migrations), then the rows the selection reads.
    for (const f of [SNAPSHOT, `${SNAPSHOT}-wal`, `${SNAPSHOT}-shm`]) fs.rmSync(f, { force: true });
    // initDatabase migrates and writes whatever getDbPath() names — make sure that is the snapshot.
    process.env.MEMORY_BANK_DB_PATH = SNAPSHOT;
    const { getDbPath } = await import(dist('paths.js'));
    if (path.resolve(getDbPath()) !== SNAPSHOT || fs.realpathSync(LIVE_DB) === path.resolve(SNAPSHOT)) fail('snapshot path resolves to the live DB — refusing');
    const { initDatabase } = await import(dist('db.js'));
    const snap = initDatabase();
    if (path.resolve(snap.name) !== SNAPSHOT) fail(`initDatabase opened ${snap.name}, not the snapshot`);
    const copyTable = (table, skip = []) => {
      const liveCols = live.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
      const snapCols = new Set(snap.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name));
      const cols = liveCols.filter((c) => snapCols.has(c) && !skip.includes(c));
      const ins = snap.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      let n = 0;
      const batch = snap.transaction((rows) => { for (const r of rows) ins.run(...cols.map((c) => r[c])); });
      let buf = [];
      for (const r of live.prepare(`SELECT ${cols.join(',')} FROM ${table}`).iterate()) {
        buf.push(r);
        if (buf.length >= 2000) { batch(buf); n += buf.length; buf = []; }
      }
      if (buf.length) { batch(buf); n += buf.length; }
      return n;
    };
    const counts = {};
    counts.facts = copyTable('facts', ['embedding']); // the legacy float column is read by no selection path
    counts.ontology_relations = copyTable('ontology_relations');
    counts.fact_revisions = copyTable('fact_revisions'); // as-of hides facts rewritten after a prompt
    // The vector tables take the live DDL and int8 scale record, whatever the code's fresh-DB default is
    // (live fact tables can be float32, int8@127 or int8@600 — the stored bytes are copied as they are).
    const liveHasScale = live.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_int8_scale'").get();
    for (const table of ['vec_facts', 'vec_facts_kr']) {
      const ddl = live.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
      if (!ddl) fail(`live DB has no ${table}`);
      snap.exec(`DROP TABLE IF EXISTS ${table}`);
      snap.exec(ddl);
      snap.prepare('DELETE FROM vec_int8_scale WHERE table_name = ?').run(table);
      const rec = liveHasScale ? live.prepare('SELECT scale FROM vec_int8_scale WHERE table_name = ?').get(table) : undefined;
      if (rec) snap.prepare('INSERT INTO vec_int8_scale (table_name, scale) VALUES (?, ?)').run(table, rec.scale);
      const lq = getVecQuant(live, table);
      const sq = getVecQuant(snap, table);
      if (lq.dtype !== sq.dtype || lq.scale !== sq.scale) {
        fail(`vec quant differs for ${table}: live=${JSON.stringify(lq)} snapshot=${JSON.stringify(sq)}`);
      }
      const ins = snap.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(sq)})`);
      const batch = snap.transaction((rows) => { for (const r of rows) ins.run(r.id, r.embedding); });
      let buf = [];
      let n = 0;
      for (const r of live.prepare(`SELECT id, embedding FROM ${table}`).iterate()) {
        buf.push(r);
        if (buf.length >= 2000) { batch(buf); n += buf.length; buf = []; }
      }
      if (buf.length) { batch(buf); n += buf.length; }
      counts[table] = n;
    }
    // Which session each fact was extracted in (as-of: a prompt never sees facts from its own session).
    snap.exec('CREATE TABLE bench_fact_sessions (fact_id TEXT NOT NULL, session_id TEXT NOT NULL)');
    const sessionOf = live.prepare('SELECT session_id FROM exchanges WHERE id = ?');
    const insFs = snap.prepare('INSERT INTO bench_fact_sessions (fact_id, session_id) VALUES (?, ?)');
    let fsRows = 0;
    let badSourceIds = 0;
    snap.transaction(() => {
      for (const f of live.prepare('SELECT id, source_exchange_ids FROM facts').iterate()) {
        let exIds = [];
        try { exIds = JSON.parse(f.source_exchange_ids || '[]'); } catch { badSourceIds++; continue; }
        if (!Array.isArray(exIds)) { badSourceIds++; continue; }
        const seen = new Set();
        for (const exId of exIds) {
          const s = sessionOf.get(String(exId))?.session_id;
          if (s && !seen.has(s)) { seen.add(s); insFs.run(f.id, s); fsRows++; }
        }
      }
    })();
    counts.fact_sessions = fsRows;
    snap.exec('CREATE INDEX bench_fact_sessions_fact ON bench_fact_sessions(fact_id)');
    snap.close();

    writeJson(path.join(OUT, 'sample.json'), sample);
    const after = stamp(LIVE_DB);
    const report = {
      generatedAt: new Date().toISOString(),
      live: { path: LIVE_DB, before, after, live_unchanged: before.mtimeMs === after.mtimeMs && before.size === after.size, handle_readonly: live.readonly },
      log: { rows: logRows.length, searched: searched.length },
      aligned: aligned.length,
      dropped,
      sample: {
        distinct_prompts: sample.length,
        train: sample.filter((s) => s.split === 'train').length,
        heldout: sample.filter((s) => s.split === 'heldout').length,
        projects: new Set(sample.map((s) => s.project)).size,
      },
      snapshot: { path: SNAPSHOT, ...counts, bad_source_exchange_ids: badSourceIds },
    };
    writeJson(path.join(OUT, 'build.json'), report);
    console.log(JSON.stringify({ live_unchanged: report.live.live_unchanged, handle_readonly: report.live.handle_readonly, distinct_prompts: sample.length, ...report.sample, snapshot: counts }));
  } finally {
    live.exec('COMMIT');
    live.close();
  }
}

// ------------------------------------------------------------------ add revisions

/**
 * Snapshots built before --build copied fact_revisions hold an empty table, so as-of could not
 * see rewrites. Copy the live rows up to the snapshot's build time (later rewrites do not touch
 * the snapshot's text) — once; the live DB is opened read-only.
 */
function addRevisions() {
  const buildFile = path.join(OUT, 'build.json');
  if (!fs.existsSync(buildFile) || !fs.existsSync(SNAPSHOT)) fail('no build.json / snapshot — run --build');
  const buildInfo = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
  if (buildInfo.snapshot?.fact_revisions !== undefined) fail(`snapshot already holds fact revisions (${buildInfo.snapshot.fact_revisions})`);
  const before = stamp(LIVE_DB);
  const live = new Database(LIVE_DB, { readonly: true, fileMustExist: true });
  const snap = new Database(SNAPSHOT, { fileMustExist: true });
  try {
    if (snap.prepare('SELECT COUNT(*) AS n FROM fact_revisions').get().n !== 0) fail('snapshot fact_revisions is not empty');
    const bound = buildInfo.generatedAt;
    const cols = live.prepare('SELECT name FROM pragma_table_info(?)').all('fact_revisions').map((c) => c.name)
      .filter((c) => snap.prepare('SELECT name FROM pragma_table_info(?)').all('fact_revisions').some((x) => x.name === c));
    const rows = live.prepare(`SELECT ${cols.join(',')} FROM fact_revisions WHERE created_at <= ?`).all(bound);
    const ins = snap.prepare(`INSERT INTO fact_revisions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    snap.transaction(() => { for (const r of rows) ins.run(...cols.map((c) => r[c])); })();
    const after = stamp(LIVE_DB);
    buildInfo.snapshot.fact_revisions = rows.length;
    buildInfo.revisions = { added_at: new Date().toISOString(), bound, via: '--add-revisions', live_unchanged: before.mtimeMs === after.mtimeMs && before.size === after.size, handle_readonly: live.readonly };
    writeJson(buildFile, buildInfo);
    console.log(JSON.stringify({ fact_revisions: rows.length, bound, live_unchanged: buildInfo.revisions.live_unchanged }));
  } finally {
    live.close();
    snap.close();
  }
}

// ------------------------------------------------------------------ replay

const round6 = (x) => (x === null ? null : Math.round(x * 1e6) / 1e6);

async function replay() {
  for (const f of ['build.json', 'sample.json', 'snapshot.sqlite']) {
    if (!fs.existsSync(path.join(OUT, f))) fail(`missing ${path.join(OUT, f)} — run --build first`);
  }
  const variants = args.values['--variants'] ? args.values['--variants'].split(',') : VARIANTS;
  const unknown = variants.filter((v) => !VARIANTS.includes(v));
  if (unknown.length) fail(`unknown variant(s): ${unknown.join(', ')}`);
  const suffix = args.values['--suffix'] ?? '';
  if (!/^[A-Za-z0-9._-]*$/.test(suffix)) fail('bad --suffix');

  const sample = JSON.parse(fs.readFileSync(path.join(OUT, 'sample.json'), 'utf8'));
  const buildInfo = JSON.parse(fs.readFileSync(path.join(OUT, 'build.json'), 'utf8'));
  if (typeof buildInfo.snapshot?.fact_revisions !== 'number') fail('snapshot holds no fact revisions — as-of cannot hide rewritten facts; run --add-revisions');
  const db = new Database(SNAPSHOT, { readonly: true, fileMustExist: true });
  sqliteVec.load(db);
  const { selectInjectFacts, formatInjectBlock } = await import(dist('inject-select.js'));
  const { scopeMatcher, resolveRepoRoots } = await import(dist('project-family.js'));
  const { generateEmbedding, initEmbeddings, queryBaseline } = await import(dist('embeddings.js'));
  const index = buildFactIndex(db);

  // kw lane: identifier → active facts containing it (as-of + scope filtered per prompt)
  const kwScan = db.prepare("SELECT id, fact, category, created_at, scope_type, scope_project FROM facts WHERE is_active = 1 AND instr(lower(fact), ?) > 0");
  const kwCache = new Map();
  const kwFacts = (ident) => { if (!kwCache.has(ident)) kwCache.set(ident, kwScan.all(ident)); return kwCache.get(ident); };
  const byId = db.prepare('SELECT * FROM facts WHERE id = ?');

  // C2 'affected', through the same predicate the selection uses: the family predicate is wider than the
  // exact match and the widened paths hold facts. Registered reading (decides): the prompt's cwd has such
  // facts active now. Post-hoc reading (reported, plan Deviations 2): facts this prompt could see (as-of).
  const projectFacts = db.prepare("SELECT id, scope_project FROM facts WHERE is_active = 1 AND scope_type = 'project'").all();
  const widenedOf = new Map();
  const widened = (project) => {
    if (!widenedOf.has(project)) {
      const inFamily = scopeMatcher(project, true);
      widenedOf.set(project, resolveRepoRoots(project).length === 0 ? []
        : projectFacts.filter((f) => f.scope_project !== project && inFamily(f.scope_project)).map((f) => f.id));
    }
    return widenedOf.get(project);
  };
  const affected = new Set();
  const isAffectedAsOf = (p, asOf) => widened(p.project).some((id) => asOf.visibleFactId(id));

  await initEmbeddings();
  const out = Object.fromEntries(variants.map((v) => [v, []]));
  const meta = { prompts: sample.length, hard: [], affectedRegistered: [], affectedAsOf: [], kw: { identifiers: 0, picked: 0, bypassSkipped: 0 } };
  for (const p of sample) {
    const e = await generateEmbedding(p.query, 'query');
    const baseline = await queryBaseline(e);
    const asOf = makeAsOf(index, p);
    const base = { relMargin: null, scopeFamily: false, visibleFactId: asOf.visibleFactId, visibleRelation: asOf.visibleRelation };
    const shownOf = (selection, extra = []) => {
      const items = [...selection.lines.map((l) => ({ fact: l.fact, note: l.note, origin: l.origin, margin: l.margin })), ...extra];
      const { shown } = formatInjectBlock(items);
      return items.slice(0, shown).map((l) => ({ id: l.fact.id, origin: l.origin, note: l.note, margin: round6(l.margin) }));
    };
    let v0Selection = null;
    for (const v of variants) {
      let selection;
      let extra = [];
      let info = {};
      if (v === 'v0' || v === 'kw') {
        v0Selection ??= selectInjectFacts(db, e, baseline, p.project, base);
        selection = v0Selection;
      } else if (v in REL_VARIANTS) {
        selection = selectInjectFacts(db, e, baseline, p.project, { ...base, relMargin: REL_VARIANTS[v] });
      } else if (v === 'family') {
        selection = selectInjectFacts(db, e, baseline, p.project, { ...base, scopeFamily: true });
      }
      if (v === 'kw') {
        const identifiers = extractIdentifiers(p.query, p.project);
        const inScope = scopeMatcher(p.project, false);
        const matches = new Map(identifiers.map((ident) => [ident, kwFacts(ident).filter((f) =>
          asOf.visibleFactId(f.id) && (f.scope_type !== 'project' || inScope(f.scope_project)))]));
        const present = selection.lines.map((l) => l.fact.id);
        const { picked, bypassSkipped } = kwLines(identifiers, matches, present);
        extra = picked.map((f) => ({ fact: byId.get(f.id), note: '[kw]', origin: 'kw', margin: null }));
        meta.kw.identifiers += identifiers.length; meta.kw.picked += picked.length; meta.kw.bypassSkipped += bypassSkipped;
        info = { identifiers: identifiers.length };
      }
      const lines = shownOf(selection, extra);
      out[v].push({
        qid: p.qid, lines,
        candidates: selection.candidates, gated: selection.gated.length,
        rel_gated_out: selection.relGatedOut, rel_unscored: selection.relUnscored, ...info,
      });
      if (v === 'v0' && lines.length === 0) meta.hard.push(p.qid);
    }
    if (widened(p.project).length > 0) { affected.add(p.qid); meta.affectedRegistered.push(p.qid); }
    if (isAffectedAsOf(p, asOf)) meta.affectedAsOf.push(p.qid);
  }
  db.close();
  const hashes = {};
  for (const v of variants) {
    const body = out[v].map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(path.join(OUT, `lines-${v}${suffix}.jsonl`), body);
    hashes[v] = crypto.createHash('sha256').update(body).digest('hex');
  }
  if (!suffix) writeJson(path.join(OUT, 'replay-meta.json'), { ...meta, generatedAt: new Date().toISOString(), hashes });
  console.log(JSON.stringify({ prompts: sample.length, variants, hard: meta.hard.length, affected: affected.size, affectedAsOf: meta.affectedAsOf.length, kw: meta.kw, hashes }));
}

// ------------------------------------------------------------------ determinism

function checkDeterminism() {
  // Order: --build → --replay → --check-determinism (it compares two fresh runs with the lines files the judge reads).
  const missing = VARIANTS.filter((v) => !fs.existsSync(path.join(OUT, `lines-${v}.jsonl`)));
  if (missing.length) fail(`no lines file for ${missing.join(', ')} in ${OUT} — run --replay first (order: --build → --replay → --check-determinism)`);
  const self = fileURLToPath(import.meta.url);
  for (const s of ['.det-a', '.det-b']) {
    execFileSync(process.execPath, [self, '--replay', '--out', OUT, '--suffix', s], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  // Bound to the lines files the judge and report read: both re-runs must equal them, not just each other.
  const variants = {};
  for (const v of VARIANTS) {
    const h = (s) => crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, `lines-${v}${s}.jsonl`))).digest('hex');
    const a = h('.det-a');
    const b = h('.det-b');
    const used = h('');
    variants[v] = { a, b, lines: used, identical: a === b && a === used };
  }
  const identical = Object.values(variants).every((x) => x.identical);
  writeJson(path.join(OUT, 'determinism.json'), { generatedAt: new Date().toISOString(), identical, variants });
  console.log(JSON.stringify({ identical, variants: Object.fromEntries(Object.entries(variants).map(([k, x]) => [k, x.identical])) }));
  if (!identical) process.exit(1);
}

if (mode === '--build') await build();
else if (mode === '--replay') await replay();
else if (mode === '--add-revisions') addRevisions();
else checkDeterminism();
