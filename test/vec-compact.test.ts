import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, getVecQuant, embeddingToVecBlob, vecParamSql } from '../src/db.js';
import { vecTableFill, compactVecTable, compactSparseVecTables, rebuildVecTable } from '../src/vec-compact.js';
import { suppressConsole } from './test-utils.js';

// vec0 never reuses a deleted slot: insertFact/updateFact are DELETE+INSERT and
// deactivateFact is DELETE only, so the brute-force KNN keeps scanning holes
// (live 2026-10-16: vec_facts 41 chunks, 57.9% filled). Compaction rebuilds a
// table from its live rows — same ids, same stored bytes, same dtype/scale.

const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

function vec(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.cos(seed * 1.7 + i * 0.37) * 0.1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function knn(db: Database.Database, table: string, query: number[], k = 10): Array<{ id: string; distance: number }> {
  const q = getVecQuant(db, table);
  return db.prepare(`SELECT id, distance FROM ${table} WHERE embedding MATCH ${vecParamSql(q)} ORDER BY distance LIMIT ?`)
    .all(embeddingToVecBlob(query, q), k) as Array<{ id: string; distance: number }>;
}

/**
 * What compaction guarantees for a KNN: the same distances, and the same ids
 * strictly closer than the k-th distance. Rows at EXACTLY the k-th distance are
 * ties; vec0 orders ties by storage position, which a rebuild changes (seen
 * with sqlite-vec 0.1.9), so which tied row fills the last slots is unspecified.
 */
function knnInvariant(rows: Array<{ id: string; distance: number }>) {
  const kth = rows.length ? rows[rows.length - 1].distance : 0;
  return {
    distances: rows.map((r) => r.distance),
    strictlyCloser: rows.filter((r) => r.distance < kth).map((r) => r.id).sort(),
  };
}

function storedBytes(db: Database.Database, table: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.prepare(`SELECT id, embedding FROM ${table}`).all() as Array<{ id: string; embedding: Buffer }>) {
    m.set(r.id, Buffer.from(r.embedding).toString('hex'));
  }
  return m;
}

