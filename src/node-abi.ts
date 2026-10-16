import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Native-ABI guard for hook entry points. Node builtins only.
 *
 * Hooks are registered as `node <script>`, so they run under whatever `node`
 * the host's PATH resolves first — and every worker they spawn inherits it via
 * process.execPath. better-sqlite3 is a native addon built for ONE ABI. On a
 * machine with Homebrew node 26 (ABI 147) first in some hosts' PATH and the
 * plugin's addon built under node 22 (ABI 127), every such hook died at its
 * first `new Database()`:
 *   "...compiled against a different Node.js version using NODE_MODULE_VERSION
 *    127. This version of Node.js requires NODE_MODULE_VERSION 147."
 * Measured 2026-10-16: 10,630 such lines in fact-extract.log and 20,066 in
 * fact-consolidate.log (last 2026-10-16T01:08Z) — fact extraction silently
 * failing for those sessions.
 *
 * ensureNativeAbi() runs first in each entry point: when the addon cannot load
 * because of the ABI, it re-runs the same script under an installed node whose
 * ABI matches (stdio inherited, so the hook's stdin JSON still flows through)
 * and exits with that run's status. No matching node → a loud stderr line and
 * the script continues to fail as before (visibly, never silently).
 */

const REEXEC_ENV = 'MEMORY_BANK_NODE_REEXEC';
/** Bound for one candidate probe (a hung child must not hold the hook). */
const PROBE_TIMEOUT_MS = 3_000;
/**
 * Default bound for a stdin re-run (rerunWithInput). A caller with a known
 * budget passes its own: inject-context passes what is left of the 30s
 * UserPromptSubmit hook budget after its own run time.
 */
const RERUN_TIMEOUT_MS = 25_000;

/** NODE_MODULE_VERSION a native module was built for, parsed from Node's dlopen error; null for any other error. */
export function requiredNativeAbi(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /compiled against a different Node\.js version using\s+NODE_MODULE_VERSION (\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}

function readDirNames(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Installed node binaries to try, in order: MEMORY_BANK_NODE, every PATH
 * entry, then Homebrew keg-only node@N, nvm, volta, fnm, asdf and the usual
 * system paths. Only existing files are returned, each once.
 */
export function candidateNodePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  exists: (p: string) => boolean = fs.existsSync,
  listDir: (dir: string) => string[] = readDirNames,
): string[] {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const out: string[] = [];
  const add = (p: string | undefined) => { if (p && !out.includes(p) && exists(p)) out.push(p); };
  add(env.MEMORY_BANK_NODE);
  for (const dir of (env.PATH ?? '').split(path.delimiter)) if (dir) add(path.join(dir, exe));
  for (const kegRoot of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const name of listDir(kegRoot)) if (/^node(@\d+)?$/.test(name)) add(path.join(kegRoot, name, 'bin', exe));
  }
  const managers: Array<[string, string[]]> = [
    [path.join(home, '.nvm', 'versions', 'node'), ['bin', exe]],
    [path.join(home, '.volta', 'tools', 'image', 'node'), ['bin', exe]],
    [path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin', exe]],
    [path.join(home, '.asdf', 'installs', 'nodejs'), ['bin', exe]],
  ];
  for (const [base, rel] of managers) for (const v of listDir(base)) add(path.join(base, v, ...rel));
  add('/usr/local/bin/node');
  add('/usr/bin/node');
  return out;
}

/** The ABI a node binary reports, null when it cannot be run. */
export function probeNodeAbi(nodePath: string): number | null {
  const r = spawnSync(nodePath, ['-p', 'process.versions.modules'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (r.status !== 0) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isInteger(n) ? n : null;
}

/** First candidate whose ABI equals `abi`, or null. */
export function findNodeForAbi(
  abi: number,
  candidates: string[],
  probe: (nodePath: string) => number | null = probeNodeAbi,
): string | null {
  for (const c of candidates) if (probe(c) === abi) return c;
  return null;
}

/**
 * Load better-sqlite3's native addon in this process. Returns the ABI it needs
 * when it cannot load because of an ABI mismatch, null when it loads (or fails
 * for some other reason — that failure belongs to the caller's own error path).
 */
export function nativeAbiMismatch(): number | null {
  try {
    // createRequire: the one sanctioned require (CLAUDE.md, ESM Module System) —
    // a synchronous, catchable load; a static import would fail before any code runs.
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return null;
  } catch (e) {
    return requiredNativeAbi(e);
  }
}

/**
 * The same check in a short-lived child, for long-lived processes (the MCP
 * wrapper) that must not map the addon themselves: a later in-place npm
 * rebuild of a mapped .node file can get the mapping process killed.
 * `root` is the package root whose node_modules to load from.
 */
export function childNativeAbiMismatch(root: string, node: string = process.execPath): number | null {
  const r = spawnSync(node, ['-e',
    "const D=require('module').createRequire(process.argv[1])('better-sqlite3'); new D(':memory:').close()",
    path.join(root, 'package.json')], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS * 2 });
  return r.status === 0 ? null : requiredNativeAbi(String(r.stderr));
}

function nodeForAbi(label: string, need: number): string | null {
  const node = findNodeForAbi(need, candidateNodePaths().filter((p) => p !== process.execPath));
  if (!node) {
    console.error(`${label}: better-sqlite3 needs NODE_MODULE_VERSION ${need} but ${process.execPath} is ` +
      `${process.versions.modules} and no installed node matches — set MEMORY_BANK_NODE to a node with ABI ${need}`);
  }
  return node;
}

/** A node binary that can load the installed addon: this one, or a matching install; null when none. */
export function compatibleNode(label: string): string | null {
  const need = nativeAbiMismatch();
  return need === null ? process.execPath : nodeForAbi(label, need);
}

/** compatibleNode for a long-lived caller — checks in a child process (see childNativeAbiMismatch). */
export function compatibleNodeFor(root: string, label: string): string | null {
  const need = childNativeAbiMismatch(root);
  return need === null ? process.execPath : nodeForAbi(label, need);
}

/**
 * Call first in a hook entry point, before reading stdin. On an ABI mismatch,
 * re-run this script under a compatible node and exit with its status.
 * No time bound of its own: the child IS this script (same work, same stdin),
 * so whatever limits the script — the hook timeout, a CLI user — limits it;
 * a fixed bound here would cut long CLI runs (sync, reindex) short.
 */
export function ensureNativeAbi(label: string): void {
  if (nativeAbiMismatch() === null) return;
  if (process.env[REEXEC_ENV]) {
    console.error(`${label}: native ABI still mismatched after re-exec under ${process.execPath}`);
    return;
  }
  const node = compatibleNode(label);
  if (!node || node === process.execPath) return;
  const r = spawnSync(node, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, [REEXEC_ENV]: '1' },
  });
  if (r.error) {
    console.error(`${label}: re-exec under ${node} failed: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

/**
 * Time a re-run may take inside a hook that the host cancels at `budgetMs`
 * after start: the budget minus what this process already used and a margin
 * to write the outcome. Null when that leaves less than `minMs` — too little
 * for the work, so the caller records the miss instead of starting a run the
 * host will cancel with no trace.
 */
export function rerunBudgetMs(elapsedMs: number, opts: { budgetMs: number; marginMs: number; minMs: number }): number | null {
  const left = opts.budgetMs - opts.marginMs - elapsedMs;
  return left >= opts.minMs ? left : null;
}

/**
 * For callers that already consumed stdin: run `script` under `node`, feeding
 * `input`. Returns null on exit 0, else why it failed (spawn error, timeout,
 * signal, exit status) — the caller must record it, not report success.
 */
export function rerunWithInput(
  node: string, script: string, input: string, extraEnv: Record<string, string>,
  timeoutMs: number = RERUN_TIMEOUT_MS,
): string | null {
  const r = spawnSync(node, [script], {
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, [REEXEC_ENV]: '1', ...extraEnv },
    timeout: timeoutMs,
  });
  let failure: string | null = null;
  if (r.error) failure = /ETIMEDOUT/.test(r.error.message) ? `timed out after ${timeoutMs}ms` : r.error.message;
  else if (r.signal) failure = `killed by ${r.signal}`;
  else if (r.status !== 0) failure = `exit ${r.status}`;
  if (failure) console.error(`${path.basename(script)}: re-run under ${node} failed: ${failure}`);
  return failure;
}
