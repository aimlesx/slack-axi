import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { ConfigStore } from "../src/config.js";
import { AxiError } from "../src/errors.js";
import { applyAction, directOrStage } from "../src/mutations.js";
import { PolicyStore } from "../src/policy.js";
import type { AuthProfile, Policy } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

type ReleaseLayer = "policy" | "credential" | "action";
type RemoteOutcome = "applied" | "unknown";
type InjectedState = RemoteOutcome | "applying";

class RenameWonActionStore extends ActionStore {
  constructor(directory: string, secrets: MemorySecrets, private readonly failState: InjectedState) {
    super(directory, secrets);
  }

  protected override async persistSignedState(filename: string, value: unknown): Promise<void> {
    await super.persistSignedState(filename, value);
    const state = (value as { data?: { state?: unknown } }).data?.state;
    if (state === this.failState) {
      throw new AxiError({ code: "DIRECTORY_FSYNC_FAILED", message: "Injected failure after the state rename became visible." });
    }
  }
}

function policyValue(): Policy {
  return {
    version: 1,
    allow_direct_apply: [{ operation: "message.send", conversations: ["C1"] }],
    allow_broadcast_mentions: [],
    allowed_unfurl_domains: [],
  };
}

function failingLock(code: string): { acquire(): Promise<{ owner: Record<string, unknown>; release(): Promise<void> }> } {
  return {
    async acquire() {
      return {
        owner: {},
        async release() { throw new AxiError({ code, message: "Injected release failure." }); },
      };
    },
  };
}

function context(postMessage: ReturnType<typeof vi.fn>): WorkspaceContext {
  return {
    profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
    public: {
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      postMessage,
      async permalink() { return "https://example.slack.com/archives/C1/p1786712345001200"; },
    },
    snapshot: {},
    conversations: [],
    users: [],
    userMap: new Map(),
  } as unknown as WorkspaceContext;
}

