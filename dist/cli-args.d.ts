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
export declare function parseCliArgs(argv: string[], spec: {
    values?: string[];
    flags?: string[];
}): CliArgs;
/**
 * Fail when an argument that the chosen mode does not use was given. A flag
 * accepted by the parser but ignored by the mode is worse than an unknown one:
 * `--restore FILE --dry-run` used to restore for real.
 */
export declare function assertOnlyArgs(args: CliArgs, allowed: string[], mode: string): void;
