import { describe, expect, it, vi } from "vitest";
import { assertLiveActionIdentity } from "../src/identity.js";
import type { WorkspaceContext } from "../src/app.js";
import type { ActionPlan } from "../src/types.js";

const action = {
  workspace_id: "T1",
  actor_id: "U1",
} as ActionPlan;

function context(identity: Record<string, unknown>): WorkspaceContext {
  return {
    profile: { alias: "work", team_id: "T1", actor_id: "U1" },
    public: { authTest: vi.fn(async () => identity) },
  } as unknown as WorkspaceContext;
}

describe("live action identity", () => {
  it("accepts the live credential only when signed team and actor both match", async () => {
    const value = context({ team_id: "T1", user_id: "U1" });
    await expect(assertLiveActionIdentity(value, action)).resolves.toBeUndefined();
    expect(value.public.authTest).toHaveBeenCalledOnce();
  });

  it.each([
    [{ team_id: "T1", user_id: "U2" }, "U2"],
    [{ team_id: "T2", user_id: "U1" }, "U1"],
    [{}, null],
  ])("fails closed before dispatch for a different or malformed live identity", async (identity, actor) => {
    await expect(assertLiveActionIdentity(context(identity), action)).rejects.toMatchObject({
      code: "ACTION_IDENTITY_MISMATCH",
      details: { signed_workspace_id: "T1", signed_actor_id: "U1", live_actor_id: actor },
    });
  });
});
