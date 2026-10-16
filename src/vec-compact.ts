import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getVecQuant, vecParamSql, VEC_INT8_SCALE_TABLE, FACT_VEC_TABLES, type VecQuant } from './db.js';

/**
 * Fact-side vec0 table maintenance: slot compaction and dtype/scale swaps.
 *
 * vec0 never reuses a deleted slot. insertFact/updateFact rewrite a vector as
 * DELETE+INSERT (a new slot at the end) and deactivateFact only DELETEs, so a
 * table's chunks fill with holes that the brute-force KNN still scans on every
 * query. Measured live 2026-10-16: vec_facts 41 chunks at 57.9% fill,
 * vec_facts_kr 28 chunks at 72.9% — rebuilding from live rows alone took the
 * cold first injection search on a live-size copy from 539.4ms to 403.2ms
 * (median of 7, sqlite-vec 0.1.9), same distances, only tied rows reordered.
 *
 * Every rebuild is ONE BEGIN IMMEDIATE transaction (a savepoint inside a
 * caller's transaction): read the live rows, DROP, CREATE, re-insert, then read
 * the new table back and require its (id, bytes) digest and row count to equal
 * exactly what was meant to be written — otherwise throw and roll back, so a
 * wrong rebuild can never commit. Measured on the live-size copy: the whole
 * compaction held the write lock ~2.4s; a concurrent writer waited at most
 * 2,195ms, with no errors (docs/plans/2026-10-16-local-search-perf.md).
 */

const COMPACTABLE = new Set<string>(FACT_VEC_TABLES);
const SUPPORTED_DDL = /USING\s+vec0\s*\(\s*id\s+TEXT\s+PRIMARY\s+KEY\s*,\s*embedding\s+(?:int8|float)\s*\[\s*384\s*\]\s*\)\s*$/i;
/** vec0's default chunk size — the slot count one freed chunk gives back. */
const VEC0_CHUNK_SLOTS = 1024;

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

/** Order-independent digest of (id, bytes) pairs. */
function rowsDigest(rows: Iterable<readonly [string, Buffer]>): string {
  const sorted = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha256');
  for (const [id, blob] of sorted) {
    h.update(id); h.update('\0'); h.update(String(blob.length)); h.update('\0'); h.update(blob);
  }
  return h.digest('hex');
}

function assertCompactable(table: string): void {
  if (!COMPACTABLE.has(table)) throw new Error(`not a fact-side vec table: ${table}`);
}

function tableDdl(db: Database.Database, table: string): string | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as
    { sql: string } | undefined;
  return row?.sql ?? null;
}

/** Fill of a fact-side vec0 table, or null when the table does not exist. */
export function vecTableFill(db: Database.Database, table: string): VecFill | null {
  assertCompactable(table);
  if (!tableDdl(db, table)) return null;
  const rows = (db.prepare(`SELECT count(*) AS n FROM ${table}_rowids`).get() as { n: number }).n;
  const c = db.prepare(`SELECT count(*) AS chunks, coalesce(sum(size), 0) AS slots FROM ${table}_chunks`)
    .get() as { chunks: number; slots: number };
  return { table, rows, slots: c.slots, chunks: c.chunks, ratio: c.slots === 0 ? 1 : rows / c.slots };
}

/**
 * Rebuild a fact-side vec0 table in one BEGIN IMMEDIATE transaction. With no
 * options this is a pure compaction (same DDL, same bytes, same scale record).
 * Throws — and rolls back — when the rows read back after the swap are not
 * byte-for-byte the rows it meant to write, or when the table's schema is not
 * the plain (id TEXT PRIMARY KEY, embedding <type>[384]) this code knows how
 * to copy.
 */
