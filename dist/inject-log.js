import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getIndexDir } from './paths.js';
/**
 * Observability log for the UserPromptSubmit context injection pipeline.
 *
 * The injection hook historically failed silently (stderr discarded, empty
 * output indistinguishable from "no relevant facts"), which let a broken
 * install go unnoticed for months. Every run now appends one JSONL line so
 * "injection never fires" becomes measurable instead of invisible.
 *
 * Logging is strictly best-effort: it must never throw or block injection.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate at 5MB
/** Log form of a fact id — 12 chars keep lines short and are unique enough for joins. */
export function shortId(id) {
    return id.slice(0, 12);
}
/** sha256(session id) prefix, or undefined without a session id. */
export function sessionKey(sessionId) {
    return sessionId ? createHash('sha256').update(sessionId).digest('hex').slice(0, 12) : undefined;
}
let cachedVersion;
/** Version from the package.json next to dist/ (works for dist/*.js and the bundled server alike); undefined when unreadable. */
export function pluginVersion() {
    if (cachedVersion === undefined) {
        try {
            const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
            cachedVersion = typeof pkg.version === 'string' ? pkg.version : null;
        }
        catch {
            cachedVersion = null;
        }
    }
    return cachedVersion ?? undefined;
}
export function getInjectLogPath() {
    const dir = path.join(getIndexDir(), 'logs');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'inject-context.jsonl');
}
/**
 * Append a single JSONL entry to the injection log.
 * Rotates to `.old` (replacing any previous rotation) when the log exceeds 5MB.
 * Never throws.
 */
export function appendInjectLog(entry) {
    try {
        const logPath = getInjectLogPath();
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > MAX_LOG_BYTES) {
                fs.renameSync(logPath, `${logPath}.old`);
            }
        }
        catch {
            // No existing log — nothing to rotate.
        }
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
        fs.appendFileSync(logPath, line + '\n');
    }
    catch {
        // Best-effort only: observability must not break injection.
    }
}
