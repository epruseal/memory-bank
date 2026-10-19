import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { VARIANTS } from '../bench/inject-bench-lib.mjs';

/**
 * `inject-judge.mjs --report` run end to end on a small synthetic bench folder (plan 2026-10-19):
 * which reading decides C2, what V4 is bound to, and which mismatched inputs stop the report.
 * 60 prompts; the family variant adds one grade-2 line to q0..q19. The registered reading lists
 * q0..q39 (40 prompts), the post-hoc as-of reading q0..q19 (20 — below the minimum of 30).
 */

const SCRIPT = fileURLToPath(new URL('../bench/inject-judge.mjs', import.meta.url));
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let out: string;

type Line = { id: string; origin: string; note: string; margin: number | null };
function writeLines(variant: string, rows: Array<{ qid: string; lines: Line[] }>) {
  fs.writeFileSync(path.join(out, `lines-${variant}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function writeMeta(patch: Record<string, unknown> = {}) {
  const hashes = Object.fromEntries(VARIANTS.map((v) => [v, sha(path.join(out, `lines-${v}.jsonl`))]));
  const meta = {
    prompts: 60, hard: [], kw: { identifiers: 0, picked: 0, bypassSkipped: 0 },
    affectedRegistered: Array.from({ length: 40 }, (_, i) => `q${i}`),
    affectedAsOf: Array.from({ length: 20 }, (_, i) => `q${i}`),
    hashes, inputs: { sample: sha(path.join(out, 'sample.json')), snapshot: sha(path.join(out, 'snapshot.sqlite')) }, ...patch,
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
function report() {
  const r = spawnSync(process.execPath, [SCRIPT, '--report', '--out', out], { encoding: 'utf8' });
  const file = path.join(out, 'report.json');
  return { status: r.status, stderr: r.stderr, report: r.status === 0 && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

function makeFixture() {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-report-'));
  const qids = Array.from({ length: 60 }, (_, i) => `q${i}`);
  fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify(qids.map((qid, i) => ({
    qid, project: `/no-such-root/proj-${i % 3}`, split: i % 2 ? 'heldout' : 'train', query: `query ${i}`, ts: '2026-10-01T00:00:00Z', sessionId: `s${i}`,
  }))));
  const db = new Database(path.join(out, 'snapshot.sqlite'));
  db.exec('CREATE TABLE facts (id TEXT PRIMARY KEY, fact TEXT)');
  db.close();
  const base = (i: number): Line[] => [{ id: `f${i}`, origin: 'vec', note: '', margin: 0.1 }];
  for (const v of VARIANTS) {
    writeLines(v, qids.map((qid, i) => ({ qid, lines: v === 'family' && i < 20 ? [...base(i), { id: `g${i}`, origin: 'vec', note: '', margin: 0.05 }] : base(i) })));
  }
  fs.writeFileSync(path.join(out, 'judgments.jsonl'), qids.map((qid, i) => JSON.stringify({
    qid, pass: 'main', model: 'test-model',
    scores: i < 20 ? { [`f${i}`]: 1, [`g${i}`]: 2 } : { [`f${i}`]: 1 },
    items: [{ factId: `f${i}`, kind: 'line' }, ...(i < 20 ? [{ factId: `g${i}`, kind: 'line' }] : [])],
  })).join('\n') + '\n');
  writeMeta();
  writeDeterminism();
}

beforeEach(makeFixture);
afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

describe('inject-judge --report (synthetic bench folder)', () => {
  it('C2 is computed on the registered reading; the as-of reading is reported beside it and decides nothing', () => {
    const r = report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.c2.affected).toBe(40);
    expect(r.report.c2.j2Delta.point).toBeCloseTo(20 / 40, 10);
    expect(r.report.c2.asOf.affected).toBe(20);
    expect(r.report.c2.asOf.j2Delta.point).toBeCloseTo(1, 10);
    expect(r.report.c2.asOf.decision, 'below the registered minimum').toBe('not-decidable');
    expect(r.report.c2.byRepo.totalGain).toBe(20);
    expect(r.report.validity.gates.V4.pass).toBe(true);
    expect(r.report.inputs.sample).toBe(sha(path.join(out, 'sample.json')));
    expect(r.report.inputs.judgments).toBe(sha(path.join(out, 'judgments.jsonl')));
  });

  it('V4 fails when either determinism run differs from the lines file the report reads', () => {
    for (const side of ['a', 'b'] as const) {
      writeDeterminism({ family: { [side]: 'f'.repeat(64) } });
      const r = report();
      expect(r.status, r.stderr).toBe(0);
      expect(r.report.validity.gates.V4.pass, side).toBe(false);
    }
  });

  it('a replay-meta made from other bytes stops the report: lines, sample, snapshot, or a prompt missing a row', () => {
    const cases: Array<[string, () => void, RegExp]> = [
      ['lines', () => writeMeta({ hashes: { ...writeMeta().hashes, kw: '0'.repeat(64) } }), /hashes do not match the lines files for kw/],
      ['sample', () => fs.appendFileSync(path.join(out, 'sample.json'), ' '), /made from another sample/],
      ['snapshot', () => { const db = new Database(path.join(out, 'snapshot.sqlite')); db.exec("INSERT INTO facts VALUES ('x', 'y')"); db.close(); }, /made from another snapshot/],
      ['row', () => {
        writeLines('kw', Array.from({ length: 59 }, (_, i) => ({ qid: `q${i}`, lines: [{ id: `f${i}`, origin: 'vec', note: '', margin: 0.1 }] })));
        writeMeta();
        writeDeterminism();
      }, /lines files miss sampled prompts \(kw 1\)/],
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
