#!/usr/bin/env node
// Injection replay bench — LLM judge and report (plan docs/plans/2026-10-19-memorilla-applicability.md).
//
//   node bench/inject-judge.mjs --smoke                     one isolated judge call; proves it leaves no trace
//   node bench/inject-judge.mjs --judge [--model M] [--concurrency N] [--limit N]
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
  CONTROL_PER_KIND, JUDGE_SYSTEM, REJUDGE_PROMPTS, VARIANTS, aggregate, bootstrapDelta, decide, decideC2,
  decideC3, decisionsBlock, judgeUserMessage, labelItems, leakProbes, lostJ2Rel, meanDelta, perPromptCounts, ratioDelta,
  seededRandom, validateJudgeReply, validity, makeAsOf, isBypassFact, buildFactIndex,
} from './inject-bench-lib.mjs';

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
    flags: ['--smoke', '--judge', '--report', '--leak-check'],
  });
} catch (e) {
  console.error(`inject-judge: ${e.message}`);
  process.exit(2);
}
const modes = ['--smoke', '--judge', '--report', '--leak-check'].filter((m) => args.flags.has(m));
if (modes.length !== 1) { console.error('inject-judge: give exactly one of --smoke, --judge, --report, --leak-check'); process.exit(2); }
const mode = modes[0];
try {
  assertOnlyArgs(args, {
    '--smoke': ['--smoke', '--model', '--db'],
    '--judge': ['--judge', '--out', '--model', '--concurrency', '--limit'],
    '--report': ['--report', '--out', '--doc'],
    '--leak-check': ['--leak-check', '--out'],
  }[mode], mode);
} catch (e) { console.error(`inject-judge: ${e.message}`); process.exit(2); }

const OUT = path.resolve(args.values['--out'] ?? path.join(REPO, '.bench-out', 'inject-replay'));
const MODEL = args.values['--model'] ?? 'claude-sonnet-5-5';
const JUDGMENTS = path.join(OUT, 'judgments.jsonl');
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
    if (v.ok) return v;
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

function loadJudgments() {
  if (!fs.existsSync(JUDGMENTS)) return [];
  const out = [];
  for (const line of fs.readFileSync(JUDGMENTS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail of an interrupted append — that call is redone */ }
  }
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
  for (const j of prior) if (j.pass === 'main' && j.items) items.set(j.qid, [...(items.get(j.qid) ?? []), ...j.items]);

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
  const crypto = await import('node:crypto');
  const judgedQids = sample.filter((p) => items.has(p.qid) || tasks.some((t) => t.prompt.qid === p.qid));
  const rejudgeSet = [...judgedQids].sort((a, b) => crypto.createHash('sha256').update(`${a.qid}:rejudge`).digest('hex')
    .localeCompare(crypto.createHash('sha256').update(`${b.qid}:rejudge`).digest('hex'))).slice(0, REJUDGE_PROMPTS);

  const selected = tasks.slice(0, limit);
  let done = 0;
  let failed = 0;
  const append = (rec) => fs.appendFileSync(JUDGMENTS, JSON.stringify(rec) + '\n');
  const run = async (task) => {
    const labeled = labelItems(task.want.map((w) => ({ ...w, text: text(w.factId) })), task.seed);
    const reply = await judgeCall(task.prompt, labeled);
    if (reply.ok) {
      append({ qid: task.prompt.qid, pass: task.pass, model: MODEL, at: new Date().toISOString(), items: task.want,
        scores: Object.fromEntries(labeled.map((it) => [it.factId, reply.scores.get(it.label)])) });
    } else {
      failed++;
      append({ qid: task.prompt.qid, pass: task.pass, model: MODEL, at: new Date().toISOString(), items: task.want, failed: reply.reason });
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

// ------------------------------------------------------------------ report

const fmt = (x, d = 3) => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toFixed(d) : String(x));
const ci = (c) => (c.point === null ? '—' : `${fmt(c.point)} [${fmt(c.lo)}, ${fmt(c.hi)}]`);

async function report() {
  const { sample, meta, lines } = await loadBench();
  const judgments = loadJudgments();
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
  // agreement (V3)
  let agree = 0;
  let pairs = 0;
  for (const j of judgments.filter((x) => x.pass === 'rejudge' && x.scores)) {
    for (const [id, s] of Object.entries(j.scores)) {
      const m = score(j.qid, id);
      if (m === undefined) continue;
      pairs++;
      if (m === s) agree++;
    }
  }
  const det = fs.existsSync(path.join(OUT, 'determinism.json')) ? readJson('determinism.json') : null;
  const bySplit = { train: sample.filter((p) => p.split === 'train').map((p) => p.qid), heldout: sample.filter((p) => p.split === 'heldout').map((p) => p.qid) };
  bySplit.all = [...bySplit.train, ...bySplit.heldout];

  const counts = {};
  const unjudged = new Set();
  for (const v of VARIANTS) {
    const r = perPromptCounts(bySplit.all, lines[v], score);
    counts[v] = r.counts;
    r.unjudged.forEach((q) => unjudged.add(q));
  }
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
  const affected = usable(meta.affected);
  const c2stats = {
    affected: affected.length,
    j2Delta: bootstrapDelta(pairsOf(affected, 'family'), meanDelta('j2'), { seed: 'c2:j2' }),
    precisionJ2Delta: bootstrapDelta(pairsOf(affected, 'family'), ratioDelta('j2', 'lines'), { seed: 'c2:pj2' }),
  };
  const hard = usable(meta.hard);
  const hardGain = Object.fromEntries(VARIANTS.map((v) => [v, hard.reduce((t, q) => t + counts[v].get(q).j2, 0)]));
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
    agreement: pairs ? agree / pairs : null, agreementPairs: pairs,
    deterministic: det ? det.identical === true : false,
    heldoutPrompts: usable(bySplit.heldout).length, hardPrompts: hard.length,
    judgeCalls: calls, judgeFailures: failures,
  });
  const c3 = decideC3(stats);
  const c2 = decideC2(c2stats);
  const decisions = decide(v.valid, c3, c2);
  const result = {
    generatedAt: new Date().toISOString(), model,
    sample: { distinct: sample.length, train: bySplit.train.length, heldout: bySplit.heldout.length, unjudged: unjudged.size, hard: hard.length, affected: affected.length },
    judge: { calls, failures, controls: { same: ctrl.control_same, other: ctrl.control_other }, agreement: { agree, pairs } },
    validity: v, stats, c2: c2stats, c4, hardGain, decisions,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(result, null, 1) + '\n');
  console.log(JSON.stringify({ verdict: decisions.verdict, validity: Object.fromEntries(Object.entries(v.gates).map(([k, g]) => [k, g.pass])), C3: c3.decision, C2: c2.decision, production: decisions.production }));
  if (args.values['--doc']) writeDoc(path.resolve(REPO, args.values['--doc']), result);
}

