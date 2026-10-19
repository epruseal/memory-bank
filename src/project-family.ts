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
 * family when its scope_project is one of those roots or lies under one.
 *
 * Resolved from the filesystem only (no `git` process — the injection hook has
 * a hard time budget). A root is never $HOME, an ancestor of it, or '/': a home
 * directory that is itself a git work tree would otherwise make every
 * non-repo folder under it one family with every project.
 */

const WORKTREE_CONTAINERS = ['/.auto-issue-worktrees/', '/.claude/worktrees/'];
const CACHE_LIMIT = 256;
const cache = new Map<string, string[]>();

function isDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return fs.lstatSync(p).isFile(); } catch { return false; }
}

/** A root that would swallow unrelated projects: '/', $HOME, or any ancestor of $HOME. */
function tooBroad(root: string): boolean {
  const home = path.resolve(os.homedir());
  return root === path.parse(root).root || home === root || home.startsWith(root + path.sep);
}

/**
 * Main repository root behind a linked worktree's `.git` file, or null. The
 * file must read `gitdir: <R>/.git/worktrees/<name>`, `<R>/.git` must be a
 * directory, and that admin dir's own `gitdir` back-reference must name this
 * worktree's `.git` file — so a forged `.git` file cannot pull another
 * project's facts into this one.
 */
function mainRootOf(worktreeTop: string): string | null {
  let content: string;
  try { content = fs.readFileSync(path.join(worktreeTop, '.git'), 'utf8'); } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  const adminDir = path.resolve(worktreeTop, m[1]);
  const parts = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(adminDir);
  if (!parts) return null;
  const root = parts[1];
  if (!isDir(path.join(root, '.git'))) return null;
  let back: string;
  try { back = fs.readFileSync(path.join(adminDir, 'gitdir'), 'utf8').trim(); } catch { return null; }
  if (path.resolve(adminDir, back) !== path.join(worktreeTop, '.git')) return null;
  return root;
}

function resolveUncached(cwd: string): string[] {
  const start = path.resolve(cwd);
  if (!isDir(start)) {
    // A deleted worktree (replayed history): its container names the repo.
    for (const marker of WORKTREE_CONTAINERS) {
      const i = start.indexOf(marker);
      if (i > 0) {
        const root = start.slice(0, i);
        return tooBroad(root) ? [] : [root];
      }
    }
    return [];
  }
  for (let dir = start; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    if (isDir(dotGit)) return tooBroad(dir) ? [] : [dir];
    if (isFile(dotGit)) {
      if (tooBroad(dir)) return [];
      const main = mainRootOf(dir);
      return main && !tooBroad(main) && main !== dir ? [dir, main] : [dir];
    }
    if (dir === path.dirname(dir)) return [];
  }
}

/** Family roots of `cwd` ([] = no family: not in a repository, or only a too-broad one). Cached per cwd. */
export function resolveRepoRoots(cwd: string): string[] {
  const hit = cache.get(cwd);
  if (hit) return hit;
  const roots = resolveUncached(cwd);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(cwd, roots);
  return roots;
}

/** Test hook — the cache is per process and keyed by cwd. */
export function clearRepoRootCache(): void {
  cache.clear();
}

/**
 * Whether a project-scoped fact's scope_project is visible from `project`.
 * The single predicate behind the KNN scope filter, the relation scope filter
 * and the replay bench. family=false (and family=true with no roots) is the
 * exact match the injection has always used; family=true matches a root or a
 * path under it — on a '/' boundary, so `memory-bank` never matches
 * `memory-bank-cloud`. A null project sees every scope.
 */
export function scopeMatcher(project: string | null, family: boolean): (scopeProject: string | null) => boolean {
  if (!project) return () => true;
  if (!family) return (scopeProject) => scopeProject === project;
  const roots = resolveRepoRoots(project);
  if (roots.length === 0) return (scopeProject) => scopeProject === project;
  return (scopeProject) => scopeProject === project
    || (scopeProject != null && roots.some((r) => scopeProject === r || scopeProject.startsWith(r + '/')));
}