export function rebuildVecTable(
  db: Database.Database,
  table: string,
  opts: VecRebuildOptions = {},
): { before: VecFill; after: VecFill } {
  assertCompactable(table);
  const swap = db.transaction(() => {
    const ddl = tableDdl(db, table);
    if (!ddl) throw new Error(`${table}: table does not exist`);
    if (!SUPPORTED_DDL.test(ddl)) throw new Error(`${table}: unsupported vec0 schema — ${ddl}`);
    const newDdl = opts.ddl ?? ddl;
    if (!SUPPORTED_DDL.test(newDdl)) throw new Error(`${table}: unsupported target schema — ${newDdl}`);
    const before = vecTableFill(db, table)!;

    const source = db.prepare(`SELECT id, embedding FROM ${table}`).all() as Array<{ id: string; embedding: Buffer }>;
    if (source.length !== before.rows) throw new Error(`${table}: read ${source.length}/${before.rows} rows`);
    const convert = opts.convert ?? ((b: Buffer) => b);
    const prepared = source.map((r) => [r.id, convert(Buffer.from(r.embedding), r.id)] as const);
    const expected = rowsDigest(prepared);
    const targetQuant = opts.quant ?? getVecQuant(db, table);

    db.exec(`DROP TABLE ${table}`);
    db.exec(newDdl);
    const ins = db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(targetQuant)})`);
    for (const [id, blob] of prepared) ins.run(id, blob);

    if (opts.quant) {
      db.exec(`CREATE TABLE IF NOT EXISTS ${VEC_INT8_SCALE_TABLE} (table_name TEXT PRIMARY KEY, scale REAL NOT NULL)`);
      if (opts.quant.dtype === 'int8') {
        db.prepare(`INSERT OR REPLACE INTO ${VEC_INT8_SCALE_TABLE} (table_name, scale) VALUES (?, ?)`)
          .run(table, opts.quant.scale);
      } else {
        db.prepare(`DELETE FROM ${VEC_INT8_SCALE_TABLE} WHERE table_name = ?`).run(table);
      }
    }

    const after = vecTableFill(db, table)!;
    if (after.rows !== prepared.length) {
      throw new Error(`${table}: count mismatch after swap ${after.rows}/${prepared.length}`);
    }
    const readBack = (db.prepare(`SELECT id, embedding FROM ${table}`).all() as Array<{ id: string; embedding: Buffer }>)
      .map((r) => [r.id, Buffer.from(r.embedding)] as const);
    if (rowsDigest(readBack) !== expected) throw new Error(`${table}: rows read back after the swap differ from the rows written`);
    const got = getVecQuant(db, table);
    if (got.dtype !== targetQuant.dtype || got.scale !== targetQuant.scale) {
      throw new Error(`${table}: quant after swap ${JSON.stringify(got)} ≠ ${JSON.stringify(targetQuant)}`);
    }
    return { before, after };
  });
  return swap.immediate();
}

/** Rebuild a table from its own live rows (holes removed, nothing else changes). */
export function compactVecTable(db: Database.Database, table: string): { before: VecFill; after: VecFill } {
  return rebuildVecTable(db, table);
}

export type CompactOutcome =
  | { table: string; action: 'compacted'; before: VecFill; after: VecFill }
  | { table: string; action: 'skipped'; reason: string; fill: VecFill | null }
  | { table: string; action: 'failed'; error: string };

/**
 * Compact every fact-side table whose fill is below `minRatio` AND that has at
 * least one chunk's worth of free slots (a rebuild that cannot drop a chunk
 * scans exactly as much as before). Tables are rebuilt one at a time, each in
 * its own transaction, so the write lock is never held across all three.
 * A failure is reported per table, never thrown: a table swapped before it
 * stays swapped, and throwing would drop that outcome from the caller's log.
 */
export function compactSparseVecTables(
  db: Database.Database,
  opts: { minRatio?: number; tables?: string[] } = {},
): CompactOutcome[] {
  const minRatio = opts.minRatio ?? 0.8;
  const out: CompactOutcome[] = [];
  for (const table of opts.tables ?? [...COMPACTABLE]) {
    try {
      const fill = vecTableFill(db, table);
      if (!fill) { out.push({ table, action: 'skipped', reason: 'absent', fill }); continue; }
      if (fill.ratio >= minRatio) { out.push({ table, action: 'skipped', reason: `fill ${fill.ratio.toFixed(3)} ≥ ${minRatio}`, fill }); continue; }
      if (fill.slots - fill.rows < VEC0_CHUNK_SLOTS) {
        out.push({ table, action: 'skipped', reason: `only ${fill.slots - fill.rows} free slots`, fill });
        continue;
      }
      const r = compactVecTable(db, table);
      out.push({ table, action: 'compacted', before: r.before, after: r.after });
    } catch (e) {
      out.push({ table, action: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
