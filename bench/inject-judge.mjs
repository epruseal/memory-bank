#!/usr/bin/env node
// Injection replay bench — LLM judge and report (plan docs/plans/2026-10-19-memorilla-applicability.md).
//
//   node bench/inject-judge.mjs --smoke                     one isolated judge call; proves it leaves no trace
//   node bench/inject-judge.mjs --judge [--model M] [--concurrency N] [--limit N]
//   node bench/inject-judge.mjs --bind-legacy                 bind judgment rows written before rows carried a binding (call transcripts)
//   node bench/inject-judge.mjs --report [--doc docs/bench/2026-10-19-inject-replay.md]
//   node bench/inject-judge.mjs --leak-check <file>         exit 1 when a sampled prompt or fact text is in <file>
//
// Judge calls go through callHaiku (src/llm.ts): no user settings/plugins/MCP,
// no tools, the memory-bank-llm working folder whose transcripts the indexer
// excludes. Judgments are cached per (prompt, fact) in .bench-out/ — an
// interrupted run resumes without re-sending finished calls.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_PER_KIND, JUDGE_SYSTEM, REJUDGE_PROMPTS, THRESHOLDS, VARIANTS, aggregate, bootstrapDelta, decide, decideC2,
  decideC3, decisionsBlock, judgeUserMessage, labelItems, leakProbes, lostJ2Rel, meanDelta, perPromptCounts, ratioDelta,
  seededRandom, validateJudgeReply, validity, makeAsOf, isBypassFact, buildFactIndex, blockDiffers, leakFold, repoOf, unboundMeta,
  driftedInputs, missingRows, determinismBound, codeDigest, driftedCode, sqliteDigest, placementOf, gitState,
  judgeMessageSha, JUDGE_RETRY_MARK, firstAttemptSha, indexCalls, legacyBinding, replyGivesRowScores,
} from './inject-bench-lib.mjs';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const dist = (m) => path.join(REPO, 'dist', m);
const { parseCliArgs, assertOnlyArgs } = await import(dist('cli-args.js'));

let args;
let positional = [];
try {
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--leak-check');
  if (li > -1 && argv[li + 1] && !argv[li + 1].startsWith('--')) { positional = [argv[li + 1]]; argv.splice(li + 1, 1); }
  args = parseCliArgs(argv, {
    values: ['--out', '--model', '--concurrency', '--limit', '--doc', '--db'],
    flags: ['--smoke', '--judge', '--bind-legacy', '--report', '--leak-check'],
  });
} catch (e) {
  console.error(`inject-judge: ${e.message}`);
  process.exit(2);
}
const modes = ['--smoke', '--judge', '--bind-legacy', '--report', '--leak-check'].filter((m) => args.flags.has(m));
if (modes.length !== 1) { console.error('inject-judge: give exactly one of --smoke, --judge, --bind-legacy, --report, --leak-check'); process.exit(2); }
const mode = modes[0];
try {
  assertOnlyArgs(args, {
    '--smoke': ['--smoke', '--model', '--db'],
    '--judge': ['--judge', '--out', '--model', '--concurrency', '--limit'],
    '--bind-legacy': ['--bind-legacy', '--out'],
    '--report': ['--report', '--out', '--doc'],
    '--leak-check': ['--leak-check', '--out'],
  }[mode], mode);
} catch (e) { console.error(`inject-judge: ${e.message}`); process.exit(2); }

const OUT = path.resolve(args.values['--out'] ?? path.join(REPO, '.bench-out', 'inject-replay'));
const MODEL = args.values['--model'] ?? 'claude-sonnet-5-5';
const JUDGMENTS = path.join(OUT, 'judgments.jsonl');
const BINDINGS = path.join(OUT, 'judgment-bindings.json');   // --bind-legacy: bindings of rows written before rows carried one
const JUDGE_CALLS = path.join(OUT, 'judge-calls.jsonl');       // --bind-legacy: the judge calls those bindings name (message + reply)
const fileSha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (msg) => { console.error(`inject-judge: ${msg}`); process.exit(1); };
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const readLines = (f) => fs.readFileSync(path.join(OUT, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const intArg = (name, dflt, min, max) => {
  const raw = args.values[name];
  if (raw === undefined) return dflt;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) fail(`${name} must be an integer in [${min}, ${max}]`);
  return Number(raw);
};

// ------------------------------------------------------------------ judge call

async function judgeCall(prompt, labeled) {
  process.env.MEMORY_BANK_FACT_MODEL = MODEL;
  const { callHaiku, parseJsonResponse } = await import(dist('llm.js'));
  const labels = labeled.map((it) => it.label);
  let user = judgeUserMessage(prompt, labeled);
  for (let attempt = 0; attempt < 2; attempt++) {
    let text;
    try {
      text = await callHaiku(JUDGE_SYSTEM, user, 1024);
    } catch (e) {
      if (attempt === 1) return { ok: false, reason: `call failed: ${String(e?.message ?? e).slice(0, 200)}` };
      continue;
    }
    const v = validateJudgeReply(parseJsonResponse(text), labels);
    if (v.ok) return { ...v, retried: attempt > 0, reply: text };
    if (attempt === 1) return { ok: false, reason: v.reason };
    user = `${judgeUserMessage(prompt, labeled)}\n\nYour previous answer was invalid (${v.reason}). Answer again with only the JSON array, every id exactly once.`;
  }
  return { ok: false, reason: 'unreachable' };
}

// ------------------------------------------------------------------ smoke (AC-008)

async function smoke() {
  const { getInjectLogPath } = await import(dist('inject-log.js'));
  const { getProjectsDir, LLM_WORKDIR_BASENAME, isExcludedProject } = await import(dist('paths.js'));
  const { llmWorkdir } = await import(dist('llm.js'));
  const logPath = getInjectLogPath();
  const workdir = llmWorkdir();
  const linesOf = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);
  const beforeLines = linesOf().length;
  const start = Date.now();
  const prompt = { project: '/tmp/inject-judge-smoke', query: 'Which tool do we use to run database migrations?' };
  const labeled = labelItems([
    { factId: 'a', text: '[decision] Database migrations run through Flyway with versioned SQL files only' },
    { factId: 'b', text: '[note] The team lunch order on Fridays is kimchi stew' },
  ], 'smoke');
  const reply = await judgeCall(prompt, labeled);
  const after = linesOf();
  const newLines = after.slice(beforeLines).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const fromWorkdir = newLines.filter((r) => typeof r.project === 'string' && (r.project === workdir || r.project.endsWith(`/${LLM_WORKDIR_BASENAME}`))).length;
  // The call's transcript must land in the reserved memory-bank-llm project folder the indexer skips.
  let transcript = null;
  const projectsDir = getProjectsDir();
  for (const entry of fs.readdirSync(projectsDir)) {
    if (entry !== LLM_WORKDIR_BASENAME && !entry.endsWith(`-${LLM_WORKDIR_BASENAME}`)) continue;
    for (const f of fs.readdirSync(path.join(projectsDir, entry))) {
      const p = path.join(projectsDir, entry, f);
      if (f.endsWith('.jsonl') && fs.statSync(p).mtimeMs >= start - 1000) transcript = { folder: entry, file: f, excluded: isExcludedProject(entry) };
    }
  }
  const dbPath = args.values['--db'] ?? path.join(os.homedir(), '.config', 'superpowers', 'conversation-index', 'db.sqlite');
  // Worker sessions run every day, so an indexer that picked up the memory-bank-llm folder would show
  // rows from the last days. Rows older than that are the July 2026 pollution from before the exclusion.
  const live = new Database(dbPath, { readonly: true, fileMustExist: true });
  const llmWhere = "(project LIKE '%memory-bank-llm' OR cwd LIKE '%/memory-bank-llm')";
  const since = new Date(start - 30 * 86400000).toISOString();
  const llmRecent = live.prepare(`SELECT COUNT(*) AS n FROM exchanges WHERE ${llmWhere} AND timestamp >= ?`).get(since).n;
  const llmTotal = live.prepare(`SELECT COUNT(*) AS n, MAX(timestamp) AS newest FROM exchanges WHERE ${llmWhere}`).get();
  live.close();
  const result = {
    reply_valid: reply.ok, reply_reason: reply.ok ? null : reply.reason,
    scores: reply.ok ? Object.fromEntries(labeled.map((it) => [it.factId, reply.scores.get(it.label)])) : null,
    inject_log_new_lines_total: newLines.length, inject_log_delta: fromWorkdir,
    llm_workdir_transcript: transcript,
    llm_workdir_exchanges: llmRecent, llm_workdir_exchanges_window: `timestamp >= ${since}`,
    llm_workdir_exchanges_all_time: llmTotal.n, llm_workdir_exchanges_newest: llmTotal.newest,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'smoke.json'), JSON.stringify(result, null, 1) + '\n');
  console.log(JSON.stringify(result));
  const ok = reply.ok && fromWorkdir === 0 && llmRecent === 0 && transcript && transcript.excluded;
  process.exit(ok ? 0 : 1);
}

