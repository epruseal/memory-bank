/**
 * Repository family of a working directory — the read-side scope widening the
 * injection bench evaluates (plan 2026-10-19, candidate C2).
 *
 * facts.scope_project is the exact cwd a fact was extracted in, so a session in
 * a worktree (`<repo>/.auto-issue-worktrees/issue-12`) or a sub-folder
 * (`<repo>/docs`) never sees the repo's own project facts, and the repo never
 * sees what its worktrees learned. The family is the git top-level of the cwd
 * plus, for a linked worktree, the main repository root; a fact is in the
 * family when its scope_project is one of those roots or lies under one —
 * but not inside another repository nested there (a separate clone or a
 * submodule); a linked worktree of a family root is not "another repository".
 * The widening is one-way for worktrees placed outside the repository folder
 * (a sibling `.auto-issue-worktrees/` folder): such a worktree sees the
 * repository's facts, the repository does not see the worktree's.
 *
 * Resolved from the filesystem only (no `git` process — the injection hook has
 * a hard time budget). A root is a real repository: a `.git` directory holding
 * HEAD, or a `.git` file naming an existing git dir (a folder holding HEAD); anything else named
 * `.git` (garbage, an empty folder, a symlink) means no family. A root is never
 * a home directory ($HOME or the account's own — HOME can be overridden), an
 * ancestor of one, or '/': a home directory that is itself a git work tree
 * would otherwise make every non-repo folder under it one family with every
 * project. Relative paths have no family here (callers resolve a slug-form
 * project to a path first — canonicalizeProject — and use that path's family),
 * and neither has a cwd that is a symbolic link or a file, or that has a
 * symbolic link between it and its repository root — the root itself included (a
 * link can point into another repository, and a link's target can change under
 * the same path). Links above the root are not looked at: the scope is a path,
 * as the exact-path project scope always was. A path that cannot be read (EACCES, EIO) counts as no family / outside
 * it, never as absent. A path that no longer exists has no family and is never
 * in one: nothing on disk tells which repository it was (a deleted worktree, a
 * deleted clone, another repository's layer in a container all look the same),
 * so facts learned in a since-deleted worktree are not seen by its repository.
 * Inside a worktree container only the family's linked worktrees count, for a cwd
 * and a fact path alike (a plain folder there may hold another repository's
 * worktrees); the container is the one of the repository or worktree the path
 * is in, its name compared case-folded on macOS (on a case-sensitive volume too —
 * folding only ever leaves more out). A Windows path has no family (the boundaries
 * here are '/' segments): the exact-path scope. The worktrees of a
 * bare repository (`<dir>/.bare/worktrees/…`) are not grouped: each one is its
 * own family.
 */
/** Worktree containers of a repository root (`<root>/.claude/worktrees/<name>`) — the one list. */
export declare const WORKTREE_CONTAINERS: readonly string[];
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
 * path under it — on a '/' boundary, so `<repo>` never matches
 * `<repo>-extra`, never inside a repository nested under a root, never a
 * path that no longer exists, and inside a worktree container only a family worktree. A
 * path with '.' or '..' segments matches only exactly. A null project sees
 * every scope.
 */
export declare function scopeMatcher(project: string | null, family: boolean): (scopeProject: string | null) => boolean;
