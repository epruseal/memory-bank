import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Static guards for the 2026-10-16 search-performance changes. Each one pins a
// property no unit test would notice regressing silently.

const REPO = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SOURCES = ['src', 'scripts', 'cli', 'bench']
  .flatMap((d) => walk(path.join(REPO, d)))
  .concat([path.join(REPO, 'bench-perf.mjs')]);

describe('per-table int8 scale is used everywhere', () => {
  it('scans real files', () => {
    expect(SOURCES.length).toBeGreaterThan(40);
  });

  it('no caller encodes/decodes with a bare dtype string (that would silently use the wrong scale)', () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const src = fs.readFileSync(f, 'utf8');
      if (/getVecDtype\s*\(/.test(src)) offenders.push(`${path.relative(REPO, f)}: getVecDtype`);
      if (/(embeddingToVecBlob|normalizeVecDistance)\([^)]*,\s*'(int8|float32)'\s*\)/.test(src)) offenders.push(`${path.relative(REPO, f)}: string dtype`);
      if (/vecParamSql\(\s*'(int8|float32)'\s*\)/.test(src)) offenders.push(`${path.relative(REPO, f)}: vecParamSql string`);
    }
    expect(offenders).toEqual([]);
  });

  it('every file that writes or MATCHes a vec table derives its codec from getVecQuant', () => {
    const missing: string[] = [];
    for (const f of SOURCES) {
      const src = fs.readFileSync(f, 'utf8');
      const touches = /(INSERT INTO|FROM)\s+\$?\{?(vec_facts|vec_facts_kr|vec_categories|vec_exchanges)\b[^`]*?(VALUES|MATCH)/s.test(src);
      if (touches && !/getVecQuant\(/.test(src) && !/vecParamFor\(/.test(src)) missing.push(path.relative(REPO, f));
    }
    // Deliberate exceptions, all on vec_exchanges (scale unchanged at 127) or copying blobs as-is:
    //  - src/vec-compact.ts copies stored blobs and reads the quant once per swap;
    //  - bench/analyze-int8.mjs is the one-off float32-vs-int8@127 comparison that justified the
    //    exchanges migration (it builds its own int8 table on purpose);
    //  - bench/profile.mjs predates the int8 exchanges table (already broken since 2026-07-11,
    //    out of scope here — recorded in docs/plans/2026-10-16-local-search-perf.md Deviations).
    const allowed = new Set([path.join('src', 'vec-compact.ts'), path.join('bench', 'analyze-int8.mjs'), path.join('bench', 'profile.mjs')]);
    expect(missing.filter((f) => !allowed.has(f))).toEqual([]);
  });
});

describe('MCP search knowledge section', () => {
  it('reuses the cached search connection (no initDatabase per call)', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/search.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function getKnowledgeContext'), src.indexOf('export function formatKnowledgeContext'))
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(body).toContain('getSearchDb()');
    expect(body).not.toMatch(/initDatabase\(\)|db\.close\(\)|listCategories\(/);
  });

  it('a failure is reported on stderr and in the result, never swallowed', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/mcp-server.ts'), 'utf8');
    const at = src.indexOf('getKnowledgeContext(params.query');
    const tail = src.slice(at, at + 700);
    expect(tail).not.toMatch(/catch\s*\{/);
    expect(tail).toMatch(/console\.error\(`memory-bank search: related knowledge unavailable/);
    expect(tail).toMatch(/Related knowledge unavailable/);
  });
});
