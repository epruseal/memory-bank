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

  it('a path that no longer exists has no family — a deleted worktree included (nothing on disk tells which repository it was)', () => {
    const Q = path.join(tmp, 'del-wt');
    makeRepo(Q);
    fs.mkdirSync(path.join(Q, '.auto-issue-worktrees'), { recursive: true });
    const live = path.join(Q, '.claude', 'worktrees', 'live');
    linkWorktree(live, Q, 'live');
    expect(resolveRepoRoots(path.join(Q, '.auto-issue-worktrees', 'gone-9'))).toEqual([]);
    expect(resolveRepoRoots(path.join(Q, '.claude', 'worktrees', 'agent-x'))).toEqual([]);
    expect(resolveRepoRoots(path.join(Q, 'never-existed'))).toEqual([]);
    expect(resolveRepoRoots(live), 'positive control: the live worktree').toEqual([live, Q]);
  });

  it('inside a worktree container only the family\'s worktrees count — a plain folder there may be another repository\'s layer', () => {
    const T = path.join(tmp, 'layer-in-repo');
    const other = path.join(tmp, 'layer-main');
    makeRepo(T);
    makeRepo(other);
    const layer = path.join(T, '.auto-issue-worktrees', 'ORG-other');
    linkWorktree(path.join(layer, 'issue-2'), other, 'issue-2');
    const own = path.join(T, '.auto-issue-worktrees', 'own');
    linkWorktree(own, T, 'own');
    const m = scopeMatcher(T, true);
    expect(m(layer), 'the layer folder itself').toBe(false);
    expect(m(path.join(layer, 'issue-2')), 'the other repository\'s worktree in it').toBe(false);
    expect(m(own), 'positive control: the family\'s worktree').toBe(true);
    expect(m(path.join(T, '.auto-issue-worktrees')), 'the container itself is a plain folder of T').toBe(true);
    // the container's name in another case is the same folder where names fold (and no folder where they do not)
    expect(m(path.join(T, '.Auto-Issue-Worktrees', 'ORG-other')), 'the layer folder named in another case').toBe(false);
    // a cwd passes the same test on its way down from the root: a session opened in the layer borrows nothing
    fs.mkdirSync(path.join(layer, 'notes'), { recursive: true });
    expect(resolveRepoRoots(layer), 'a cwd that is the layer folder').toEqual([]);
    expect(resolveRepoRoots(path.join(layer, 'notes')), 'a cwd below it').toEqual([]);
    expect(scopeMatcher(layer, true)(T), 'so T\'s facts stay out of a session there').toBe(false);
    expect(resolveRepoRoots(path.join(T, '.auto-issue-worktrees')), 'positive control: the container folder itself is T\'s').toEqual([T]);
    expect(resolveRepoRoots(own), 'positive control: the family worktree').toEqual([own, T]);
  });

  it('a linked worktree\'s own containers count from that worktree: a plain folder in one is out, for a fact and a cwd', () => {
    const Q = path.join(tmp, 'nested-container');
    makeRepo(Q);
    const wt = path.join(Q, '.claude', 'worktrees', 'wt');
    linkWorktree(wt, Q, 'wt');
    const plain = path.join(wt, '.claude', 'worktrees', 'plain');
    fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
    fs.mkdirSync(path.join(wt, 'docs'), { recursive: true });
    const m = scopeMatcher(wt, true);
    expect(m(plain), 'walked from the main root the container is the worktree\'s, not the root\'s').toBe(false);
    expect(m(path.join(plain, 'src'))).toBe(false);
    expect(scopeMatcher(Q, true)(plain), 'from the repository too').toBe(false);
    expect(m(path.join(wt, 'docs')), 'positive control: a plain folder of the worktree').toBe(true);
    expect(resolveRepoRoots(path.join(plain, 'src')), 'a cwd in that plain folder').toEqual([]);
    expect(resolveRepoRoots(path.join(wt, 'docs')), 'positive control: a cwd in the worktree').toEqual([wt, Q]);
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

  it('a linked worktree whose main root is named through a symbolic link is only itself (the link can change target)', () => {
    const link = path.join(tmp, 'link-to-R-main');
    fs.symlinkSync(R, link);
    const wt = path.join(tmp, 'wt-via-link');
    const admin = path.join(R, '.git', 'worktrees', 'via-link');
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/wt\n');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(link, '.git', 'worktrees', 'via-link')}\n`);
    fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(wt, '.git')}\n`);
    expect(resolveRepoRoots(wt)).toEqual([wt]);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
    clearRepoRootCache();
    expect(resolveRepoRoots(wt), 'positive control: the physical admin path').toEqual([wt, R]);
  });

  it('a symbolic link inside a worktree container borrows nothing from the container\'s repository', () => {
    const Q = path.join(tmp, 'link-in-container');
    makeRepo(Q);
    const own = path.join(Q, '.claude', 'worktrees', 'own');
    linkWorktree(own, Q, 'own');
    const lnk = path.join(Q, '.claude', 'worktrees', 'lnk');
    fs.symlinkSync(S, lnk);
    expect(resolveRepoRoots(lnk)).toEqual([]);
    expect(scopeMatcher(Q, true)(lnk)).toBe(false);
    expect(resolveRepoRoots(own), 'positive control: the family\'s worktree next to it').toEqual([own, Q]);
  });

  it('a deleted cwd inside a LIVE worktree has no family (a deleted clone could have been another repository)', () => {
    const Q = path.join(tmp, 'live-cwd-repo');
    makeRepo(Q);
    const live = path.join(Q, '.claude', 'worktrees', 'live-cwd');
    linkWorktree(live, Q, 'live-cwd');
    expect(resolveRepoRoots(path.join(live, 'gone-clone', 'x'))).toEqual([]);
    expect(resolveRepoRoots(path.join(Q, '.claude', 'worktrees', 'gone-too'))).toEqual([]);
    expect(resolveRepoRoots(live), 'positive control: the live worktree').toEqual([live, Q]);
  });

  it('a cwd that reaches its repository through a symbolic link has no family — a link to the root itself included', () => {
    fs.mkdirSync(path.join(S, 'sub', 'x'), { recursive: true });
    const via = path.join(R, 'linked-sub');
    fs.symlinkSync(path.join(S, 'sub'), via);
    expect(resolveRepoRoots(path.join(via, 'x')), 'R/linked-sub/x is a folder of S — R is only where the link sits').toEqual([]);
    const toRoot = path.join(tmp, 'link-to-root');
    fs.symlinkSync(R, toRoot);
    expect(resolveRepoRoots(toRoot)).toEqual([]);
    expect(resolveRepoRoots(path.join(toRoot, 'docs')), 'the link\'s target can change under the same path').toEqual([]);
    expect(resolveRepoRoots(path.join(R, 'docs')), 'positive control: the physical path').toEqual([R]);
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

  it('a linked worktree of a home directory that is a git work tree is only itself (the home never joins as main)', () => {
    const home = path.join(tmp, 'home3');
    makeRepo(home);
    const wt = path.join(tmp, 'wt-of-home');
    linkWorktree(wt, home, 'w');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(resolveRepoRoots(wt)).toEqual([wt]);
    vi.restoreAllMocks();
    clearRepoRootCache();
    expect(resolveRepoRoots(wt), 'positive control: the same folder as an ordinary repository').toEqual([wt, home]);
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
    for (const p of [R, path.join(R, 'docs'), path.join(R, 'src'), W, path.join(W, 'src')]) expect(m(p), p).toBe(true);
    const fromWorktree = scopeMatcher(W, true);
    expect(fromWorktree(R)).toBe(true);
    expect(fromWorktree(path.join(R, 'docs'))).toBe(true);
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

  it('a path that no longer exists is never in the family; inside a container only the family\'s worktrees', () => {
    fs.mkdirSync(path.join(R, '.claude', 'worktrees', 'plain'), { recursive: true });
    const m = scopeMatcher(path.join(R, 'docs'), true);
    for (const gone of [path.join(R, '.claude', 'worktrees', 'gone-agent'), path.join(R, '.auto-issue-worktrees', 'gone-9'), path.join(R, 'never-existed', 'x')]) expect(m(gone), gone).toBe(false);
    expect(m(path.join(R, '.claude', 'worktrees', 'plain')), 'a plain folder in a container').toBe(false);
    const clone = path.join(R, 'tmp', 'other-repo');
    makeRepo(clone);
    expect(m(clone), 'while it exists it is a nested repository').toBe(false);
    fs.rmSync(clone, { recursive: true, force: true });
    expect(scopeMatcher(path.join(R, 'docs'), true)(clone), 'deleted, it is still left out').toBe(false);
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(R, 'tmp')), 'positive control: the folder that remains').toBe(true);
    const live = path.join(R, '.claude', 'worktrees', 'live');
    linkWorktree(live, R, 'live');
    fs.mkdirSync(path.join(live, 'src'), { recursive: true });
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(live, 'src')), 'positive control: the live worktree').toBe(true);
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(live, 'gone-clone', 'x')), 'gone from inside a live worktree').toBe(false);
    expect(scopeMatcher(path.join(R, 'docs'), true)(path.join(W, 'gone-sub')), 'a deleted sub-folder of a live worktree').toBe(false);
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
    const wt = path.join(Q, '.claude', 'worktrees', 'w');
    linkWorktree(wt, Q, 'w');
    expect(scopeMatcher(path.join(Q, 'docs'), true)(wt), 'positive control: readable, a family worktree').toBe(true);
    const locked = path.join(Q, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    expect(scopeMatcher(path.join(Q, 'docs'), true)(locked), 'positive control: a readable plain folder').toBe(true);
    fs.chmodSync(path.join(Q, '.claude'), 0o000);
    fs.chmodSync(locked, 0o000);
    try {
      expect(scopeMatcher(path.join(Q, 'docs'), true)(wt), 'unreadable container').toBe(false);
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