function post(outcome: RemoteOutcome): ReturnType<typeof vi.fn> {
  return vi.fn(async () => outcome === "applied"
    ? { ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", text: "once", user: "U1" } }
    : { ok: true, message: { text: "once", user: "U1" } });
}

async function plan(actions: ActionStore) {
  return actions.create({
    workspace_id: "T1",
    actor_id: "U1",
    operation: "message.send",
    target_ids: ["C1"],
    preview: { text: "once" },
    payload: { conversation_id: "C1", text: "once", client_msg_id: "release-id", unfurl_links: false },
  });
}

async function runReleaseFailure(layer: ReleaseLayer, outcome: RemoteOutcome): Promise<{
  actions: ActionStore;
  actionId: string;
  postMessage: ReturnType<typeof vi.fn>;
  value: Awaited<ReturnType<typeof applyAction>> | undefined;
  error: unknown;
  app: SlackAxiApp;
  approval: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `slack-axi-${layer}-release-`));
  const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
  const postMessage = post(outcome);
  const workspace = context(postMessage);
  let app: SlackAxiApp;
  let actionId: string;
  let approval: string;
  let operation: Promise<Awaited<ReturnType<typeof applyAction>>>;

  if (layer === "policy") {
    const policy = new PolicyStore(path.join(root, "policy.json"), path.join(root, "project.json"));
    await policy.replace(policyValue());
    (policy as unknown as { lock: unknown }).lock = failingLock("POLICY_LOCK_LOST");
    app = { actions, policy, async context() { return workspace; } } as unknown as SlackAxiApp;
    operation = directOrStage(app, workspace, {
      operation: "message.send",
      targetIds: ["C1"],
      conversationId: "C1",
      preview: { text: "once" },
      payload: { conversation_id: "C1", text: "once", client_msg_id: "release-id", unfurl_links: false },
      apply: true,
    });
    // Direct staging happens synchronously before the first awaited policy read.
    // Retrieve identity after settlement below.
    actionId = "";
    approval = "";
  } else {
    const action = await plan(actions);
    actionId = action.id;
    approval = action.approval;
    const policy = { async validateUnfurls() {} };
    if (layer === "credential") {
      const config = new ConfigStore(path.join(root, "config.json"));
      const secrets = new MemorySecrets();
      const profile: AuthProfile = {
        alias: "work",
        team_id: "T1",
        team_name: "Test",
        actor_id: "U1",
        timezone: "UTC",
        kind: "user_token",
        keychain_accounts: ["test-token"],
        capabilities: { public_api: "supported" },
        created_at: "2026-08-16T00:00:00.000Z",
        updated_at: "2026-08-16T00:00:00.000Z",
      };
      await config.save({ version: 1, default_workspace: "work", profiles: [profile] });
      await secrets.set("test-token", "xoxp-test");
      const auth = new AuthService(config, secrets, () => workspace.public);
      (config as unknown as { lock: unknown }).lock = failingLock("CONFIG_LOCK_LOST");
      app = {
        actions,
        policy,
        async context() { return workspace; },
        async withContextLease(selector: string | undefined, callback: (leased: WorkspaceContext) => Promise<unknown>) {
          return auth.withCredentialLease(selector, async () => callback(workspace));
        },
      } as unknown as SlackAxiApp;
    } else {
      const actionStore = actions as unknown as { acquireLock(id: string): Promise<() => Promise<void>> };
      const originalAcquire = actionStore.acquireLock.bind(actions);
      actionStore.acquireLock = async (id: string) => {
        const release = await originalAcquire(id);
        return async () => {
          await release();
          throw new AxiError({ code: "ACTION_LOCK_LOST", message: "Injected release failure." });
        };
      };
      app = { actions, policy, async context() { return workspace; } } as unknown as SlackAxiApp;
    }
    operation = applyAction(app, action, action.approval);
  }

  let value: Awaited<ReturnType<typeof applyAction>> | undefined;
  let error: unknown;
  try { value = await operation; } catch (cause) { error = cause; }
  if (layer === "policy") {
    const staged = (await actions.list())[0]!;
    actionId = staged.id;
    approval = staged.approval;
  }
  return { actions, actionId, postMessage, value, error, app, approval };
}

describe("mutation outcome survives lease release failures", () => {
  it.each(["policy", "credential", "action"] as const)("returns durable applied state after %s release fails", async (layer) => {
    const result = await runReleaseFailure(layer, "applied");
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      state: "applied",
      result: { local_cleanup_warnings: expect.arrayContaining([expect.objectContaining({ code: "LOCAL_LOCK_RELEASE_INCOMPLETE", scope: layer })]) },
    });
    expect((await result.actions.get(result.actionId)).state).toBe("applied");
    expect(result.postMessage).toHaveBeenCalledOnce();

    if (layer === "action") {
      const retried = await applyAction(result.app, await result.actions.get(result.actionId), result.approval);
      expect(retried).toMatchObject({ state: "applied", result: { noop: true, already_applied: true } });
      expect(result.postMessage).toHaveBeenCalledOnce();
    }
  });

  it.each(["policy", "credential", "action"] as const)("preserves ACTION_COMMIT_UNKNOWN after %s release also fails", async (layer) => {
    const result = await runReleaseFailure(layer, "unknown");
    expect(result.value).toBeUndefined();
    expect(result.error).toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect((await result.actions.get(result.actionId)).state).toBe("unknown");
    expect(result.postMessage).toHaveBeenCalledOnce();
  });
});