// ------------------------------------------------------------------ shared loading

async function loadBench() {
  for (const f of ['sample.json', 'replay-meta.json', 'snapshot.sqlite', ...VARIANTS.map((v) => `lines-${v}.jsonl`)]) {
    if (!fs.existsSync(path.join(OUT, f))) fail(`missing ${path.join(OUT, f)} — run inject-replay.mjs --build and --replay first`);
  }
  const sample = readJson('sample.json');
  const meta = readJson('replay-meta.json');
  const lines = Object.fromEntries(VARIANTS.map((v) => [v, new Map(readLines(`lines-${v}.jsonl`).map((r) => [r.qid, r.lines]))]));
  return { sample, meta, lines };
}

/** Key of a judgment row in judgment-bindings.json: sha256 of its line. */
const rowKey = (line) => crypto.createHash('sha256').update(line).digest('hex');

/** Judgment rows (each with its line's key as a non-enumerable `key`). A torn LAST line (an interrupted
 *  append — that call is redone) is counted in `loadJudgments.torn`; a broken line anywhere else is
 *  corruption and stops the run. */
function loadJudgments() {
  loadJudgments.torn = 0;
  if (!fs.existsSync(JUDGMENTS)) return [];
  const out = [];
  const raw = fs.readFileSync(JUDGMENTS, 'utf8').split('\n').filter((l) => l.trim());
  raw.forEach((line, i) => {
    try { out.push(Object.defineProperty(JSON.parse(line), 'key', { value: rowKey(line) })); } catch {
      if (i !== raw.length - 1) fail(`${JUDGMENTS}: line ${i + 1} of ${raw.length} is not JSON — not a torn tail`);
      loadJudgments.torn += 1;
    }
  });
  return out;
}

// ------------------------------------------------------------------ judge

async function judgeAll() {
  const { sample, lines } = await loadBench();
  const concurrency = intArg('--concurrency', 4, 1, 8);
  const limit = intArg('--limit', Infinity, 1, 100000);
  const db = new Database(path.join(OUT, 'snapshot.sqlite'), { readonly: true, fileMustExist: true });
  const { truncateFact } = await import(dist('fact-text.js'));
  const { scopeMatcher } = await import(dist('project-family.js'));
  const facts = db.prepare('SELECT id, fact, category, created_at, scope_type, scope_project, is_active FROM facts').all();
  const factById = new Map(facts.map((f) => [f.id, f]));
  const active = facts.filter((f) => f.is_active === 1);
  const index = buildFactIndex(db);
  db.close();
  const text = (id) => { const f = factById.get(id); return `[${f.category}] ${truncateFact(f.fact)}`; };

  const pick = (pool, n, seed, ok) => {
    const rand = seededRandom(seed);
    const out = [];
    for (let tries = 0; tries < 2000 && out.length < n && pool.length; tries++) {
      const f = pool[Math.floor(rand() * pool.length)];
      if (ok(f) && !out.includes(f.id)) out.push(f.id);
    }
    return out;
  };

  const prior = loadJudgments().filter((j) => j.model === MODEL);
  const mainDone = new Map();
  for (const j of prior) if (j.pass === 'main' && j.scores) mainDone.set(j.qid, { ...(mainDone.get(j.qid) ?? {}), ...j.scores });
  const items = new Map(); // qid → [{factId, kind}]
  // Items of scored rows only: a prompt whose first call failed is asked again in full (lines and controls).
  for (const j of prior) if (j.pass === 'main' && j.items && j.scores) items.set(j.qid, [...(items.get(j.qid) ?? []), ...j.items]);

  const tasks = [];
  for (const p of sample) {
    const union = [...new Set(VARIANTS.flatMap((v) => (lines[v].get(p.qid) ?? []).map((l) => l.id)))];
    if (union.length === 0) continue;
    const done = mainDone.get(p.qid) ?? {};
    const missing = union.filter((id) => !(id in done));
    let want;
    if (!items.has(p.qid)) {
      const asOf = makeAsOf(index, p);
      const inUnion = new Set(union);
      const visible = (f) => asOf.visibleFactId(f.id) && !inUnion.has(f.id);
      const family = scopeMatcher(p.project, true);
      let same = pick(active.filter((f) => f.scope_type === 'project' && f.scope_project === p.project), CONTROL_PER_KIND, `${p.qid}:same`, visible);
      if (same.length < CONTROL_PER_KIND) {
        same = [...same, ...pick(active.filter((f) => f.scope_type !== 'project'), CONTROL_PER_KIND - same.length, `${p.qid}:same-global`, (f) => visible(f) && !same.includes(f.id))];
      }
      const other = pick(active.filter((f) => f.scope_type === 'project' && f.scope_project !== p.project && !family(f.scope_project)), CONTROL_PER_KIND, `${p.qid}:other`, visible);
      want = [...union.map((id) => ({ factId: id, kind: 'line' })), ...same.map((id) => ({ factId: id, kind: 'control_same' })), ...other.map((id) => ({ factId: id, kind: 'control_other' }))];
    } else if (missing.length) {
      want = missing.map((id) => ({ factId: id, kind: 'line' }));
    } else continue;
    tasks.push({ prompt: p, pass: 'main', want, seed: `${p.qid}:main:${(items.get(p.qid) ?? []).length}` });
  }
  // Re-judge pass: the same items of REJUDGE_PROMPTS prompts in another order (V3 agreement).
  const rejudged = new Set(prior.filter((j) => j.pass === 'rejudge' && j.scores).map((j) => j.qid));
  const judgedQids = sample.filter((p) => items.has(p.qid) || tasks.some((t) => t.prompt.qid === p.qid));
  const rejudgeSet = [...judgedQids].sort((a, b) => crypto.createHash('sha256').update(`${a.qid}:rejudge`).digest('hex')
    .localeCompare(crypto.createHash('sha256').update(`${b.qid}:rejudge`).digest('hex'))).slice(0, REJUDGE_PROMPTS);

  const selected = tasks.slice(0, limit);
  let done = 0;
  let failed = 0;
  const append = (rec) => fs.appendFileSync(JUDGMENTS, JSON.stringify(rec) + '\n');
  const run = async (task) => {
    const labeled = labelItems(task.want.map((w) => ({ ...w, text: text(w.factId) })), task.seed);
    // Bound to what the judge receives — the same function the report rebuilds it with from the snapshot.
    const bound = { seed: task.seed, message: judgeMessageSha(task.prompt, task.want, task.seed, text) };
    const reply = await judgeCall(task.prompt, labeled);
    if (reply.ok) {
      append({ qid: task.prompt.qid, pass: task.pass, model: MODEL, at: new Date().toISOString(), items: task.want, bound, retried: reply.retried, reply: reply.reply,
        scores: Object.fromEntries(labeled.map((it) => [it.factId, reply.scores.get(it.label)])) });
    } else {
      failed++;
      append({ qid: task.prompt.qid, pass: task.pass, model: MODEL, at: new Date().toISOString(), items: task.want, bound, failed: reply.reason });
    }
    done++;
    if (done % 10 === 0) console.error(`inject-judge: ${done}/${queue.length} calls (${failed} failed)`);
  };
  const queue = [...selected];
  // main pass first; the re-judge pass needs each prompt's main items
  const pool = async (list) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (i < list.length) { const t = list[i++]; await run(t); }
    }));
  };
  await pool(queue);
  if (limit === Infinity) {
    const after = loadJudgments().filter((j) => j.model === MODEL && j.pass === 'main' && j.items);
    const itemsNow = new Map();
    for (const j of after) itemsNow.set(j.qid, [...(itemsNow.get(j.qid) ?? []), ...j.items]);
    const rq = rejudgeSet.filter((p) => !rejudged.has(p.qid) && itemsNow.has(p.qid))
      .map((p) => ({ prompt: p, pass: 'rejudge', want: itemsNow.get(p.qid), seed: `${p.qid}:rejudge` }));
    queue.push(...rq);
    await pool(rq);
  }
  console.log(JSON.stringify({ calls: done, failed, model: MODEL }));
}

