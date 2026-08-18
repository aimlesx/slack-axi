import { AxiError } from "./errors.js";
import type { WorkspaceContext } from "./app.js";
import type { ActionPlan } from "./types.js";

/**
 * Verify the credential currently loaded from Keychain, not only the profile
 * metadata that selected it. This check must run immediately before a remote
 * mutation or identity-sensitive reconciliation boundary.
 */
export async function assertLiveActionIdentity(context: WorkspaceContext, action: ActionPlan): Promise<void> {
  const identity = await context.public.authTest();
  const teamId = typeof identity.team_id === "string" ? identity.team_id : undefined;
  const actorId = typeof identity.user_id === "string" ? identity.user_id : undefined;
  if (teamId === action.workspace_id && actorId === action.actor_id) return;

  throw new AxiError({
    code: "ACTION_IDENTITY_MISMATCH",
    message: "The live Slack credential does not match the workspace and actor in the signed action plan; no mutation was dispatched.",
    details: {
      signed_workspace_id: action.workspace_id,
      signed_actor_id: action.actor_id,
      live_workspace_id: teamId ?? null,
      live_actor_id: actorId ?? null,
    },
    suggestedCommand: `slack-axi auth doctor --workspace ${context.profile.alias}`,
  });
}