function writeDoc(file, r) {
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
    `서로 다른 프롬프트 ${r.sample.distinct}개(train ${r.sample.train} · held-out ${r.sample.heldout}). 판정 실패로 빠진 프롬프트 ${r.sample.unjudged}개. 하드 부분집합(v0 가 0줄) ${r.sample.hard}개. 가족 scope 영향 프롬프트 ${r.sample.affected}개.`,
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
    `판정 호출 ${r.judge.calls}회, 실패 ${r.judge.failures}회. 대조군 판정 2: 같은 scope ${r.judge.controls.same[0]}/${r.judge.controls.same[1]}, 다른 프로젝트 ${r.judge.controls.other[0]}/${r.judge.controls.other[1]}. 재채점 일치 ${r.judge.agreement.agree}/${r.judge.agreement.pairs}.`,
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
    `영향 프롬프트 ${r.c2.affected}개(두 분할 합침). 판정2/프롬프트 Δ ${ci(r.c2.j2Delta)} · 정밀도(=2) Δ ${ci(r.c2.precisionJ2Delta)}.`,
    `결정: \`${d.C2.decision}\` — ${d.C2.reason ?? ''}`,
    '',
    '## C4 식별자 어휘 레인 (측정만, 운영 변경 없음)',
    '',
    `[kw] 줄 ${r.c4.kwLines}개 중 판정 2 ${r.c4.kwJ2}개(정밀도 ${fmt(r.c4.kwPrecisionJ2)}). 전체 판정2/프롬프트 Δ ${ci(r.c4.j2Delta)}. 우회 패턴 사실 선택 ${r.c4.bypassSelected}건(제외로 걸러진 것 ${r.c4.bypassSkipped}건).`,
    '',
    '## 하드 부분집합 (v0 가 0줄인 프롬프트에서 얻은 판정 2 줄)',
    '',
    '| 변형 | 판정 2 줄 |',
    '|---|---|',
    ...VARIANTS.map((vn) => `| ${vn} | ${r.hardGain[vn]} |`),
    '',
    '## 한계',
    '',
    '- 판정기는 LLM 이다. 사람 라벨이 아니고, 길이·언어 편향이 있을 수 있다. 대조군(V1·V2)과 재채점(V3)으로만 보정했다.',
    '- 재생은 세션 원장(이미 보여 준 사실)을 재현하지 않는다. 비활성 전환·문장 갱신 이력도 복원하지 못한다(지금 상태로 읽음).',
    '- 표본은 대화 색인에 남은 사람의 프롬프트다. 색인되지 않는 자동화 세션에 대한 결론이 아니다.',
    '',
    '## 결정 (기계 판독 — test/inject-select.test.ts 가 운영 상수와 대조)',
    '',
    decisionsBlock(d),
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
  const body = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
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
else if (mode === '--report') await report();
else leakCheck();