// ------------------------------------------------------------------ judged text, legacy bindings

/** The text the judge is shown for a fact, from the snapshot as it is now (judgeAll's `text`). */
async function judgedTextOf() {
  const { truncateFact } = await import(dist('fact-text.js'));
  const db = new Database(path.join(OUT, 'snapshot.sqlite'), { readonly: true, fileMustExist: true });
  const facts = new Map(db.prepare('SELECT id, fact, category FROM facts').all().map((f) => [f.id, f]));
  db.close();
  return (id) => { const f = facts.get(id); return f ? `[${f.category}] ${truncateFact(f.fact)}` : `\0missing fact ${id}`; };
}

/** One recorded call of the isolated LLM sessions (a transcript file — one SDK query): its message, reply and model. */
function readCall(file) {
  let message = null;
  let reply = '';
  let model = null;
  let unreadable = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { unreadable++; continue; }
    const c = o.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
    if (o.type === 'user' && message === null && text) message = text;
    else if (o.type === 'assistant' && message !== null) { reply += text; model ??= o.message?.model ?? null; }
  }
  return { message, reply, model, unreadable };
}

/** The isolated LLM sessions' transcript folders (memory-bank-llm), and the path of a recorded call named `<folder>/<file>.jsonl`, or null. */
async function llmFolders() {
  const { getProjectsDir, LLM_WORKDIR_BASENAME } = await import(dist('paths.js'));
  const projectsDir = getProjectsDir();
  const isLlm = (entry) => entry === LLM_WORKDIR_BASENAME || entry.endsWith(`-${LLM_WORKDIR_BASENAME}`);
  const callPath = (name) => {
    const m = /^([^/]+)\/([^/]+\.jsonl)$/.exec(name ?? '');
    return m && isLlm(m[1]) && m[1] !== '..' ? path.join(projectsDir, m[1], m[2]) : null;
  };
  return { projectsDir, isLlm, callPath };
}

/** Every recorded call of the isolated LLM sessions: `<folder>/<file>.jsonl`, message, reply and answering model. */
async function llmCalls() {
  const { projectsDir, isLlm } = await llmFolders();
  const calls = [];
  let unreadable = 0;
  for (const entry of fs.readdirSync(projectsDir)) {
    if (!isLlm(entry)) continue;
    for (const f of fs.readdirSync(path.join(projectsDir, entry))) {
      if (!f.endsWith('.jsonl')) continue;
      const c = readCall(path.join(projectsDir, entry, f));
      unreadable += c.unreadable;
      if (c.message !== null) calls.push({ file: `${entry}/${f}`, message: c.message, reply: c.reply, model: c.model });
    }
  }
  return { calls, unreadable };
}

/** Whether a kept judge call (judge-calls.jsonl) is the one `b` binds row `j` to and gives the row's scores. */
function keptCallHolds(j, b, c, textOf, parse) {
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  return Boolean(c) && c.key === j.key && c.file === b.call?.file && sha(c.message) === b.call?.messageSha && sha(c.reply) === b.call?.replySha && firstAttemptSha(c.message) === b.message
    && c.model === j.model && c.model === b.call?.model && replyGivesRowScores(j, b.seed, c.reply, textOf, parse);
}

/**
 * Rows written before judgment rows carried a binding: find the judge call behind each — a call whose
 * message (its first attempt) equals the row's message rebuilt from the current snapshot, answered by the
 * row's model with exactly the row's scores. The matched calls (message and reply) are kept in
 * judge-calls.jsonl next to judgment-bindings.json; the report checks every binding against them again.
 */
async function bindLegacy() {
  const { sample } = await loadBench();
  const promptOf = new Map(sample.map((p) => [p.qid, p]));
  const textOf = await judgedTextOf();
  const { parseJsonResponse } = await import(dist('llm.js'));
  const { calls, unreadable } = await llmCalls();
  const callsByFirst = indexCalls(calls);
  const rows = loadJudgments();
  const itemCount = new Map();
  for (const j of rows) if (j.pass === 'main' && j.items) itemCount.set(j.qid, (itemCount.get(j.qid) ?? 0) + j.items.length);
  const bindings = {};
  const evidence = [];
  const counts = { rows: rows.length, boundInline: 0, kept: 0, matched: 0, retried: 0, unmatchedScored: 0, failedRows: 0 };
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  // A binding made before, whose kept call still holds, stays — even once its transcript is gone (transcripts expire).
  const before = fs.existsSync(BINDINGS) ? JSON.parse(fs.readFileSync(BINDINGS, 'utf8')).rows ?? {} : {};
  const keptBefore = new Map(fs.existsSync(JUDGE_CALLS)
    ? fs.readFileSync(JUDGE_CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.key, c]) : []);
  const used = new Set();
  for (const j of rows) {
    if (j.bound) { counts.boundInline++; continue; }
    if (!j.scores) { counts.failedRows++; continue; }   // nothing to bind: a failed row counts toward V6 only
    const p = promptOf.get(j.qid);
    const old = before[j.key];
    const oldCall = keptBefore.get(j.key);
    if (p && old && !used.has(old.call?.file) && judgeMessageSha(p, j.items, old.seed, textOf) === old.message && keptCallHolds(j, old, oldCall, textOf, parseJsonResponse)) {
      bindings[j.key] = old;
      evidence.push(JSON.stringify(oldCall));
      used.add(old.call.file);
      if (old.call.retried) counts.retried++;
      counts.kept++;
      continue;
    }
    const found = p ? legacyBinding(j, p, textOf, callsByFirst, itemCount.get(j.qid) ?? 0, parseJsonResponse, used) : null;
    if (!found) { counts.unmatchedScored++; continue; }
    used.add(found.call.file);
    const retried = found.call.message.includes(JUDGE_RETRY_MARK);
    if (retried) counts.retried++;
    bindings[j.key] = { seed: found.seed, message: found.message, via: 'transcript', call: { file: found.call.file, messageSha: sha(found.call.message), replySha: sha(found.call.reply), model: found.call.model, retried } };
    evidence.push(JSON.stringify({ key: j.key, file: found.call.file, message: found.call.message, reply: found.call.reply, model: found.call.model }));
    counts.matched++;
  }
  if (counts.unmatchedScored && Object.keys(before).length) {
    // Never trade kept evidence for less: write nothing, so the bindings that held stay as they were.
    console.log(JSON.stringify({ transcripts: calls.length, ...counts, written: false }));
    process.exit(1);
  }
  const write = (file, body) => { const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); };
  write(JUDGE_CALLS, evidence.join('\n') + (evidence.length ? '\n' : ''));
  write(BINDINGS, JSON.stringify({
    version: 2, generatedAt: new Date().toISOString(),
    generator: { ...gitState(REPO), judge: fileSha(fileURLToPath(import.meta.url)), lib: fileSha(path.join(here, 'inject-bench-lib.mjs')) },
    transcripts: { calls: calls.length, unreadableLines: unreadable }, counts, evidence: { file: path.basename(JUDGE_CALLS), sha256: fileSha(JUDGE_CALLS) }, rows: bindings,
  }, null, 1) + '\n');
  console.log(JSON.stringify({ transcripts: calls.length, ...counts }));
  if (counts.unmatchedScored) process.exit(1);
}

