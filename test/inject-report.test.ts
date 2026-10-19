import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { VARIANTS, codeDigest, parseDecisionsBlock, sqliteDigest } from '../bench/inject-bench-lib.mjs';

/**
 * `inject-judge.mjs --report` run end to end on a small synthetic bench folder (plan 2026-10-19):
 * a VALID harness (controls, 30 re-judged prompts, 110 held-out, 30 hard), so the decision itself is
 * asserted — which reading decides C2, what V4 is bound to, and which mismatched inputs stop the report.
 * 220 prompts; the family variant adds one grade-2 line to q0..q19. The registered reading lists
 * q0..q39 (40 prompts — keep), the post-hoc as-of reading q0..q19 (20 — below the minimum of 30).
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
    code: { git: null, dirty: null, files: codeDigest(REPO) },
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

const base = (i: number): Line[] => (HARD.includes(`q${i}`) ? [] : [{ id: `f${i}`, origin: 'vec', note: '', margin: 0.1 }]);
const familyLines = (i: number): Line[] => (i < 20 ? [...base(i), { id: `g${i}`, origin: 'vec', note: '', margin: 0.05 }] : base(i));

function makeFixture() {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-report-'));
  fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify(qids.map((qid, i) => ({
    qid, project: projectOf(i), split: i % 2 ? 'heldout' : 'train', query: `query ${i}`, ts: '2026-10-01T00:00:00Z', sessionId: `s${i}`,
  }))));
  const db = new Database(path.join(out, 'snapshot.sqlite'));
  db.exec('CREATE TABLE facts (id TEXT PRIMARY KEY, fact TEXT)');
  db.close();
  for (const v of VARIANTS) writeLines(v, qids.map((qid, i) => ({ qid, lines: v === 'family' ? familyLines(i) : base(i) })));
  // Main judgments: every shown line, plus one same-scope and one other-project control per prompt (all 0).
  const rows: string[] = [];
  const scoresOf = (i: number) => ({
    ...(HARD.includes(`q${i}`) ? {} : { [`f${i}`]: 1 }), ...(i < 20 ? { [`g${i}`]: 2 } : {}), [`cs${i}`]: 0, [`co${i}`]: 0,
  });
  const itemsOf = (i: number) => [
    ...(HARD.includes(`q${i}`) ? [] : [{ factId: `f${i}`, kind: 'line' }]), ...(i < 20 ? [{ factId: `g${i}`, kind: 'line' }] : []),
    { factId: `cs${i}`, kind: 'control_same' }, { factId: `co${i}`, kind: 'control_other' },
  ];
  qids.forEach((qid, i) => rows.push(JSON.stringify({ qid, pass: 'main', model: 'test-model', scores: scoresOf(i), items: itemsOf(i) })));
  // 30 re-judged prompts, same scores (agreement 1.0, ≥ 100 pairs).
  for (let i = 0; i < 30; i++) rows.push(JSON.stringify({ qid: `q${i}`, pass: 'rejudge', model: 'test-model', scores: scoresOf(i), items: itemsOf(i) }));
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
    expect(r.report.c2.byRepo.totalGain).toBe(20);
    expect(r.report.c2.byPlacement['no-family'].gain).toBe(20);
    expect(r.report.inputs.sample).toBe(sha(path.join(out, 'sample.json')));
    expect(r.report.inputs.judgments).toBe(sha(path.join(out, 'judgments.jsonl')));
    const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src', 'bench', 'dist'], { encoding: 'utf8' }).trim();
    expect(r.report.inputs.code.report.dirty, 'the dirty flag is the working tree\'s').toBe(status !== '');
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
      ['snapshot', () => { const db = new Database(path.join(out, 'snapshot.sqlite')); db.exec("INSERT INTO facts VALUES ('x', 'y')"); db.close(); }, /made from another snapshot/],
      ['row', () => {
        writeLines('kw', qids.slice(0, N - 1).map((qid, i) => ({ qid, lines: base(i) })));
        writeMeta();
        writeDeterminism();
      }, /lines files miss sampled prompts \(kw 1\)/],
      ['code', () => writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO), 'dist/project-family.js': '0'.repeat(64) } } }), /code changed since --replay \(dist\/project-family\.js\)/],
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
