import Database from 'better-sqlite3';
import type { OntologyDomain, OntologyCategory, OntologyRelation, RelationType, DomainTree, Fact } from './types.js';
export declare function createDomain(db: Database.Database, name: string, description?: string): OntologyDomain;
export declare function listDomains(db: Database.Database): OntologyDomain[];
export declare function getDomain(db: Database.Database, id: string): OntologyDomain | null;
export declare function getDomainByName(db: Database.Database, name: string): OntologyDomain | null;
export declare function createCategory(db: Database.Database, domainId: string, name: string, description?: string): OntologyCategory;
export declare function listCategories(db: Database.Database, domainId?: string): OntologyCategory[];
export declare function getCategoryByName(db: Database.Database, name: string, domainId?: string): OntologyCategory | null;
/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export declare function upsertCategoryEmbedding(db: Database.Database, categoryId: string, embedding: number[]): void;
export declare function deleteCategoryEmbedding(db: Database.Database, categoryId: string): void;
/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export declare function searchSimilarCategories(db: Database.Database, embedding: number[], k?: number): Array<{
    category: OntologyCategory;
    domainName: string;
    distance: number;
}>;
export declare function classifyFact(db: Database.Database, factId: string, categoryId: string): void;
export declare function getFactsByCategory(db: Database.Database, categoryId: string): Fact[];
export declare function getFactsByDomain(db: Database.Database, domainId: string): Fact[];
export declare function createRelation(db: Database.Database, sourceFactId: string, relationType: RelationType, targetFactId: string, reasoning?: string): OntologyRelation;
/** Options of getRelatedFacts that only the injection selection (and its replay bench) passes. */
export interface RelatedFactsOptions {
    /** Widen scopeProject to its repository family (project-family.ts). */
    scopeFamily?: boolean;
    /** Replay bench only: facts that existed at the replayed moment. */
    visibleFact?: (id: string) => boolean;
    /** Replay bench only: relations that existed at the replayed moment. */
    visibleRelation?: (relation: OntologyRelation) => boolean;
}
/**
 * Get related facts with relevance decay.
 *
 * Each hop reduces relevance by the decay factor:
 * - hop 0 (direct): relevance = 1.0
 * - hop 1: relevance = decay (default 0.6)
 * - hop 2: relevance = decay^2 (default 0.36)
 *
 * Results are sorted by relevance descending.
 * Facts below minRelevance are pruned.
 */
/**
 * @param scopeProject - If provided, only return facts from this project or global scope.
 *                       Prevents cross-project noise in graph traversal.
 *                       Pass null/undefined to allow cross-project traversal (e.g., explore_graph).
 */
export declare function getRelatedFacts(db: Database.Database, factId: string, hops?: number, decay?: number, minRelevance?: number, scopeProject?: string | null, opts?: RelatedFactsOptions): Array<{
    fact: Fact;
    relation: OntologyRelation;
    relevance: number;
    hop: number;
}>;
export declare function getRelationsForFact(db: Database.Database, factId: string): OntologyRelation[];
export declare function getOntologyTree(db: Database.Database): DomainTree[];
