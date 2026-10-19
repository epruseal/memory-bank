/** Family roots of `cwd` ([] = no family: not in a repository, or only a too-broad one). Cached per cwd. */
export declare function resolveRepoRoots(cwd: string): string[];
/** Test hook — the cache is per process and keyed by cwd. */
export declare function clearRepoRootCache(): void;
/**
 * Whether a project-scoped fact's scope_project is visible from `project`.
 * The single predicate behind the KNN scope filter, the relation scope filter
 * and the replay bench. family=false (and family=true with no roots) is the
 * exact match the injection has always used; family=true matches a root or a
 * path under it — on a '/' boundary, so `memory-bank` never matches
 * `memory-bank-cloud`. A null project sees every scope.
 */
export declare function scopeMatcher(project: string | null, family: boolean): (scopeProject: string | null) => boolean;
