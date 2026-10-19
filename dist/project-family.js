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
 * project. Relative paths have no family here (callers resolve a slug-form
 * project to a path first — canonicalizeProject — and use that path's family),
 * and neither has a cwd that is a symbolic link or a file, or that has a
 * symbolic link between it and its repository root — the root itself included (a
 * link can point into another repository, and a link's target can change under
 * the same path). Links above the root are not looked at: the scope is a path,
 * as the exact-path project scope always was. A path that cannot be read (EACCES, EIO) counts as no family / outside
 * it, never as absent. A path that no longer exists has no family and is never
 * in one: nothing on disk tells which repository it was (a deleted worktree, a
 * deleted clone, another repository's layer in a container all look the same),
 * so facts learned in a since-deleted worktree are not seen by its repository.
 * Inside a worktree container only the family's linked worktrees count, for a cwd
 * and a fact path alike (a plain folder there may hold another repository's
 * worktrees); the container is the one of the repository or worktree the path
 * is in, its name compared case-folded on macOS and Windows. The worktrees of a
 * bare repository (`<dir>/.bare/worktrees/…`) are not grouped: each one is its
 * own family.
 */
/** Worktree containers of a repository root (`<root>/.claude/worktrees/<name>`) — the one list. */
export const WORKTREE_CONTAINERS = Object.freeze(['/.auto-issue-worktrees/', '/.claude/worktrees/']);
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
    const rootSt = lstat(root);
    if (rootSt === null || rootSt === UNREADABLE || rootSt.isSymbolicLink() || !isRepoRoot(root))
        return null; // a link named as the main root can change target
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
    // Nothing there, or something that is not a folder — a symbolic link, a file, an unreadable entry — has no
    // family (a link under a worktree container must not borrow the container's repository; a deleted path could
    // have been any repository).
    if (own === null || own === UNREADABLE || !own.isDirectory())
        return [];
    for (let dir = start;; dir = path.dirname(dir)) {
        // A link on the way up to the repository root, the root included: the repository found is the
        // one the link sits in (or the link's current target), not where the cwd's facts were made.
        const st = dir === start ? own : lstat(dir);
        if (st === UNREADABLE || (st !== null && st.isSymbolicLink()))
            return [];
        const g = dotGitOf(dir);
        if (g.kind !== 'none') {
            if (g.kind === 'invalid' || tooBroad(dir))
                return [];
            const roots = g.kind === 'root' ? [dir] : g.main && !tooBroad(g.main) && g.main !== dir ? [dir, g.main] : [dir];
            // The way down to the cwd passes the same test as a fact path: a plain folder in a worktree container
            // (another repository's layer, `ORG-REPO/…`) must not borrow the container's repository.
            return dir !== start && excludedUnderRoot(dir, start, roots) ? [] : roots;
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
 * Whether `scopeProject`, strictly under `root`, is left out of the family:
 * a folder on the way (or the path itself) no longer exists or cannot be read
 * (nothing tells which repository it was — fail closed), is a symbolic link (it
 * can point into another repository), has its own `.git` that is not a linked
 * worktree of a family root (a separate clone, a submodule), or sits directly in
 * a worktree container of the root without being a family worktree (a plain
 * folder there may be another repository's layer, `ORG-REPO/…`).
 */
function excludedUnderRoot(root, scopeProject, roots) {
    let dir = root;
    let top = root; // the repository or family worktree the walk is in: its containers are the ones that count
    for (const seg of scopeProject.slice(root.length + 1).split('/')) {
        if (!seg)
            continue;
        const parent = dir;
        dir = path.join(dir, seg);
        const st = lstat(dir);
        if (st === null || st === UNREADABLE || st.isSymbolicLink())
            return true;
        const g = dotGitOf(dir);
        const familyWorktree = g.kind === 'linked' && g.main !== null && roots.includes(g.main);
        if (inWorktreeContainer(parent, top) && !familyWorktree)
            return true;
        if (familyWorktree) {
            top = dir;
            continue;
        }
        if (g.kind === 'none')
            continue;
        return true;
    }
    return false;
}
/** Whether `parent` is one of `top`'s worktree containers (case folded where names are: '.Claude/Worktrees' is the same folder). */
function inWorktreeContainer(parent, top) {
    return WORKTREE_CONTAINERS.some((c) => fold(parent + '/') === fold(top + c));
}
/**
 * Whether a project-scoped fact's scope_project is visible from `project`.
 * The single predicate behind the KNN scope filter, the relation scope filter
 * and the replay bench. family=false (and family=true with no roots) is the
 * exact match the injection has always used; family=true matches a root or a
 * path under it — on a '/' boundary, so `<repo>` never matches
 * `<repo>-extra`, never inside a repository nested under a root, never a
 * path that no longer exists, and inside a worktree container only a family worktree. A
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
