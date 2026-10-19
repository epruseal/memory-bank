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
 * and neither has a cwd that is a symbolic link or a file, or that reaches its
 * repository through a symbolic link — the root itself included (a link can
 * point into another repository, and a link's target can change under the same
 * path). A path that cannot be read (EACCES, EIO) counts as no family / outside
 * it, never as absent. The worktrees of a bare repository (`<dir>/.bare/worktrees/…`)
 * are not grouped: each one is its own family.
 */

/** Worktree containers of a repository root (`<root>/.claude/worktrees/<name>`) — the one list; the bench reads it too. */
export const WORKTREE_CONTAINERS = Object.freeze(['/.auto-issue-worktrees/', '/.claude/worktrees/']);
const CACHE_LIMIT = 256;
/** A daemon outlives a folder: the same path can become another repository (or none). */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { roots: string[]; at: number }>();

/** A path that exists but cannot be read (EACCES, EIO, …) — never read as "absent" (that would be fail-open). */
const UNREADABLE = Symbol('unreadable');

/** lstat of a path: null only when it does not exist (ENOENT / ENOTDIR), UNREADABLE on any other error. */
function lstat(p: string): fs.Stats | null | typeof UNREADABLE {
  try { return fs.lstatSync(p); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : UNREADABLE;
  }
}

function stat(p: string): fs.Stats | null {
  const st = lstat(p);
  return st === UNREADABLE ? null : st;
}

function isDir(p: string): boolean {
  return stat(p)?.isDirectory() === true;
}

/** A git HEAD: a regular file, or a symbolic link (git's core.preferSymlinkRefs) — never a folder. */
function isHead(p: string): boolean {
  const st = stat(p);
  return st !== null && (st.isFile() || st.isSymbolicLink());
}

function homes(): string[] {
  const out = [path.resolve(os.homedir())];
  try { out.push(path.resolve(os.userInfo().homedir)); } catch { /* no account entry */ }
  return out;
}

/** Comparison key of a path: macOS and Windows default to case-insensitive names ('/users/x' is the home '/Users/x'). */
function fold(p: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
}

/** A root that would swallow unrelated projects: '/', a home directory, or any ancestor of one. */
function tooBroad(root: string): boolean {
  const r = fold(root);
  return root === path.parse(root).root || homes().some((h) => {
    const home = fold(h);
    return home === r || home.startsWith(r + path.sep);
  });
}

/** A main repository root: `<root>/.git` is a directory (not a symlink) holding a HEAD. */
function isRepoRoot(root: string): boolean {
  return isDir(path.join(root, '.git')) && isHead(path.join(root, '.git', 'HEAD'));
}

/**
 * Main repository root behind a linked worktree whose `.git` file names
 * `adminDir`, or null. adminDir must be `<R>/.git/worktrees/<name>`, R a
 * repository root, and the admin dir's own `gitdir` back-reference must name
 * this worktree's `.git` file — so a forged `.git` file cannot pull another
 * project's facts into this one.
 */
function mainRootOf(worktreeTop: string, adminDir: string): string | null {
  const parts = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(adminDir);
  if (!parts) return null;
  const root = parts[1];
  if (!isRepoRoot(root)) return null;
  const backFile = path.join(adminDir, 'gitdir');
  if (stat(backFile)?.isFile() !== true) return null; // never read a FIFO or a device (the hook would block)
  let back: string;
  try { back = fs.readFileSync(backFile, 'utf8').trim(); } catch { return null; }
  if (path.resolve(adminDir, back) !== path.join(worktreeTop, '.git')) return null;
  return root;
}

type DotGit =
  | { kind: 'none' }
  | { kind: 'root' }
  | { kind: 'linked'; main: string | null }   // linked worktree (main validated) or submodule (main null)
  | { kind: 'invalid' };

