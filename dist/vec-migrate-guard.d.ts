/**
 * Guard for format changes that OLD code would misread.
 *
 * Moving the fact-side vec tables to int8 at scale 600 is safe only when every
 * process that has the DB open decodes with the recorded scale. A reader from
 * ≤1.7.6 decodes every int8 table at 127, so a scale-600 table looks ~4.7×
 * farther away: no fact passes the similarity gate and that session silently
 * stops injecting; an old writer would store scale-127 blobs into the
 * scale-600 table. live-apply rotates running sessions onto new code within
 * about a poll interval, so the migration waits for that instead of racing it.
 *
 * A holder counts as new code only when (a) its code root's package.json is at
 * least VEC_SCALE_MIN_VERSION AND (b) the process started after that
 * package.json was written (otherwise it still runs the old code it loaded).
 * Anything it cannot classify blocks — an unknown holder is not proof of safety.
 *
 * Holders are a snapshot: a short-lived hook or worker that opens the DB a
 * moment later is not in it. Those are spawned from the plugin cache dirs, so
 * staleInstallDirs() also requires every installed memory-bank dir to carry
 * new code already (live-apply copies the newest release into older dirs).
 * A long-lived process that has not opened the DB YET (the MCP server opens it
 * on the first search) is not an lsof holder either, so listMemoryBankProcesses()
 * adds every running process whose code root is a memory-bank package.
 */
/** First release whose readers decode fact-side int8 tables at their recorded scale. */
export declare const VEC_SCALE_MIN_VERSION = "1.7.7";
export interface DbHolder {
    pid: number;
    command: string;
    /** Wall-clock start of the process (from ps etime), null when unknown. */
    startedAtMs: number | null;
}
export interface HolderVerdict {
    pid: number;
    ok: boolean;
    reason: string;
    command: string;
}
export interface CodeRootInfo {
    version: string;
    mtimeMs: number;
}
/** The package root a node command runs code from (…/<root>/dist|scripts|cli/x.js), or null. */
export declare function holderCodeRoot(command: string): string | null;
/** ps etime ([[dd-]hh:]mm:ss) → seconds, null when unparseable. */
export declare function parseEtime(etime: string): number | null;
export declare function readCodeRoot(root: string): CodeRootInfo | null;
export declare function assessDbHolders(holders: DbHolder[], readRoot?: (root: string) => CodeRootInfo | null, minVersion?: string): HolderVerdict[];
/**
 * Every OTHER process with the DB (or its WAL) open, via lsof + ps. Throws when
 * lsof is unavailable — the caller must treat "cannot tell" as "not safe".
 */
export declare function listDbHolders(dbPath: string, selfPid?: number): DbHolder[];
/**
 * Installed memory-bank plugin dirs (<cache>/<marketplace>/memory-bank/<ver>/)
 * whose CONTENT version is below minVersion — any hook spawned from one would
 * run old code. Missing cache root = no installs (dev checkout) = none.
 * MEMORY_BANK_PLUGIN_CACHE_DIR points it at another cache root (tests, copies).
 */
export declare function staleInstallDirs(minVersion?: string, cacheRoot?: string): Array<{
    dir: string;
    version: string | null;
}>;
/** Is `p` the directory `root` or inside it (a path boundary, not a string prefix)? */
export declare function isInside(p: string, root: string): boolean;
/**
 * Every OTHER running process whose code root (holderCodeRoot) is a memory-bank
 * package, whether or not it has the DB open yet. Throws when ps fails.
 * MEMORY_BANK_PROCESS_SCAN_ROOT limits the scan to code roots inside one dir
 * (tests: a migration on a temp DB must not be blocked by this machine's sessions).
 */
export declare function listMemoryBankProcesses(selfPid?: number, scanRoot?: string | undefined): DbHolder[];
