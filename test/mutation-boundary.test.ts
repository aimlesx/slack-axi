import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import { AxiError } from "../src/errors.js";
import { applyAction, reconcileAction } from "../src/mutations.js";
import type { ActionPlan } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

function context(publicClient: Record<string, unknown>, browser?: Record<string, unknown>): WorkspaceContext {
  return {
    profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: browser ? "browser" : "user_token", timezone: "UTC" },
    public: {
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      ...publicClient,
    },
    ...(browser ? { browser } : {}),
    snapshot: {},
    conversations: [],
    users: [],
    userMap: new Map(),
  } as unknown as WorkspaceContext;
}

function app(actions: ActionStore, workspace: WorkspaceContext): SlackAxiApp {
  return {
    actions,
    policy: {
      async validateUnfurls() {},
      async validateUploadComment() {},
    },
    async context() { return workspace; },
  } as unknown as SlackAxiApp;
}

describe("remote mutation boundary", () => {
  it.each([
    ["missing", { ok: true, message: { text: "sent" } }],
    ["malformed", { ok: true, ts: "not-a-slack-timestamp", message: { ts: "not-a-slack-timestamp", text: "sent" } }],
  ])("preserves unknown after one acknowledged post with a %s timestamp", async (_kind, response) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-post-boundary-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "message.send",
      target_ids: ["C1"],
      preview: { text: "sent" },
      payload: { conversation_id: "C1", text: "sent", client_msg_id: "boundary-id", unfurl_links: false },
    });
    const postMessage = vi.fn(async () => response);
    const workspace = context({ postMessage });

    await expect(applyAction(app(actions, workspace), plan, plan.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect(postMessage).toHaveBeenCalledOnce();
    expect(await actions.get(plan.id)).toMatchObject({
      state: "unknown",
      content_discarded: true,
      last_error: { code: _kind === "missing" ? "ACTION_COMMIT_UNKNOWN" : "MESSAGE_REF_INVALID" },
      result: { recovery: { conversation_id: "C1", client_msg_id: "boundary-id" } },
    });

    await expect(applyAction(app(actions, workspace), await actions.get(plan.id), plan.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("does not let a local persistence failure after another acknowledged write become not_applied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reaction-boundary-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "reaction.add",
      target_ids: ["C1"],
      preview: { name: "eyes" },
      payload: { conversation_id: "C1", ts: "1786712345.001200", name: "eyes", ref: "T1/C1/1786712345.001200" },
    });
    const addReaction = vi.fn(async () => ({ noop: false }));
    const originalTransition = actions.transitionLocked.bind(actions);
    vi.spyOn(actions, "transitionLocked").mockImplementation(async (current, state, changes, discard) => {
      if (state === "applied") throw new AxiError({ code: "LOCAL_RESULT_INVALID", message: "Injected local persistence failure." });
      return originalTransition(current, state, changes, discard);
    });

    await expect(applyAction(app(actions, context({ addReaction })), plan, plan.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect(addReaction).toHaveBeenCalledOnce();
    expect((await actions.get(plan.id)).state).toBe("unknown");
  });

  it("still reports ACTION_COMMIT_UNKNOWN when persisting unknown itself fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-unknown-persistence-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "message.send",
      target_ids: ["C1"],
      preview: { text: "sent once" },
      payload: { conversation_id: "C1", text: "sent once", client_msg_id: "unknown-persistence-id", unfurl_links: false },
    });
    const postMessage = vi.fn(async () => ({ ok: true, message: { text: "sent once" } }));
    const originalTransition = actions.transitionLocked.bind(actions);
    let failUnknownOnce = true;
    vi.spyOn(actions, "transitionLocked").mockImplementation(async (current, state, changes, discard) => {
      if (state === "unknown" && failUnknownOnce) {
        failUnknownOnce = false;
        throw new AxiError({ code: "DIRECTORY_FSYNC_FAILED", message: "Injected unknown-state persistence failure." });
      }
      return originalTransition(current, state, changes, discard);
    });

    await expect(applyAction(app(actions, context({ postMessage })), plan, plan.approval)).rejects.toMatchObject({
      code: "ACTION_COMMIT_UNKNOWN",
      details: { local_state_persistence: { code: "DIRECTORY_FSYNC_FAILED", complete: false } },
    });
    expect(postMessage).toHaveBeenCalledOnce();
    expect((await actions.get(plan.id)).state).toBe("applying");

    await expect(applyAction(app(actions, context({ postMessage })), await actions.get(plan.id), plan.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect(postMessage).toHaveBeenCalledOnce();
    expect((await actions.get(plan.id)).state).toBe("unknown");
  });

  it("tracks the same acknowledgement rule for every non-message write family", async () => {
    const cases: Array<{
      operation: string;
      payload: Record<string, unknown>;
      publicClient: Record<string, unknown>;
      browser?: Record<string, unknown>;
      upload?: boolean;
      remote: ReturnType<typeof vi.fn>;
    }> = [];
    const removeReaction = vi.fn(async () => ({ noop: false }));
    cases.push({ operation: "reaction.remove", payload: { conversation_id: "C1", ts: "1786712345.001200", name: "eyes", ref: "T1/C1/1786712345.001200" }, publicClient: { removeReaction }, remote: removeReaction });
    const markRead = vi.fn(async () => ({ noop: false }));
    cases.push({ operation: "mark-read", payload: { conversation_id: "C1", ts: "1786712345.001200" }, publicClient: { markRead }, remote: markRead });
    const uploadFile = vi.fn(async () => ({ id: "F1" }));
    cases.push({ operation: "file.upload", payload: { conversation_id: "C1", filename: "fixture.bin", snapshot_hash: "hash" }, publicClient: { uploadFile }, remote: uploadFile, upload: true });
    const revokeToken = vi.fn(async () => ({ revoked: true }));
    cases.push({ operation: "auth.revoke", payload: { team_id: "T1" }, publicClient: { revokeToken }, remote: revokeToken });
    const laterComplete = vi.fn(async () => ({ ok: true }));
    cases.push({ operation: "later.complete", payload: { item_id: "C1", ts: "1786712345.001200" }, publicClient: {}, browser: { laterComplete }, remote: laterComplete });
    const laterSnooze = vi.fn(async () => ({ ok: true }));
    cases.push({ operation: "later.snooze", payload: { item_id: "C1", ts: "1786712345.001200", remind_at: 1_786_800_000 }, publicClient: {}, browser: { laterSnooze }, remote: laterSnooze });

    for (const item of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-write-boundary-"));
      const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
      const uploadPath = path.join(root, "fixture.bin");
      if (item.upload) await writeFile(uploadPath, "immutable bytes");
      const plan = await actions.create({
        workspace_id: "T1",
        actor_id: "U1",
        operation: item.operation,
        target_ids: ["C1"],
        preview: {},
        payload: item.payload,
        ...(item.upload ? { upload_path: uploadPath } : {}),
      });
      const originalTransition = actions.transitionLocked.bind(actions);
      vi.spyOn(actions, "transitionLocked").mockImplementation(async (current: ActionPlan, state, changes, discard) => {
        if (state === "applied") throw new AxiError({ code: "LOCAL_RESULT_INVALID", message: "Injected post-dispatch failure." });
        return originalTransition(current, state, changes, discard);
      });

      await expect(applyAction(app(actions, context(item.publicClient, item.browser)), plan, plan.approval), item.operation).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
      expect(item.remote, item.operation).toHaveBeenCalledOnce();
      expect((await actions.get(plan.id)).state, item.operation).toBe("unknown");
    }
  });

  it("keeps an ambiguous Later write unknown with only reconciliation identity retained", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-later-boundary-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "later.snooze",
      target_ids: ["C1", "1786712345.001200"],
      preview: {},
      payload: { item_id: "C1", ts: "1786712345.001200", remind_at: 1_786_800_000 },
    });
    const laterSnooze = vi.fn(async () => {
      throw new AxiError({
        code: "REQUEST_TIMEOUT",
        message: "The private write timed out.",
        details: { dispatch_uncertain: true },
      });
    });

    await expect(applyAction(app(actions, context({}, { laterSnooze })), plan, plan.approval)).rejects.toMatchObject({
      code: "ACTION_COMMIT_UNKNOWN",
      suggestedCommand: `slack-axi action reconcile ${plan.id}`,
    });
    expect(laterSnooze).toHaveBeenCalledOnce();
    expect(await actions.get(plan.id)).toMatchObject({
      state: "unknown",
      content_discarded: true,
      result: { recovery: { item_id: "C1", ts: "1786712345.001200", remind_at: 1_786_800_000 } },
    });
  });

  it("rejects browser-session revocation before calling the public API", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-browser-revoke-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "auth.revoke",
      target_ids: ["T1"],
      preview: {},
      payload: { team_id: "T1" },
    });
    const revokeToken = vi.fn(async () => ({ revoked: true }));

    await expect(applyAction(app(actions, context({ revokeToken }, {})), plan, plan.approval)).rejects.toMatchObject({
      code: "AUTH_REVOCATION_UNSUPPORTED",
    });
    expect(revokeToken).not.toHaveBeenCalled();
    expect((await actions.get(plan.id)).state).toBe("not_applied");
  });

  it("resets an acknowledged DM-open prerequisite after its recovery identity is durable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-dm-boundary-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "message.send",
      target_ids: ["U2"],
      preview: { text: "not sent" },
      payload: { user_id: "U2", text: "not sent", client_msg_id: "dm-id", unfurl_links: false },
    });
    const openDm = vi.fn(async () => "D1");
    const postMessage = vi.fn(async () => { throw new AxiError({ code: "SLACK_PERMISSION_DENIED", message: "denied", details: { dispatch_uncertain: false } }); });

    await expect(applyAction(app(actions, context({ openDm, postMessage })), plan, plan.approval)).rejects.toMatchObject({ code: "SLACK_PERMISSION_DENIED" });
    expect(openDm).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce();
    expect((await actions.get(plan.id)).state).toBe("not_applied");
  });

  it("recovers a DM identity after partial-state persistence fails without replaying the message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-dm-recovery-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "message.send",
      target_ids: ["U2"],
      preview: { text: "send exactly once" },
      payload: { user_id: "U2", text: "send exactly once", client_msg_id: "dm-recovery-id", unfurl_links: false },
    });
    const openDm = vi.fn(async () => "D1");
    const postMessage = vi.fn(async () => ({ ok: true, ts: "1786712345.001200" }));
    const history = vi.fn(async (options: { channel: string }) => {
      expect(options.channel).toBe("D1");
      return { items: [{ ts: "1786712345.001200", client_msg_id: "dm-recovery-id" }], complete: true };
    });
    const originalTransition = actions.transitionLocked.bind(actions);
    let failPartialOnce = true;
    vi.spyOn(actions, "transitionLocked").mockImplementation(async (current, state, changes, discard) => {
      if (state === "partial" && failPartialOnce) {
        failPartialOnce = false;
        throw new AxiError({ code: "DIRECTORY_FSYNC_FAILED", message: "Injected partial-state persistence failure." });
      }
      return originalTransition(current, state, changes, discard);
    });
    const workspace = context({ openDm, postMessage, history });
    const axi = app(actions, workspace);

    await expect(applyAction(axi, plan, plan.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect(postMessage).not.toHaveBeenCalled();
    expect(await actions.get(plan.id)).toMatchObject({
      state: "unknown",
      result: { recovery: { user_id: "U2", client_msg_id: "dm-recovery-id" } },
    });

    const reconciled = await reconcileAction(axi, await actions.get(plan.id));
    expect(reconciled).toMatchObject({ state: "applied", result: { client_msg_id: "dm-recovery-id", reconciled: true } });
    expect(openDm).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
