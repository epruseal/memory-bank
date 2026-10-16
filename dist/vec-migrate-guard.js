import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareVersions } from './version-guard.js';
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
export const VEC_SCALE_MIN_VERSION = '1.7.7';
/** A process that started within this window after its package.json changed is ambiguous. */
const START_MARGIN_MS = 2_000;
const CODE_PATH_RE = /(\/\S*?)\/(?:dist|scripts|cli)\/[^\s/]+\.(?:m?js|cjs)(?=\s|$)/;
/** The package root a node command runs code from (…/<root>/dist|scripts|cli/x.js), or null. */
export function holderCodeRoot(command) {
    const m = CODE_PATH_RE.exec(command);
    return m ? m[1] : null;
}
/** ps etime ([[dd-]hh:]mm:ss) → seconds, null when unparseable. */
export function parseEtime(etime) {
    const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(etime);
    if (!m)
        return null;
    const [, d, h, mi, s] = m;
    return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s);
}
export function readCodeRoot(root) {
    try {
        const p = path.join(root, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (typeof pkg.version !== 'string' || !pkg.version)
            return null;
        return { version: pkg.version, mtimeMs: fs.statSync(p).mtimeMs };
    }
    catch {
        return null;
    }
}
export function assessDbHolders(holders, readRoot = readCodeRoot, minVersion = VEC_SCALE_MIN_VERSION) {
    return holders.map((h) => {
        const verdict = (ok, reason) => ({ pid: h.pid, ok, reason, command: h.command });
        const root = holderCodeRoot(h.command);
        if (!root)
            return verdict(false, 'unrecognized process (not memory-bank code)');
        const info = readRoot(root);
        if (!info)
            return verdict(false, `no readable package.json under ${root}`);
        if (compareVersions(info.version, minVersion) < 0) {
            return verdict(false, `runs ${info.version} < ${minVersion}`);
        }
        if (h.startedAtMs === null)
            return verdict(false, 'start time unknown');
        if (h.startedAtMs < info.mtimeMs + START_MARGIN_MS) {
            return verdict(false, `started before its code was updated to ${info.version} (still runs the old code)`);
        }
        return verdict(true, `runs ${info.version}`);
    });
}
/**
 * Every OTHER process with the DB (or its WAL) open, via lsof + ps. Throws when
 * lsof is unavailable — the caller must treat "cannot tell" as "not safe".
 */
export function listDbHolders(dbPath, selfPid = process.pid) {
    let out = '';
    try {
        out = execFileSync('lsof', ['-F', 'p', '--', dbPath, `${dbPath}-wal`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch (e) {
        // lsof exits 1 when no process has the files open — that is an answer, not a failure.
        const err = e;
        if (err.code === 'ENOENT')
            throw new Error('lsof is not available — cannot verify which processes hold the DB');
        if (err.status === 1)
            out = err.stdout ?? '';
        else
            throw new Error(`lsof failed: ${e instanceof Error ? e.message : e}`);
    }
    const pids = [...new Set(out.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))))]
        .filter((p) => Number.isInteger(p) && p > 0 && p !== selfPid);
    const now = Date.now();
    return pids.map((pid) => {
        let command = '';
        let startedAtMs = null;
        try {
            command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
            const secs = parseEtime(execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }));
            startedAtMs = secs === null ? null : now - secs * 1000;
        }
        catch {
            // exited between lsof and ps — reported as unknown, which blocks; a retry clears it
        }
        return { pid, command, startedAtMs };
    });
}
function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * Installed memory-bank plugin dirs (<cache>/<marketplace>/memory-bank/<ver>/)
 * whose CONTENT version is below minVersion — any hook spawned from one would
 * run old code. Missing cache root = no installs (dev checkout) = none.
 * MEMORY_BANK_PLUGIN_CACHE_DIR points it at another cache root (tests, copies).
 */
export function staleInstallDirs(minVersion = VEC_SCALE_MIN_VERSION, cacheRoot = process.env.MEMORY_BANK_PLUGIN_CACHE_DIR || path.join(os.homedir(), '.claude', 'plugins', 'cache')) {
    const stale = [];
    const list = (d) => { try {
        return fs.readdirSync(d);
    }
    catch {
        return [];
    } };
    for (const market of list(cacheRoot)) {
        const pluginDir = path.join(cacheRoot, market, 'memory-bank');
        for (const ver of list(pluginDir)) {
            if (ver.startsWith('.'))
                continue; // .live-apply.lock and other bookkeeping, not a release
            const dir = path.join(pluginDir, ver);
            if (!isDir(dir))
                continue;
            // No readable package.json = cannot tell which code a hook spawned from here runs → blocks.
            const info = readCodeRoot(dir);
            if (!info || compareVersions(info.version, minVersion) < 0)
                stale.push({ dir, version: info?.version ?? null });
        }
    }
    return stale;
}
function isMemoryBankRoot(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'memory-bank';
    }
    catch {
        return false;
    }
}
/** Is `p` the directory `root` or inside it (a path boundary, not a string prefix)? */
export function isInside(p, root) {
    const rel = path.relative(root, p);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
/**
 * The supervising MCP wrapper never opens the DB: it proxies stdio and spawns
 * dist/mcp-server.js from disk, so after live-apply its child runs new code
 * while the wrapper itself keeps its old start time. Judging the wrapper would
 * block until the session restarts; its child is what is judged.
 */
const NEVER_OPENS_DB_RE = /\/cli\/mcp-server-wrapper\.js(?=\s|$)/;
/**
 * Every OTHER running process whose code root (holderCodeRoot) is a memory-bank
 * package, whether or not it has the DB open yet. Throws when ps fails.
 * MEMORY_BANK_PROCESS_SCAN_ROOT limits the scan to code roots inside one dir
 * (tests: a migration on a temp DB must not be blocked by this machine's sessions).
 */
export function listMemoryBankProcesses(selfPid = process.pid, scanRoot = process.env.MEMORY_BANK_PROCESS_SCAN_ROOT || undefined) {
    const out = execFileSync('ps', ['-axww', '-o', 'pid=,etime=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const now = Date.now();
    const found = [];
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m)
            continue;
        const pid = Number(m[1]);
        if (pid === selfPid)
            continue;
        if (NEVER_OPENS_DB_RE.test(m[3]))
            continue;
        const root = holderCodeRoot(m[3]);
        if (!root || (scanRoot && !isInside(root, scanRoot)) || !isMemoryBankRoot(root))
            continue;
        const secs = parseEtime(m[2]);
        found.push({ pid, command: m[3], startedAtMs: secs === null ? null : now - secs * 1000 });
    }
    return found;
}
