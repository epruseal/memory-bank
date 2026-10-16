/**
 * Strict argument parsing for the maintenance scripts that write the live DB.
 * A lenient `argv.indexOf('--db')` parser silently ignored `--db=PATH` and
 * typos like `--dryrun`, so a run meant for a copy hit the default (live)
 * database. Unknown arguments and missing values now fail before anything opens.
 */
export interface CliArgs {
  values: Record<string, string>;
  flags: Set<string>;
}

export function parseCliArgs(argv: string[], spec: { values?: string[]; flags?: string[] }): CliArgs {
  const valueNames = new Set(spec.values ?? []);
  const flagNames = new Set(spec.flags ?? []);
  const out: CliArgs = { values: {}, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > -1 ? a.slice(0, eq) : a;
    if (valueNames.has(name)) {
      const value = eq > -1 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
        throw new Error(`${name} needs a value`);
      }
      if (name in out.values) throw new Error(`${name} given more than once`);
      out.values[name] = value;
    } else if (flagNames.has(name) && eq === -1) {
      if (out.flags.has(name)) throw new Error(`${name} given more than once`);
      out.flags.add(name);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

/**
 * Fail when an argument that the chosen mode does not use was given. A flag
 * accepted by the parser but ignored by the mode is worse than an unknown one:
 * `--restore FILE --dry-run` used to restore for real.
 */
export function assertOnlyArgs(args: CliArgs, allowed: string[], mode: string): void {
  const ok = new Set(allowed);
  const extra = [...Object.keys(args.values), ...args.flags].filter((n) => !ok.has(n));
  if (extra.length) throw new Error(`${extra.join(', ')} cannot be used with ${mode}`);
}
