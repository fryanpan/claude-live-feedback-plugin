/**
 * Where the durable record lives — the `.ydoc` corpus, `activity.jsonl`,
 * `deploy-log.json`, and the sidecars beside them.
 *
 * ## Why this is not simply `join(repoRoot, 'data')`
 *
 * It was, and only that, until 2026-09-01. The default put the one thing this
 * project promises never to destroy INSIDE the checkout that the deploy
 * fast-forwards: `runDeploy` runs `git merge --ff-only` in the same directory
 * that holds every doc anyone has ever written. `data/` is gitignored, so the
 * two coexisted — but the coupling meant re-cloning prod, or moving it, moved
 * the corpus by hand or lost it, and nothing in the launcher could say
 * otherwise because `scripts/serve.ts` never passed `--data-dir` at all.
 *
 * The variable exists so prod can put the corpus on a path chosen for
 * durability rather than for where a checkout happens to sit. The default is
 * unchanged, so dev, staging, and a bare `bin.ts` behave exactly as before.
 *
 * ## Precedence
 *
 * `CW_DATA_DIR` beats the default. An explicit `--data-dir` on the command
 * line beats both — that is `bin.ts`'s own `arg()` fallback chain, and
 * `scripts/staging.ts` depends on it to keep a throwaway data dir off prod's.
 */
import { join } from 'node:path';

/** The env var prod sets to move the corpus off the checkout. */
export const DATA_DIR_ENV = 'CW_DATA_DIR';

/**
 * The data dir for a server rooted at `repoRoot`.
 *
 * Blank and whitespace-only are treated as unset rather than as a request for
 * the filesystem root: a plist key someone emptied out should fall back to the
 * default, not resolve `join('', 'data')`.
 */
export function resolveDataDir(env: Record<string, string | undefined>, repoRoot: string): string {
  const explicit = env[DATA_DIR_ENV]?.trim();
  if (explicit) return explicit;
  return join(repoRoot, 'data');
}