/** What `<dir>/.git` makes of dir. */
function dotGitOf(dir: string): DotGit {
  const st = lstat(path.join(dir, '.git'));
  if (st === UNREADABLE) return { kind: 'invalid' };   // cannot tell — fail closed
  if (!st) return { kind: 'none' };
  if (st.isDirectory()) return isRepoRoot(dir) ? { kind: 'root' } : { kind: 'invalid' };
  if (!st.isFile()) return { kind: 'invalid' };
  let content: string;
  try { content = fs.readFileSync(path.join(dir, '.git'), 'utf8'); } catch { return { kind: 'invalid' }; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return { kind: 'invalid' };
  const adminDir = path.resolve(dir, m[1]);
  // A git dir holds a HEAD file (git's own test) — `gitdir: .` or any other plain folder is not one.
  if (!isDir(adminDir) || !isHead(path.join(adminDir, 'HEAD'))) return { kind: 'invalid' };
  return { kind: 'linked', main: mainRootOf(dir, adminDir) };
}

function resolveUncached(cwd: string): string[] {
  if (!path.isAbsolute(cwd)) return [];
  const start = path.resolve(cwd);
  const own = lstat(start);
  // Something there that is not a folder — a symbolic link, a file, an unreadable entry — has no family
  // (a link under a worktree container must not borrow the container's repository).
  if (own !== null && (own === UNREADABLE || !own.isDirectory())) return [];
  if (own === null) {
    // A deleted worktree (replayed history): its container names the repo — when the
    // folder in front of the container is itself a repository root (an umbrella folder
    // holding worktrees of several repositories is not) and the path is a deleted worktree
    // of it by the rule facts follow (excludedUnderRoot → deletedWorktreeOf).
    for (const marker of WORKTREE_CONTAINERS) {
      const i = start.indexOf(marker);
      if (i > 0) {
        const root = start.slice(0, i);
        return !tooBroad(root) && isRepoRoot(root) && !excludedUnderRoot(root, start, [root]) ? [root] : [];
      }
    }
    return [];
  }
  for (let dir = start; ; dir = path.dirname(dir)) {
    // A link on the way up to the repository root, the root included: the repository found is the
    // one the link sits in (or the link's current target), not where the cwd's facts were made.
    const st = dir === start ? own : lstat(dir);
    if (st === UNREADABLE || (st !== null && st.isSymbolicLink())) return [];
    const g = dotGitOf(dir);
    if (g.kind !== 'none') {
      if (g.kind === 'invalid' || tooBroad(dir)) return [];
      if (g.kind === 'root') return [dir];
      return g.main && !tooBroad(g.main) && g.main !== dir ? [dir, g.main] : [dir];
    }
    if (dir === path.dirname(dir)) return [];
  }
}

/**
 * Family roots of `cwd` ([] = no family: not in a repository, or only a too-broad one) — the
 * worktree's own top first, then (for a linked worktree) the main repository root, so the last
 * root is always the repository. Cached per cwd for a minute.
 */
export function resolveRepoRoots(cwd: string): string[] {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.roots;
  const roots = resolveUncached(cwd);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(cwd, { roots, at: now });
  return roots;
}

/** Test hook — the cache is per process and keyed by cwd. */
export function clearRepoRootCache(): void {
  cache.clear();
}

/**
 * Whether `container` (a worktree container of `root`, present on disk) holds nothing but the root's
 * own linked worktrees — any other folder or link in it (a per-repository layer such as
 * `ORG-REPO/`, a clone) means it may hold several repositories' worktrees. Files are ignored.
 */
function ownContainer(root: string, container: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(container, { withFileTypes: true }); } catch { return false; }
  return entries.every((e) => {
    if (e.isSymbolicLink()) return false;
    if (!e.isDirectory()) return true;
    const g = dotGitOf(path.join(container, e.name));
    return g.kind === 'linked' && g.main === root;
  });
}

/**
 * Whether `scopeProject`, whose first missing folder on the way down from `root` is `missing`, is a
 * deleted worktree of `root`: the path IS a worktree folder directly in one of the root's worktree
 * containers, that container is still there and holds only the root's own linked worktrees. A deeper
 * path (a clone inside the deleted worktree?), a gone container, or a container that also holds
 * other folders (an umbrella of several repositories' worktrees?) cannot be told apart on disk — left out.
 */
function deletedWorktreeOf(root: string, scopeProject: string, missing: string): boolean {
  return WORKTREE_CONTAINERS.some((c) => {
    const base = root + c;   // '<root>/.claude/worktrees/'
    return scopeProject === missing && path.dirname(missing) + '/' === base && ownContainer(root, base.slice(0, -1));
  });
}

/**
 * Whether `scopeProject`, strictly under `root`, is left out of the family:
 * a folder on the way (or the path itself) is a symbolic link (it can point
 * into another repository), or has its own `.git` that is not a
 * linked worktree of a family root (a separate clone, a submodule). A folder
 * that no longer exists ends the walk: the path stays in the family only when
 * it is itself a deleted worktree folder in a worktree container of the root
 * (`<root>/.claude/worktrees/<w>`, `<root>/.auto-issue-worktrees/<w>` — see
 * deletedWorktreeOf). A folder that cannot be read excludes the path.
 * Any other deleted path may have been another repository, and nothing on disk
 * can tell, so it is left out — at the cost of facts from deleted plain
 * sub-folders of the repository.
 */
function excludedUnderRoot(root: string, scopeProject: string, roots: string[]): boolean {
  let dir = root;
  for (const seg of scopeProject.slice(root.length + 1).split('/')) {
    if (!seg) continue;
    dir = path.join(dir, seg);
    const st = lstat(dir);
    if (st === UNREADABLE) return true;   // cannot tell — fail closed
    if (!st) return !deletedWorktreeOf(root, scopeProject, dir);
    if (st.isSymbolicLink()) return true;
    const g = dotGitOf(dir);
    if (g.kind === 'none') continue;
    if (g.kind === 'linked' && g.main !== null && roots.includes(g.main)) continue;
    return true;
  }
  return false;
}

/**
 * Whether a project-scoped fact's scope_project is visible from `project`.
 * The single predicate behind the KNN scope filter, the relation scope filter
 * and the replay bench. family=false (and family=true with no roots) is the
 * exact match the injection has always used; family=true matches a root or a
 * path under it — on a '/' boundary, so `<repo>` never matches
 * `<repo>-extra`, never inside a repository nested under a root, and a
 * deleted path only when it is a deleted worktree folder of the root (deletedWorktreeOf). A
 * path with '.' or '..' segments matches only exactly. A null project sees
 * every scope.
 */
export function scopeMatcher(project: string | null, family: boolean): (scopeProject: string | null) => boolean {
  if (!project) return () => true;
  if (!family) return (scopeProject) => scopeProject === project;
  const roots = resolveRepoRoots(project);
  if (roots.length === 0) return (scopeProject) => scopeProject === project;
  const memo = new Map<string, boolean>();
  const inFamily = (s: string): boolean => {
    if (s.split('/').some((seg) => seg === '.' || seg === '..')) return false;
    return roots.some((r) => s === r || (s.startsWith(r + '/') && !excludedUnderRoot(r, s, roots)));
  };
  return (scopeProject) => {
    if (scopeProject === project) return true;
    if (scopeProject == null) return false;
    let hit = memo.get(scopeProject);
    if (hit === undefined) {
      hit = inFamily(scopeProject);
      memo.set(scopeProject, hit);
    }
    return hit;
  };
}
