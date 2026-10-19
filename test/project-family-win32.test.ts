import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import nodePath from 'path';

// The family's boundaries are '/' segments: with Windows' separator the predicate makes no family (the exact-path
// scope). This platform's separator is '/', so the module sees a path whose `sep` is '\\'.
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return { ...actual, default: { ...actual, sep: '\\' }, sep: '\\' };
});

const { resolveRepoRoots, scopeMatcher, clearRepoRootCache } = await import('../src/project-family.js');

const tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'mb-family-win32-')));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('project family on a Windows separator', () => {
  it('a real repository gets no family: only the exact path is in scope', () => {
    const repo = nodePath.join(tmp, 'repo');
    fs.mkdirSync(nodePath.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(nodePath.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(nodePath.join(repo, 'docs'), { recursive: true });
    clearRepoRootCache();
    expect(resolveRepoRoots(repo)).toEqual([]);
    expect(resolveRepoRoots(nodePath.join(repo, 'docs'))).toEqual([]);
    const m = scopeMatcher(nodePath.join(repo, 'docs'), true);
    expect(m(repo), 'the repository root is not the sub-folder\'s family').toBe(false);
    expect(m(nodePath.join(repo, 'docs')), 'the exact path still is').toBe(true);
  });
});
