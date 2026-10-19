import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { VARIANTS, codeDigest, judgeMessageSha, parseDecisionsBlock, sqliteDigest } from '../bench/inject-bench-lib.mjs';
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
function report(doc?: string) {
  const r = spawnSync(process.execPath, [SCRIPT, '--report', '--out', out, ...(doc ? ['--doc', doc] : [])], { encoding: 'utf8' });
  const file = path.join(out, 'report.json');
  return { status: r.status, stderr: r.stderr, report: r.status === 0 && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

const shared = (i: number): Line[] => (i < 5 ? [{ id: `h${i}`, origin: 'vec', note: '', margin: 0.2 }] : []);
const base = (i: number): Line[] => (HARD.includes(`q${i}`) ? [] : [{ id: `f${i}`, origin: 'vec', note: '', margin: 0.1 }, ...shared(i)]);
const familyLines = (i: number): Line[] => (i < 20 ? [...base(i), { id: `g${i}`, origin: 'vec', note: '', margin: 0.05 }] : base(i));
const bound = (i: number, items: Array<{ factId: string; kind: string }>, seed: string) => ({ seed, message: judgeMessageSha(promptOf(i), items, seed, judged) });

function makeFixture() {
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
  qids.forEach((qid, i) => rows.push(JSON.stringify({ qid, pass: 'main', model: 'test-model', scores: scoresOf(i), items: itemsOf(i), bound: bound(i, itemsOf(i), `${qid}:main:0`) })));
  // 30 re-judged prompts, same scores (agreement 1.0, ≥ 100 pairs).
  for (let i = 0; i < 30; i++) rows.push(JSON.stringify({ qid: `q${i}`, pass: 'rejudge', model: 'test-model', scores: scoresOf(i), items: itemsOf(i), bound: bound(i, itemsOf(i), `q${i}:rejudge`) }));
  fs.writeFileSync(path.join(out, 'judgments.jsonl'), rows.join('\n') + '\n');
  writeMeta();
  writeDeterminism();
}

beforeEach(makeFixture);
afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

describe('inject-judge --report (synthetic bench folder, valid harness)', () => {
  it('the registered reading decides C2 (keep) and the committed decisions block says so; the as-of reading decides nothing', () => {
    const doc = path.join(out, 'doc.md');
    const r = report(doc);
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
    expect(r.report.judge.binding).toEqual({ inline: 250, transcript: 0, unbound: 0, drifted: 0 });
    expect(r.report.judge.fillRows).toBe(0);
    const docText = fs.readFileSync(doc, 'utf8');
    expect(docText, 'the doc names the report it came from').toContain(`sha256: \`${sha(path.join(out, 'report.json'))}\``);
    expect(docText, 'every placement bucket the report holds is listed').toContain('가족 없음 40·20·+20');
    expect(r.report.inputs.sample).toBe(sha(path.join(out, 'sample.json')));
    expect(r.report.inputs.judgments).toBe(sha(path.join(out, 'judgments.jsonl')));
    const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src', 'bench', 'dist'], { encoding: 'utf8' }).trim();
    expect(r.report.inputs.code.report.dirty, 'the dirty flag is the working tree\'s').toBe(status !== '');
  });

  it('a row written before rows carried a binding counts through judgment-bindings.json (the --bind-legacy file) and only there', () => {
    const file = path.join(out, 'judgments.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const row = JSON.parse(lines[0]);
    const legacyLine = JSON.stringify({ ...row, bound: undefined });
    lines[0] = legacyLine;
    fs.writeFileSync(file, lines.join('\n') + '\n');
    expect(report().stderr, 'no binding anywhere').toMatch(/1 without a binding/);
    const key = crypto.createHash('sha256').update(legacyLine).digest('hex');
    fs.writeFileSync(path.join(out, 'judgment-bindings.json'), JSON.stringify({ version: 1, rows: { [key]: { ...row.bound, via: 'transcript' } } }));
    const r = report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding).toEqual({ inline: 249, transcript: 1, unbound: 0, drifted: 0 });
    expect(r.report.inputs.bindings).toBe(sha(path.join(out, 'judgment-bindings.json')));
  });

  it('V4 fails when either determinism run differs from the lines file the report reads — the harness is then invalid', () => {
    for (const side of ['a', 'b'] as const) {
      writeDeterminism({ family: { [side]: 'f'.repeat(64) } });
      const r = report();
      expect(r.status, r.stderr).toBe(0);
      expect(r.report.validity.gates.V4.pass, side).toBe(false);
      expect(r.report.decisions.production, side).toEqual({ relMargin: null, scopeFamily: false });
    }
  });

  it('lists made from other bytes, other code, unjudged lines or missing roots stop the report', () => {
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
        lines[3] = JSON.stringify({ ...JSON.parse(lines[3]), bound: undefined });
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
      makeFixture();
      expect(report().status, `${name}: positive control on a fresh folder`).toBe(0);
      mutate();
      const r = report();
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(message);
    }
  });
});
