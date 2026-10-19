import fs from 'fs';
import os from 'os';
import path from 'path';
/**
 * Repository family of a working directory — the read-side scope widening the
 * injection bench evaluates (plan 2026-10-19, candidate C2).
 *
 * facts.scope_project is the exact cwd a fact was extracted in, so a session in
 * a worktree (`<repo>/.auto-issue-worktrees/issue-12`) or a sub-folder
 * (`<repo>/docs`) never sees the repo's own project facts, and the repo never
 * sees what its worktrees learned. The family is the git top-level of the cwd
 * plus, for a linked worktree, the main repository root; a fact is in the
 * family when its scope_project is one of those roots or lies under one —
 * but not inside another repository nested there (a separate clone or a
 * submodule); a linked worktree of a family root is not "another repository".
 * The widening is one-way for worktrees placed outside the repository folder
 * (a sibling `.auto-issue-worktrees/` folder): such a worktree sees the
 * repository's facts, the repository does not see the worktree's.
 *
 * Resolved from the filesystem only (no `git` process — the injection hook has
 * a hard time budget). A root is a real repository: a `.git` directory holding
 * HEAD, or a `.git` file naming an existing git dir (a folder holding HEAD); anything else named
 * `.git` (garbage, an empty folder, a symlink) means no family. A root is never
 * a home directory ($HOME or the account's own — HOME can be overridden), an
 * ancestor of one, or '/': a home directory that is itself a git work tree
 * would otherwise make every non-repo folder under it one family with every
 * project. Relative paths (slug-form projects) have no family, and neither has
 * a cwd whose last component is a symbolic link or a file. A path that cannot
 * be read (EACCES, EIO) counts as no family / outside it, never as absent.
 */
const WORKTREE_CONTAINERS = ['/.auto-issue-worktrees/', '/.claude/worktrees/'];
const CACHE_LIMIT = 256;
/** A daemon outlives a folder: the same path can become another repository (or none). */
const CACHE_TTL_MS = 60_000;
const cache = new Map();
/** A path that exists but cannot be read (EACCES, EIO, …) — never read as "absent" (that would be fail-open). */
const UNREADABLE = Symbol('unreadable');
/** lstat of a path: null only when it does not exist (ENOENT / ENOTDIR), UNREADABLE on any other error. */
function lstat(p) {
    try {
        return fs.lstatSync(p);
    }
    catch (e) {
        const code = e.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? null : UNREADABLE;
    }
}
function stat(p) {
    const st = lstat(p);
    return st === UNREADABLE ? null : st;
}
function isDir(p) {
    return stat(p)?.isDirectory() === true;
}
/** A git HEAD: a regular file, or a symbolic link (git's core.preferSymlinkRefs) — never a folder. */
function isHead(p) {
    const st = stat(p);
    return st !== null && (st.isFile() || st.isSymbolicLink());
}
function homes() {
    const out = [path.resolve(os.homedir())];
    try {
        out.push(path.resolve(os.userInfo().homedir));
    }
    catch { /* no account entry */ }
    return out;
}
/** Comparison key of a path: macOS and Windows default to case-insensitive names ('/users/x' is the home '/Users/x'). */
function fold(p) {
    return process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
}
/** A root that would swallow unrelated projects: '/', a home directory, or any ancestor of one. */
function tooBroad(root) {
    const r = fold(root);
    return root === path.parse(root).root || homes().some((h) => {
        const home = fold(h);
        return home === r || home.startsWith(r + path.sep);
    });
}
/** A main repository root: `<root>/.git` is a directory (not a symlink) holding a HEAD. */
function isRepoRoot(root) {
    return isDir(path.join(root, '.git')) && isHead(path.join(root, '.git', 'HEAD'));
}
/**
 * Main repository root behind a linked worktree whose `.git` file names
 * `adminDir`, or null. adminDir must be `<R>/.git/worktrees/<name>`, R a
 * repository root, and the admin dir's own `gitdir` back-reference must name
 * this worktree's `.git` file — so a forged `.git` file cannot pull another
 * project's facts into this one.
 */
