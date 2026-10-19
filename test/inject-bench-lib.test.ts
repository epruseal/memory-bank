import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  THRESHOLDS, alignWindow, bootstrapDelta, decide, decideC2, decideC3, decisionsBlock, extractIdentifiers, foldSample,
  isBypassFact, kwLines, leakProbes, lostJ2Rel, makeAsOf, meanDelta, parseDecisionsBlock, perPromptCounts, aggregate,
  ratioDelta, searchedLogRows, splitOf, toEpoch, validateJudgeReply, validity, labelItems, leakFold, blockDiffers,
  buildFactIndex, repoOf, unboundMeta,
} from '../bench/inject-bench-lib.mjs';

/**
 * Pure rules of the injection replay bench (plan 2026-10-19). These decide the
 * report's numbers and the production defaults, so each path is pinned here:
 * sample selection, as-of visibility, judge-reply acceptance, the validity
 * gates and the pre-registered decision rules.
 */

const gate = (m: string) => (m.startsWith('<task-notification>') ? { reason: 'task-notification', query: '' } : m.length < 5 ? { reason: 'short', query: '' } : { reason: null, query: m });

describe('sample', () => {
  it('searchedLogRows keeps searched rows once per req_id and drops skipped / session-start / incomplete rows', () => {
    const rows = [
      { status: 'injected', project: '/p', prompt_len: 10, req_id: 'r1', via: 'daemon' },
      { status: 'no-match', project: '/p', prompt_len: 10, req_id: 'r1', via: 'fallback' },
      { status: 'skipped', project: '/p', prompt_len: 10 },
      { status: 'injected', project: '/p', via: 'session-start', prompt_len: 3 },
      { status: 'deduped', project: '', prompt_len: 10 },
      { status: 'error', project: '/q', prompt_len: 7 },
    ];
    expect(searchedLogRows(rows).map((r: { status: string }) => r.status)).toEqual(['injected', 'error']);
  });

  it('foldSample applies the current gate, drops synthetic turns, folds one query, counts every drop', () => {
    const aligned = [
      { project: '/p', ts: '2026-10-01T00:00:02Z', sessionId: 's1', exchangeId: 'e2', message: 'How do we deploy the billing service?' },
      { project: '/p', ts: '2026-10-01T00:00:01Z', sessionId: 's0', exchangeId: 'e1', message: 'How do we deploy the billing service?' },
      { project: '/p', ts: '2026-10-01T00:00:03Z', sessionId: 's1', exchangeId: 'e3', message: '<task-notification>x</task-notification>' },
      { project: '/p', ts: '2026-10-01T00:00:04Z', sessionId: 's1', exchangeId: 'e4', message: 'Base directory for this skill: /x\n\nDo things' },
      { project: '/p', ts: '2026-10-01T00:00:05Z', sessionId: 's1', exchangeId: 'e5', message: 'Stop hook feedback:\n[bash x] failed' },
    ];
    const { sample, dropped } = foldSample(aligned, gate);
    expect(sample).toHaveLength(1);
    expect(sample[0]).toMatchObject({ exchangeId: 'e1', sessionId: 's0', split: splitOf('How do we deploy the billing service?') });
    expect(dropped).toEqual({ gate: { 'task-notification': 1 }, synthetic: 2, duplicate: 1 });
  });

  it('alignWindow spans ±180 s and the last second’s milliseconds', () => {
    const [lo, hi] = alignWindow('2026-10-01T00:10:00.500Z');
    expect(lo).toBe('2026-10-01T00:07:00');
    expect(hi).toBe('2026-10-01T00:13:00.999Z');
    expect('2026-10-01T00:13:00.250Z' <= hi).toBe(true);
  });

  it('splitOf is fixed by the text and roughly halves', () => {
    expect(splitOf('abc')).toBe(splitOf('abc'));
    const n = Array.from({ length: 400 }, (_, i) => splitOf(`q${i}`)).filter((s) => s === 'train').length;
    expect(n).toBeGreaterThan(160);
    expect(n).toBeLessThan(240);
  });
});

