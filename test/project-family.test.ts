import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveRepoRoots, scopeMatcher, clearRepoRootCache } from '../src/project-family.js';

/**
 * Repository family (plan 2026-10-19, C2): the scope widening the replay bench
 * judges. Built on real folders — the resolver reads `.git` from disk.
 */

let tmp: string;
let R: string;   // main repo (memory-bank)
let S: string;   // sibling whose name extends R's (memory-bank-extra)
let W: string;   // linked worktree inside R
let E: string;   // linked worktree outside R

/** A repository root as git leaves it: `.git/` holding HEAD. */
function makeRepo(dir: string) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

function linkWorktree(worktreeTop: string, repo: string, name: string, backRef = path.join(worktreeTop, '.git')) {
  const admin = path.join(repo, '.git', 'worktrees', name);
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/wt\n');
  fs.mkdirSync(worktreeTop, { recursive: true });
  fs.writeFileSync(path.join(worktreeTop, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'gitdir'), `${backRef}\n`);
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-family-')));
  R = path.join(tmp, 'proj', 'memory-bank');
  S = path.join(tmp, 'proj', 'memory-bank-extra');
  makeRepo(R);
  fs.mkdirSync(path.join(R, 'docs', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(R, 'src'), { recursive: true });
  makeRepo(S);
  W = path.join(R, '.auto-issue-worktrees', 'issue-1');
  linkWorktree(W, R, 'issue-1');
  fs.mkdirSync(path.join(W, 'src'), { recursive: true });
  E = path.join(tmp, 'elsewhere', 'wt');
  linkWorktree(E, R, 'ext');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { clearRepoRootCache(); vi.restoreAllMocks(); });

describe('resolveRepoRoots', () => {
  it('a sub-folder resolves to the repo whose .git is a directory', () => {
    expect(resolveRepoRoots(path.join(R, 'docs', 'deep'))).toEqual([R]);
    expect(resolveRepoRoots(R)).toEqual([R]);
  });

  it('a linked worktree resolves to itself and the main repository', () => {
    expect(resolveRepoRoots(W)).toEqual([W, R]);
    expect(resolveRepoRoots(E)).toEqual([E, R]);
  });

  it('a deleted worktree path resolves through its container', () => {
    expect(resolveRepoRoots(path.join(R, '.auto-issue-worktrees', 'gone-9', 'src'))).toEqual([R]);
    expect(resolveRepoRoots(path.join(R, '.claude', 'worktrees', 'agent-x'))).toEqual([R]);
  });

  it('outside any repository there is no family', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(resolveRepoRoots(plain)).toEqual([]);
    expect(resolveRepoRoots(path.join(tmp, 'never-existed'))).toEqual([]);
  });

  it('forged .git file: a gitdir without the back-reference links nothing; one naming no git dir is no repository', () => {
    const F = path.join(tmp, 'proj', 'forged');
    linkWorktree(F, S, 'x', '/somewhere/else/.git'); // back-reference names another worktree
    expect(resolveRepoRoots(F)).toEqual([F]);
    const G = path.join(tmp, 'proj', 'forged2');
    fs.mkdirSync(G, { recursive: true });
    fs.writeFileSync(path.join(G, '.git'), `gitdir: ${path.join(tmp, 'nogit', '.git', 'worktrees', 'y')}\n`);
    expect(resolveRepoRoots(G)).toEqual([]);
    const H = path.join(tmp, 'proj', 'submodule-like');
    fs.mkdirSync(path.join(R, '.git', 'modules', 'h'), { recursive: true });
    fs.writeFileSync(path.join(R, '.git', 'modules', 'h', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(H, { recursive: true });
    fs.writeFileSync(path.join(H, '.git'), `gitdir: ${path.join(R, '.git', 'modules', 'h')}\n`);
    expect(resolveRepoRoots(H), 'a submodule is its own root, not linked to R').toEqual([H]);
  });

  it('a .git file naming a folder that is no git dir (no HEAD) — `gitdir: .` included — is no repository', () => {
    const U = path.join(tmp, 'umbrella-gitdir-dot');
    for (const p of ['P1', 'P2']) fs.mkdirSync(path.join(U, p), { recursive: true });
    fs.writeFileSync(path.join(U, '.git'), 'gitdir: .\n');
    expect(resolveRepoRoots(path.join(U, 'P1'))).toEqual([]);
    expect(scopeMatcher(path.join(U, 'P1'), true)(path.join(U, 'P2')), 'two unrelated projects stay apart').toBe(false);
    const V = path.join(tmp, 'gitdir-plain');
    fs.mkdirSync(path.join(V, 'p'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'plain-admin'), { recursive: true });
    fs.writeFileSync(path.join(V, '.git'), `gitdir: ${path.join(tmp, 'plain-admin')}\n`);
    expect(resolveRepoRoots(path.join(V, 'p'))).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'plain-admin', 'HEAD'), 'ref: refs/heads/main\n');
    clearRepoRootCache();
    expect(resolveRepoRoots(path.join(V, 'p')), 'positive control: with HEAD it is a git dir').toEqual([V]);
  });

  it('a cwd whose last component is a symbolic link has no family (left out, never pulled in)', () => {
    const link = path.join(tmp, 'link-to-docs');
    fs.symlinkSync(path.join(R, 'docs'), link);
    expect(resolveRepoRoots(link)).toEqual([]);
  });

  it('a symbolic link inside a worktree container borrows nothing from the container\'s repository', () => {
    fs.mkdirSync(path.join(R, '.claude', 'worktrees'), { recursive: true });
    const lnk = path.join(R, '.claude', 'worktrees', 'lnk');
    fs.symlinkSync(S, lnk);
    expect(resolveRepoRoots(lnk)).toEqual([]);
    expect(resolveRepoRoots(path.join(R, '.claude', 'worktrees', 'really-gone')), 'positive control: a missing worktree folder').toEqual([R]);
  });

  it('a deleted cwd inside a LIVE worktree has no family — the rule facts follow (a deleted clone could have been another repository)', () => {
    const live = path.join(R, '.claude', 'worktrees', 'live-cwd');
    linkWorktree(live, R, 'live-cwd');
    expect(resolveRepoRoots(path.join(live, 'gone-clone', 'x'))).toEqual([]);
    expect(resolveRepoRoots(path.join(R, '.claude', 'worktrees', 'gone-too', 'x')), 'positive control: the worktree folder itself is gone').toEqual([R]);
    expect(resolveRepoRoots(live), 'positive control: the live worktree').toEqual([live, R]);
  });

  it('a cwd that reaches its repository through a symbolic link has no family; a link to the root itself is that root', () => {
    fs.mkdirSync(path.join(S, 'sub', 'x'), { recursive: true });
    const via = path.join(R, 'linked-sub');
    fs.symlinkSync(path.join(S, 'sub'), via);
    expect(resolveRepoRoots(path.join(via, 'x')), 'R/linked-sub/x is a folder of S — R is only where the link sits').toEqual([]);
    const toRoot = path.join(tmp, 'link-to-root');
    fs.symlinkSync(R, toRoot);
    expect(resolveRepoRoots(path.join(toRoot, 'docs'))).toEqual([toRoot]);
  });

  it('a cwd that is a file has no family', () => {
    const file = path.join(R, 'docs', 'notes.txt');
    fs.writeFileSync(file, 'x');
    expect(resolveRepoRoots(file)).toEqual([]);
    expect(resolveRepoRoots(path.join(R, 'docs')), 'positive control: its folder').toEqual([R]);
  });

  it('a HEAD that is a FIFO is no git HEAD (never a repository)', (ctx) => {
    const Q = path.join(tmp, 'fifo-head');
    fs.mkdirSync(path.join(Q, '.git'), { recursive: true });
    fs.mkdirSync(path.join(Q, 'p'), { recursive: true });
    if (spawnSync('mkfifo', [path.join(Q, '.git', 'HEAD')]).status !== 0) ctx.skip();
    expect(resolveRepoRoots(path.join(Q, 'p'))).toEqual([]);
    fs.rmSync(path.join(Q, '.git', 'HEAD'));
    fs.writeFileSync(path.join(Q, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    clearRepoRootCache();
    expect(resolveRepoRoots(path.join(Q, 'p')), 'positive control: a regular HEAD').toEqual([Q]);
  });

  it('HEAD may be a symbolic link (core.preferSymlinkRefs) but never a folder', () => {
    const L = path.join(tmp, 'head-symlink');
    fs.mkdirSync(path.join(L, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(L, '.git', 'refs', 'heads', 'main'), '0'.repeat(40) + '\n');
    fs.symlinkSync('refs/heads/main', path.join(L, '.git', 'HEAD'));
    expect(resolveRepoRoots(L)).toEqual([L]);
    const D = path.join(tmp, 'head-folder');
    fs.mkdirSync(path.join(D, '.git', 'HEAD'), { recursive: true });
    fs.mkdirSync(path.join(D, 'p'), { recursive: true });
    expect(resolveRepoRoots(path.join(D, 'p'))).toEqual([]);
  });

  it('the root cache is bounded: past 256 entries it starts over, so an old answer is recomputed', () => {
    const first = path.join(tmp, 'bounded-first');
    fs.mkdirSync(first, { recursive: true });
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    expect(resolveRepoRoots(first)).toEqual([]);
    makeRepo(first);
    expect(resolveRepoRoots(first), 'cached').toEqual([]);
    for (let i = 0; i < 256; i++) resolveRepoRoots(path.join(tmp, 'bounded-other', String(i)));
    expect(resolveRepoRoots(first), 'the cache was cleared at the bound').toEqual([first]);
  });

  it('a .git that is not a repository — garbage file, empty folder, symlink — means no family', () => {
    const cases: Array<[string, (d: string) => void]> = [
      ['garbage', (d) => fs.writeFileSync(path.join(d, '.git'), 'not a gitdir line\n')],
      ['empty-dir', (d) => fs.mkdirSync(path.join(d, '.git'))],
      ['symlink', (d) => fs.symlinkSync(path.join(R, '.git'), path.join(d, '.git'))],
    ];
    for (const [name, make] of cases) {
      const d = path.join(tmp, 'umbrella-' + name);
      fs.mkdirSync(path.join(d, 'project'), { recursive: true });
      make(d);
      expect(resolveRepoRoots(path.join(d, 'project')), name).toEqual([]);
    }
  });

  it('a deleted worktree under an umbrella folder (not a repository) has no family', () => {
    const U = path.join(tmp, 'umbrella');
    makeRepo(path.join(U, 'RepoA'));
    makeRepo(path.join(U, 'RepoB'));
    expect(resolveRepoRoots(path.join(U, '.auto-issue-worktrees', 'ORG-RepoA', 'issue-7'))).toEqual([]);
    expect(resolveRepoRoots(path.join(U, '.claude', 'worktrees', 'x'))).toEqual([]);
  });

  it('only absolute paths resolve (a slug-form project has no family), whatever the process cwd', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(R); // a relative path would otherwise resolve inside R
    expect(resolveRepoRoots('docs')).toEqual([]);
    expect(resolveRepoRoots('-Users-x-proj')).toEqual([]);
  });

  it('a home directory that is a git work tree never becomes a root', () => {
    const home = path.join(tmp, 'home');
    makeRepo(home);
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(resolveRepoRoots(path.join(home, 'notes'))).toEqual([]);
    expect(resolveRepoRoots(home)).toEqual([]);
    // A deleted worktree of the global ~/.claude container names $HOME as its repo — still no root.
    expect(resolveRepoRoots(path.join(home, '.claude', 'worktrees', 'gone-1'))).toEqual([]);
    expect(resolveRepoRoots(path.join(tmp, '.claude', 'worktrees', 'gone-2'))).toEqual([]);
  });

  it('on a case-insensitive file system a differently cased home is still the home', (ctx) => {
    const home = path.join(tmp, 'home3');
    makeRepo(home);
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const upper = home.toUpperCase();
    if (!fs.existsSync(path.join(upper, 'NOTES')) || (process.platform !== 'darwin' && process.platform !== 'win32')) ctx.skip();
    expect(resolveRepoRoots(path.join(upper, 'NOTES')), 'the same home folder, other case').toEqual([]);
    expect(resolveRepoRoots(path.join(home, 'notes'))).toEqual([]);
  });

  it('the root cache expires — a folder that became a repository is seen within a minute', () => {
    const later = path.join(tmp, 'becomes-repo');
    fs.mkdirSync(later, { recursive: true });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect(resolveRepoRoots(later)).toEqual([]);
    makeRepo(later);
    now += 30_000;
    expect(resolveRepoRoots(later), 'still the cached answer').toEqual([]);
    now += 31_000;
    expect(resolveRepoRoots(later)).toEqual([later]);
  });

  it('a gitdir back-reference that is not a regular file (a FIFO) is never read', (ctx) => {
    const wt = path.join(tmp, 'fifo-wt');
    linkWorktree(wt, R, 'fifo');
    const back = path.join(R, '.git', 'worktrees', 'fifo', 'gitdir');
    fs.rmSync(back);
    if (spawnSync('mkfifo', [back]).status !== 0) ctx.skip();
    expect(resolveRepoRoots(wt), 'reading it would block the hook; the main repository is not linked').toEqual([wt]);
  });

  it('the account home counts even when HOME points elsewhere', () => {
    const home = path.join(tmp, 'home2');
    makeRepo(home);
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'other-home'));
    vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), homedir: home });
    expect(resolveRepoRoots(path.join(home, 'notes'))).toEqual([]);
  });
});

