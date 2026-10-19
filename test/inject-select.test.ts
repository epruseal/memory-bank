import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';

/**
 * selectInjectFacts (plan 2026-10-19): the selection the live hook and the
 * replay bench share. Real embedding model + temp DB, like inject-core.test.ts —
 * mocked vectors cannot show which neighbours a real margin keeps.
 */

const restoreConsole = suppressConsole();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-inject-select-')));
const prevEnv = { ...process.env };
const PROJECT = path.join(tmp, 'repo', 'docs');
const REPO = path.join(tmp, 'repo');

let sel: typeof import('../src/inject-select.js');
let embed: typeof import('../src/embeddings.js');
let factDb: typeof import('../src/fact-db.js');
let onto: typeof import('../src/ontology-db.js');
let dbMod: typeof import('../src/db.js');
let db: import('better-sqlite3').Database;

const ids: Record<string, string> = {};

async function add(key: string, text: string, opts: { scope?: string | null; kr?: string; noVector?: boolean } = {}) {
  ids[key] = factDb.insertFact(db, {
    fact: text, category: 'decision',
    scope_type: opts.scope ? 'project' : 'global', scope_project: opts.scope ?? null,
    source_exchange_ids: [],
    embedding: opts.noVector ? null : await embed.generateEmbedding(text, 'passage'),
    ...(opts.kr ? { fact_kr: opts.kr, embedding_kr: await embed.generateEmbedding(opts.kr, 'passage') } : {}),
  });
}

async function queryVec(q: string) {
  const e = await embed.generateEmbedding(q, 'query');
  return { e, baseline: await embed.queryBaseline(e) };
}

const QUERY = 'Which tool runs our database migrations and in what file format?';

beforeAll(async () => {
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.TEST_DB_PATH = path.join(tmp, 'test.db');
  for (const repo of [REPO, `${REPO}-cloud`]) {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }
  fs.mkdirSync(PROJECT, { recursive: true });
  sel = await import('../src/inject-select.js');
  embed = await import('../src/embeddings.js');
  factDb = await import('../src/fact-db.js');
  onto = await import('../src/ontology-db.js');
  dbMod = await import('../src/db.js');
  await embed.initEmbeddings();
  db = dbMod.initDatabase();
  await add('seed', 'Database migrations run through Flyway with versioned SQL files only');
  await add('near', 'Each Flyway migration file is named V<number>__description.sql and is never edited after merge');
  await add('far', 'Our team lunch order on Fridays is usually kimchi stew from the place downstairs');
  await add('contra', 'The office plants are watered on Monday mornings by whoever arrives first');
  await add('novec', 'Schema changes are reviewed by the platform team before the migration is merged', { noVector: true });
  await add('krnear', 'The parking garage closes at midnight on weekdays', { kr: '데이터베이스 마이그레이션은 Flyway 의 버전별 SQL 파일로만 실행한다' });
  onto.createRelation(db, ids.seed, 'SUPPORTS', ids.near);
  onto.createRelation(db, ids.seed, 'SUPPORTS', ids.far);
  onto.createRelation(db, ids.seed, 'CONTRADICTS', ids.contra);
  onto.createRelation(db, ids.seed, 'SUPPORTS', ids.novec);
  onto.createRelation(db, ids.seed, 'INFLUENCES', ids.krnear);
  // repo-family fixture: a fact scoped to the repo root, queried from its docs/ folder
  await add('rootfact', 'Release builds of this repository are signed with the hardware key kept by the release manager', { scope: REPO });
  // a sibling repository whose name extends REPO's — must never reach REPO's family
  await add('sibfact', 'Release builds of the cloud repository are signed with a hardware key kept in the office safe', { scope: `${REPO}-cloud` });
}, 180_000);