describe('vec0 slot compaction', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-compact-'));
    process.env.TEST_DB_PATH = path.join(dir, 'test.db');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(db: Database.Database, table: string, n: number, keepEvery: number) {
    const q = getVecQuant(db, table);
    const ins = db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, ${vecParamSql(q)})`);
    const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    db.transaction(() => {
      for (let i = 0; i < n; i++) ins.run(`f-${i}`, embeddingToVecBlob(vec(i), q));
      for (let i = 0; i < n; i++) if (i % keepEvery !== 0) del.run(`f-${i}`);
    })();
  }

  for (const dtype of ['int8', 'float32'] as const) {
    it(`${dtype}: keeps ids, stored bytes, schema and scale; KNN identical; chunks shrink`, () => {
      if (dtype === 'float32') {
        const raw = new Database(process.env.TEST_DB_PATH!);
        sqliteVec.load(raw);
        raw.exec('CREATE VIRTUAL TABLE vec_facts USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])');
        raw.close();
      }
      const db = initDatabase();
      try {
        seed(db, 'vec_facts', 4096, 3); // 4 chunks, ~1/3 live
        const before = vecTableFill(db, 'vec_facts')!;
        expect(before.chunks).toBe(4);
        expect(before.rows).toBe(1366);
        expect(before.ratio).toBeLessThan(0.4);

        const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='vec_facts'").get() as { sql: string }).sql;
        const quant = getVecQuant(db, 'vec_facts');
        const bytes = storedBytes(db, 'vec_facts');
        const queries = [vec(0.5), vec(99.2), vec(2048.1), vec(4000.7)];
        const knnBefore = queries.map((qv) => knnInvariant(knn(db, 'vec_facts', qv)));

        const res = compactVecTable(db, 'vec_facts');
        expect(res.before.rows).toBe(1366);
        expect(res.after.rows).toBe(1366);
        expect(res.after.chunks).toBe(2);
        expect(res.after.ratio).toBeGreaterThan(0.6);

        expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='vec_facts'").get() as { sql: string }).sql).toBe(ddl);
        expect(getVecQuant(db, 'vec_facts')).toEqual(quant);
        expect(storedBytes(db, 'vec_facts')).toEqual(bytes);
        expect(queries.map((qv) => knnInvariant(knn(db, 'vec_facts', qv)))).toEqual(knnBefore);
      } finally {
        db.close();
      }
    });
  }

  it('compactSparseVecTables only rebuilds tables below the ratio with at least one chunk to free', () => {
    const db = initDatabase();
    try {
      seed(db, 'vec_facts', 4096, 3);      // sparse → compacted
      seed(db, 'vec_facts_kr', 1500, 1);   // 2 chunks, 73% full but only 548 free slots → left alone
      const out = compactSparseVecTables(db, { minRatio: 0.8 });
      const byTable = new Map(out.map((o) => [o.table, o]));
      expect(byTable.get('vec_facts')?.action).toBe('compacted');
      expect(byTable.get('vec_facts_kr')?.action).toBe('skipped');
      expect(byTable.get('vec_categories')?.action).toBe('skipped');
      expect(vecTableFill(db, 'vec_facts')!.chunks).toBe(2);
      expect(vecTableFill(db, 'vec_facts_kr')!.chunks).toBe(2);
    } finally {
      db.close();
    }
  });

  it('refuses a vec table whose schema is not (id TEXT PRIMARY KEY, embedding <type>[384])', () => {
    const db = initDatabase();
    try {
      // vec_exchanges is not in the compactable set at all.
      expect(() => compactVecTable(db, 'vec_exchanges')).toThrow(/not a fact-side vec table/);
      db.exec('DROP TABLE vec_categories');
      db.exec('CREATE VIRTUAL TABLE vec_categories USING vec0(id TEXT PRIMARY KEY, embedding int8[384], +note TEXT)');
      expect(() => compactVecTable(db, 'vec_categories')).toThrow(/unsupported vec0 schema/);
    } finally {
      db.close();
    }
  });

  it('a rebuild that fails after the DROP rolls back: the original table, bytes and chunks survive', () => {
    const db = initDatabase();
    try {
      seed(db, 'vec_facts', 2048, 2);
      const bytes = storedBytes(db, 'vec_facts');
      const fill = vecTableFill(db, 'vec_facts');
      expect(() => rebuildVecTable(db, 'vec_facts', { convert: (b) => b.subarray(0, 100) })).toThrow();
      expect(storedBytes(db, 'vec_facts')).toEqual(bytes);
      expect(vecTableFill(db, 'vec_facts')).toEqual(fill);
    } finally {
      db.close();
    }
  });

  it('a statement another connection prepared before the swap answers the same after it (SQLite re-prepares)', () => {
    const db = initDatabase();
    const other = new Database(process.env.TEST_DB_PATH!);
    sqliteVec.load(other);
    try {
      seed(db, 'vec_facts', 3072, 3);
      const q = getVecQuant(other, 'vec_facts');
      const stmt = other.prepare(`SELECT id, distance FROM vec_facts WHERE embedding MATCH ${vecParamSql(q)} ORDER BY distance LIMIT 10`);
      const probe = embeddingToVecBlob(vec(77.7), q);
      const before = knnInvariant(stmt.all(probe) as Array<{ id: string; distance: number }>);
      compactVecTable(db, 'vec_facts');
      // prepared before the swap, re-prepared by SQLite after it
      expect(knnInvariant(stmt.all(probe) as Array<{ id: string; distance: number }>)).toEqual(before);
      expect(vecTableFill(other, 'vec_facts')!.chunks).toBe(1);
    } finally {
      other.close();
      db.close();
    }
  });

  it('separate processes reading and writing DURING the swap: no errors, writes wait for the lock and all land', async () => {
    const db = initDatabase();
    try {
      seed(db, 'vec_facts', 30720, 3); // ~10k live rows in 30 chunks — a swap long enough to overlap
    } finally {
      db.close();
    }
    const req = createRequire(import.meta.url);
    const worker = path.join(dir, 'worker.cjs');
    fs.writeFileSync(worker, `
      const D = require(${JSON.stringify(req.resolve('better-sqlite3'))});
      const vec = require(${JSON.stringify(req.resolve('sqlite-vec'))});
      const [dbPath, mode, ms] = process.argv.slice(2);
      const db = new D(dbPath); vec.load(db); db.pragma('busy_timeout = 15000');
      const probe = Buffer.from(new Int8Array(384).fill(3).buffer);
      let n = 0, maxWait = 0; const errors = [];
      process.stdout.write('ready\\n');
      const until = Date.now() + Number(ms);
      while (Date.now() < until) {
        const t0 = Date.now();
        try {
          if (mode === 'read') db.prepare('SELECT id FROM vec_facts WHERE embedding MATCH vec_int8(?) ORDER BY distance LIMIT 5').all(probe);
          else db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, vec_int8(?))').run('w-' + n, probe);
          n++;
        } catch (e) { errors.push(String(e && e.message)); }
        maxWait = Math.max(maxWait, Date.now() - t0);
      }
      process.stdout.write(JSON.stringify({ n, errors: errors.slice(0, 5), errorCount: errors.length, maxWait }) + '\\n');
    `);
    const start = (mode: string) => {
      const c = spawn(process.execPath, [worker, process.env.TEST_DB_PATH!, mode, '2500'], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      const ready = new Promise<void>((resolve) => c.stdout!.on('data', (d) => { out += d; if (out.includes('ready')) resolve(); }));
      const done = new Promise<{ n: number; errors: string[]; errorCount: number; maxWait: number }>((resolve) =>
        c.once('exit', () => resolve(JSON.parse(out.trim().split('\n').pop()!))));
      return { ready, done };
    };
    const reader = start('read');
    const writer = start('write');
    await Promise.all([reader.ready, writer.ready]);
    const db2 = initDatabase();
    let swapMs = 0;
    try {
      const t0 = Date.now();
      const res = compactVecTable(db2, 'vec_facts');
      swapMs = Date.now() - t0;
      expect(res.after.chunks).toBeLessThan(res.before.chunks);
    } finally {
      db2.close();
    }
    const [r, w] = await Promise.all([reader.done, writer.done]);
    expect(r.errorCount, r.errors.join(' | ')).toBe(0);
    expect(w.errorCount, w.errors.join(' | ')).toBe(0);
    expect(r.n).toBeGreaterThan(0);
    expect(w.n).toBeGreaterThan(0);
    expect(swapMs).toBeGreaterThan(0);
    const db3 = initDatabase();
    try {
      const landed = (db3.prepare("SELECT count(*) AS n FROM vec_facts_rowids WHERE id LIKE 'w-%'").get() as { n: number }).n;
      expect(landed).toBe(w.n); // every write that returned is in the rebuilt table
    } finally {
      db3.close();
    }
  }, 60_000);

  it('a failing table is reported as failed and does not hide the tables compacted before it', () => {
    const db = initDatabase();
    try {
      seed(db, 'vec_facts', 4096, 3);
      db.exec('DROP TABLE vec_facts_kr');
      db.exec('CREATE VIRTUAL TABLE vec_facts_kr USING vec0(id TEXT PRIMARY KEY, embedding int8[384], +note TEXT)');
      const ins = db.prepare('INSERT INTO vec_facts_kr (id, embedding, note) VALUES (?, vec_int8(?), ?)');
      db.transaction(() => {
        for (let i = 0; i < 2048; i++) ins.run(`k-${i}`, Buffer.from(new Int8Array(384).fill(i % 50).buffer), 'n');
        db.prepare("DELETE FROM vec_facts_kr WHERE CAST(substr(id, 3) AS INTEGER) % 4 != 0").run();
      })();
      const out = compactSparseVecTables(db, { minRatio: 0.8 });
      const byTable = new Map(out.map((o) => [o.table, o]));
      expect(byTable.get('vec_facts')?.action).toBe('compacted');
      const kr = byTable.get('vec_facts_kr');
      expect(kr?.action).toBe('failed');
      expect(kr && 'error' in kr ? kr.error : '').toMatch(/unsupported vec0 schema/);
      expect(byTable.get('vec_categories')?.action).toBe('skipped'); // later tables still get their turn
    } finally {
      db.close();
    }
  });

  it('vecTableFill returns null for an absent table', () => {
    const db = initDatabase();
    try {
      db.exec('DROP TABLE vec_categories');
      expect(vecTableFill(db, 'vec_categories')).toBeNull();
    } finally {
      db.close();
    }
  });
});