// ------------------------------------------------------------------ report

const fmt = (x, d = 3) => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toFixed(d) : String(x));
const ci = (c) => (c.point === null ? '—' : `${fmt(c.point)} [${fmt(c.lo)}, ${fmt(c.hi)}]`);

async function report() {
  const { sample, meta, lines } = await loadBench();
  const inSample = new Set(sample.map((p) => p.qid));
  const allJudgments = loadJudgments();
  const torn = loadJudgments.torn;
  const judgments = allJudgments.filter((j) => inSample.has(j.qid)); // rows of prompts no longer sampled never count
  const models = [...new Set(judgments.map((j) => j.model))];
  if (models.length !== 1) fail(`judgments.jsonl holds ${models.length} judge models (${models.join(', ')}) — one model per report`);
  const model = models[0];
  const main = new Map();
  const kinds = new Map();
  for (const j of judgments.filter((x) => x.pass === 'main' && x.scores)) {
    const m = main.get(j.qid) ?? new Map();
    for (const [id, s] of Object.entries(j.scores)) if (!m.has(id)) m.set(id, s);
    main.set(j.qid, m);
    for (const it of j.items) kinds.set(`${j.qid}|${it.factId}`, it.kind);
  }
  const score = (qid, id) => main.get(qid)?.get(id);
  const calls = judgments.length;
  const failures = judgments.filter((j) => j.failed).length;
  // Every scored row is bound to the message the judge received (system text, prompt, fact texts),
  // rebuilt now from this sample and snapshot — a row judged on other text never counts.
  const textOf = await judgedTextOf();
  const promptOf = new Map(sample.map((p) => [p.qid, p]));
  // A legacy binding counts only with its judge call kept in judge-calls.jsonl: that call's message is the
  // row's message and its reply gives exactly the row's scores, from the row's model.
  const bindingsDoc = fs.existsSync(BINDINGS) ? JSON.parse(fs.readFileSync(BINDINGS, 'utf8')) : null;
  const legacy = bindingsDoc?.rows ?? {};
  const keptCalls = new Map(fs.existsSync(JUDGE_CALLS)
    ? fs.readFileSync(JUDGE_CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.key, c]) : []);
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const { parseJsonResponse } = await import(dist('llm.js'));
  const { callPath } = await llmFolders();
  const shownIds = (q) => new Set(VARIANTS.flatMap((v) => (lines[v].get(q) ?? []).map((l) => l.id)));
  const binding = {
    inline: 0, transcript: 0, unbound: 0, drifted: 0, noReply: 0, noCall: 0, badItems: 0, callReused: 0, retried: 0,
    transcriptChecked: 0, transcriptGone: 0, transcriptMismatch: 0,
    evidenceDrift: Object.keys(legacy).length > 0 && (!fs.existsSync(JUDGE_CALLS) || bindingsDoc?.evidence?.sha256 !== fileSha(JUDGE_CALLS)),
  };
  const usedCalls = new Set();
  for (const j of judgments.filter((x) => x.scores)) {
    // the row's items are what it scored; its lines are lines shown for the prompt, its controls are not
    const ids = new Set(j.items.map((it) => it.factId));
    const shown = shownIds(j.qid);
    if (Object.keys(j.scores).some((k) => !ids.has(k)) || j.items.some((it) => !(it.factId in j.scores) || (it.kind === 'line') !== shown.has(it.factId))) { binding.badItems++; continue; }
    const b = j.bound ?? legacy[j.key];
    if (!b) { binding.unbound++; continue; }
    if (judgeMessageSha(promptOf.get(j.qid), j.items, b.seed, textOf) !== b.message) { binding.drifted++; continue; }
    if (j.bound) {
      // a row the judge wrote carries the reply it got: the scores must be that reply's
      if (typeof j.reply !== 'string' || !replyGivesRowScores(j, b.seed, j.reply, textOf, parseJsonResponse)) { binding.noReply++; continue; }
      if (j.retried) binding.retried++;
      binding.inline++;
      continue;
    }
    const c = keptCalls.get(j.key);
    if (!keptCallHolds(j, b, c, textOf, parseJsonResponse)) { binding.noCall++; continue; }
    if (usedCalls.has(b.call.file)) { binding.callReused++; continue; }
    usedCalls.add(b.call.file);
    if (b.call.retried) binding.retried++;
    // the original transcript, while it is still there, must be the call that was kept
    const orig = callPath(b.call.file);
    if (orig && fs.existsSync(orig)) {
      const o = readCall(orig);
      if (o.message !== null && sha(o.message) === b.call.messageSha && sha(o.reply) === b.call.replySha && o.model === b.call.model) binding.transcriptChecked++;
      else binding.transcriptMismatch++;
    } else binding.transcriptGone++;
    binding.transcript++;
  }
  if (binding.unbound || binding.drifted || binding.noReply || binding.noCall || binding.badItems || binding.callReused || binding.transcriptMismatch || binding.evidenceDrift) {
    fail(`judgment rows not bound to what the judge received: ${binding.unbound} without a binding, ${binding.drifted} whose message no longer matches (fact text, prompt or judge text changed), ${binding.noReply} judged rows without the reply that gives their scores, ${binding.noCall} whose kept judge call is missing or does not give the row's scores, ${binding.badItems} whose items or scores do not fit the shown lines, ${binding.callReused} binding a call another row binds, ${binding.transcriptMismatch} whose transcript differs from the kept call${binding.evidenceDrift ? ', and judge-calls.jsonl is not the file the bindings name' : ''} — run --bind-legacy, or --judge again`);
  }
  // Main rows that re-asked only the lines a prompt was missing (no controls) — counted, read like any main row.
  const fillRows = judgments.filter((j) => j.pass === 'main' && j.scores && !j.items.some((it) => it.kind !== 'line')).length;
  // Judged prompts none of whose scored main rows holds a control — V1/V2 count fewer pairs; surfaced, not hidden.
  const withControls = new Set([...kinds].filter(([, k]) => k !== 'line').map(([key]) => key.split('|')[0]));
  const promptsWithoutControls = [...main.keys()].filter((q) => !withControls.has(q)).length;

  // controls (V1, V2)
  const ctrl = { control_same: [0, 0], control_other: [0, 0] };
  for (const [key, kind] of kinds) {
    if (!(kind in ctrl)) continue;
    const [qid, id] = key.split('|');
    const s = score(qid, id);
    if (s === undefined) continue;
    ctrl[kind][1]++;
    if (s === 2) ctrl[kind][0]++;
  }
  // agreement (V3) — plus, for reading only, lines alone and the grade-2 call the decisions count
  let agree = 0;
  let pairs = 0;
  const lineAgree = [0, 0];
  const j2 = { main: 0, rejudge: 0, both: 0 };
  const rejudgePrompts = new Set();
  for (const j of judgments.filter((x) => x.pass === 'rejudge' && x.scores)) {
    rejudgePrompts.add(j.qid);
    for (const [id, s] of Object.entries(j.scores)) {
      const m = score(j.qid, id);
      if (m === undefined) continue;
      pairs++;
      if (m === s) agree++;
      if (kinds.get(`${j.qid}|${id}`) === 'line') {
        lineAgree[1]++;
        if (m === s) lineAgree[0]++;
        if (m === 2) j2.main++;
        if (s === 2) j2.rejudge++;
        if (m === 2 && s === 2) j2.both++;
      }
    }
  }
  // V4 is bound to the bytes this report reads: both determinism re-runs equal these lines files.
  const det = fs.existsSync(path.join(OUT, 'determinism.json')) ? readJson('determinism.json') : null;
  const lineSha = Object.fromEntries(VARIANTS.map((v) => [v, crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, `lines-${v}.jsonl`))).digest('hex')]));
  const deterministic = determinismBound(det, lineSha);
  // The affected / hard lists come from replay-meta.json — they must belong to these lines files,
  // made from this sample and snapshot; every sampled prompt must have a row in every variant.
  const unbound = unboundMeta(meta.hashes, lineSha);
  if (unbound.length) fail(`replay-meta.json hashes do not match the lines files for ${unbound.join(', ')} — re-run --replay (all variants, no suffix)`);
  if (!Array.isArray(meta.affectedRegistered) || !Array.isArray(meta.affectedAsOf)) fail('replay-meta.json has no affectedRegistered / affectedAsOf — re-run --replay');
  const outSha = (f) => fileSha(path.join(OUT, f));
  const replayInputs = { sample: outSha('sample.json'), snapshot: sqliteDigest(path.join(OUT, 'snapshot.sqlite')) };
  const drifted = driftedInputs(meta.inputs, replayInputs);
  if (drifted.length) fail(`replay-meta.json was made from another ${drifted.join(' and ')} — re-run --replay`);
  const gaps = missingRows(sample.map((p) => p.qid), lines);
  if (gaps.length) fail(`lines files miss sampled prompts (${gaps.map((g) => `${g.variant} ${g.missing}`).join(', ')}) — re-run --replay`);
  // The code that made the lines must be the code on disk now (the report names one code version):
  // every module the replay loads, the packages they import, the embedding model and its files.
  const { EMBEDDING_MODEL } = await import(dist('embedding-version.js'));
  // The Node version is the replay's (the report makes no lines) — recorded, shown, not compared.
  const withoutNode = ({ node: _node, ...rest } = {}) => rest;
  const codeChanged = driftedCode(withoutNode(meta.code?.files), withoutNode(codeDigest(REPO, EMBEDDING_MODEL)));
  if (codeChanged.length) fail(`code changed since --replay (${codeChanged.slice(0, 5).join(', ')}${codeChanged.length > 5 ? ', …' : ''}) — re-run --replay and --check-determinism`);
  const missingRoots = [...new Set(sample.map((p) => p.project))].filter((p) => !Array.isArray(meta.roots?.[p]));
  if (missingRoots.length) fail(`replay-meta.json has no family roots for ${missingRoots.length} cwd(s) — re-run --replay`);
  const codeKeys = Object.keys(meta.code.files);
  const inputs = {
    ...replayInputs, judgments: outSha('judgments.jsonl'), bindings: fs.existsSync(BINDINGS) ? fileSha(BINDINGS) : null, judgeCalls: fs.existsSync(JUDGE_CALLS) ? fileSha(JUDGE_CALLS) : null,
    code: {
      replay: { git: meta.code.git, dirty: meta.code.dirty },
      bound: {
        modules: codeKeys.filter((k) => /\.(m?js)$/.test(k) && !k.includes(':') && !k.startsWith('node_modules/')).length,
        packages: codeKeys.filter((k) => k.startsWith('package:')).length,
        native: codeKeys.filter((k) => k.startsWith('native:')).length,
        modelFiles: codeKeys.filter((k) => k.startsWith('node_modules/@xenova/transformers/')).length,
        model: meta.code.files['embedding-model'],
        node: meta.code.files.node,
      },
      report: gitState(REPO),
    },
  };
  const bySplit = { train: sample.filter((p) => p.split === 'train').map((p) => p.qid), heldout: sample.filter((p) => p.split === 'heldout').map((p) => p.qid) };
  bySplit.all = [...bySplit.train, ...bySplit.heldout];

  const counts = {};
  const unjudged = new Set();
  for (const v of VARIANTS) {
    const r = perPromptCounts(bySplit.all, lines[v], score);
    counts[v] = r.counts;
    r.unjudged.forEach((q) => unjudged.add(q));
  }
  // Every shown line must carry a judgment: a prompt left out would quietly shrink the sets the rules decide on.
  if (unjudged.size) fail(`${unjudged.size} prompt(s) have shown lines without a judgment — run --judge first`);
  const usable = (qids) => qids.filter((q) => !unjudged.has(q));
  const pairsOf = (qids, a, b = 'v0') => usable(qids).map((q) => ({ base: counts[b].get(q), alt: counts[a].get(q) }));
  const stats = {};
  for (const split of ['train', 'heldout', 'all']) {
    stats[split] = {};
    for (const v of VARIANTS) {
      const qids = usable(bySplit[split]);
      stats[split][v] = {
        agg: aggregate(qids.map((q) => counts[v].get(q))),
        lostJ2Rel: lostJ2Rel(qids, lines.v0, lines[v], score),
        relJ0Delta: bootstrapDelta(pairsOf(bySplit[split], v), meanDelta('relJ0'), { seed: `relJ0:${split}:${v}` }),
        j2Delta: bootstrapDelta(pairsOf(bySplit[split], v), meanDelta('j2'), { seed: `j2:${split}:${v}` }),
        precisionJ2Delta: bootstrapDelta(pairsOf(bySplit[split], v), ratioDelta('j2', 'lines'), { seed: `pj2:${split}:${v}` }),
      };
    }
  }
  const c2For = (qids) => ({
    affected: qids.length,
    j2Delta: bootstrapDelta(pairsOf(qids, 'family'), meanDelta('j2'), { seed: 'c2:j2' }),
    precisionJ2Delta: bootstrapDelta(pairsOf(qids, 'family'), ratioDelta('j2', 'lines'), { seed: 'c2:pj2' }),
  });
  // The rule decides on the registered reading (the prompt's cwd has facts in the widened paths, active now);
  // the as-of reading is post-hoc (plan Deviations 2) and reported with its own decision, which decides nothing.
  const affected = usable(meta.affectedRegistered);
  const c2stats = c2For(affected);
  const asOfQids = usable(meta.affectedAsOf);
  c2stats.asOf = { ...c2For(asOfQids), decision: decideC2(c2For(asOfQids)).decision };
  // Where the effect lives (reading aid). Grouped by repository — a linked worktree counts with its main
  // repository (the last family root) — and by cwd root (the worktree / folder itself).
  const projectOf = new Map(sample.map((p) => [p.qid, p.project]));
  const rootsOfQ = (q) => meta.roots[projectOf.get(q)];   // as resolved at replay time
  const repoOfQ = (q) => repoOf(rootsOfQ(q), projectOf.get(q));
  const rootOfQ = (q) => rootsOfQ(q)[0] ?? projectOf.get(q);
  const differs = new Set(blockDiffers(affected, lines.family, lines.v0));
  const byRepo = new Map();
  for (const q of affected) {
    const r = byRepo.get(repoOfQ(q)) ?? { prompts: 0, differs: 0, gain: 0, roots: new Set() };
    r.prompts++;
    if (differs.has(q)) r.differs++;
    r.gain += counts.family.get(q).j2 - counts.v0.get(q).j2;
    r.roots.add(rootOfQ(q));
    byRepo.set(repoOfQ(q), r);
  }
  const repos = [...byRepo.entries()].sort((a, b) => b[1].gain - a[1].gain || b[1].prompts - a[1].prompts);
  const totalGain = repos.reduce((t, [, r]) => t + r.gain, 0);
  const [topRepo, top] = repos[0] ?? [null, null];
  const rest = affected.filter((q) => repoOfQ(q) !== topRepo);
  // Grade-2 gain by where the cwd sits in its repository (repository folder, worktree inside it, worktree outside it).
  c2stats.byPlacement = {};
  for (const q of affected) {
    const k = placementOf(projectOf.get(q), rootsOfQ(q));
    const b = c2stats.byPlacement[k] ?? { prompts: 0, differs: 0, gain: 0 };
    b.prompts++;
    if (differs.has(q)) b.differs++;
    b.gain += counts.family.get(q).j2 - counts.v0.get(q).j2;
    c2stats.byPlacement[k] = b;
  }
  const placed = Object.values(c2stats.byPlacement).reduce((t, b) => t + b.prompts, 0);
  if (placed !== affected.length) fail(`placement buckets hold ${placed} prompts, not the ${affected.length} affected`);
  c2stats.blockDiffers = {
    prompts: differs.size,
    cwds: new Set([...differs].map((q) => projectOf.get(q))).size,
    repos: new Set([...differs].map(repoOfQ)).size,
  };
  c2stats.byRepo = {
    repos: repos.length,
    totalGain,
    gainByRepo: repos.map(([, r]) => r.gain),
    largest: top && { prompts: top.prompts, differs: top.differs, gain: top.gain, cwdRoots: top.roots.size },
    // Without the repository holding the largest gain: below the registered minimum the delta is not judged.
    withoutLargest: rest.length >= THRESHOLDS.C2_min_affected
      ? { measurable: true, ...bootstrapDelta(pairsOf(rest, 'family'), meanDelta('j2'), { seed: 'c2:j2:loo' }) }
      : { measurable: false, n: rest.length, gain: rest.reduce((t, q) => t + counts.family.get(q).j2 - counts.v0.get(q).j2, 0) },
  };
  const hard = usable(meta.hard);
  const hardGain = Object.fromEntries(VARIANTS.map((v) => [v, hard.reduce((t, q) => t + counts[v].get(q).j2, 0)]));
  const hardLines = Object.fromEntries(VARIANTS.map((v) => [v, hard.reduce((t, q) => {
    const c = counts[v].get(q);
    return { j2: t.j2 + c.j2, j1: t.j1 + c.j1, j0: t.j0 + c.j0 };
  }, { j2: 0, j1: 0, j0: 0 })]));
  // C4 measured only
  const kwLines = [];
  for (const q of usable(bySplit.all)) for (const l of lines.kw.get(q) ?? []) if (l.origin === 'kw') kwLines.push({ q, id: l.id });
  const snapDb = new Database(path.join(OUT, 'snapshot.sqlite'), { readonly: true });
  const factText = snapDb.prepare('SELECT fact FROM facts WHERE id = ?');
  const kwBypass = kwLines.filter((x) => isBypassFact(factText.get(x.id)?.fact ?? '')).length;
  snapDb.close();
  const c4 = {
    kwLines: kwLines.length,
    kwJ2: kwLines.filter((x) => score(x.q, x.id) === 2).length,
    kwPrecisionJ2: kwLines.length ? kwLines.filter((x) => score(x.q, x.id) === 2).length / kwLines.length : null,
    j2Delta: stats.all.kw.j2Delta,
    bypassSelected: kwBypass,
    bypassSkipped: meta.kw.bypassSkipped,
  };

  const v = validity({
    controlSameJ2Rate: ctrl.control_same[1] ? ctrl.control_same[0] / ctrl.control_same[1] : null,
    controlOtherJ2Rate: ctrl.control_other[1] ? ctrl.control_other[0] / ctrl.control_other[1] : null,
    agreement: pairs ? agree / pairs : null, agreementPairs: pairs, rejudgePrompts: rejudgePrompts.size,
    deterministic,
    heldoutPrompts: usable(bySplit.heldout).length, hardPrompts: hard.length,
    judgeCalls: calls, judgeFailures: failures,
  });
  const c3 = decideC3(stats);
  const c2 = decideC2(c2stats);
  const decisions = decide(v.valid, c3, c2);
  const result = {
    generatedAt: new Date().toISOString(), model,
    sample: { distinct: sample.length, train: bySplit.train.length, heldout: bySplit.heldout.length, unjudged: unjudged.size, hard: hard.length, affected: affected.length },
    judge: {
      calls, failures, tornTail: torn, outsideSample: allJudgments.length - judgments.length,
      controls: { same: ctrl.control_same, other: ctrl.control_other },
      agreement: { agree, pairs, prompts: rejudgePrompts.size, lines: lineAgree, j2 },
      binding, fillRows, promptsWithoutControls,
    },
    lineSha, inputs, validity: v, stats, c2: c2stats, c4, hardGain, hardLines, decisions,
  };
  const reportBody = JSON.stringify(result, null, 1) + '\n';
  fs.writeFileSync(path.join(OUT, 'report.json'), reportBody);
  console.log(JSON.stringify({ verdict: decisions.verdict, validity: Object.fromEntries(Object.entries(v.gates).map(([k, g]) => [k, g.pass])), C3: c3.decision, C2: c2.decision, production: decisions.production }));
  if (args.values['--doc']) writeDoc(path.resolve(REPO, args.values['--doc']), result, crypto.createHash('sha256').update(reportBody).digest('hex'));
}

