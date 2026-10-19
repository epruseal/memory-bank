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
let S: string;   // sibling whose name extends R's (memory-bank-cloud)
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
  fs.mkdirSync(worktreeTop, { recursive: true });
  fs.writeFileSync(path.join(worktreeTop, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'gitdir'), `${backRef}\n`);
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-family-')));
  R = path.join(tmp, 'proj', 'memory-bank');
  S = path.join(tmp, 'proj', 'memory-bank-cloud');
  makeRepo(R);
  fs.mkdirSync(path.join(R, 'docs', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(R, 'src'), { recursive: true });
  makeRepo(S);
  W = path.join(R, '.auto-issue-worktrees', 'issue-1');
  linkWorktree(W, R, 'issue-1');
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
    fs.mkdirSync(H, { recursive: true });
    fs.writeFileSync(path.join(H, '.git'), `gitdir: ${path.join(R, '.git', 'modules', 'h')}\n`);
    expect(resolveRepoRoots(H), 'a submodule is its own root, not linked to R').toEqual([H]);
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
  });

  it('a path with . or .. segments matches only exactly', () => {
    fs.mkdirSync(path.join(tmp, 'proj', 'plain-outside'), { recursive: true });
    const m = scopeMatcher(R, true);
    expect(m(`${R}/../plain-outside`), 'climbs out of R into a folder that is no repository').toBe(false);
    expect(m(`${R}/../memory-bank-cloud`)).toBe(false);
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