describe('as-of', () => {
  const index = {
    factCreated: new Map([['old', toEpoch('2026-09-01T00:00:00Z')], ['new', toEpoch('2026-10-02T00:00:00Z')], ['mine', toEpoch('2026-09-01T00:00:00Z')]]),
    factSessions: new Map([['mine', new Set(['s1'])]]),
    factRevised: new Map<string, number>(),
  };
  const asOf = makeAsOf(index, { ts: '2026-10-01T00:00:00Z', sessionId: 's1' });
  it('hides a fact rewritten after the prompt (its text and vector are the later ones); an earlier rewrite is fine', () => {
    const idx = {
      ...index,
      factCreated: new Map([...index.factCreated, ['evolved', toEpoch('2026-09-01T00:00:00Z')], ['settled', toEpoch('2026-09-01T00:00:00Z')]]),
      factRevised: new Map([['evolved', toEpoch('2026-10-05T00:00:00Z')], ['settled', toEpoch('2026-09-15T00:00:00Z')]]),
    };
    const a = makeAsOf(idx, { ts: '2026-10-01T00:00:00Z', sessionId: 's9' });
    expect(a.visibleFactId('evolved')).toBe(false);
    expect(a.visibleFactId('settled')).toBe(true);
    expect(makeAsOf(idx, { ts: '2026-10-06T00:00:00Z', sessionId: 's9' }).visibleFactId('evolved')).toBe(true);
  });
  it('hides facts created after the prompt and facts extracted from the prompt’s own session', () => {
    expect(asOf.visibleFactId('old')).toBe(true);
    expect(asOf.visibleFactId('new')).toBe(false);
    expect(asOf.visibleFactId('mine')).toBe(false);
    expect(asOf.visibleFactId('unknown')).toBe(false);
    expect(makeAsOf(index, { ts: '2026-10-01T00:00:00Z', sessionId: 's2' }).visibleFactId('mine')).toBe(true);
  });
  it('a CONTRADICTION merge that rewrote the NEW fact counts as its rewrite (the revision row names the old fact)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE facts (id TEXT, fact TEXT, created_at TEXT);
             CREATE TABLE bench_fact_sessions (fact_id TEXT, session_id TEXT);
             CREATE TABLE fact_revisions (fact_id TEXT, new_fact TEXT, created_at TEXT);`);
    const fact = db.prepare('INSERT INTO facts VALUES (?, ?, ?)');
    fact.run('old', 'deploy target is heroku', '2026-09-01T00:00:00Z');
    fact.run('new', 'deploy target is vercel, merged', '2026-09-10T00:00:00Z');
    fact.run('later', 'deploy target is vercel, merged', '2026-10-10T00:00:00Z');
    fact.run('evolved', 'cache ttl is 60s', '2026-09-01T00:00:00Z');
    fact.run('other', 'unrelated sentence', '2026-09-01T00:00:00Z');
    const rev = db.prepare('INSERT INTO fact_revisions VALUES (?, ?, ?)');
    rev.run('old', 'deploy target is vercel, merged', '2026-10-05T00:00:00Z');
    rev.run('evolved', 'cache ttl is 60s', '2026-10-06T00:00:00Z');
    const idx = buildFactIndex(db);
    db.close();
    expect(idx.factRevised.get('old')).toBe(toEpoch('2026-10-05T00:00:00Z'));
    expect(idx.factRevised.get('new'), 'the merged text landed on the new fact').toBe(toEpoch('2026-10-05T00:00:00Z'));
    expect(idx.factRevised.has('later'), 'created after the revision — its text is its own').toBe(false);
    expect(idx.factRevised.get('evolved')).toBe(toEpoch('2026-10-06T00:00:00Z'));
    expect(idx.factRevised.has('other')).toBe(false);
    expect(makeAsOf(idx, { ts: '2026-10-01T00:00:00Z', sessionId: 's9' }).visibleFactId('new')).toBe(false);
    expect(makeAsOf(idx, { ts: '2026-10-07T00:00:00Z', sessionId: 's9' }).visibleFactId('new')).toBe(true);
  });
  it('compares relation times as instants — SQLite "YYYY-MM-DD HH:MM:SS" and ISO alike', () => {
    expect(asOf.visibleRelation({ created_at: '2026-09-30 23:59:59' })).toBe(true);
    expect(asOf.visibleRelation({ created_at: '2026-10-01 00:00:01' })).toBe(false);
    expect(asOf.visibleRelation({ created_at: '2026-10-01T00:00:00.000Z' })).toBe(true);
    expect(asOf.visibleRelation({ created_at: 'garbage' })).toBe(false);
  });
});

describe('kw lane', () => {
  it('extracts identifier-like tokens only, lowercased, without URLs or the project path', () => {
    const ids = extractIdentifiers('fix computeInjectResult in src/inject-core.ts and BASELINE_MARGIN for v1.7.8 see https://x.io/a_b', '/Users/me/proj');
    expect(ids).toEqual(['computeinjectresult', 'src/inject-core.ts', 'baseline_margin', 'v1.7.8']);
    expect(extractIdentifiers('please explain how deployment works here')).toEqual([]);
  });
  it('picks the rarest identifier’s facts, at most two, never a gate-bypass fact', () => {
    const f = (id: string, fact: string, at = '2026-09-01T00:00:00Z') => ({ id, fact, created_at: at });
    const matches = new Map([
      ['common_ident', Array.from({ length: 25 }, (_, i) => f(`c${i}`, 'x'))],
      ['rare_ident', [f('r1', 'reader_first_response_gate can be bypassed with READER_FIRST=0 environment variable'), f('r2', 'rare_ident lives in src/a.ts', '2026-09-02T00:00:00Z'), f('r3', 'rare_ident is old')]],
    ]);
    const { picked, bypassSkipped } = kwLines(['common_ident', 'rare_ident'], matches, ['r3']);
    expect(picked.map((x: { id: string }) => x.id)).toEqual(['r2']);
    expect(bypassSkipped).toBe(1);
    expect(isBypassFact('the push gate can be disabled with GATE=0')).toBe(true);
    expect(isBypassFact('the push gate runs the full suite')).toBe(false);
  });
});

describe('judge response', () => {
  const labels = ['f1', 'f2', 'f3'];
  it('accepts exactly the sent ids with scores 0/1/2', () => {
    const v = validateJudgeReply([{ id: 'f2', score: 0 }, { id: 'f1', score: 2 }, { id: 'f3', score: 1 }], labels);
    expect(v.ok).toBe(true);
    expect(Object.fromEntries(v.scores)).toEqual({ f1: 2, f2: 0, f3: 1 });
  });
  it.each([
    ['missing id', [{ id: 'f1', score: 2 }, { id: 'f2', score: 0 }]],
    ['extra id', [{ id: 'f1', score: 2 }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }, { id: 'f4', score: 1 }]],
    ['repeated id', [{ id: 'f1', score: 2 }, { id: 'f1', score: 2 }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }]],
    ['score 3', [{ id: 'f1', score: 3 }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }]],
    ['score as string', [{ id: 'f1', score: '2' }, { id: 'f2', score: 0 }, { id: 'f3', score: 1 }]],
    ['object not array', { f1: 2, f2: 0, f3: 1 }],
    ['null (non-JSON reply)', null],
  ])('rejects %s', (_name, parsed) => {
    expect(validateJudgeReply(parsed, labels).ok).toBe(false);
  });
  it('labelItems shuffles deterministically per seed and labels f1..fn', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ factId: `x${i}` }));
    const a = labelItems(items, 's').map((x: { factId: string }) => x.factId);
    expect(labelItems(items, 's').map((x: { factId: string }) => x.factId)).toEqual(a);
    expect(labelItems(items, 't').map((x: { factId: string }) => x.factId)).not.toEqual(a);
    expect(labelItems(items, 's').map((x: { label: string }) => x.label)).toEqual(items.map((_, i) => `f${i + 1}`));
  });
});

describe('metrics', () => {
  const lines = new Map([['q1', [{ id: 'a', origin: 'vec' }, { id: 'b', origin: 'rel' }]], ['q2', [{ id: 'c', origin: 'rel' }]], ['q3', []]]);
  const scores: Record<string, number> = { 'q1|a': 2, 'q1|b': 0, 'q2|c': 2 };
  const score = (q: string, id: string) => scores[`${q}|${id}`];
  it('counts lines by score and origin; a prompt with an unjudged line is dropped and listed', () => {
    const { counts, unjudged } = perPromptCounts(['q1', 'q2', 'q3'], lines, score);
    expect(counts.get('q1')).toMatchObject({ lines: 2, j2: 1, j0: 1, rel: 1, relJ0: 1 });
    expect(counts.get('q3')).toMatchObject({ lines: 0 });
    const r = perPromptCounts(['q1'], new Map([['q1', [{ id: 'zz', origin: 'vec' }]]]), score);
    expect(r.unjudged).toEqual(['q1']);
    const agg = aggregate([...counts.values()]);
    expect(agg).toMatchObject({ prompts: 3, lines: 3, j2: 2, rel: 2, precision_j2: 2 / 3, rel_precision_ge1: 0.5 });
    expect(unjudged).toEqual([]);
  });
  it('lostJ2Rel counts j2 relation lines the alternative no longer carries', () => {
    const alt = new Map([['q1', [{ id: 'a', origin: 'vec' }]], ['q2', []]]);
    expect(lostJ2Rel(['q1', 'q2'], lines, alt, score)).toBe(1);
  });
  it('bootstrap is seeded, brackets the point, and returns nulls on an undefined stat', () => {
    const pairs = Array.from({ length: 50 }, (_, i) => ({ base: { j2: 0, lines: 2 }, alt: { j2: i % 2, lines: 2 } }));
    const a = bootstrapDelta(pairs, meanDelta('j2'), { seed: 'x', B: 500 });
    expect(a).toEqual(bootstrapDelta(pairs, meanDelta('j2'), { seed: 'x', B: 500 }));
    expect(a.point).toBeCloseTo(0.5);
    expect(a.lo).toBeLessThanOrEqual(a.point);
    expect(a.hi).toBeGreaterThanOrEqual(a.point);
    expect(bootstrapDelta([], meanDelta('j2'))).toMatchObject({ point: null, lo: null });
    expect(ratioDelta('j2', 'lines')([{ base: { j2: 0, lines: 0 }, alt: { j2: 1, lines: 2 } }])).toBeNull();
  });
});

describe('validity', () => {
  const good = { controlSameJ2Rate: 0.05, controlOtherJ2Rate: 0.0, agreement: 0.9, agreementPairs: 150, rejudgePrompts: 30, deterministic: true, heldoutPrompts: 150, hardPrompts: 100, judgeCalls: 200, judgeFailures: 1 };
  it('passes when every gate holds', () => {
    expect(validity(good).valid).toBe(true);
  });
  it.each([
    ['V1', { controlSameJ2Rate: 0.11 }], ['V2', { controlOtherJ2Rate: 0.06 }], ['V3', { agreement: 0.84 }], ['V3', { agreementPairs: 99 }], ['V3', { rejudgePrompts: 29 }],
    ['V4', { deterministic: false }], ['V5', { heldoutPrompts: 99 }], ['V5', { hardPrompts: 29 }], ['V6', { judgeFailures: 5 }],
    ['V1', { controlSameJ2Rate: null }],
  ])('fails %s', (gateName, change) => {
    const v = validity({ ...good, ...change });
    expect(v.valid).toBe(false);
    expect(v.gates[gateName as 'V1'].pass).toBe(false);
  });
});

describe('decision', () => {
  const agg = (relPrec: number | null, rel: number, relJ2: number) => ({ rel_precision_ge1: relPrec, rel, relJ2 });
  const st = (relPrec: number | null, lost: number, hi: number | null = -0.1, rel = 100, relJ2 = 20) =>
    ({ agg: agg(relPrec, rel, relJ2), lostJ2Rel: lost, relJ0Delta: { point: hi === null ? null : hi - 0.05, lo: hi === null ? null : hi - 0.1, hi } });
  const base = (over: Record<string, unknown> = {}) => ({
    train: { v0: st(0.5, 0), rel020: st(0.55, 1), rel030: st(0.62, 2), rel045: st(0.8, 9), ...over },
    heldout: { v0: st(0.5, 0), rel020: st(0.55, 0), rel030: st(0.6, 1, -0.05), rel045: st(0.8, 5) },
  });
  it('C3 keep: the smallest margin passing the train rule, confirmed on held-out', () => {
    const d = decideC3(base());
    expect(d).toMatchObject({ decision: 'keep', relMargin: 0.03 });
  });
  it('C3 reject on train: no margin gains 10pp without losing more than 10% of j2 relation lines', () => {
    const d = decideC3(base({ rel030: st(0.62, 3), rel045: st(0.8, 9) }));
    expect(d.decision).toBe('reject');
    expect(d.relMargin).toBeNull();
  });
  it('C3 reject on held-out: CI upper bound not below zero', () => {
    const s = base();
    s.heldout.rel030 = st(0.6, 1, 0.01);
    expect(decideC3(s)).toMatchObject({ decision: 'reject', relMargin: null });
  });
  it('C3 not decidable without relation lines', () => {
    const s = base();
    s.train.v0 = st(null, 0, -0.1, 0, 0);
    expect(decideC3(s).decision).toBe('not-decidable');
  });
  it('C2 keep / reject / not-decidable', () => {
    const ci = (lo: number) => ({ point: lo + 0.1, lo, hi: lo + 0.2 });
    expect(decideC2({ affected: 40, j2Delta: ci(0.01), precisionJ2Delta: ci(-0.04) })).toMatchObject({ decision: 'keep', scopeFamily: true });
    expect(decideC2({ affected: 40, j2Delta: ci(-0.01), precisionJ2Delta: ci(0) })).toMatchObject({ decision: 'reject', scopeFamily: false });
    expect(decideC2({ affected: 40, j2Delta: ci(0.1), precisionJ2Delta: ci(-0.06) })).toMatchObject({ decision: 'reject', scopeFamily: false });
    expect(decideC2({ affected: THRESHOLDS.C2_min_affected - 1, j2Delta: ci(1), precisionJ2Delta: ci(0) })).toMatchObject({ decision: 'not-decidable', scopeFamily: false });
  });
  it('an invalid harness decides nothing: production stays current', () => {
    const d = decide(false, { decision: 'keep', relMargin: 0.03 }, { decision: 'keep', scopeFamily: true });
    expect(d.verdict).toBe('invalid');
    expect(d.production).toEqual({ relMargin: null, scopeFamily: false });
    expect(decide(true, { decision: 'keep', relMargin: 0.03 }, { decision: 'reject', scopeFamily: false }).production).toEqual({ relMargin: 0.03, scopeFamily: false });
  });
  it('the decisions block round-trips through the committed markdown', () => {
    const d = decide(true, { decision: 'keep', relMargin: 0.045 }, { decision: 'reject', scopeFamily: false });
    const md = `# x\n\n${decisionsBlock(d)}\n`;
    expect(parseDecisionsBlock(md)).toEqual({ verdict: 'valid', production: { relMargin: 0.045, scopeFamily: false } });
    expect(parseDecisionsBlock('no block')).toBeNull();
  });
  it('leak probes are folded 40-char windows every 20 chars over the whole text — every 59-char run holds one', () => {
    expect(leakProbes(['  How   do we deploy the billing service to production today please', 'short'])[0])
      .toBe('how do we deploy the billing service to');
    expect(leakProbes(['short'])).toEqual([]);
    const long = Array.from({ length: 600 }, (_, i) => String.fromCharCode(0x4e00 + i)).join(''); // no window repeats
    const probes = leakProbes([long]);
    expect(probes.length).toBe(30);
    for (let i = 0; i + 59 <= long.length; i++) expect(probes.some((w) => long.slice(i, i + 59).includes(w)), `offset ${i}`).toBe(true);
    expect(probes.some((w) => w.endsWith(long.slice(-5))), 'windows reach the end of the text').toBe(true);
  });
  it('--check-determinism without lines files names the run order instead of crashing', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-det-'));
    try {
      const script = fileURLToPath(new URL('../bench/inject-replay.mjs', import.meta.url));
      const r = spawnSync(process.execPath, [script, '--check-determinism', '--out', out], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/run --replay first \(order: --build → --replay → --check-determinism\)/);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
  it('the report decides C2 on the registered reading and refuses meta lists of other bytes (scripts pinned)', () => {
    const judge = fs.readFileSync(fileURLToPath(new URL('../bench/inject-judge.mjs', import.meta.url)), 'utf8');
    const replay = fs.readFileSync(fileURLToPath(new URL('../bench/inject-replay.mjs', import.meta.url)), 'utf8');
    expect(judge).toContain('const unbound = unboundMeta(meta.hashes, lineSha);\n  if (unbound.length) fail(');
    expect(judge).toContain('const affected = usable(meta.affectedRegistered);\n  const c2stats = c2For(affected);');
    expect(judge).toContain('const c2 = decideC2(c2stats);');
    expect(judge, 'grouped by repository, not by worktree').toContain('const repoOfQ = (q) => repoOf(resolveRepoRoots(projectOf.get(q)), projectOf.get(q));');
    expect(replay).toContain('if (widened(p.project).length > 0) { affected.add(p.qid); meta.affectedRegistered.push(p.qid); }');
  });
  it('repoOf groups a linked worktree with its repository; unboundMeta names variants whose meta hash differs', () => {
    expect(repoOf(['/r/.wt/a', '/r'], '/r/.wt/a/src')).toBe('/r');
    expect(repoOf(['/r'], '/r/docs')).toBe('/r');
    expect(repoOf([], '/x')).toBe('/x');
    expect(unboundMeta({ v0: 'a', family: 'b' }, { v0: 'a', family: 'c', kw: 'd' })).toEqual(['family', 'kw']);
    expect(unboundMeta(undefined, { v0: 'a' })).toEqual(['v0']);
    expect(unboundMeta({ v0: 'a' }, { v0: 'a' })).toEqual([]);
  });
  it('leak fold catches a copy that differs in case, Unicode form, markdown escapes or spacing', () => {
    const fact = 'Release notes are written in Korean — 릴리즈 노트는 한국어로 쓴다 and attached to the GitHub release';
    const copy = `> release NOTES are written in korean — ${'릴리즈 노트는 한국어로 쓴다'.normalize('NFD')} and attached to the GitHub\\_release`;
    const body = leakFold(copy);
    expect(leakProbes([fact]).some((w) => body.includes(w))).toBe(true);
    expect(leakProbes(['A completely different sentence about lunch menus on Fridays']).some((w) => body.includes(w))).toBe(false);
  });
  it('blockDiffers lists prompts whose shown ids differ', () => {
    const a = new Map([['q1', [{ id: 'x' }]], ['q2', [{ id: 'x' }, { id: 'y' }]]]);
    const b = new Map([['q1', [{ id: 'x' }]], ['q2', [{ id: 'y' }, { id: 'x' }]], ['q3', [{ id: 'z' }]]]);
    expect(blockDiffers(['q1', 'q2', 'q3', 'q4'], a, b)).toEqual(['q2', 'q3']);
  });
});
