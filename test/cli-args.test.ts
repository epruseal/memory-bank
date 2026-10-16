import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';

// The DB-writing maintenance scripts must never fall back to the live DB because
// an argument was spelled `--db=PATH` or mistyped.
describe('parseCliArgs', () => {
  const spec = { values: ['--db', '--min-ratio'], flags: ['--dry-run'] };

  it('accepts --name value and --name=value', () => {
    expect(parseCliArgs(['--db', '/a.db', '--min-ratio=0.5', '--dry-run'], spec)).toEqual({
      values: { '--db': '/a.db', '--min-ratio': '0.5' }, flags: new Set(['--dry-run']),
    });
    expect(parseCliArgs(['--db=/x=y.db'], spec).values['--db']).toBe('/x=y.db');
  });

  it('rejects unknown arguments, typos and missing values', () => {
    expect(() => parseCliArgs(['--dryrun'], spec)).toThrow(/unknown argument: --dryrun/);
    expect(() => parseCliArgs(['stray'], spec)).toThrow(/unknown argument: stray/);
    expect(() => parseCliArgs(['--db'], spec)).toThrow(/--db needs a value/);
    expect(() => parseCliArgs(['--db', '--dry-run'], spec)).toThrow(/--db needs a value/);
    expect(() => parseCliArgs(['--db='], spec)).toThrow(/--db needs a value/);
    expect(() => parseCliArgs(['--dry-run=1'], spec)).toThrow(/unknown argument/);
  });
});
