/**
 * Family roots of `cwd` ([] = no family: not in a repository, or only a too-broad one) — the
 * worktree's own top first, then (for a linked worktree) the main repository root, so the last
 * root is always the repository. Cached per cwd for a minute.
 */
export declare function resolveRepoRoots(cwd: string): string[];
/** Test hook — the cache is per process and keyed by cwd. */
export declare function clearRepoRootCache(): void;
/**
 * Whether a project-scoped fact's scope_project is visible from `project`.
 * The single predicate behind the KNN scope filter, the relation scope filter
 * and the replay bench. family=false (and family=true with no roots) is the
 * exact match the injection has always used; family=true matches a root or a
 * path under it — on a '/' boundary, so `memory-bank` never matches
 * `memory-bank-cloud`, never inside a repository nested under a root, and a
 * deleted path only inside a worktree container of the root. A
 * path with '.' or '..' segments matches only exactly. A null project sees
 * every scope.
 */
export declare function scopeMatcher(project: string | null, family: boolean): (scopeProject: string | null) => boolean;
