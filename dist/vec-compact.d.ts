import type Database from 'better-sqlite3';
import { type VecQuant } from './db.js';
export interface VecFill {
    table: string;
    /** Live vectors (rows in the `_rowids` shadow table). */
    rows: number;
    /** Allocated slots (sum of chunk sizes) — what every KNN scans. */
    slots: number;
    chunks: number;
    /** rows / slots; 1 for an empty table. */
    ratio: number;
}
export interface VecRebuildOptions {
    /** CREATE statement for the new table. Default: the current DDL. */
    ddl?: string;
    /** dtype/scale of the new table. When given, the scale record is rewritten. */
    quant?: VecQuant;
    /**
     * Map one stored row of the OLD table to the blob for the NEW table — called
     * inside the transaction for every current row, so rows written concurrently
     * are never missed. Default: identity (the stored bytes).
     */
    convert?: (blob: Buffer, id: string) => Buffer;
}
/** Fill of a fact-side vec0 table, or null when the table does not exist. */
export declare function vecTableFill(db: Database.Database, table: string): VecFill | null;
/**
 * Rebuild a fact-side vec0 table in one BEGIN IMMEDIATE transaction. With no
 * options this is a pure compaction (same DDL, same bytes, same scale record).
 * Throws — and rolls back — when the rows read back after the swap are not
 * byte-for-byte the rows it meant to write, or when the table's schema is not
 * the plain (id TEXT PRIMARY KEY, embedding <type>[384]) this code knows how
 * to copy.
 */
export declare function rebuildVecTable(db: Database.Database, table: string, opts?: VecRebuildOptions): {
    before: VecFill;
    after: VecFill;
};
/** Rebuild a table from its own live rows (holes removed, nothing else changes). */
export declare function compactVecTable(db: Database.Database, table: string): {
    before: VecFill;
    after: VecFill;
};
export type CompactOutcome = {
    table: string;
    action: 'compacted';
    before: VecFill;
    after: VecFill;
} | {
    table: string;
    action: 'skipped';
    reason: string;
    fill: VecFill | null;
} | {
    table: string;
    action: 'failed';
    error: string;
};
/**
 * Compact every fact-side table whose fill is below `minRatio` AND that has at
 * least one chunk's worth of free slots (a rebuild that cannot drop a chunk
 * scans exactly as much as before). Tables are rebuilt one at a time, each in
 * its own transaction, so the write lock is never held across all three.
 * A failure is reported per table, never thrown: a table swapped before it
 * stays swapped, and throwing would drop that outcome from the caller's log.
 */
export declare function compactSparseVecTables(db: Database.Database, opts?: {
    minRatio?: number;
    tables?: string[];
}): CompactOutcome[];