/** Placement buckets in the order the doc lists them; a bucket the report holds is never left out. */
const PLACEMENT_LABELS = { 'repo-folder': '저장소 폴더(본체·하위 폴더)', 'worktree-inside': '저장소 안 worktree', 'worktree-outside': '저장소 밖 worktree', 'no-family': '가족 없음' };

function writeDoc(file, r, reportSha) {
  const rows = (split) => VARIANTS.map((vn) => {
    const s = r.stats[split][vn];
    const a = s.agg;
    return `| ${vn} | ${a.prompts} | ${fmt(a.lines_per_prompt, 2)} | ${fmt(a.precision_ge1)} | ${fmt(a.precision_j2)} | ${fmt(a.j2_per_prompt)} | ${a.rel} | ${fmt(a.rel_precision_ge1)} | ${fmt(a.rel_j0_per_prompt)} | ${vn === 'v0' ? '—' : ci(s.j2Delta)} | ${vn === 'v0' ? '—' : s.lostJ2Rel} |`;
  });
  const g = r.validity.gates;
  const gateRow = (k, label) => `| ${k} | ${label} | ${typeof g[k].value === 'object' && g[k].value !== null ? JSON.stringify(g[k].value) : fmt(g[k].value)} | ${g[k].threshold} | ${g[k].pass ? '통과' : '미달'} |`;
  const d = r.decisions;
  const c3 = d.C3;
  const c3trace = (c3.train ?? []).map((t) => `| ${t.variant} | ${t.margin} | ${fmt(t.gain)} | ${t.lost} | ${t.lostOk ? '예' : '아니오'} |`);
  const body = [
    '# 주입 재생 판정 결과 — 2026-10-19',
    '',
    `계획: \`docs/plans/2026-10-19-memorilla-applicability.md\` · 생성: \`node bench/inject-judge.mjs --report --doc …\` (${r.generatedAt}) · 판정 모델 \`${r.model}\``,
    '',
    '이 문서에는 집계 수치만 싣는다. 프롬프트·사실 원문은 `.bench-out/` 밖으로 나가지 않는다(`--leak-check` 로 확인).',
    '',
    `**결론: ${d.verdict === 'valid' ? '유효' : '무효 — 모든 후보는 현행 유지'}** · C3 관계 게이트 \`${c3.decision}\` · C2 가족 scope \`${d.C2.decision}\` · 운영 값 \`${JSON.stringify(d.production)}\``,
    '',
    '## 표본',
    '',
    `서로 다른 프롬프트 ${r.sample.distinct}개(train ${r.sample.train} · held-out ${r.sample.heldout}). 판정이 없어 빠진 프롬프트(판정 실패·미판정) ${r.sample.unjudged}개. 하드 부분집합(v0 가 0줄) ${r.sample.hard}개. 가족 scope 영향 프롬프트 ${r.sample.affected}개.`,
    '표본은 운영 로그와 대화 색인이 맞는 프롬프트만 쓴다(같은 cwd·같은 길이·±180초, 현행 게이트 통과, 합성 턴 제외, 같은 질의 하나로 접음). 색인되지 않는 자동화 세션은 빠진다.',
    '',
    '## 유효성 (V1~V6, 사전 등록)',
    '',
    '| 기준 | 내용 | 값 | 기준값 | 결과 |',
    '|---|---|---|---|---|',
    gateRow('V1', '같은 scope 무작위 대조군의 판정 2 비율'),
    gateRow('V2', '다른 프로젝트 무작위 대조군의 판정 2 비율'),
    gateRow('V3', '다른 순서 재채점 일치율'),
    gateRow('V4', '재생 결정론'),
    gateRow('V5', 'held-out·하드 부분집합 크기'),
    gateRow('V6', '판정 실패율'),
    '',
    `판정 호출 ${r.judge.calls}회, 실패 ${r.judge.failures}회, 끊긴 마지막 줄 ${r.judge.tornTail}개, 표본 밖 판정 행 ${r.judge.outsideSample}개(집계 제외). 대조군 판정 2: 같은 scope ${r.judge.controls.same[0]}/${r.judge.controls.same[1]}, 다른 프로젝트 ${r.judge.controls.other[0]}/${r.judge.controls.other[1]}. 재채점 일치 ${r.judge.agreement.agree}/${r.judge.agreement.pairs}(재채점 프롬프트 ${r.judge.agreement.prompts}개).`,
    `참고(판정 규칙 밖): 대조군을 뺀 줄만의 재채점 일치 ${r.judge.agreement.lines[0]}/${r.judge.agreement.lines[1]}. 판정 2 의 재현성은 처음 판정 ${r.judge.agreement.j2.main}개·재채점 ${r.judge.agreement.j2.rejudge}개·양쪽 ${r.judge.agreement.j2.both}개(양성 일치 ${fmt(r.judge.agreement.j2.main + r.judge.agreement.j2.rejudge ? (2 * r.judge.agreement.j2.both) / (r.judge.agreement.j2.main + r.judge.agreement.j2.rejudge) : null)}). 부트스트랩 구간은 판정 잡음을 담지 않는다.`,
    `V4 는 두 번의 재생이 이 보고가 읽은 줄 파일과 바이트 단위로 같아야 통과한다(줄 파일 sha256 앞 12자: ${VARIANTS.map((vn) => `${vn} ${r.lineSha[vn].slice(0, 12)}`).join(' · ')}).`,
    `결속: 이 보고는 재생이 시작할 때 기록한(끝날 때 다시 재어 같았던) 표본·스냅샷(WAL 포함) 해시와, 재생이 불러온 모듈 ${r.inputs.code.bound.modules}개·패키지 ${r.inputs.code.bound.packages}개(하위 의존 포함, 버전)·네이티브 바이너리 ${r.inputs.code.bound.native}개·임베딩 모델(\`${r.inputs.code.bound.model}\`) 파일 ${r.inputs.code.bound.modelFiles}개의 해시를 지금 다시 계산해 같을 때만 낸다(표본 ${r.inputs.sample.slice(0, 12)} · 스냅샷 ${r.inputs.snapshot.slice(0, 12)}). 재생의 Node 버전(\`${r.inputs.code.bound.node ?? '기록 없음'}\`)은 재생이 시작과 끝에 같았는지만 보고, 보고는 다시 비교하지 않는다(보고는 줄을 만들지 않는다). 표시된 줄은 모두 판정돼 있어야 하고, 판정 행은 판정기가 받은 메시지(판정 지시문·프롬프트·사실 문장)를 지금 스냅샷으로 다시 만든 것과 바이트가 같아야 한다 — 판정 때 기록한 행 ${r.judge.binding.inline}개(받은 답 원문을 행에 싣고, 보고가 그 답의 점수가 행 점수와 같은지 다시 본다), 판정 호출 기록에서 찾은 행 ${r.judge.binding.transcript}개(그 호출의 메시지와 답을 \`judge-calls.jsonl\` 에 보존하고, 보고가 그 파일이 결속 파일이 가리키는 해시인지와 답의 점수·모델이 행과 같은지 다시 보며, 원래 대화 기록이 남아 있으면 그것과도 대조한다 — 대조 ${r.judge.binding.transcriptChecked}개·원본 없음 ${r.judge.binding.transcriptGone}개). 한 호출은 한 행만 결속하고, 행의 항목은 점수 키와 같아야 하며 줄로 적힌 항목은 표시된 줄, 대조군은 표시되지 않은 사실이어야 한다. 재생 코드 \`${r.inputs.code.replay?.git ? r.inputs.code.replay.git.slice(0, 7) : '확인 불가'}\`${r.inputs.code.replay?.dirty === true ? '(src·bench·dist 에 커밋 안 된 변경 있음)' : r.inputs.code.replay?.dirty === false ? '(src·bench·dist 깨끗함)' : ''}. 기록만 하는 값: 판정 파일 ${r.inputs.judgments.slice(0, 12)}, 보고를 낸 코드 \`${r.inputs.code.report.git ? r.inputs.code.report.git.slice(0, 7) : '확인 불가'}\`.`,
    `보충 판정 행(대조군 없이 빠진 줄만 다시 부른 main 행) ${r.judge.fillRows}개 — 다른 main 행과 같이 읽는다. 대조군이 하나도 판정되지 않은 프롬프트 ${r.judge.promptsWithoutControls}개. 한 번 다시 물어 점수를 얻은 판정 행 ${r.judge.binding.retried}개(결속은 첫 메시지 — 다시 묻기는 형식 지적 한 줄만 덧붙인다).`,
    '',
    ...['train', 'heldout', 'all'].flatMap((split) => [
      `## 변형별 지표 — ${split}`,
      '',
      '| 변형 | 프롬프트 | 줄/프롬프트 | 정밀도(≥1) | 정밀도(=2) | 판정2/프롬프트 | 관계 줄 | 관계 정밀도(≥1) | 관계 판정0/프롬프트 | Δ판정2/프롬프트 [95% CI] | 잃은 판정2 관계 줄 |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows(split),
      '',
    ]),
    '## C3 관계 이웃 게이트',
    '',
    'train 선택 규칙: 관계 줄 정밀도(≥1)가 v0 대비 +10pp 이상이고 잃은 판정 2 관계 줄이 v0 의 10% 이하인 가장 작은 margin.',
    '',
    '| 변형 | margin | 관계 정밀도 이득 | 잃은 판정2 관계 줄 | 손실 조건 |',
    '|---|---|---|---|---|',
    ...c3trace,
    '',
    `결정: \`${c3.decision}\` — ${c3.reason ?? ''}`,
    c3.heldout ? `held-out(${c3.heldout.variant}): 관계 판정0/프롬프트 Δ ${ci(c3.heldout.relJ0Delta)}, 잃은 판정2 관계 줄 ${c3.heldout.lost}/${c3.heldout.baseRelJ2}` : '',
    '',
    '## C2 저장소 가족 scope',
    '',
    `영향 프롬프트 ${r.c2.affected}개(두 분할 합침 — 사전 등록 문장 "넓어진 경로에 사실이 있는 cwd 의 프롬프트"의 cwd 단위 해석. 원문에 시점이 없어 사실은 지금 활성인 것으로 센다). 판정2/프롬프트 Δ ${ci(r.c2.j2Delta)} · 정밀도(=2) Δ ${ci(r.c2.precisionJ2Delta)}.`,
    `사후 해석(판정 규칙 밖 — 계획 Deviations 2, 결정에 쓰지 않음): 그 프롬프트 시점에 보이는 사실로 세면 영향 ${r.c2.asOf.affected}개, 판정2/프롬프트 Δ ${ci(r.c2.asOf.j2Delta)} · 정밀도(=2) Δ ${ci(r.c2.asOf.precisionJ2Delta)} → 같은 규칙이면 \`${r.c2.asOf.decision}\`.`,
    `참고(판정 규칙 밖): family 블록이 v0 와 실제로 다른 프롬프트 ${r.c2.blockDiffers.prompts}개 — cwd ${r.c2.blockDiffers.cwds}곳, 저장소 ${r.c2.blockDiffers.repos}곳(연결 worktree 는 본 저장소로 셈, 루트는 재생 때 해석한 값).`,
    `프롬프트의 cwd 가 놓인 자리별(영향 프롬프트 · 블록이 달라진 프롬프트 · 그 프롬프트들이 얻은 판정 2 이득 — 이득이 된 사실이 어디서 왔는지가 아니다): ${[...Object.keys(PLACEMENT_LABELS).filter((k) => r.c2.byPlacement[k]), ...Object.keys(r.c2.byPlacement).filter((k) => !(k in PLACEMENT_LABELS))].map((k) => { const b = r.c2.byPlacement[k]; return `${PLACEMENT_LABELS[k] ?? k} ${b.prompts}·${b.differs}·${b.gain >= 0 ? '+' : ''}${b.gain}`; }).join(' / ')}.`,
    `일반화 한계: 영향 프롬프트는 저장소 ${r.c2.byRepo.repos}곳에 걸치지만, 판정 2 이득 ${r.c2.byRepo.totalGain}줄의 저장소별 몫은 [${r.c2.byRepo.gainByRepo.join(', ')}]이다. 이득이 가장 큰 저장소 하나(cwd 루트 ${r.c2.byRepo.largest?.cwdRoots ?? 0}곳 — 본체와 연결 worktree)에 영향 프롬프트 ${r.c2.byRepo.largest?.prompts ?? 0}개, 블록이 달라진 프롬프트 ${r.c2.byRepo.largest?.differs ?? 0}개, 이득 ${r.c2.byRepo.largest?.gain ?? 0}줄이 있다. ${r.c2.byRepo.withoutLargest.measurable ? `그 저장소를 뺀 프롬프트 ${r.c2.byRepo.withoutLargest.n}개의 판정2/프롬프트 Δ ${ci(r.c2.byRepo.withoutLargest)}.` : `그 저장소를 빼면 영향 프롬프트 ${r.c2.byRepo.withoutLargest.n}개(이득 ${r.c2.byRepo.withoutLargest.gain}줄)로 사전 등록 최소 ${THRESHOLDS.C2_min_affected}개에 못 미쳐 판정할 수 없다 — 다른 저장소에서의 효과는 이번 표본으로 말할 수 없다.`} 프롬프트 단위 부트스트랩이라 같은 cwd·저장소끼리의 상관은 반영하지 않는다(구간이 실제보다 좁을 수 있다).`,
    `결정: \`${d.C2.decision}\` — ${d.C2.reason ?? ''}`,
    '',
    '## C4 식별자 어휘 레인 (측정만, 운영 변경 없음)',
    '',
    `[kw] 줄 ${r.c4.kwLines}개 중 판정 2 ${r.c4.kwJ2}개(정밀도 ${fmt(r.c4.kwPrecisionJ2)}). 전체 판정2/프롬프트 Δ ${ci(r.c4.j2Delta)}. 우회 패턴 사실 선택 ${r.c4.bypassSelected}건(제외로 걸러진 것 ${r.c4.bypassSkipped}건).`,
    '',
    '## 하드 부분집합 (v0 가 0줄인 프롬프트에서 얻은 판정 2 줄)',
    '',
    '| 변형 | 판정 2 줄 | 판정 1 줄 | 판정 0 줄 |',
    '|---|---|---|---|',
    ...VARIANTS.map((vn) => `| ${vn} | ${r.hardLines[vn].j2} | ${r.hardLines[vn].j1} | ${r.hardLines[vn].j0} |`),
    '',
    '## 한계',
    '',
    '- 판정기는 LLM 이다. 사람 라벨이 아니고, 길이·언어 편향이 있을 수 있다. 대조군(V1·V2)과 재채점(V3)으로만 보정했다.',
    '- 판정 메시지 결속은 Agent SDK 경로의 바이트(판정 지시문 + 빈 줄 + 사용자 메시지)다. SDK 가 실패해 API 키 경로로 가면 같은 내용이 system 과 user 로 나뉘어 간다 — 내용은 같고 나뉜 자리만 다르다. 판정 호출 기록이 없는 그 경로의 행은 판정 때 기록한 결속만 있다.',
    '- 재생은 세션 원장(이미 보여 준 사실)을 재현하지 않는다. 비활성 전환은 복원하지 못한다(지금 상태로 읽음). 프롬프트 뒤에 문장이 바뀐 사실은 숨긴다 — 통합의 재작성은 벡터를 바꾸지 않아 행에는 그때의 벡터와 나중 문장이 짝지어 있고, 판정할 문장이 그때 보인 문장이 아니기 때문이다. 대상: 통합의 EVOLUTION(개정 행의 사실), CONTRADICTION 병합(개정 행의 새 문장을 지금 가진 다른 사실 — 병합 없이 새 사실 문장을 그대로 쓴 경우까지 숨겨 보수적).',
    '- 지워진 경로(cwd·사실 경로 모두)는 어느 저장소의 가족도 아니다 — 지워진 경로가 어느 저장소에 속했는지는 지금 디스크로 알 수 없어서다(다른 저장소였을 수 있다). 그래서 지운 worktree 에서 쓴 사실은 가족으로 들어오지 않고, cwd 가 지워진 프롬프트의 가족 효과는 재지 못한다. worktree 보관 폴더(`.claude/worktrees/`·`.auto-issue-worktrees/`) 안에서는 그 저장소의 연결 worktree 만 가족이다(보관 폴더가 다른 저장소의 worktree 를 담을 수 있다). 심링크를 거쳐 저장소에 닿는 경로(루트로 가는 링크 포함)도 가족 밖이다. bare 저장소(`.bare/worktrees/…`)의 worktree 끼리는 묶지 않는다(각자 한 가족).',
    '- 가족 판정은 재생할 때의 디스크(폴더·`.git`)를 읽고, 보고는 그 디스크 상태를 결속하지 않는다 — 재생 뒤 worktree 를 지우거나 만들면 같은 입력으로 다시 재생한 줄이 달라질 수 있다(재생이 cwd 마다 찾은 루트는 \`replay-meta.json\` 의 roots 에 남는다).',
    '- 판정 결속은 위조를 막는 서명이 아니다: 판정 파일·결속 파일·보존 호출 파일 셋을 맞춰 고치면 보고는 알아채지 못한다. 원래 대화 기록이 남아 있는 행만 그것과 대조된다.',
    '- 정렬은 ±180초 안의 가장 이른 행을 고르고 여러 행이 맞는 경우를 세지 않는다. 프롬프트 길이 비교는 UTF-16 길이(JS)와 코드포인트 수(SQLite)가 달라 이모지가 든 프롬프트는 빠진다.',
    '- 누출 검사는 정규화(NFC·소문자·공백 접기·마크다운 이스케이프 제거)한 원문 전체에서 20자 간격으로 뽑은 40자 창을 이 문서에서 찾는다 — 59자 이상 그대로 옮긴 인용은 반드시 잡는다. 더 짧은 인용·의역은 잡지 못한다.',
    '- 표본은 대화 색인에 남은 사람의 프롬프트다. 색인되지 않는 자동화 세션에 대한 결론이 아니다.',
    '',
    '## 결정 (기계 판독 — test/inject-select.test.ts 가 운영 상수와 대조)',
    '',
    decisionsBlock(d),
    '',
    `이 블록을 낸 \`report.json\` 의 sha256: \`${reportSha}\` (그 파일이 있으면 같은 테스트가 블록과 그 파일의 decisions 를 대조한다).`,
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  console.log(`wrote ${file}`);
}

// ------------------------------------------------------------------ leak check

function leakCheck() {
  const file = positional[0];
  if (!file) fail('--leak-check needs a file');
  const body = leakFold(fs.readFileSync(file, 'utf8'));
  const sample = readJson('sample.json');
  const db = new Database(path.join(OUT, 'snapshot.sqlite'), { readonly: true, fileMustExist: true });
  const judged = new Set(loadJudgments().flatMap((j) => (j.items ?? []).map((it) => it.factId)));
  const factText = db.prepare('SELECT fact FROM facts WHERE id = ?');
  const texts = [...sample.map((p) => p.query), ...[...judged].map((id) => factText.get(id)?.fact ?? '')];
  db.close();
  const probes = leakProbes(texts);
  const hits = probes.filter((p) => body.includes(p));
  console.log(JSON.stringify({ file, probes: probes.length, hits: hits.length }));
  process.exit(hits.length ? 1 : 0);
}

if (mode === '--smoke') await smoke();
else if (mode === '--judge') await judgeAll();
else if (mode === '--bind-legacy') await bindLegacy();
else if (mode === '--report') await report();
else leakCheck();

