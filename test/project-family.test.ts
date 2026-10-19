import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  fs.mkdirSync(path.join(R, '.git'), { recursive: true });
  fs.mkdirSync(path.join(R, 'docs', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(S, '.git'), { recursive: true });
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

  it('forged .git file: a gitdir without the back-reference, or into a repo without a .git directory, links nothing', () => {
    const F = path.join(tmp, 'proj', 'forged');
    linkWorktree(F, S, 'x', '/somewhere/else/.git'); // back-reference names another worktree
    expect(resolveRepoRoots(F)).toEqual([F]);
    const G = path.join(tmp, 'proj', 'forged2');
    fs.mkdirSync(G, { recursive: true });
    fs.writeFileSync(path.join(G, '.git'), `gitdir: ${path.join(tmp, 'nogit', '.git', 'worktrees', 'y')}\n`);
    expect(resolveRepoRoots(G)).toEqual([G]);
    const H = path.join(tmp, 'proj', 'submodule-like');
    fs.mkdirSync(H, { recursive: true });
    fs.writeFileSync(path.join(H, '.git'), `gitdir: ${path.join(R, '.git', 'modules', 'h')}\n`);
    expect(resolveRepoRoots(H)).toEqual([H]);
  });

  it('a home directory that is a git work tree never becomes a root', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.git'), { recursive: true });
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(resolveRepoRoots(path.join(home, 'notes'))).toEqual([]);
    expect(resolveRepoRoots(home)).toEqual([]);
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
