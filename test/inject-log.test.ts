import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const originalEnv = { ...process.env };

describe('inject-log', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-inject-log-'));
    process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sessionKey hashes only a non-empty string session id', async () => {
    const { sessionKey } = await import('../src/inject-log.js');
    expect(sessionKey('abc')).toMatch(/^[0-9a-f]{12}$/);
    for (const v of [12345, {}, ['x'], '', null, undefined]) expect(sessionKey(v), JSON.stringify(v)).toBeUndefined();
  });

  it('appends a parseable JSONL entry with timestamp', async () => {
    const { appendInjectLog, getInjectLogPath } = await import('../src/inject-log.js');

    appendInjectLog({ status: 'injected', project: '/tmp/proj', prompt_len: 42, candidates: 5, injected: 3, duration_ms: 120 });
    appendInjectLog({ status: 'no-match', project: '/tmp/proj', prompt_len: 30, candidates: 5, injected: 0 });

    const logPath = getInjectLogPath();
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.status).toBe('injected');
    expect(first.injected).toBe(3);
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const second = JSON.parse(lines[1]);
    expect(second.status).toBe('no-match');
  });

  it('records error entries', async () => {
    const { appendInjectLog, getInjectLogPath } = await import('../src/inject-log.js');

    appendInjectLog({ status: 'error', project: '/tmp/proj', error: 'Cannot find module better-sqlite3' });

    const entry = JSON.parse(fs.readFileSync(getInjectLogPath(), 'utf8').trim());
    expect(entry.status).toBe('error');
    expect(entry.error).toContain('better-sqlite3');
  });

  it('rotates the log to .old when exceeding 5MB', async () => {
    const { appendInjectLog, getInjectLogPath } = await import('../src/inject-log.js');

    const logPath = getInjectLogPath();
    fs.writeFileSync(logPath, 'x'.repeat(5 * 1024 * 1024 + 1));

    appendInjectLog({ status: 'skipped', prompt_len: 3 });

    expect(fs.existsSync(`${logPath}.old`)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).status).toBe('skipped');
  });

  it('decision helpers: shortId is 12 chars, sessionKey is a sha256 prefix, pluginVersion is package.json', async () => {
    const { shortId, sessionKey, pluginVersion } = await import('../src/inject-log.js');
    const { createHash } = await import('crypto');
    expect(shortId('0123456789abcdef-rest')).toBe('0123456789ab');
    expect(sessionKey('sess-1')).toBe(createHash('sha256').update('sess-1').digest('hex').slice(0, 12));
    expect(sessionKey(undefined)).toBeUndefined();
    expect(sessionKey('')).toBeUndefined();
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    expect(pluginVersion()).toBe(pkg.version);
  });

  it('a field holding a newline cannot split the JSONL line', async () => {
    const { appendInjectLog, getInjectLogPath } = await import('../src/inject-log.js');
    appendInjectLog({ status: 'skipped', project: '/tmp/a\n{"status":"injected"}\u2028x', reason: 'r\r\nq' });
    const raw = fs.readFileSync(getInjectLogPath(), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(raw).project).toContain('\n');
  });

  it('never throws when the log directory is not writable', async () => {
    const { appendInjectLog } = await import('../src/inject-log.js');
    // Point config dir at a path whose parent is a file — mkdir will fail internally.
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'file');
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(blocker, 'nested');

    expect(() => appendInjectLog({ status: 'skipped' })).not.toThrow();
  });
});
