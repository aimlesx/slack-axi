import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import { atomicWriteJson } from "../src/fs-store.js";
import { applyAction, stageAction } from "../src/mutations.js";
import { PolicyStore } from "../src/policy.js";
import { MemorySecrets } from "./helpers.js";

async function policyWithDomains(domains = ["example.com"]): Promise<PolicyStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-links-"));
  const globalFile = path.join(root, "policy.json");
  await atomicWriteJson(globalFile, { version: 1, allow_direct_apply: [], allowed_unfurl_domains: domains });
  return new PolicyStore(globalFile, path.join(root, "project.json"));
}

describe("unfurl policy", () => {
  it("allows normal and Slack-labeled links only for allowlisted domains", async () => {
    const policy = await policyWithDomains();
    await expect(policy.validateUnfurls("see https://docs.example.com/a", true)).resolves.toBeUndefined();
    await expect(policy.validateUnfurls("see <https://docs.example.com/a|documentation>", true)).resolves.toBeUndefined();
    await expect(policy.validateUnfurls("see https://evil.test/a", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    await expect(policy.validateUnfurls("see <https://evil.test/a|documentation>", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
  });

  it("fails closed for malformed and encoded URL-like constructs", async () => {
    const policy = await policyWithDomains();
    await expect(policy.validateUnfurls("see <https://docs.example.com/a|missing close", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    await expect(policy.validateUnfurls("see https://%65vil.test/a", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    await expect(policy.validateUnfurls("see https%3A%2F%2Fevil.test/a", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    await expect(policy.validateUnfurls("see %68%74%74%70%73%3A%2F%2Fevil.test/a", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    await expect(policy.validateUnfurls("see www%2Eevil.test/a", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    await expect(policy.validateUnfurls("see https://docs.example.com/redirect?next=https://evil.test", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
  });

  it("permits links when message unfurls are explicitly disabled", async () => {
    const policy = await policyWithDomains([]);
    await expect(policy.validateUnfurls("see <https://evil.test|label>", false)).resolves.toBeUndefined();
  });

  it("rejects every URL-like upload comment because upload unfurls cannot be disabled", async () => {
    const policy = await policyWithDomains();
    await expect(policy.validateUploadComment("release notes attached")).resolves.toBeUndefined();
    for (const comment of [
      "see https://docs.example.com/a",
      "see <https://evil.test/a|details>",
      "see <https://docs.example.com/a|missing close",
      "see https%3A%2F%2Fdocs.example.com/a",
    ]) {
      await expect(policy.validateUploadComment(comment), comment).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    }
  });

  it("revalidates message payloads and upload comments at the staging boundary", async () => {
    const actions = { create: vi.fn(async () => ({ id: "staged" })) };
    const policy = {
      validateUnfurls: vi.fn(async () => undefined),
      validateUploadComment: vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "UNFURL_POLICY_DENIED" }); }),
    };
    const app = { actions, policy } as unknown as SlackAxiApp;
    const context = { profile: { team_id: "T1", actor_id: "U1" } } as WorkspaceContext;

    await stageAction(app, context, {
      operation: "message.reply",
      targetIds: ["C1"],
      preview: {},
      payload: { text: "<https://example.com|label>", unfurl_links: true },
    });
    expect(policy.validateUnfurls).toHaveBeenCalledWith("<https://example.com|label>", true);

    await expect(stageAction(app, context, {
      operation: "message.send",
      targetIds: ["C1"],
      preview: {},
      payload: { text: "x".repeat(40_001), unfurl_links: false },
    })).rejects.toMatchObject({ code: "MESSAGE_TOO_LONG" });

    await expect(stageAction(app, context, {
      operation: "file.upload",
      targetIds: ["C1"],
      preview: {},
      payload: { initial_comment: "https://example.com" },
    })).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    expect(policy.validateUploadComment).toHaveBeenCalledWith("https://example.com");
    expect(actions.create).toHaveBeenCalledTimes(1);
  });

  it("revalidates previously staged message and upload content before dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-apply-"));
    const policy = await policyWithDomains([]);
    const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    const source = path.join(root, "upload.txt");
    await atomicWriteJson(source, { content: "snapshot" });
    const postMessage = vi.fn();
    const uploadFile = vi.fn();
    const context = {
      profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      public: {
        async authTest() { return { team_id: "T1", user_id: "U1" }; },
        postMessage,
        uploadFile,
      },
      snapshot: {}, conversations: [], users: [], userMap: new Map(),
    } as unknown as WorkspaceContext;
    const app = { actions, policy, async context() { return context; } } as unknown as SlackAxiApp;

    for (const operation of ["message.send", "message.reply"] as const) {
      const plan = await actions.create({
        workspace_id: "T1",
        actor_id: "U1",
        operation,
        target_ids: ["C1"],
        preview: {},
        payload: {
          conversation_id: "C1",
          ...(operation === "message.reply" ? { thread_ts: "1786712345.000001" } : {}),
          text: "<https://evil.test|label>",
          client_msg_id: `${operation}-id`,
          unfurl_links: true,
        },
      });
      await expect(applyAction(app, plan, plan.approval)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
      // Policy is checked while the policy lease is held and before the action
      // crosses the remote boundary. A denial therefore leaves the immutable
      // approved plan replayable only if policy changes again before expiry.
      expect((await actions.get(plan.id)).state).toBe("planned");
    }

    const oversized = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "message.send",
      target_ids: ["C1"],
      preview: {},
      payload: { conversation_id: "C1", text: "x".repeat(40_001), client_msg_id: "oversized-id", unfurl_links: false },
    });
    await expect(applyAction(app, oversized, oversized.approval)).rejects.toMatchObject({ code: "MESSAGE_TOO_LONG" });
    expect((await actions.get(oversized.id)).state).toBe("not_applied");

    const upload = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "file.upload",
      target_ids: ["C1"],
      preview: {},
      payload: { conversation_id: "C1", filename: "upload.txt", initial_comment: "https://evil.test" },
      upload_path: source,
    });
    await expect(applyAction(app, upload, upload.approval)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    expect((await actions.get(upload.id)).state).toBe("not_applied");
    expect(postMessage).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