afterAll(() => {
  db?.close();
  process.env = prevEnv;
  restoreConsole();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('selectInjectFacts', () => {
  it('options off match the reference algorithm (KNN → baseline gate → 1-hop of the first three, ≤8)', async () => {
    const { e, baseline } = await queryVec(QUERY);
    const got = sel.selectInjectFacts(db, e, baseline, PROJECT, { relMargin: null, scopeFamily: false });
    // Reference: the pre-2026-10-19 inline pipeline, written out independently.
    const cands = factDb.searchSimilarFacts(db, e, PROJECT, sel.TOP_K, 0);
    const gated = cands.filter((r) => dbMod.l2DistanceToSimilarity(r.distance) - baseline >= sel.BASELINE_MARGIN);
    const seen = new Set(gated.map((r) => r.fact.id));
    const want = gated.map((r) => `${r.fact.id}|`);
    for (const { fact } of gated.slice(0, 3)) {
      for (const { fact: f, relation } of onto.getRelatedFacts(db, fact.id, 1, 0.6, 0.2, PROJECT)) {
        if (!seen.has(f.id) && want.length < sel.MAX_CONTEXT_FACTS) { seen.add(f.id); want.push(`${f.id}|[${relation.relation_type}]`); }
      }
    }
    expect(got.lines.map((l) => `${l.fact.id}|${l.note}`)).toEqual(want);
    expect(got.lines[0].fact.id).toBe(ids.seed);
    expect(got.lines.some((l) => l.fact.id === ids.far), 'no gate: an unrelated SUPPORTS neighbour is carried').toBe(true);
    expect(got.relGatedOut + got.relUnscored).toBe(0);
    // The default (production) options differ only in scopeFamily; this project has no family facts besides rootfact.
    expect(sel.selectInjectFacts(db, e, baseline, PROJECT, { ...sel.PRODUCTION_SELECT_OPTIONS, scopeFamily: false }).lines).toEqual(got.lines);
  }, 30_000);

  it('relation gate keeps exactly the affirmative neighbours at margin >= relMargin, safety edges exempt', async () => {
    const { e, baseline } = await queryVec(QUERY);
    const m = (k: string) => sel.neighbourMargin(db, ids[k], e, baseline);
    expect(m('near')!, 'sanity: the on-topic neighbour beats the lunch one').toBeGreaterThan(m('far')!);
    for (const relMargin of [0, 0.02, 0.045]) {
      const got = sel.selectInjectFacts(db, e, baseline, PROJECT, { relMargin, scopeFamily: false });
      const vecIds = new Set(got.lines.filter((l) => l.origin === 'vec').map((l) => l.fact.id));
      const relIds = new Set(got.lines.filter((l) => l.origin === 'rel').map((l) => l.fact.id));
      // A neighbour close enough to be a vector hit is already a line; the gate judges the rest.
      const judged = ['near', 'far', 'krnear'].filter((k) => !vecIds.has(ids[k]));
      expect(judged, 'the off-topic neighbour reaches the gate').toContain('far');
      for (const k of judged) expect(relIds.has(ids[k]), `${k} @${relMargin} (margin ${m(k)})`).toBe(m(k)! >= relMargin);
      expect(relIds.has(ids.far), 'the lunch neighbour is gated out at every candidate margin').toBe(false);
      expect(relIds.has(ids.contra), 'CONTRADICTS is exempt').toBe(true);
      expect(relIds.has(ids.novec), 'no vector → not carried').toBe(false);
      expect(got.relUnscored).toBe(1);
      expect(got.relGatedOut).toBe(judged.filter((k) => m(k)! < relMargin).length);
      const rel = got.lines.filter((l) => l.origin === 'rel');
      const scoredRel = rel.filter((l) => l.margin !== null).map((l) => l.margin!);
      expect(scoredRel, 'passing neighbours in margin order').toEqual([...scoredRel].sort((a, b) => b - a));
      expect(rel.at(-1)!.fact.id, 'safety edges after the scored ones').toBe(ids.contra);
    }
  }, 30_000);

  it('relation gate: neighbour distance is the smaller of the English and Korean vectors, normalized like the KNN', async () => {
    const { e } = await queryVec('데이터베이스 마이그레이션은 어떤 도구로 실행하나요?');
    const d = factDb.factVectorDistance(db, ids.krnear, e)!;
    // The KNN's own distance for this id (what searchSimilarFacts ranks by), per table.
    const knn = (table: 'vec_facts' | 'vec_facts_kr') => {
      const q = dbMod.getVecQuant(db, table);
      const all = db.prepare(`SELECT id, distance FROM ${table} WHERE embedding MATCH ${dbMod.vecParamSql(q)} ORDER BY distance LIMIT 200`)
        .all(dbMod.embeddingToVecBlob(e, q)) as Array<{ id: string; distance: number }>;
      const hit = all.find((r) => r.id === ids.krnear);
      return hit ? dbMod.normalizeVecDistance(hit.distance, q) : Infinity;
    };
    const en = knn('vec_facts');
    const kr = knn('vec_facts_kr');
    expect(kr, 'the Korean vector is the near one for a Korean query').toBeLessThan(en);
    expect(d).toBeCloseTo(Math.min(en, kr), 5);
    expect(factDb.factVectorDistance(db, ids.novec, e)).toBeNull();
  }, 30_000);

  it('relation gate scores at most REL_SCORE_CAP neighbours per seed', async () => {
    const hub = 'Every deploy of the billing service is announced in the release channel with its changelog link';
    await add('hub', hub);
    for (let i = 0; i < sel.REL_SCORE_CAP + 10; i++) {
      await add(`spoke${i}`, `Billing release announcement detail number ${i}: the changelog link points at tag v${i}.0`);
      onto.createRelation(db, ids.hub, 'SUPPORTS', ids[`spoke${i}`]);
    }
    const { e, baseline } = await queryVec('How do we announce a billing service deploy and where is its changelog?');
    const got = sel.selectInjectFacts(db, e, baseline, PROJECT, { relMargin: -10, scopeFamily: false });
    expect(got.lines[0].fact.id).toBe(ids.hub);
    // Spokes that were vector hits are already lines; the hub's other neighbours compete for the cap.
    const gatedIds = new Set(got.gated.map((g) => g.fact.id));
    const unseen = onto.getRelatedFacts(db, ids.hub, 1, 0.6, 0.2, PROJECT).filter((r) => !gatedIds.has(r.fact.id)).length;
    expect(unseen).toBeGreaterThan(sel.REL_SCORE_CAP);
    expect(got.relUnscored).toBe(unseen - sel.REL_SCORE_CAP);
    expect(got.relGatedOut).toBe(0);
    expect(got.lines.length).toBeLessThanOrEqual(sel.MAX_CONTEXT_FACTS);
    // With every neighbour passing, the slots left after the vector hits go to the highest margins.
    const relMargins = got.lines.filter((l) => l.origin === 'rel' && l.margin !== null).map((l) => l.margin!);
    expect(relMargins.length, 'several scored neighbours compete for the slots').toBeGreaterThan(2);
    expect(relMargins).toEqual([...relMargins].sort((a, b) => b - a));
    const allScored = onto.getRelatedFacts(db, ids.hub, 1, 0.6, 0.2, PROJECT)
      .filter((r) => !gatedIds.has(r.fact.id)).slice(0, sel.REL_SCORE_CAP)
      .map((r) => sel.neighbourMargin(db, r.fact.id, e, baseline)!).sort((a, b) => b - a);
    expect(relMargins).toEqual(allScored.slice(0, relMargins.length));
  }, 120_000);

  it('relation gate: a neighbour two seeds share is scored and counted once', async () => {
    await add('invA', 'The invoice PDF export job runs every night at two and writes to the billing bucket');
    await add('invB', 'Invoice PDF exports that fail overnight are retried by the export job at six');
    await add('lunchX', 'The rooftop garden is closed whenever it rains in the afternoon');
    onto.createRelation(db, ids.invA, 'SUPPORTS', ids.lunchX);
    onto.createRelation(db, ids.invB, 'SUPPORTS', ids.lunchX);
    const { e, baseline } = await queryVec('When does the invoice PDF export job run and what happens when it fails?');
    const got = sel.selectInjectFacts(db, e, baseline, PROJECT, { relMargin: 0.02, scopeFamily: false });
    const seeds = got.gated.slice(0, 3).map((g) => g.fact.id);
    expect(seeds, 'both invoice facts are seeds').toEqual(expect.arrayContaining([ids.invA, ids.invB]));
    expect(sel.neighbourMargin(db, ids.lunchX, e, baseline)!, 'sanity: the garden fact is below the margin').toBeLessThan(0.02);
    expect(got.lines.some((l) => l.fact.id === ids.lunchX)).toBe(false);
    expect(got.relGatedOut, 'one neighbour, gated once').toBe(1);
  }, 60_000);

  it('scope family: a repo-root fact reaches a sub-folder only with scopeFamily on', async () => {
    const { e, baseline } = await queryVec('Who holds the hardware key that signs release builds of this repository?');
    const off = sel.selectInjectFacts(db, e, baseline, PROJECT, { relMargin: null, scopeFamily: false });
    const on = sel.selectInjectFacts(db, e, baseline, PROJECT, { relMargin: null, scopeFamily: true });
    expect(off.lines.some((l) => l.fact.id === ids.rootfact)).toBe(false);
    expect(on.lines[0]?.fact.id).toBe(ids.rootfact);
    expect(on.lines.some((l) => l.fact.id === ids.sibfact), 'the sibling repository\'s fact never reaches REPO/docs').toBe(false);
    const sib = sel.selectInjectFacts(db, e, baseline, `${REPO}-cloud`, { relMargin: null, scopeFamily: true });
    expect(sib.lines.some((l) => l.fact.id === ids.sibfact), 'positive control: it is a match from its own repository').toBe(true);
    expect(sib.lines.some((l) => l.fact.id === ids.rootfact), 'a sibling name is not the family').toBe(false);
  }, 30_000);

  it('visibleFactId hides a fact from the KNN and from relation expansion (replay as-of)', async () => {
    const { e, baseline } = await queryVec(QUERY);
    const hidden = new Set([ids.seed]);
    const got = sel.selectInjectFacts(db, e, baseline, PROJECT, {
      relMargin: null, scopeFamily: false, visibleFactId: (id) => !hidden.has(id),
    });
    expect(got.lines.some((l) => l.fact.id === ids.seed)).toBe(false);
    const seedFirst = sel.selectInjectFacts(db, e, baseline, PROJECT, {
      relMargin: null, scopeFamily: false, visibleFactId: (id) => id !== ids.near,
      visibleRelation: (r) => r.relation_type !== 'CONTRADICTS',
    });
    expect(seedFirst.lines[0].fact.id).toBe(ids.seed);
    expect(seedFirst.lines.some((l) => l.fact.id === ids.near || l.fact.id === ids.contra)).toBe(false);
  }, 30_000);

  it('production options equal the committed replay decision', async () => {
    const { parseDecisionsBlock } = await import('../bench/inject-bench-lib.mjs');
    const doc = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'bench', '2026-10-19-inject-replay.md'), 'utf8');
    const decided = parseDecisionsBlock(doc);
    expect(decided, 'the report carries a decisions block').not.toBeNull();
    expect(decided.verdict).toBe('valid');
    expect({ ...sel.PRODUCTION_SELECT_OPTIONS }).toEqual(decided.production);
    expect(Object.isFrozen(sel.PRODUCTION_SELECT_OPTIONS)).toBe(true);
  });

  it('visibleFactId is applied before the overfetch cut: hidden rows cannot crowd out a visible match', async () => {
    const hidden = new Set<string>();
    for (let i = 0; i < 55; i++) {
      await add(`aq${i}`, `The office aquarium filter is cleaned every Tuesday morning before standup (note ${i})`);
      hidden.add(ids[`aq${i}`]);
    }
    await add('aqTarget', 'Aquarium water in the office is partly changed once a month on the first Monday');
    const e = await embed.generateEmbedding('How often do we clean the office aquarium filter?', 'query');
    // Precondition: without the filter the target sits below the 50-row cut (a post-cut filter would lose it).
    const unfiltered = factDb.searchSimilarFacts(db, e, PROJECT, 60, 0).map((r) => r.fact.id);
    expect(unfiltered.slice(0, 50).includes(ids.aqTarget), 'scenario: 50 hidden rows outrank the target').toBe(false);
    const got = factDb.searchSimilarFacts(db, e, PROJECT, 5, 0, { visibleId: (id) => !hidden.has(id) });
    expect(got.map((r) => r.fact.id)).toContain(ids.aqTarget);
    expect(got.some((r) => hidden.has(r.fact.id))).toBe(false);
  }, 120_000);

  it('formatInjectBlock keeps the first line, cuts the tail at the budget, reports how many made it', () => {
    const fact = (n: number) => ({ id: `f${n}`, fact: 'x'.repeat(300), category: 'decision', created_at: '2026-10-19T00:00:00Z' }) as never;
    const { lines, shown } = sel.formatInjectBlock(Array.from({ length: 8 }, (_, i) => ({ fact: fact(i), note: '' })));
    expect(lines[0]).toBe(sel.BLOCK_HEADER);
    expect(shown).toBe(lines.length - 1);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(8);
    expect(lines.join('\n').length).toBeLessThanOrEqual(sel.BLOCK_CHAR_BUDGET + 1);
  });
});
