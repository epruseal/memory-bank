import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { requiredNativeAbi, candidateNodePaths, findNodeForAbi, probeNodeAbi, rerunWithInput, rerunBudgetMs } from '../src/node-abi.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { suppressConsole } from './test-utils.js';

const REPO = path.resolve(__dirname, '..');
const restoreConsole = suppressConsole();
afterAll(() => restoreConsole());

const ABI_ERROR = "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  'was compiled against a different Node.js version using\nNODE_MODULE_VERSION 127. This version of Node.js requires\n' +
  'NODE_MODULE_VERSION 147. Please try re-compiling or re-installing';

describe('node-abi helpers', () => {
  it('reads the required ABI from the dlopen error and ignores other errors', () => {
    expect(requiredNativeAbi(new Error(ABI_ERROR))).toBe(127);
    expect(requiredNativeAbi(new Error("Cannot find module 'better-sqlite3'"))).toBeNull();
  });

  it('lists MEMORY_BANK_NODE, PATH, keg-only node@N and version managers — existing files only, once each', () => {
    const files = new Set([
      '/custom/node', '/a/bin/node', '/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/opt/node/bin/node',
      '/h/.nvm/versions/node/v20.1.0/bin/node', '/usr/local/bin/node',
    ]);
    const dirs: Record<string, string[]> = {
      '/opt/homebrew/opt': ['node@22', 'node', 'python@3.12'],
      '/h/.nvm/versions/node': ['v20.1.0'],
    };
    const got = candidateNodePaths(
      { MEMORY_BANK_NODE: '/custom/node', PATH: ['/a/bin', '/missing/bin', '/a/bin'].join(path.delimiter) },
      '/h', (p) => files.has(p), (d) => dirs[d] ?? [],
    );
    expect(got).toEqual([
      '/custom/node', '/a/bin/node', '/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/opt/node/bin/node',
      '/h/.nvm/versions/node/v20.1.0/bin/node', '/usr/local/bin/node',
    ]);
  });

  it('picks the first candidate whose ABI matches', () => {
    const abi: Record<string, number | null> = { '/n26': 147, '/broken': null, '/n22': 127, '/n22b': 127 };
    expect(findNodeForAbi(127, ['/n26', '/broken', '/n22', '/n22b'], (p) => abi[p])).toBe('/n22');
    expect(findNodeForAbi(115, ['/n26', '/n22'], (p) => abi[p])).toBeNull();
  });

  it('every hook entry point runs the ABI check before it reads stdin or opens the DB', () => {
    const entries: Array<[string, string]> = [
      ['scripts/fact-extract-hook.js', 'readStdin()'],
      ['scripts/fact-consolidate-hook.js', 'readHookInput('],
      ['scripts/sync-import-hook.js', 'importFromSync()'],
      ['scripts/sync-export-hook.js', 'exportForSync()'],
      ['cli/memory-bank.js', 'switch (command)'],
      ['scripts/session-start-maintenance.js', 'main().catch'],
    ];
    for (const [file, firstUse] of entries) {
      const src = fs.readFileSync(path.join(REPO, file), 'utf8');
      expect(src, file).toContain("from '../dist/node-abi.js'");
      const guard = src.indexOf('ensureNativeAbi(');
      expect(guard, `${file}: ensureNativeAbi call`).toBeGreaterThan(-1);
      const use = src.indexOf(firstUse); // the FIRST use: the guard must precede every one
      expect(use, `${file}: ${firstUse} present`).toBeGreaterThan(-1);
      expect(guard, `${file}: guard before ${firstUse}`).toBeLessThan(use);
    }
    const inject = fs.readFileSync(path.join(REPO, 'scripts/inject-context.js'), 'utf8');
    expect(inject.indexOf('nativeAbiMismatch()')).toBeLessThan(inject.indexOf("import(path.join(__dirname, '../dist/inject-core.js'))"));
    const wrapper = fs.readFileSync(path.join(REPO, 'cli/mcp-server-wrapper.js'), 'utf8');
    // The long-lived wrapper checks in a child process (it must not map the addon itself).
    expect(wrapper).toMatch(/spawn\(compatibleNodeFor\(PLUGIN_ROOT, 'memory-bank wrapper'\) \?\? process\.execPath, \[SERVER_PATH\]/);
    expect(wrapper).not.toMatch(/\bcompatibleNode\(/);
  });

  it('rerunBudgetMs: what is left of the hook budget after the time used and the log margin; null below the minimum', () => {
    const opts = { budgetMs: 30_000, marginMs: 3_000, minMs: 3_000 };
    expect(rerunBudgetMs(400, opts)).toBe(26_600);
    expect(rerunBudgetMs(20_400, opts)).toBe(6_600); // after a full 20s daemon warming wait
    expect(rerunBudgetMs(24_000, opts)).toBe(3_000);
    expect(rerunBudgetMs(24_001, opts)).toBeNull();
  });

  it('rerunWithInput feeds the input and reports exit status, timeout — never a silent success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rerun-'));
    try {
      const echo = path.join(dir, 'echo.mjs');
      fs.writeFileSync(echo, "let s=''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { process.exitCode = s === 'hello' ? 0 : 7; });");
      expect(rerunWithInput(process.execPath, echo, 'hello', {})).toBeNull();
      expect(rerunWithInput(process.execPath, echo, 'other', {})).toBe('exit 7');
      const hang = path.join(dir, 'hang.mjs');
      fs.writeFileSync(hang, 'setTimeout(() => {}, 60000);');
      expect(rerunWithInput(process.execPath, hang, '', {}, 300)).toBe('timed out after 300ms');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Live reproduction: needs a second installed node with a different ABI (this
// machine: Homebrew node 26 = ABI 147 next to node 22 = ABI 127). Skipped elsewhere.
const otherNode = candidateNodePaths().find((p) => {
  const abi = probeNodeAbi(p);
  return abi !== null && abi !== Number(process.versions.modules);
});

describe.skipIf(!otherNode)('hooks under a node whose ABI does not match the addon', () => {
  it('sync-export-hook re-runs under a compatible node and exports instead of failing', () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-abi-'));
    const dbPath = path.join(cfg, 'db.sqlite');
    try {
      process.env.TEST_DB_PATH = dbPath;
      const db = initDatabase();
      insertFact(db, {
        fact: 'ABI guard keeps hooks alive', category: 'knowledge', scope_type: 'global', scope_project: null,
        source_exchange_ids: ['ex-1'], embedding: Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.05),
      });
      db.close();
      const r = spawnSync(otherNode!, ['scripts/sync-export-hook.js'], {
        cwd: REPO, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath, MEMORY_BANK_NODE_REEXEC: '' },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/NODE_MODULE_VERSION/);
      expect(r.stdout).toMatch(/sync-export: 1 facts/);
    } finally {
      delete process.env.TEST_DB_PATH;
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('the MCP wrapper under a mismatched node serves a DB-opening tool call (server child runs under a compatible node)', async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-abi-wrap-'));
    const dbPath = path.join(cfg, 'db.sqlite');
    process.env.TEST_DB_PATH = dbPath;
    initDatabase().close();
    delete process.env.TEST_DB_PATH;
    const child = spawn(otherNode!, ['cli/mcp-server-wrapper.js'], {
      cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath, MEMORY_BANK_WRAPPER_NO_NPM: '1', MEMORY_BANK_NODE_REEXEC: '' },
    });
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d; });
    const responses = new Map<number, Record<string, unknown>>();
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) > -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { const m = JSON.parse(line); if (typeof m.id === 'number') responses.set(m.id, m); } catch { /* not JSON-RPC */ }
      }
    });
    const send = (m: unknown) => child.stdin!.write(JSON.stringify(m) + '\n');
    const waitFor = async (id: number) => {
      for (let i = 0; i < 300 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 100));
      return responses.get(id);
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      expect(await waitFor(1), stderr).toBeTruthy();
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'graph_stats', arguments: {} } });
      const r = await waitFor(2) as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: unknown };
      expect(r, stderr).toBeTruthy();
      expect(r.error, JSON.stringify(r)).toBeUndefined();
      expect(r.result?.isError ?? false, JSON.stringify(r)).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/NODE_MODULE_VERSION/);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  }, 60_000);

  it('UserPromptSubmit injection under a mismatched node re-runs the cold path under a compatible one and logs it (no error line)', () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-abi-inject-'));
    const dbPath = path.join(cfg, 'db.sqlite');
    try {
      process.env.TEST_DB_PATH = dbPath;
      initDatabase().close();
      delete process.env.TEST_DB_PATH;
      const input = JSON.stringify({
        session_id: 'abi-inject', cwd: cfg, hook_event_name: 'UserPromptSubmit',
        prompt: 'How did we decide to compact the fact vector tables in memory-bank last week?',
      });
      const r = spawnSync(otherNode!, ['scripts/inject-context.js'], {
        cwd: REPO, encoding: 'utf8', timeout: 60_000, input,
        env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath, MEMORY_BANK_NODE_REEXEC: '', MEMORY_BANK_INJECT_FALLBACK_REASON: '' },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/NODE_MODULE_VERSION|re-run under .* failed/);
      const logFile = path.join(cfg, 'conversation-index', 'logs', 'inject-context.jsonl');
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const last = lines[lines.length - 1];
      expect(last.via, JSON.stringify(last)).toBe('fallback');
      expect(last.status, JSON.stringify(last)).not.toBe('error');
      expect(lines.filter((l) => l.status === 'error')).toEqual([]);
    } finally {
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  }, 90_000);

  it('UserPromptSubmit injection with no hook budget left records an error line instead of a re-run the host would cancel', () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-abi-budget-'));
    const dbPath = path.join(cfg, 'db.sqlite');
    try {
      process.env.TEST_DB_PATH = dbPath;
      initDatabase().close();
      delete process.env.TEST_DB_PATH;
      const input = JSON.stringify({
        session_id: 'abi-budget', cwd: cfg, hook_event_name: 'UserPromptSubmit',
        prompt: 'How did we decide to compact the fact vector tables in memory-bank last week?',
      });
      const r = spawnSync(otherNode!, ['scripts/inject-context.js'], {
        cwd: REPO, encoding: 'utf8', timeout: 60_000, input,
        env: {
          ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath, MEMORY_BANK_NODE_REEXEC: '',
          MEMORY_BANK_INJECT_FALLBACK_REASON: '', MEMORY_BANK_INJECT_HOOK_BUDGET_MS: '5000', // < used + 3s margin + 3s minimum
        },
      });
      expect(r.status, r.stderr).toBe(0);
      const lines = fs.readFileSync(path.join(cfg, 'conversation-index', 'logs', 'inject-context.jsonl'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].status).toBe('error');
      expect(lines[0].error).toMatch(/native-ABI re-run under .* failed: no time left in the 5000ms hook budget/);
    } finally {
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  }, 60_000);

  it('the re-run keeps the hook stdin: SessionStart key facts for the stdin cwd come out the same as under a matching node', () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-abi-stdin-'));
    const dbPath = path.join(cfg, 'db.sqlite');
    const proj = path.join(cfg, 'proj-from-stdin');
    try {
      process.env.TEST_DB_PATH = dbPath;
      const db = initDatabase();
      insertFact(db, {
        fact: 'Only visible when the hook reads cwd from stdin', category: 'decision', scope_type: 'project',
        scope_project: proj, source_exchange_ids: ['ex-1'], embedding: Array.from({ length: 384 }, (_, i) => Math.cos(i) * 0.05),
      });
      db.close();
      const hook = (node: string, input: string) => spawnSync(node, ['scripts/fact-consolidate-hook.js'], {
        cwd: REPO, encoding: 'utf8', timeout: 60_000, input,
        env: { ...process.env, MEMORY_BANK_CONFIG_DIR: cfg, MEMORY_BANK_DB_PATH: dbPath, MEMORY_BANK_SESSION_START_SPAWN: '0', MEMORY_BANK_NODE_REEXEC: '' },
      });
      const stdin = (sid: string) => JSON.stringify({ session_id: sid, cwd: proj, hook_event_name: 'SessionStart' });
      const control = hook(process.execPath, stdin('abi-stdin-control')); // separate session ids: separate ledgers
      expect(control.status, control.stderr).toBe(0);
      expect(control.stdout).toContain('Only visible when the hook reads cwd from stdin');
      const noStdin = hook(process.execPath, '');
      expect(noStdin.stdout).not.toContain('Only visible when the hook reads cwd from stdin');
      const viaReexec = hook(otherNode!, stdin('abi-stdin-reexec'));
      expect(viaReexec.status, viaReexec.stderr).toBe(0);
      expect(viaReexec.stderr).not.toMatch(/NODE_MODULE_VERSION/);
      expect(viaReexec.stdout).toBe(control.stdout);
    } finally {
      delete process.env.TEST_DB_PATH;
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  });
});