function mainRootOf(worktreeTop, adminDir) {
    const parts = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(adminDir);
    if (!parts)
        return null;
    const root = parts[1];
    if (!isRepoRoot(root))
        return null;
    const backFile = path.join(adminDir, 'gitdir');
    if (stat(backFile)?.isFile() !== true)
        return null; // never read a FIFO or a device (the hook would block)
    let back;
    try {
        back = fs.readFileSync(backFile, 'utf8').trim();
    }
    catch {
        return null;
    }
    if (path.resolve(adminDir, back) !== path.join(worktreeTop, '.git'))
        return null;
    return root;
}
/** What `<dir>/.git` makes of dir. */
function dotGitOf(dir) {
    const st = lstat(path.join(dir, '.git'));
    if (st === UNREADABLE)
        return { kind: 'invalid' }; // cannot tell — fail closed
    if (!st)
        return { kind: 'none' };
    if (st.isDirectory())
        return isRepoRoot(dir) ? { kind: 'root' } : { kind: 'invalid' };
    if (!st.isFile())
        return { kind: 'invalid' };
    let content;
    try {
        content = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    }
    catch {
        return { kind: 'invalid' };
    }
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    if (!m)
        return { kind: 'invalid' };
    const adminDir = path.resolve(dir, m[1]);
    // A git dir holds a HEAD file (git's own test) — `gitdir: .` or any other plain folder is not one.
    if (!isDir(adminDir) || !isHead(path.join(adminDir, 'HEAD')))
        return { kind: 'invalid' };
    return { kind: 'linked', main: mainRootOf(dir, adminDir) };
}
function resolveUncached(cwd) {
    if (!path.isAbsolute(cwd))
        return [];
    const start = path.resolve(cwd);
    const own = lstat(start);
    // Something there that is not a folder — a symbolic link, a file, an unreadable entry — has no family
    // (a link under a worktree container must not borrow the container's repository).
    if (own !== null && (own === UNREADABLE || !own.isDirectory()))
        return [];
    if (own === null) {
        // A deleted worktree (replayed history): its container names the repo — when the
        // folder in front of the container is itself a repository root (an umbrella folder
        // holding worktrees of several repositories is not).
        for (const marker of WORKTREE_CONTAINERS) {
            const i = start.indexOf(marker);
            if (i > 0) {
                const root = start.slice(0, i);
                return !tooBroad(root) && isRepoRoot(root) ? [root] : [];
            }
        }
        return [];
    }
    for (let dir = start;; dir = path.dirname(dir)) {
        const g = dotGitOf(dir);
        if (g.kind !== 'none') {
            if (g.kind === 'invalid' || tooBroad(dir))
                return [];
            if (g.kind === 'root')
                return [dir];
            return g.main && !tooBroad(g.main) && g.main !== dir ? [dir, g.main] : [dir];
        }
        if (dir === path.dirname(dir))
            return [];
    }
}
/**
 * Family roots of `cwd` ([] = no family: not in a repository, or only a too-broad one) — the
 * worktree's own top first, then (for a linked worktree) the main repository root, so the last
 * root is always the repository. Cached per cwd for a minute.
 */
export function resolveRepoRoots(cwd) {
    const now = Date.now();
    const hit = cache.get(cwd);
    if (hit && now - hit.at < CACHE_TTL_MS)
        return hit.roots;
    const roots = resolveUncached(cwd);
    if (cache.size >= CACHE_LIMIT)
        cache.clear();
    cache.set(cwd, { roots, at: now });
    return roots;
}
/** Test hook — the cache is per process and keyed by cwd. */
export function clearRepoRootCache() {
    cache.clear();
}
/**
 * Whether the first missing folder `missing` on the way to `scopeProject` is a deleted worktree of
 * `root`: the path lies in one of the root's own worktree containers and what is gone is the
 * container itself or a worktree folder directly in it — not something deeper (a clone deleted from
 * inside a live worktree could have been another repository).
 */
function deletedWorktreeOf(root, scopeProject, missing) {
    return WORKTREE_CONTAINERS.some((c) => {
        const base = root + c; // '<root>/.claude/worktrees/'
        return scopeProject.startsWith(base) && (base.startsWith(missing + '/') || path.dirname(missing) + '/' === base);
    });
}
/**
 * Whether `scopeProject`, strictly under `root`, is left out of the family:
 * a folder on the way (or the path itself) has its own `.git` that is not a
 * linked worktree of a family root (a separate clone, a submodule). A folder
 * that no longer exists ends the walk: the path stays in the family only under
 * a worktree container of the root (`<root>/.claude/worktrees/…`,
 * `<root>/.auto-issue-worktrees/…` — a deleted worktree of this repository,
 * see deletedWorktreeOf). A folder that cannot be read excludes the path.
 * Any other deleted path may have been another repository, and nothing on disk
 * can tell, so it is left out — at the cost of facts from deleted plain
 * sub-folders of the repository.
 */
function excludedUnderRoot(root, scopeProject, roots) {
    let dir = root;
    for (const seg of scopeProject.slice(root.length + 1).split('/')) {
        if (!seg)
            continue;
        dir = path.join(dir, seg);
        const st = lstat(dir);
        if (st === UNREADABLE)
            return true; // cannot tell — fail closed
        if (!st)
            return !deletedWorktreeOf(root, scopeProject, dir);
        const g = dotGitOf(dir);
        if (g.kind === 'none')
            continue;
        if (g.kind === 'linked' && g.main !== null && roots.includes(g.main))
            continue;
        return true;
    }
    return false;
}
/**
 * Whether a project-scoped fact's scope_project is visible from `project`.
 * The single predicate behind the KNN scope filter, the relation scope filter
 * and the replay bench. family=false (and family=true with no roots) is the
 * exact match the injection has always used; family=true matches a root or a
 * path under it — on a '/' boundary, so `memory-bank` never matches
 * `memory-bank-cloud`, never inside a repository nested under a root, and a
 * deleted path only inside a worktree container of the root. A
 * path with '.' or '..' segments matches only exactly. A null project sees
 * every scope.
 */
export function scopeMatcher(project, family) {
    if (!project)
        return () => true;
    if (!family)
        return (scopeProject) => scopeProject === project;
    const roots = resolveRepoRoots(project);
    if (roots.length === 0)
        return (scopeProject) => scopeProject === project;
    const memo = new Map();
    const inFamily = (s) => {
        if (s.split('/').some((seg) => seg === '.' || seg === '..'))
            return false;
        return roots.some((r) => s === r || (s.startsWith(r + '/') && !excludedUnderRoot(r, s, roots)));
    };
    return (scopeProject) => {
        if (scopeProject === project)
            return true;
        if (scopeProject == null)
            return false;
        let hit = memo.get(scopeProject);
        if (hit === undefined) {
            hit = inFamily(scopeProject);
            memo.set(scopeProject, hit);
        }
        return hit;
    };
}