describe('scopeMatcher', () => {
  it('family off is the exact match the injection always used', () => {
    const m = scopeMatcher(path.join(R, 'docs'), false);
    expect(m(path.join(R, 'docs'))).toBe(true);
    expect(m(R)).toBe(false);
    expect(m(path.join(R, 'docs', 'deep'))).toBe(false);
  });

  it('family on matches the roots and paths under them', () => {
    const m = scopeMatcher(path.join(R, 'docs'), true);
    for (const p of [R, path.join(R, 'docs'), path.join(R, 'src'), W, path.join(R, '.auto-issue-worktrees', 'gone-9')]) expect(m(p), p).toBe(true);
    const fromWorktree = scopeMatcher(W, true);
    expect(fromWorktree(R)).toBe(true);
    expect(fromWorktree(path.join(R, '.auto-issue-worktrees', 'issue-2'))).toBe(true);
    expect(scopeMatcher(E, true)(R)).toBe(true);
  });

  it('a repository nested under a root — a separate clone or a submodule — is not in the family; a linked worktree is', () => {
    const N = path.join(R, 'vendor', 'lib');
    makeRepo(N);
    fs.mkdirSync(path.join(R, '.git', 'modules', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(R, '.git', 'modules', 'sub', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(R, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(R, 'sub', '.git'), `gitdir: ${path.join(R, '.git', 'modules', 'sub')}\n`);
    const m = scopeMatcher(path.join(R, 'docs'), true);
    expect(m(path.join(R, 'vendor')), 'a plain folder above the clone').toBe(true);
    expect(m(N)).toBe(false);
    expect(m(path.join(N, 'src'))).toBe(false);
    expect(m(path.join(R, 'sub'))).toBe(false);
    expect(m(W), 'linked worktree of R').toBe(true);
    expect(m(path.join(W, 'src'))).toBe(true);
    const foreign = path.join(R, 'other-wt');
    linkWorktree(foreign, S, 'foreign');
    expect(m(foreign), 'a worktree of another repository placed under R').toBe(false);
  });

  it('a deleted path under a root stays in the family only inside a worktree container of that root', () => {
    const m = scopeMatcher(path.join(R, 'docs'), true);
    expect(m(path.join(R, '.claude', 'worktrees', 'gone-agent'))).toBe(true);
    expect(m(path.join(R, '.auto-issue-worktrees', 'gone-9', 'src'))).toBe(true);
    expect(m(path.join(R, '.claude', 'other', 'x')), 'not a container').toBe(false);
    expect(m(path.join(R, 'never-existed', 'x')), 'a deleted plain folder could have been another repository').toBe(false);
    const clone = path.join(R, 'tmp', 'other-repo');
    makeRepo(clone);
    expect(m(clone), 'while it exists it is a nested repository').toBe(false);
    fs.rmSync(clone, { recursive: true, force: true });
    expect(scopeMatcher(path.join(R, 'docs'), true)(clone), 'deleted, it is still left out').toBe(false);
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(R, 'tmp')), 'positive control: the folder that remains').toBe(true);
    // A clone deleted from inside a LIVE worktree of the root could have been another repository.
    const live = path.join(R, '.claude', 'worktrees', 'live');
    linkWorktree(live, R, 'live');
    fs.mkdirSync(path.join(live, 'src'), { recursive: true });
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(live, 'src')), 'positive control: the live worktree').toBe(true);
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(live, 'gone-clone', 'x')), 'gone from inside a live worktree').toBe(false);
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(W, 'gone-sub')), 'a deleted sub-folder of a live worktree').toBe(false);
    // A container below a sub-folder (a deleted nested repository's worktree) is not the root's container.
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(R, 'tmp', 'gone-clone', '.claude', 'worktrees', 'w')), 'not the root\'s own container').toBe(false);
  });

  it('a fact path through a symbolic link under the root is left out (the link can point into another repository)', () => {
    fs.mkdirSync(path.join(S, 'pkg', 'deep'), { recursive: true });
    const lnk = path.join(R, 'vendor-link');
    fs.symlinkSync(path.join(S, 'pkg'), lnk);
    const m = scopeMatcher(path.join(R, 'docs'), true);
    expect(m(lnk)).toBe(false);
    expect(m(path.join(lnk, 'deep'))).toBe(false);
    expect(m(path.join(R, 'docs', 'deep')), 'positive control: a real folder').toBe(true);
  });

  it('a folder that cannot be read is never read as absent (fail closed)', (ctx) => {
    if (process.getuid?.() === 0) ctx.skip();   // root reads through permissions
    const Q = path.join(tmp, 'locked-repo');
    makeRepo(Q);
    fs.mkdirSync(path.join(Q, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(Q, '.claude', 'worktrees'), { recursive: true });
    const gone = path.join(Q, '.claude', 'worktrees', 'gone', 'x');
    expect(scopeMatcher(path.join(Q, 'docs'), true)(gone), 'positive control: readable, a deleted worktree').toBe(true);
    const locked = path.join(Q, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    expect(scopeMatcher(path.join(Q, 'docs'), true)(locked), 'positive control: a readable plain folder').toBe(true);
    fs.chmodSync(path.join(Q, '.claude'), 0o000);
    fs.chmodSync(locked, 0o000);
    try {
      expect(scopeMatcher(path.join(Q, 'docs'), true)(gone), 'unreadable container').toBe(false);
      expect(scopeMatcher(path.join(Q, 'docs'), true)(locked), 'a folder whose .git cannot be looked at').toBe(false);
    } finally {
      fs.chmodSync(path.join(Q, '.claude'), 0o755);
      fs.chmodSync(locked, 0o755);
    }
  });

  it('a path with . or .. segments matches only exactly', () => {
    fs.mkdirSync(path.join(tmp, 'proj', 'plain-outside'), { recursive: true });
    const m = scopeMatcher(R, true);
    expect(m(`${R}/../plain-outside`), 'climbs out of R into a folder that is no repository').toBe(false);
    expect(m(`${R}/../memory-bank-extra`)).toBe(false);
    expect(m(`${R}/./docs`)).toBe(false);
  });

  it('a sibling whose name extends the root is never in the family', () => {
    const m = scopeMatcher(R, true);
    expect(m(S)).toBe(false);
    expect(m(path.join(S, 'docs'))).toBe(false);
    expect(m(path.join(tmp, 'proj'))).toBe(false);
    expect(m(null)).toBe(false);
  });

  it('no family falls back to the exact match; a null project sees every scope', () => {
    const plain = path.join(tmp, 'plain2');
    fs.mkdirSync(path.join(plain, 'sub'), { recursive: true });
    const m = scopeMatcher(plain, true);
    expect(m(plain)).toBe(true);
    expect(m(path.join(plain, 'sub'))).toBe(false);
    expect(scopeMatcher(null, true)('/anything')).toBe(true);
  });
});
