import type Database from 'better-sqlite3';
import type { Fact, OntologyRelation } from './types.js';
/**
 * Which facts a prompt's context block would carry — the selection half of the
 * UserPromptSubmit injection, kept apart from the session ledger, the log and
 * delivery so that the live hook (inject-core.ts) and the offline replay bench
 * (bench/inject-replay.mjs) run the SAME code: a bench with its own copy of the
 * pipeline would measure that copy.
 */
export declare const TOP_K = 5;
export declare const BASELINE_MARGIN = 0.045;
export declare const MAX_CONTEXT_FACTS = 8;
export declare const BLOCK_CHAR_BUDGET = 1000;
export declare const BLOCK_HEADER = "\uD83D\uDCCC \uAD00\uB828 \uACFC\uAC70 \uACB0\uC815:";
/** Neighbours per seed whose margin is computed when the relation gate is on (relation degree reaches 122 live). */
export declare const REL_SCORE_CAP = 30;
/**
 * Selection knobs the replay bench varies. The live hook passes
 * PRODUCTION_SELECT_OPTIONS; the visible* filters exist for the bench only.
 */
export interface InjectSelectOptions {
    /**
     * Relation gate: a SUPPORTS/INFLUENCES neighbour is kept only when its own
     * sim − baseline ≥ relMargin (null = no gate, every neighbour is kept).
     * CONTRADICTS/SUPERSEDES neighbours are exempt — they correct a belief the
     * block is about to state, whatever the query's wording.
     */
    relMargin: number | null;
    /** Widen the project scope to the repository family (project-family.ts). */
    scopeFamily: boolean;
    /** Replay bench only: facts that existed at the replayed prompt's moment. */
    visibleFactId?: (id: string) => boolean;
    /** Replay bench only: relations that existed at that moment. */
    visibleRelation?: (relation: OntologyRelation) => boolean;
}
/**
 * What the live injection runs. Changed only by the replay bench's
 * pre-registered decision (docs/bench/2026-10-19-inject-replay.md).
 */
export declare const PRODUCTION_SELECT_OPTIONS: Readonly<InjectSelectOptions>;
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
    gated: Array<{
        fact: Fact;
        margin: number;
    }>;
    /** Gated hits then relation lines, ≤ MAX_CONTEXT_FACTS — before the session ledger. */
    lines: SelectedLine[];
    /** Relation gate on: neighbours dropped for a margin below relMargin. */
    relGatedOut: number;
    /** Relation gate on: neighbours never scored — no current-version vector, or past REL_SCORE_CAP. */
    relUnscored: number;
    /** related_ms is absent when nothing cleared the gate (no expansion ran). */
    timings: {
        search_ms: number;
        related_ms?: number;
    };
}
/** sim − baseline of one stored fact, or null when it has no current-version vector. */
export declare function neighbourMargin(db: Database.Database, factId: string, embedding: number[], baseline: number): number | null;
/**
 * Top-K similar facts gated by the probe baseline, expanded with 1-hop ontology
 * relations of the first three hits.
 */
export declare function selectInjectFacts(db: Database.Database, embedding: number[], baseline: number, project: string, opts?: Readonly<InjectSelectOptions>): InjectSelection;
/**
 * Block text for the given lines, in order, under BLOCK_CHAR_BUDGET — fact 당
 * 160자 절단, 하위 관련도부터 탈락 (lines are in relevance order, so the tail is
 * cut). The first line is always kept. `shown` = how many leading items made it.
 */
export declare function formatInjectBlock(items: ReadonlyArray<{
    fact: Fact;
    note: string;
}>): {
    lines: string[];
    shown: number;
};
