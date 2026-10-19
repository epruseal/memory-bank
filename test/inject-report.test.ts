import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { VARIANTS, codeDigest, judgeMessage, judgeMessageSha, labelItems, parseDecisionsBlock, sqliteDigest } from '../bench/inject-bench-lib.mjs';
import { truncateFact } from '../src/fact-text.js';
import { EMBEDDING_MODEL } from '../src/embedding-version.js';

/**
 * `inject-judge.mjs --report` run end to end on a small synthetic bench folder (plan 2026-10-19):
 * a VALID harness (controls, 30 re-judged prompts, 110 held-out, 30 hard), so the decision itself is
 * asserted — which reading decides C2, what V4 is bound to, and which mismatched inputs stop the report.
 * 220 prompts; the family variant adds one grade-2 line to q0..q19. The registered reading lists
 * q0..q39 (40 prompts — keep), the post-hoc as-of reading q0..q19 (20 — below the minimum of 30).
 * q0..q4 also show a grade-2 line h<i> in both v0 and family (the gain is family minus v0, not family's count).
 * Every judgment row is bound to its judge message (seed + sha256), rebuilt from the snapshot's facts.
 */

const SCRIPT = fileURLToPath(new URL('../bench/inject-judge.mjs', import.meta.url));
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const N = 220;
const HARD = Array.from({ length: 30 }, (_, i) => `q${190 + i}`);
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let out: string;

type Line = { id: string; origin: string; note: string; margin: number | null };
const qids = Array.from({ length: N }, (_, i) => `q${i}`);
const projectOf = (i: number) => `/no-such-root/proj-${i % 3}`;
const promptOf = (i: number) => ({ qid: `q${i}`, project: projectOf(i), split: i % 2 ? 'heldout' : 'train', query: `query ${i}`, ts: '2026-10-01T00:00:00Z', sessionId: `s${i}` });
const factText = (id: string) => `note ${id} about the synthetic bench`;
const judged = (id: string) => `[decision] ${truncateFact(factText(id))}`;

