import type Database from 'better-sqlite3';
import { l2DistanceToSimilarity } from './db.js';
import { searchSimilarFacts } from './fact-db.js';
import { getRelatedFacts } from './ontology-db.js';
import { truncateFact } from './fact-text.js';
import type { Fact } from './types.js';

/**
 * Which facts a prompt's context block would carry — the selection half of the
 * UserPromptSubmit injection, kept apart from the session ledger, the log and
 * delivery so that the live hook (inject-core.ts) and the offline replay bench
 * (bench/inject-replay.mjs) run the SAME code: a bench with its own copy of the
 * pipeline would measure that copy.
 */

export const TOP_K = 5;
// Probe-baseline relevance gate (e5 scores are compressed, so absolute
// thresholds cannot separate relevant from irrelevant). A fact is injected
// only when sim(query, fact) exceeds the query's own background baseline by
// this margin. Measured on KR/EN real-DB pairs: related +0.047~+0.123,
// unrelated -0.028~-0.091; long compound "memory" facts can leak in at
// +0.04~+0.045, so the margin sits just above that noise band.
export const BASELINE_MARGIN = 0.045;
export const MAX_CONTEXT_FACTS = 8;
// Token budget: fact 평균 140자·p90 207자 실측 — 절단 없이 8건이면 ~470 tok/프롬프트.
// fact 당 160자(fact-text.ts FACT_CHAR_CAP) + 블록 1,000자 예산으로 상한. 잘린 내용이 필요하면 search_facts 로 조회.
export const BLOCK_CHAR_BUDGET = 1000;
export const BLOCK_HEADER = '📌 관련 과거 결정:';

/** One line of the block: a vector hit, or a 1-hop relation of one (note = '[TYPE]'). */
export interface SelectedLine {
  fact: Fact;
  note: string;
  origin: 'vec' | 'rel';
  /** sim − baseline for vector hits; null for relation lines. */
  margin: number | null;
}

export interface InjectSelection {
  /** KNN rows that survived the scope filter (≤ TOP_K). */
  candidates: number;
  /** sim − baseline of each candidate, in rank order. */
  topMargins: number[];
  /** Candidates that cleared BASELINE_MARGIN. */
  gated: Array<{ fact: Fact; margin: number }>;
  /** Gated hits then relation lines, ≤ MAX_CONTEXT_FACTS — before the session ledger. */
  lines: SelectedLine[];
  /** related_ms is absent when nothing cleared the gate (no expansion ran). */
  timings: { search_ms: number; related_ms?: number };
}

/**
 * Top-K similar facts gated by the probe baseline, expanded with 1-hop ontology
 * relations of the first three hits.
 */
export function selectInjectFacts(
  db: Database.Database,
  embedding: number[],
  baseline: number,
  project: string,
): InjectSelection {
  let tStage = Date.now();
  // threshold 0: take top-k by distance, then gate by baseline margin below
  const candidates = searchSimilarFacts(db, embedding, project, TOP_K, 0);
  const search_ms = Date.now() - tStage;
  const scored = candidates.map((r) => ({ fact: r.fact, margin: l2DistanceToSimilarity(r.distance) - baseline }));
  const gated = scored.filter((r) => r.margin >= BASELINE_MARGIN);
  const topMargins = scored.map((r) => r.margin);
  if (gated.length === 0) {
    return { candidates: candidates.length, topMargins, gated, lines: [], timings: { search_ms } };
  }

  tStage = Date.now();
  const seenIds = new Set(gated.map((r) => r.fact.id));
  const lines: SelectedLine[] = gated.map((r) => ({ fact: r.fact, note: '', origin: 'vec', margin: r.margin }));
  for (const { fact } of gated.slice(0, 3)) {
    const related = getRelatedFacts(db, fact.id, 1, 0.6, 0.2, project);
    for (const { fact: relFact, relation } of related) {
      if (!seenIds.has(relFact.id) && lines.length < MAX_CONTEXT_FACTS) {
        seenIds.add(relFact.id);
        lines.push({ fact: relFact, note: `[${relation.relation_type}]`, origin: 'rel', margin: null });
      }
    }
  }
  return {
    candidates: candidates.length, topMargins, gated, lines,
    timings: { search_ms, related_ms: Date.now() - tStage },
  };
}

/**
 * Block text for the given lines, in order, under BLOCK_CHAR_BUDGET — fact 당
 * 160자 절단, 하위 관련도부터 탈락 (lines are in relevance order, so the tail is
 * cut). The first line is always kept. `shown` = how many leading items made it.
 */
export function formatInjectBlock(items: ReadonlyArray<{ fact: Fact; note: string }>): { lines: string[]; shown: number } {
  const lines = [BLOCK_HEADER];
  let blockChars = BLOCK_HEADER.length;
  let shown = 0;
  for (const { fact, note } of items) {
    const dateStr = fact.created_at.slice(0, 10);
    const line = `- ${note ? note + ' ' : ''}[${fact.category}] ${truncateFact(fact.fact)} (${dateStr})`;
    if (blockChars + line.length > BLOCK_CHAR_BUDGET && shown > 0) break;
    lines.push(line);
    blockChars += line.length + 1;
    shown++;
  }
  return { lines, shown };
}
