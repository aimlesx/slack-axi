import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import { AxiError } from "../src/errors.js";
import { directOrStage } from "../src/mutations.js";
import { PolicyStore } from "../src/policy.js";
import type { Policy } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

type FailureMode = "before_rename" | "rename_won" | "unexpected_target";

function policyValue(direct = true, broadcast = false): Policy {
  return {
    version: 1,
    allow_direct_apply: direct ? [{ operation: "message.send", conversations: ["C1"] }] : [],
    allow_broadcast_mentions: broadcast ? [{ operation: "message.send", conversations: ["C1"] }] : [],
    allowed_unfurl_domains: [],
  };
}

class FailingPolicyStore extends PolicyStore {
  private failure: FailureMode | undefined;

  constructor(private readonly targetFile: string, projectFile: string) {
    super(targetFile, projectFile);
  }

  arm(failure: FailureMode): void {
    this.failure = failure;
  }

  protected override async persistPolicyFile(filename: string, value: unknown): Promise<void> {
    if (filename !== this.targetFile || !this.failure) {
      await super.persistPolicyFile(filename, value);
      return;
    }
    const failure = this.failure;
    this.failure = undefined;
    if (failure === "before_rename") {
      throw new AxiError({ code: "POLICY_WRITE_FAILED", message: "Injected failure before the policy rename." });
    }
    await super.persistPolicyFile(filename, failure === "unexpected_target" ? policyValue(true, true) : value);
    throw new AxiError({ code: "DIRECTORY_FSYNC_FAILED", message: "Injected failure after the policy rename became visible." });
  }
}

function failingLock(): { acquire(): Promise<{ owner: Record<string, unknown>; release(): Promise<void> }> } {
  return {
    async acquire() {
      return {
        owner: {},
        async release() { throw new AxiError({ code: "POLICY_LOCK_LOST", message: "Injected release failure." }); },
      };
    },
  };
}

function workspace(postMessage: ReturnType<typeof vi.fn>): WorkspaceContext {
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

async function directSend(policy: PolicyStore, root: string, postMessage: ReturnType<typeof vi.fn>) {
  const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
  const context = workspace(postMessage);
  const app = { actions, policy, async context() { return context; } } as unknown as SlackAxiApp;
  return directOrStage(app, context, {
    operation: "message.send",
    targetIds: ["C1"],
    conversationId: "C1",
    preview: { text: "once" },
    payload: { conversation_id: "C1", text: "once", client_msg_id: "policy-commit-id", unfurl_links: false },
    apply: true,
  });
}

describe("policy commit boundaries", () => {
  it("recognizes an exact grant whose rename won, then permits exactly one direct dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-rename-won-"));
    const filename = path.join(root, "policy.json");
    const policy = new FailingPolicyStore(filename, path.join(root, "project.json"));
    await policy.replace(policyValue(false));
    policy.arm("rename_won");

    await expect(policy.replace(policyValue(true))).resolves.toEqual(policyValue(true));
    await expect(policy.load()).resolves.toEqual(policyValue(true));
    expect(JSON.parse(await readFile(`${filename}.commit.json`, "utf8"))).toMatchObject({ state: "committed", target: policyValue(true) });

    const postMessage = vi.fn(async () => ({ ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", user: "U1" } }));
    await expect(directSend(policy, root, postMessage)).resolves.toMatchObject({ state: "applied" });
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("leaves a durable fail-closed fence when neither target nor prior state is visible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-unknown-"));
    const filename = path.join(root, "policy.json");
    const policy = new FailingPolicyStore(filename, path.join(root, "project.json"));
    await policy.replace(policyValue(false));
    policy.arm("unexpected_target");

    await expect(policy.replace(policyValue(true))).rejects.toMatchObject({
      code: "POLICY_COMMIT_UNKNOWN",
      retryable: false,
      details: { direct_authorization_blocked: true },
    });
    expect(JSON.parse(await readFile(`${filename}.commit.json`, "utf8"))).toMatchObject({ state: "pending", target: policyValue(true) });
    await expect(policy.allows("message.send", "C1")).rejects.toMatchObject({ code: "POLICY_COMMIT_UNKNOWN" });

    const postMessage = vi.fn();
    await expect(directSend(policy, root, postMessage)).rejects.toMatchObject({ code: "POLICY_COMMIT_UNKNOWN" });
    expect(postMessage).not.toHaveBeenCalled();

    await expect(policy.replace(policyValue(false))).resolves.toEqual(policyValue(false));
    await expect(policy.allows("message.send", "C1")).resolves.toBe(false);
  });

  it("reports an ordinary write failure only after restoring the exact prior policy record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-prior-"));
    const filename = path.join(root, "policy.json");
    const policy = new FailingPolicyStore(filename, path.join(root, "project.json"));
    await policy.replace(policyValue(true));
    policy.arm("before_rename");

    await expect(policy.replace(policyValue(false))).rejects.toMatchObject({ code: "POLICY_WRITE_FAILED" });
    await expect(policy.load()).resolves.toEqual(policyValue(true));
    expect(JSON.parse(await readFile(`${filename}.commit.json`, "utf8"))).toMatchObject({ state: "committed", target: policyValue(true) });
    await expect(policy.allows("message.send", "C1")).resolves.toBe(true);
  });

  it("returns the committed grant when releasing the policy lease fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-release-"));
    const policy = new PolicyStore(path.join(root, "policy.json"), path.join(root, "project.json"));
    (policy as unknown as { lock: unknown }).lock = failingLock();

    await expect(policy.replace(policyValue(true))).resolves.toEqual(policyValue(true));
    await expect(policy.allows("message.send", "C1")).resolves.toBe(true);

    const postMessage = vi.fn(async () => ({ ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", user: "U1" } }));
    await expect(directSend(policy, root, postMessage)).resolves.toMatchObject({
      state: "applied",
      result: { local_cleanup_warnings: [expect.objectContaining({ scope: "policy" })] },
    });
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("recognizes an exact initialized policy and preserves init success across release failure", async () => {
    const renameRoot = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-init-rename-"));
    const renameFile = path.join(renameRoot, "policy.json");
    const renamed = new FailingPolicyStore(renameFile, path.join(renameRoot, "project.json"));
    renamed.arm("rename_won");
    await expect(renamed.init()).resolves.toEqual(policyValue(false));
    await expect(renamed.load()).resolves.toEqual(policyValue(false));

    const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-init-release-"));
    const released = new PolicyStore(path.join(releaseRoot, "policy.json"), path.join(releaseRoot, "project.json"));
    (released as unknown as { lock: unknown }).lock = failingLock();
    await expect(released.init()).resolves.toEqual(policyValue(false));
    await expect(released.load()).resolves.toEqual(policyValue(false));
  });
});