function writeLines(variant: string, rows: Array<{ qid: string; lines: Line[] }>) {
  fs.writeFileSync(path.join(out, `lines-${variant}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function writeMeta(patch: Record<string, unknown> = {}) {
  const hashes = Object.fromEntries(VARIANTS.map((v) => [v, sha(path.join(out, `lines-${v}.jsonl`))]));
  const meta = {
    prompts: N, hard: HARD, kw: { identifiers: 0, picked: 0, bypassSkipped: 0 },
    affectedRegistered: qids.slice(0, 40), affectedAsOf: qids.slice(0, 20),
    hashes, inputs: { sample: sha(path.join(out, 'sample.json')), snapshot: sqliteDigest(path.join(out, 'snapshot.sqlite')) },
    roots: Object.fromEntries([0, 1, 2].map((i) => [projectOf(i), []])),
    code: { git: null, dirty: null, files: codeDigest(REPO, EMBEDDING_MODEL) },
    ...patch,
  };
  fs.writeFileSync(path.join(out, 'replay-meta.json'), JSON.stringify(meta));
  return meta;
}
function writeDeterminism(override: Record<string, { a?: string; b?: string }> = {}) {
  const variants = Object.fromEntries(VARIANTS.map((v) => {
    const h = sha(path.join(out, `lines-${v}.jsonl`));
    return [v, { a: override[v]?.a ?? h, b: override[v]?.b ?? h, lines: h, identical: true }];
  }));
  fs.writeFileSync(path.join(out, 'determinism.json'), JSON.stringify({ identical: true, variants }));
}
/**
 * Run the script without blocking this worker: a test here runs it a dozen times, and a worker whose event loop is
 * held that long misses vitest's RPC deadline. The transcripts it reads are the fixture's (never this machine's own).
 */
function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, TEST_PROJECTS_DIR: path.join(out, 'projects') } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
async function report(doc?: string) {
  const r = await run(['--report', '--out', out, ...(doc ? ['--doc', doc] : [])]);
  const file = path.join(out, 'report.json');
  return { status: r.status, stderr: r.stderr, report: r.status === 0 && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

const shared = (i: number): Line[] => (i < 5 ? [{ id: `h${i}`, origin: 'vec', note: '', margin: 0.2 }] : []);
const base = (i: number): Line[] => (HARD.includes(`q${i}`) ? [] : [{ id: `f${i}`, origin: 'vec', note: '', margin: 0.1 }, ...shared(i)]);
const familyLines = (i: number): Line[] => (i < 20 ? [...base(i), { id: `g${i}`, origin: 'vec', note: '', margin: 0.05 }] : base(i));
const bound = (i: number, items: Array<{ factId: string; kind: string }>, seed: string) => ({ seed, message: judgeMessageSha(promptOf(i), items, seed, judged) });
/** The judge's answer to a row: its items labelled with the seed, each given the row's score. */
const replyFor = (items: Array<{ factId: string; kind: string }>, scores: Record<string, number>, seed: string) =>
  JSON.stringify(labelItems(items.map((it) => ({ ...it, text: judged(it.factId) })), seed).map((it) => ({ id: it.label, score: scores[it.factId] })));
/** A judgment row as the judge writes it: binding and the reply it got. */
const judgedRow = (i: number, pass: string, items: Array<{ factId: string; kind: string }>, scores: Record<string, number>, seed: string) =>
  ({ qid: `q${i}`, pass, model: 'test-model', scores, items, bound: bound(i, items, seed), reply: replyFor(items, scores, seed) });
const NO_DRIFT = {
  unbound: 0, drifted: 0, noReply: 0, noCall: 0, badItems: 0, callReused: 0, transcriptMismatch: 0, unaccountedCalls: 0, malformedRows: 0, failedUnbound: 0, evidenceDrift: false,
};
type Item = { factId: string; kind: string };
/** The isolated LLM sessions' transcript folder of the fixture (one SDK query per file: the message, then the answer). */
const llmDir = () => path.join(out, 'projects', '-private-tmp-memory-bank-llm');
function recordCall(name: string, i: number, items: Item[], scores: Record<string, number>, seed: string, model = 'test-model') {
  const labeled = labelItems(items.map((it) => ({ ...it, text: judged(it.factId) })), seed);
  const reply = JSON.stringify(labeled.map((it) => ({ id: it.label, score: scores[it.factId] })));
  fs.mkdirSync(llmDir(), { recursive: true });
  fs.writeFileSync(path.join(llmDir(), name), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: judgeMessage(promptOf(i), labeled) } }),
    JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: reply }] } }),
  ].join('\n') + '\n');
}
const lastJson = (r: { stdout: string }) => JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
async function bind() {
  return run(['--bind-legacy', '--out', out]);
}
/** Bind every scored row (the fixture's calls are recorded); a run that leaves a row unbound is a fixture error. */
async function rebind() {
  const r = await bind();
  if (r.status !== 0) throw new Error(`--bind-legacy: ${r.stdout}${r.stderr}`);
  return r;
}
const rewrite = (file: string, n: number, change: (row: Record<string, any>) => Record<string, unknown>) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines[n] = JSON.stringify(change(JSON.parse(lines[n])));
  fs.writeFileSync(file, lines.join('\n') + '\n');
};

async function makeFixture() {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-report-'));
  fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify(qids.map((_, i) => promptOf(i))));
  const db = new Database(path.join(out, 'snapshot.sqlite'));
  db.exec('CREATE TABLE facts (id TEXT PRIMARY KEY, fact TEXT, category TEXT)');
  const ins = db.prepare("INSERT INTO facts VALUES (?, ?, 'decision')");
  for (let i = 0; i < N; i++) for (const k of ['f', 'g', 'h', 'cs', 'co']) ins.run(`${k}${i}`, factText(`${k}${i}`));
  db.close();
  for (const v of VARIANTS) writeLines(v, qids.map((qid, i) => ({ qid, lines: v === 'family' ? familyLines(i) : base(i) })));
  // Main judgments: every shown line, plus one same-scope and one other-project control per prompt (all 0).
  const rows: string[] = [];
  const scoresOf = (i: number) => ({
    ...(HARD.includes(`q${i}`) ? {} : { [`f${i}`]: 1 }), ...(i < 5 ? { [`h${i}`]: 2 } : {}), ...(i < 20 ? { [`g${i}`]: 2 } : {}), [`cs${i}`]: 0, [`co${i}`]: 0,
  });
  const itemsOf = (i: number) => [
    ...(HARD.includes(`q${i}`) ? [] : [{ factId: `f${i}`, kind: 'line' }]), ...(i < 5 ? [{ factId: `h${i}`, kind: 'line' }] : []),
    ...(i < 20 ? [{ factId: `g${i}`, kind: 'line' }] : []),
    { factId: `cs${i}`, kind: 'control_same' }, { factId: `co${i}`, kind: 'control_other' },
  ];
  const asked: Array<[number, string, Item[], Record<string, number>, string]> = qids.map((qid, i) => [i, 'main', itemsOf(i), scoresOf(i), `${qid}:main:0`]);
  // a fill-in row: the main pass re-asked one line of q7 alone (no controls); its score repeats the first one
  asked.push([7, 'main', [{ factId: 'f7', kind: 'line' }], { f7: 1 }, `q7:main:${itemsOf(7).length}`]);
  // 30 re-judged prompts, same scores (agreement 1.0, ≥ 100 pairs).
  for (let i = 0; i < 30; i++) asked.push([i, 'rejudge', itemsOf(i), scoresOf(i), `q${i}:rejudge`]);
  // every call is recorded (fx-<row>.jsonl) and every row bound to it, as --judge leaves them
  asked.forEach(([i, pass, items, scores, seed], n) => {
    rows.push(JSON.stringify(judgedRow(i, pass, items, scores, seed)));
    recordCall(`fx-${n}.jsonl`, i, items, scores, seed);
  });
  fs.writeFileSync(path.join(out, 'judgments.jsonl'), rows.join('\n') + '\n');
  writeMeta();
  writeDeterminism();
  await rebind();
}

beforeEach(makeFixture);
afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

describe('inject-judge --report (synthetic bench folder, valid harness)', () => {
  it('the registered reading decides C2 (keep) and the committed decisions block says so; the as-of reading decides nothing', async () => {
    const doc = path.join(out, 'doc.md');
    const r = await report(doc);
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.validity.valid, JSON.stringify(r.report.validity.gates)).toBe(true);
    expect(r.report.c2.affected).toBe(40);
    expect(r.report.c2.j2Delta.point).toBeCloseTo(20 / 40, 10);
    expect(r.report.c2.asOf.affected).toBe(20);
    expect(r.report.c2.asOf.decision, 'below the registered minimum').toBe('not-decidable');
    expect(r.report.decisions.C2.decision).toBe('keep');
    expect(r.report.decisions.production).toEqual({ relMargin: null, scopeFamily: true });
    expect(parseDecisionsBlock(fs.readFileSync(doc, 'utf8')), 'the doc block is the report\'s decision').toEqual({ verdict: 'valid', production: { relMargin: null, scopeFamily: true } });
    expect(r.report.c2.byRepo.totalGain, 'family minus v0 — q0..q4 show h<i> in both').toBe(20);
    expect(r.report.c2.byPlacement).toEqual({ 'no-family': { prompts: 40, differs: 20, gain: 20 } });
    // grouped by cwd (no roots): gains 7·7·6 over proj-0·proj-2·proj-1; without the largest, 26 prompts — below 30
    expect(r.report.c2.byRepo.gainByRepo).toEqual([7, 7, 6]);
    expect(r.report.c2.byRepo.largest).toEqual({ prompts: 14, differs: 7, gain: 7, cwdRoots: 1 });
    expect(r.report.c2.byRepo.withoutLargest).toEqual({ measurable: false, n: 26, gain: 13 });
    expect(r.report.c2.blockDiffers).toEqual({ prompts: 20, cwds: 3, repos: 3 });
    expect(r.report.judge.binding).toEqual({
      inline: 251, transcript: 0, retried: 0, transcriptChecked: 251, transcriptGone: 0, staleLines: 0, staleRows: 0,
      recordedJudgeCalls: 251, smokeCalls: 0, transcriptsFolder: true, ...NO_DRIFT,
    });
    expect(r.report.judge.fillRows, 'the q7 row without controls').toBe(1);
    expect(r.report.judge.promptsWithoutControls, 'q7 also has its first row with controls').toBe(0);
    const docText = fs.readFileSync(doc, 'utf8');
    expect(docText, 'the doc names the report it came from').toContain(`sha256: \`${sha(path.join(out, 'report.json'))}\``);
    expect(docText, 'every placement bucket the report holds is listed').toContain('가족 없음 40·20·+20');
    expect(r.report.inputs.sample).toBe(sha(path.join(out, 'sample.json')));
    expect(r.report.inputs.judgments).toBe(sha(path.join(out, 'judgments.jsonl')));
    const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src', 'bench', 'dist'], { encoding: 'utf8' }).trim();
    expect(r.report.inputs.code.report.dirty, 'the dirty flag is the working tree\'s').toBe(status !== '');
  });

  it('--bind-legacy binds every scored row to a recorded judge call with its message AND its scores, one call per row; the report checks the kept call again', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    // start over: nothing bound yet, rows 0 and 1 written before rows carried their own binding, their calls not found yet
    fs.rmSync(callsFile);
    fs.rmSync(bindingsFile);
    for (const n of [0, 1]) fs.rmSync(path.join(llmDir(), `fx-${n}.jsonl`));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const legacy = [0, 1].map((n) => { const row = JSON.parse(lines[n]); lines[n] = JSON.stringify({ ...row, bound: undefined, reply: undefined }); return row; });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect((await report()).stderr, 'no binding anywhere').toMatch(/251 without a binding/);
    const record = (name: string, n: number, scores = legacy[n].scores, model = 'test-model') => recordCall(name, n, legacy[n].items, scores, legacy[n].bound.seed, model);
    record('row0.jsonl', 0);
    record('row1-other-model.jsonl', 1, legacy[1].scores, 'another-model');
    record('row1-other-scores.jsonl', 1, { ...legacy[1].scores, cs1: 2 });
    const first = await bind();
    expect(first.status, 'row 1 has no call with its model and its scores').toBe(1);
    expect(lastJson(first)).toMatchObject({ withOwnBinding: 249, matched: 250, unmatchedScored: 1 });
    expect((await report()).stderr).toMatch(/1 without a binding/);
    record('row1.jsonl', 1);
    const second = await bind();
    expect(second.status, second.stderr).toBe(0);
    expect(lastJson(second)).toMatchObject({ kept: 250, matched: 1, unmatchedScored: 0 });
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding).toMatchObject({ inline: 249, transcript: 2, transcriptChecked: 251, transcriptGone: 0, ...NO_DRIFT });
    expect(r.report.inputs.bindings).toBe(sha(bindingsFile));
    expect(r.report.inputs.judgeCalls).toBe(sha(callsFile));
    const kept = fs.readFileSync(callsFile, 'utf8');
    const keptBindings = fs.readFileSync(bindingsFile, 'utf8');
    const keptLines = kept.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const shaOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
    const restore = () => { fs.writeFileSync(callsFile, kept); fs.writeFileSync(bindingsFile, keptBindings); };
    /** Rewrite the kept call of row 0 (and, for a consistent forgery, its binding and the evidence hash to match). */
    const forge = (call: Record<string, any>, consistent: boolean) => {
      const body = [call, ...keptLines.slice(1)].map((l) => JSON.stringify(l)).join('\n') + '\n';
      fs.writeFileSync(callsFile, body);
      if (!consistent) return;
      const doc = JSON.parse(keptBindings);
      const b = doc.rows[keptLines[0].key];
      b.call.messageSha = shaOf(call.message);
      b.call.replySha = shaOf(call.reply);
      b.call.model = call.model;
      b.call.file = call.file;
      doc.evidence.sha256 = shaOf(body);
      fs.writeFileSync(bindingsFile, JSON.stringify(doc));
    };
    const otherScore = (reply: string) => JSON.stringify(JSON.parse(reply).map((x: { id: string; score: number }, n: number) => (n === 0 ? { ...x, score: (x.score + 1) % 3 } : x)));
    const NOT_KEPT = /1 whose kept judge call is missing or does not give the row's scores/;
    forge({ ...keptLines[0], reply: otherScore(keptLines[0].reply) }, false);
    expect((await report()).stderr, 'the reply bytes differ from the ones bound — and the kept file from the one named').toMatch(/1 whose kept judge call is missing or does not give the row's scores, 0 whose score keys .*and judge-calls\.jsonl is not the file the bindings name/);
    forge({ ...keptLines[0], reply: otherScore(keptLines[0].reply) }, true);
    expect((await report()).stderr, 'a consistent forgery of the reply: its scores still differ from the row').toMatch(NOT_KEPT);
    forge({ ...keptLines[0], message: `${keptLines[0].message} (and one more thing)` }, true);
    expect((await report()).stderr, 'a consistent forgery of the message: not the message the row was judged on').toMatch(NOT_KEPT);
    forge({ ...keptLines[0], model: 'another-model' }, true);
    expect((await report()).stderr, 'another model answered').toMatch(NOT_KEPT);
    restore();   // the binding names the true call again: only the kept call's file name differs below
    forge({ ...keptLines[0], file: `${keptLines[0].file}.elsewhere` }, false);
    expect((await report()).stderr, 'the kept call is not the recording the binding names').toMatch(NOT_KEPT);
    forge({ ...keptLines[0], file: keptLines[1].file }, true);
    expect((await report()).stderr, 'one recorded call named as the answer to two rows').toMatch(/1 binding a call another row binds/);
    restore();
    fs.appendFileSync(callsFile, '\n');
    expect((await report()).stderr, 'the kept file is not the one the bindings name').toMatch(/judge-calls\.jsonl is not the file the bindings name/);
    restore();
    // the original transcript, while it is there, is checked against the kept call
    const row0 = path.join(llmDir(), 'row0.jsonl');
    const original = fs.readFileSync(row0, 'utf8');
    expect(original).toContain('"model":"test-model"');
    fs.writeFileSync(row0, original.replace('"model":"test-model"', '"model":"another-model"'));
    expect((await report()).stderr, 'the transcript now says something else').toMatch(/1 whose transcript differs from the kept call/);
    fs.writeFileSync(row0, original);
    // transcripts expire: once they are gone, --bind-legacy keeps the bindings whose kept calls still hold
    for (const f of fs.readdirSync(llmDir())) fs.rmSync(path.join(llmDir(), f));
    const third = await bind();
    expect(third.status, third.stderr).toBe(0);
    expect(lastJson(third)).toMatchObject({ transcripts: 0, keptOnly: 251, kept: 251, matched: 0, unmatchedScored: 0, keptUnbound: 0 });
    expect(fs.readFileSync(callsFile, 'utf8'), 'the kept calls are the same bytes').toBe(kept);
    const gone = await report();
    expect(gone.status, gone.stderr).toBe(0);
    expect(gone.report.judge.binding).toMatchObject({ inline: 249, transcript: 2, transcriptChecked: 0, transcriptGone: 251, recordedJudgeCalls: 0, ...NO_DRIFT });
    // with the bindings file gone too, the kept calls alone bind every row again (they are the only copy now)
    fs.rmSync(bindingsFile);
    const fourth = await bind();
    expect(fourth.status, fourth.stderr).toBe(0);
    expect(lastJson(fourth)).toMatchObject({ kept: 0, matched: 251, unmatchedScored: 0 });
    expect(fs.readFileSync(callsFile, 'utf8'), 'nothing lost').toBe(kept);
    expect((await report()).status).toBe(0);
    // the same row twice (an append repeated): its kept call answers one of them, the other stays unbound
    const judgedLines = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, judgedLines.split('\n')[0] + '\n');
    const dup = await bind();
    expect(dup.status, 'a duplicated row cannot take its call a second time').toBe(1);
    expect(lastJson(dup)).toMatchObject({ kept: 251, unmatchedScored: 1 });
    expect(fs.readFileSync(callsFile, 'utf8')).toBe(kept);
    // a row of a prompt no longer sampled is the report's to ignore, not a row left unbound
    fs.writeFileSync(file, judgedLines + JSON.stringify({ qid: 'q-gone', pass: 'main', model: 'test-model', items: [{ factId: 'f0', kind: 'line' }], scores: { f0: 1 } }) + '\n');
    const outside = await bind();
    expect(outside.status, outside.stderr).toBe(0);
    expect(lastJson(outside)).toMatchObject({ outOfSample: 1, unmatchedScored: 0 });
    // a row that can no longer be bound: the run fails, and every kept call stays in the file
    fs.writeFileSync(file, judgedLines);
    rewrite(file, 2, (row) => ({ ...row, bound: undefined, reply: undefined, scores: { ...row.scores, cs2: 2 } }));
    const fifth = await bind();
    expect(fifth.status).toBe(1);
    expect(lastJson(fifth)).toMatchObject({ unmatchedScored: 1, keptUnbound: 1 });
    const after = fs.readFileSync(callsFile, 'utf8');
    for (const l of kept.split('\n').filter(Boolean)) expect(after).toContain(l);
    fs.rmSync(callsFile);
    expect((await report()).stderr, 'a bindings file without its calls').toMatch(/1 without a binding, 0 whose message no longer matches .*250 whose kept judge call is missing/);
  });

  it('a row the judge wrote must carry the reply that gives its scores and items that are its score keys; no control is a line shown now', async () => {
    const cases: Array<[string, (row: Record<string, any>) => Record<string, unknown>, RegExp]> = [
      // a legacy row given an inline binding by hand: no reply behind it
      ['inline binding without a reply', (row) => ({ ...row, reply: undefined }), /1 judged rows without the reply that gives their scores/],
      ['reply with other scores', (row) => ({ ...row, reply: replyFor(row.items, { ...row.scores, cs3: 2 }, row.bound.seed) }), /1 judged rows without the reply/],
      ['scores changed, reply kept', (row) => ({ ...row, scores: { ...row.scores, cs3: 2 } }), /1 judged rows without the reply/],
      // the judgment file alone made consistent (scores, reply and binding agree): no recorded call gives these scores
      ['scores and reply changed together', (row) => ({ ...row, scores: { ...row.scores, cs3: 2 }, reply: replyFor(row.items, { ...row.scores, cs3: 2 }, row.bound.seed) }), /1 without a binding, 0 whose message/],
      ['a score key outside the items', (row) => ({ ...row, scores: { ...row.scores, g99: 2 } }), /1 whose score keys are not their items or whose controls are lines shown now/],
      ['an item without a score', (row) => {
        const { cs3: _cs3, ...scores } = row.scores;
        return { ...row, scores, reply: replyFor(row.items, { ...scores, cs3: 0 }, row.bound.seed) };
      }, /1 whose score keys are not their items/],
      ['a shown line relabelled as a control', (row) => {
        const items = row.items.map((it: { factId: string; kind: string }) => (it.factId === 'f3' ? { ...it, kind: 'control_same' } : it));
        return { ...row, items, bound: bound(3, items, row.bound.seed), reply: replyFor(items, row.scores, row.bound.seed) };
      }, /1 whose score keys are not their items or whose controls are lines shown now/],
    ];
    for (const [name, change, message] of cases) {
      fs.rmSync(out, { recursive: true, force: true });
      await makeFixture();
      expect((await report()).status, `${name}: positive control on a fresh folder`).toBe(0);
      rewrite(path.join(out, 'judgments.jsonl'), 3, change);
      const r = await report();
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(message);
    }
  });

  it('a line no variant shows now (judged for an earlier replay) is counted and named in the doc, never read as a line', async () => {
    // indistinguishable from a control relabelled as a line — the judge never sees kinds; the count makes it visible
    const file = path.join(out, 'judgments.jsonl');
    rewrite(file, 3, (row) => {
      const items = row.items.map((it: { factId: string; kind: string }) => (it.factId === 'cs3' ? { ...it, kind: 'line' } : it));
      return { ...row, items, bound: bound(3, items, row.bound.seed), reply: replyFor(items, row.scores, row.bound.seed) };
    });
    await rebind();   // the same call: kinds are not in the message
    const doc = path.join(out, 'doc.md');
    const r = await report(doc);
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding).toMatchObject({ staleLines: 1, staleRows: 1, ...NO_DRIFT });
    expect(r.report.judge.controls.same[1], 'one control fewer').toBe(N - 1);
    expect(fs.readFileSync(doc, 'utf8')).toContain('지금 어느 변형도 표시하지 않는 줄 항목 1개(1행)');
  });

  it('a row the judge wrote is bound with its own seed and message: another seed\'s call, or a call on other text, binds nothing', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    const shaOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
    const line3 = fs.readFileSync(file, 'utf8').split('\n')[3];
    const row = JSON.parse(line3);
    const key = shaOf(line3);
    // the bindings and kept calls rewritten together to a call of another seed (same items, same scores)
    const seed = 'q3:main:1';
    recordCall('other-seed.jsonl', 3, row.items, row.scores, seed);
    const message = judgeMessage(promptOf(3), labelItems(row.items.map((it: Item) => ({ ...it, text: judged(it.factId) })), seed));
    const reply = replyFor(row.items, row.scores, seed);
    const callFile = '-private-tmp-memory-bank-llm/other-seed.jsonl';
    const keptLines = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const body = keptLines.map((c) => JSON.stringify(c.key === key ? { key, file: callFile, message, reply, model: 'test-model' } : c)).join('\n') + '\n';
    fs.writeFileSync(callsFile, body);
    const doc = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    doc.rows[key] = { seed, message: shaOf(message), via: 'transcript', call: { file: callFile, messageSha: shaOf(message), replySha: shaOf(reply), model: 'test-model', retried: false } };
    doc.evidence.sha256 = shaOf(body);
    fs.writeFileSync(bindingsFile, JSON.stringify(doc));
    expect((await report()).stderr, 'the binding names another seed than the row recorded').toMatch(/0 without a binding, 1 whose message no longer matches/);
    // --bind-legacy: the row's text changed since it was judged, and a call on the new text gives its scores
    fs.rmSync(callsFile);
    fs.rmSync(bindingsFile);
    fs.rmSync(path.join(llmDir(), 'other-seed.jsonl'));
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten after the judge saw it' WHERE id = 'cs3'").run();
    db.close();
    writeMeta();
    // a call on the snapshot's new text, the row's seed and scores (recordCall labels with the fixture's own texts)
    const newText = (id: string) => (id === 'cs3' ? `[decision] ${truncateFact('rewritten after the judge saw it')}` : judged(id));
    const labeled = labelItems(row.items.map((it: Item) => ({ ...it, text: newText(it.factId) })), row.bound.seed);
    fs.writeFileSync(path.join(llmDir(), 'new-text.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: judgeMessage(promptOf(3), labeled) } }),
      JSON.stringify({ type: 'assistant', message: { model: 'test-model', content: [{ type: 'text', text: JSON.stringify(labeled.map((it) => ({ id: it.label, score: row.scores[it.factId] }))) }] } }),
    ].join('\n') + '\n');
    const r = await bind();
    expect(r.status, 'the row recorded the message it was judged on: a call on the new text is not its call').toBe(1);
    expect(lastJson(r), 'q3\'s main row and its re-judge row (cs3 is in both)').toMatchObject({ matched: 249, unmatchedScored: 2 });
  });

  it('V6 counts rows that are bound: a row neither scored nor failed, a failed row not bound to its message, or a judge call no row records stops the report', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const failedItems = [{ factId: 'f0', kind: 'line' }];
    const failedRow = { qid: 'q0', pass: 'main', model: 'test-model', at: '2026-10-19T00:00:00Z', items: failedItems, bound: bound(0, failedItems, 'q0:main:99'), failed: 'invalid reply' };
    fs.appendFileSync(file, JSON.stringify(failedRow) + '\n');
    const ok = await report();
    expect(ok.status, `positive control — a failed row bound to its message counts toward V6: ${ok.stderr}`).toBe(0);
    expect(ok.report.judge.failures).toBe(1);
    const judgments = () => path.join(out, 'judgments.jsonl');   // the folder is made again for each case
    const cases: Array<[string, () => void, RegExp]> = [
      ['an empty row (it would only grow the denominator)', () => fs.appendFileSync(judgments(), JSON.stringify({ qid: 'q0', pass: 'main', model: 'test-model' }) + '\n'), /1 rows neither scored nor failed/],
      ['a failed row without its message', () => fs.appendFileSync(judgments(), JSON.stringify({ ...failedRow, bound: undefined }) + '\n'), /1 failed rows not bound to the message they sent/],
      ['a failed row whose message is another', () => fs.appendFileSync(judgments(), JSON.stringify({ ...failedRow, bound: { ...failedRow.bound, message: 'e'.repeat(64) } }) + '\n'), /1 failed rows not bound/],
      ['a row removed while its call is on disk (the last re-judge row)', () => {
        const lines = fs.readFileSync(judgments(), 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(judgments(), lines.slice(0, -1).join('\n') + '\n');
      }, /1 recorded judge calls no row records/],
    ];
    for (const [name, mutate, message] of cases) {
      fs.rmSync(out, { recursive: true, force: true });
      await makeFixture();
      expect((await report()).status, `${name}: positive control on a fresh folder`).toBe(0);
      mutate();
      const r = await report();
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(message);
    }
  });

  it('the smoke call is told apart from judgment calls; a call the judge cut off before its row is not', async () => {
    // the smoke prompt and notes of inject-judge --smoke (one recorded call, no row)
    const smoke = labelItems([
      { factId: 'a', text: '[decision] Database migrations run through Flyway with versioned SQL files only' },
      { factId: 'b', text: '[note] The team lunch order on Fridays is kimchi stew' },
    ], 'smoke');
    fs.writeFileSync(path.join(llmDir(), 'smoke.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: judgeMessage({ project: '/tmp/inject-judge-smoke', query: 'Which tool do we use to run database migrations?' }, smoke) } }),
      JSON.stringify({ type: 'assistant', message: { model: 'test-model', content: [{ type: 'text', text: '[]' }] } }),
    ].join('\n') + '\n');
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding).toMatchObject({ recordedJudgeCalls: 252, smokeCalls: 1, unaccountedCalls: 0 });
    recordCall('cut-off.jsonl', 3, [{ factId: 'f3', kind: 'line' }], { f3: 1 }, 'q3:main:77');
    expect((await report()).stderr).toMatch(/1 recorded judge calls no row records/);
  });

  it('a judged prompt with no control in any scored main row is counted (V1/V2 then rest on fewer pairs)', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const row = JSON.parse(lines[9]);
    const items = row.items.filter((it: { kind: string }) => it.kind === 'line');
    const scores = Object.fromEntries(items.map((it: { factId: string }) => [it.factId, row.scores[it.factId]]));
    lines[9] = JSON.stringify(judgedRow(9, 'main', items, scores, row.bound.seed));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    // the call that made this row (its message has no controls) — the call for the old row is gone with it
    fs.rmSync(path.join(llmDir(), 'fx-9.jsonl'));
    recordCall('fx-9b.jsonl', 9, items, scores, row.bound.seed);
    await rebind();
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.promptsWithoutControls).toBe(1);
    expect(r.report.judge.controls.same[1], 'one prompt\'s control fewer').toBe(N - 1);
  });

  it('the Node version the replay ran on is recorded and shown, not compared — the report makes no lines', async () => {
    writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), node: 'v0.0.0 other-arch' } } });
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.inputs.code.bound.node).toBe('v0.0.0 other-arch');
    writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), 'dist/fact-text.js': '0'.repeat(64), node: 'v0.0.0 other-arch' } } });
    expect((await report()).stderr, 'every other file is still compared').toMatch(/code changed since --replay \(dist\/fact-text\.js\)/);
  });

  it('V4 fails when either determinism run differs from the lines file the report reads — the harness is then invalid', async () => {
    for (const side of ['a', 'b'] as const) {
      writeDeterminism({ family: { [side]: 'f'.repeat(64) } });
      const r = await report();
      expect(r.status, r.stderr).toBe(0);
      expect(r.report.validity.gates.V4.pass, side).toBe(false);
      expect(r.report.decisions.production, side).toEqual({ relMargin: null, scopeFamily: false });
    }
  });

  it('lists made from other bytes, other code, unjudged lines or missing roots stop the report', async () => {
    const cases: Array<[string, () => void, RegExp]> = [
      ['lines', () => writeMeta({ hashes: { ...writeMeta().hashes, kw: '0'.repeat(64) } }), /hashes do not match the lines files for kw/],
      ['sample', () => fs.appendFileSync(path.join(out, 'sample.json'), ' '), /made from another sample/],
      ['snapshot', () => { const db = new Database(path.join(out, 'snapshot.sqlite')); db.exec("INSERT INTO facts VALUES ('x', 'y', 'decision')"); db.close(); }, /made from another snapshot/],
      ['row', () => {
        writeLines('kw', qids.slice(0, N - 1).map((qid, i) => ({ qid, lines: base(i) })));
        writeMeta();
        writeDeterminism();
      }, /lines files miss sampled prompts \(kw 1\)/],
      ['code', () => writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), 'dist/fact-text.js': '0'.repeat(64) } } }), /code changed since --replay \(dist\/fact-text\.js\)/],
      ['model', () => writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), 'embedding-model': 'Other/model' } } }), /code changed since --replay \(embedding-model\)/],
      ['judged text', () => {
        const db = new Database(path.join(out, 'snapshot.sqlite'));
        db.prepare("UPDATE facts SET fact = 'rewritten after the judge saw it' WHERE id = 'f5'").run();
        db.close();
        writeMeta();   // the replay is re-bound to the new snapshot; the judgment of f5 is not
      }, /0 without a binding, 2 whose message no longer matches/],   // q5's main and re-judge rows
      ['unbound', () => {
        const file = path.join(out, 'judgments.jsonl');
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        lines[3] = JSON.stringify({ ...JSON.parse(lines[3]), bound: undefined, reply: undefined });
        fs.writeFileSync(file, lines.join('\n') + '\n');
      }, /1 without a binding, 0 whose message/],
      ['seed', () => {
        const file = path.join(out, 'judgments.jsonl');
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const row = JSON.parse(lines[7]);
        lines[7] = JSON.stringify({ ...row, bound: { ...row.bound, seed: 'q7:main:1' } });
        fs.writeFileSync(file, lines.join('\n') + '\n');
      }, /1 whose message no longer matches/],
      ['roots', () => writeMeta({ roots: {} }), /no family roots for 3 cwd/],
      ['unjudged', () => {
        writeLines('family', qids.map((qid, i) => ({ qid, lines: i === 5 ? [...familyLines(i), { id: 'never-judged', origin: 'vec', note: '', margin: 0 }] : familyLines(i) })));
        writeMeta();
        writeDeterminism();
      }, /1 prompt\(s\) have shown lines without a judgment/],
    ];
    for (const [name, mutate, message] of cases) {
      fs.rmSync(out, { recursive: true, force: true });
      await makeFixture();
      expect((await report()).status, `${name}: positive control on a fresh folder`).toBe(0);
      mutate();
      const r = await report();
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(message);
    }
  });
});
