import { AxiError } from "./errors.js";
import type { ActionPlan } from "./types.js";

export async function withOwnedRelease<T>(
  operation: () => Promise<T>,
  release: () => Promise<void>,
  onSuccessfulReleaseFailure?: (value: T, cause: unknown) => T,
): Promise<T> {
  let value: T;
  try {
    value = await operation();
  } catch (primary) {
    // Cleanup is secondary to the operation's result. In particular, never
    // replace ACTION_COMMIT_UNKNOWN with a lock-release implementation error.
    try { await release(); } catch { /* preserve the primary outcome */ }
    throw primary;
  }

  try {
    await release();
  } catch (cause) {
    if (onSuccessfulReleaseFailure) return onSuccessfulReleaseFailure(value, cause);
    throw cause;
  }
  return value;
}

function isActionPlan(value: unknown): value is ActionPlan {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ActionPlan>;
  return typeof candidate.id === "string"
    && typeof candidate.state === "string"
    && typeof candidate.revision === "number";
}

export function preserveActionOutcome<T>(value: T, cause: unknown, scope: "action" | "credential" | "policy" | "content"): T {
  if (!isActionPlan(value)) throw cause;
  const dependencyCode = cause instanceof AxiError
    ? cause.code
    : cause instanceof Error && "code" in cause
      ? String(cause.code)
      : "LOCK_RELEASE_FAILED";
  const warning = {
    code: scope === "content" ? "LOCAL_CONTENT_CLEANUP_INCOMPLETE" : "LOCAL_LOCK_RELEASE_INCOMPLETE",
    scope,
    dependency_code: dependencyCode,
    message: scope === "content"
      ? `The signed '${value.state}' action outcome is durable, but sensitive local action content still requires cleanup.`
      : `The signed '${value.state}' action outcome is durable, but the local ${scope} lease could not be released cleanly.`,
  };
  const result = value.result ?? {};
  const existing = Array.isArray(result.local_cleanup_warnings) ? result.local_cleanup_warnings : [];
  return {
    ...value,
    result: { ...result, local_cleanup_warnings: [...existing, warning] },
  } as T;
}