describe("durable outcome survives sensitive-content cleanup failures", () => {
  it.each(["applied", "unknown"] as const)("keeps %s authoritative and repairs content on the next load", async (outcome) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-content-cleanup-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const action = await plan(actions);
    const postMessage = post(outcome);
    const workspace = context(postMessage);
    const app = { actions, policy: { async validateUnfurls() {} }, async context() { return workspace; } } as unknown as SlackAxiApp;
    const originalCleanup = actions.cleanupContent.bind(actions);
    let attempts = 0;
    vi.spyOn(actions, "cleanupContent").mockImplementation(async (id) => {
      attempts += 1;
      if (attempts === 1) throw new AxiError({ code: "CONTENT_CLEANUP_FAILED", message: "Injected cleanup failure." });
      return originalCleanup(id);
    });

    if (outcome === "applied") {
      const applied = await applyAction(app, action, action.approval);
      expect(applied).toMatchObject({ state: "applied", result: { local_cleanup_warnings: [expect.objectContaining({ code: "LOCAL_CONTENT_CLEANUP_INCOMPLETE", scope: "content" })] } });
    } else {
      await expect(applyAction(app, action, action.approval)).rejects.toMatchObject({
        code: "ACTION_COMMIT_UNKNOWN",
        details: { local_cleanup_warnings: [expect.objectContaining({ code: "LOCAL_CONTENT_CLEANUP_INCOMPLETE", scope: "content" })] },
      });
    }
    expect(postMessage).toHaveBeenCalledOnce();
    const rawState = JSON.parse(await readFile(path.join(root, action.id, "state.json"), "utf8"));
    expect(rawState.data).toMatchObject({ state: outcome, content_discarded: true });
    await expect(stat(path.join(root, action.id, "payload.json"))).resolves.toBeDefined();

    const repaired = await actions.get(action.id);
    expect(repaired.state).toBe(outcome);
    await expect(stat(path.join(root, action.id, "payload.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});

describe("state persistence recognizes a rename that won before fsync failed", () => {
  it.each(["applied", "unknown"] as const)("preserves the exact signed %s revision", async (outcome) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-state-rename-won-"));
    const actions = new RenameWonActionStore(root, new MemorySecrets(), outcome);
    const action = await plan(actions);
    const postMessage = post(outcome);
    const workspace = context(postMessage);
    const app = { actions, policy: { async validateUnfurls() {} }, async context() { return workspace; } } as unknown as SlackAxiApp;

    if (outcome === "applied") {
      await expect(applyAction(app, action, action.approval)).resolves.toMatchObject({ state: "applied" });
    } else {
      await expect(applyAction(app, action, action.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    }
    expect(postMessage).toHaveBeenCalledOnce();
    expect(await actions.get(action.id)).toMatchObject({ state: outcome, content_discarded: true });
    const rawState = JSON.parse(await readFile(path.join(root, action.id, "state.json"), "utf8"));
    expect(rawState.data.state).toBe(outcome);
  });

  it("never dispatches when a planned-to-applying durability sync fails after rename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-applying-rename-won-"));
    const actions = new RenameWonActionStore(root, new MemorySecrets(), "applying");
    const action = await plan(actions);
    const postMessage = post("applied");
    const workspace = context(postMessage);
    const app = { actions, policy: { async validateUnfurls() {} }, async context() { return workspace; } } as unknown as SlackAxiApp;

    await expect(applyAction(app, action, action.approval)).rejects.toMatchObject({ code: "DIRECTORY_FSYNC_FAILED" });
    expect(postMessage).not.toHaveBeenCalled();
    expect(await actions.get(action.id)).toMatchObject({ state: "applying" });
  });

  it("never dispatches when a partial-to-applying durability sync fails after rename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-partial-rename-won-"));
    const secrets = new MemorySecrets();
    const setup = new ActionStore(root, secrets);
    const action = await plan(setup);
    const applying = await setup.transition(action, "applying");
    const partial = await setup.transition(applying, "partial", { result: { recovery: { conversation_id: "C1" } } });
    const actions = new RenameWonActionStore(root, secrets, "applying");
    const postMessage = post("applied");
    const workspace = context(postMessage);
    const app = { actions, policy: { async validateUnfurls() {} }, async context() { return workspace; } } as unknown as SlackAxiApp;

    await expect(applyAction(app, partial, partial.approval)).rejects.toMatchObject({ code: "DIRECTORY_FSYNC_FAILED" });
    expect(postMessage).not.toHaveBeenCalled();
    expect(await actions.get(action.id)).toMatchObject({ state: "applying" });
  });
});
