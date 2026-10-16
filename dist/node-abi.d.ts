/** NODE_MODULE_VERSION a native module was built for, parsed from Node's dlopen error; null for any other error. */
export declare function requiredNativeAbi(err: unknown): number | null;
/**
 * Installed node binaries to try, in order: MEMORY_BANK_NODE, every PATH
 * entry, then Homebrew keg-only node@N, nvm, volta, fnm, asdf and the usual
 * system paths. Only existing files are returned, each once.
 */
export declare function candidateNodePaths(env?: NodeJS.ProcessEnv, home?: string, exists?: (p: string) => boolean, listDir?: (dir: string) => string[]): string[];
/** The ABI a node binary reports, null when it cannot be run. */
export declare function probeNodeAbi(nodePath: string): number | null;
/** First candidate whose ABI equals `abi`, or null. */
export declare function findNodeForAbi(abi: number, candidates: string[], probe?: (nodePath: string) => number | null): string | null;
/**
 * Load better-sqlite3's native addon in this process. Returns the ABI it needs
 * when it cannot load because of an ABI mismatch, null when it loads (or fails
 * for some other reason — that failure belongs to the caller's own error path).
 */
export declare function nativeAbiMismatch(): number | null;
/**
 * The same check in a short-lived child, for long-lived processes (the MCP
 * wrapper) that must not map the addon themselves: a later in-place npm
 * rebuild of a mapped .node file can get the mapping process killed.
 * `root` is the package root whose node_modules to load from.
 */
export declare function childNativeAbiMismatch(root: string, node?: string): number | null;
/** A node binary that can load the installed addon: this one, or a matching install; null when none. */
export declare function compatibleNode(label: string): string | null;
/** compatibleNode for a long-lived caller — checks in a child process (see childNativeAbiMismatch). */
export declare function compatibleNodeFor(root: string, label: string): string | null;
/**
 * Call first in a hook entry point, before reading stdin. On an ABI mismatch,
 * re-run this script under a compatible node and exit with its status.
 * No time bound of its own: the child IS this script (same work, same stdin),
 * so whatever limits the script — the hook timeout, a CLI user — limits it;
 * a fixed bound here would cut long CLI runs (sync, reindex) short.
 */
export declare function ensureNativeAbi(label: string): void;
/**
 * Time a re-run may take inside a hook that the host cancels at `budgetMs`
 * after start: the budget minus what this process already used and a margin
 * to write the outcome. Null when that leaves less than `minMs` — too little
 * for the work, so the caller records the miss instead of starting a run the
 * host will cancel with no trace.
 */
export declare function rerunBudgetMs(elapsedMs: number, opts: {
    budgetMs: number;
    marginMs: number;
    minMs: number;
}): number | null;
/**
 * For callers that already consumed stdin: run `script` under `node`, feeding
 * `input`. Returns null on exit 0, else why it failed (spawn error, timeout,
 * signal, exit status) — the caller must record it, not report success.
 */
export declare function rerunWithInput(node: string, script: string, input: string, extraEnv: Record<string, string>, timeoutMs?: number): string | null;
