import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import { createProgram } from "../src/cli.js";
import { applyAction, directOrStage, stageAction } from "../src/mutations.js";
import { PolicyStore, validateBroadcastMentions } from "../src/policy.js";
import type { Policy } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

function policyValue(direct = true, broadcast = false): Policy {
  return {
    version: 1,
    allow_direct_apply: direct ? [{ operation: "message.send", conversations: ["C1"] }] : [],
    allow_broadcast_mentions: broadcast ? [{ operation: "message.send", conversations: ["C1"] }] : [],
    allowed_unfurl_domains: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(publicClient: Record<string, unknown>): WorkspaceContext {
  return {
    profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
    public: publicClient,
    snapshot: {},
    conversations: [],
    users: [],
    userMap: new Map(),
  } as unknown as WorkspaceContext;
}

async function harness(publicClient: Record<string, unknown>, initial = policyValue()): Promise<{
  actions: ActionStore;
  policy: PolicyStore;
  app: SlackAxiApp;
  context: WorkspaceContext;
  policyFile: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-race-"));
  const policyFile = path.join(root, "policy.json");
  const policy = new PolicyStore(policyFile, path.join(root, "project.json"));
  await policy.replace(initial);
  const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
  const context = workspace(publicClient);
  const app = { actions, policy, async context() { return context; } } as unknown as SlackAxiApp;
  return { actions, policy, app, context, policyFile };
}

function sendInput(text = "hello", allowBroadcast = false): Parameters<typeof directOrStage>[2] {
  return {
    operation: "message.send",
    targetIds: ["C1"],
    conversationId: "C1",
    preview: { text, allow_broadcast_mentions: allowBroadcast },
    payload: { conversation_id: "C1", text, client_msg_id: "policy-race-id", unfurl_links: false, allow_broadcast_mentions: allowBroadcast },
    apply: true,
  };
}

describe("direct-apply policy lease", () => {
  it("re-reads policy after identity verification and denies a revocation that completed first", async () => {
    const enteredIdentity = deferred();
    const releaseIdentity = deferred();
    const postMessage = vi.fn();
    const state = await harness({
      async authTest() {
        enteredIdentity.resolve();
        await releaseIdentity.promise;
        return { team_id: "T1", user_id: "U1" };
      },
      postMessage,
    });

    const applying = directOrStage(state.app, state.context, sendInput());
    await enteredIdentity.promise;
    await state.policy.replace(policyValue(false));
    releaseIdentity.resolve();

    await expect(applying).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(postMessage).not.toHaveBeenCalled();
    expect((await state.actions.list())[0]?.state).toBe("planned");
  });

  it("holds authorization through dispatch and durable outcome so revocation waits", async () => {
    const enteredDispatch = deferred();
    const releaseDispatch = deferred();
    const postMessage = vi.fn(async () => {
      enteredDispatch.resolve();
      await releaseDispatch.promise;
      return { ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", text: "hello", user: "U1" } };
    });
    const state = await harness({
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      postMessage,
      async permalink() { return "https://example.slack.com/archives/C1/p1786712345001200"; },
    });

    const applying = directOrStage(state.app, state.context, sendInput());
    await enteredDispatch.promise;
    await expect(stat(`${state.policyFile}.lock`)).resolves.toBeDefined();
    const revokedPolicyFile = path.join(path.dirname(state.policyFile), "revoked.json");
    await writeFile(revokedPolicyFile, JSON.stringify(policyValue(false)));
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { output.push(String(value)); return true; });
    let revocationFinished = false;
    const revocation = createProgram({ policy: state.policy } as unknown as SlackAxiApp)
      .parseAsync(["node", "slack-axi", "--output", "json", "policy", "apply", revokedPolicyFile])
      .then(() => { revocationFinished = true; })
      .finally(() => { write.mockRestore(); });
    const ordering = await Promise.race([
      revocation.then(() => "revoked" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 75)),
    ]);
    expect(ordering).toBe("blocked");
    expect(revocationFinished).toBe(false);

    releaseDispatch.resolve();
    await expect(applying).resolves.toMatchObject({ state: "applied" });
    await revocation;
    expect(revocationFinished).toBe(true);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: true, scope: { command: "policy.apply" }, data: { applied: true } });
    await expect(state.policy.allows("message.send", "C1")).resolves.toBe(false);
  });

  it("expires without dispatch after waiting for the final policy lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-expiry-"));
      const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
      const postMessage = vi.fn();
      const context = workspace({
        async authTest() { return { team_id: "T1", user_id: "U1" }; },
        postMessage,
      });
      const policy = {
        async validateUnfurls() {},
        async allows() { return true; },
        async withDirectApplyLease(_input: unknown, callback: () => Promise<unknown>) {
          vi.advanceTimersByTime(16 * 60_000);
          return callback();
        },
      };
      const app = { actions, policy, async context() { return context; } } as unknown as SlackAxiApp;

      await expect(directOrStage(app, context, sendInput())).rejects.toMatchObject({ code: "ACTION_EXPIRED" });
      expect(postMessage).not.toHaveBeenCalled();
      expect((await actions.list())[0]).toMatchObject({ state: "expired", content_discarded: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manual unfurl policy lease", () => {
  const unfurlPolicy = (): Policy => ({ ...policyValue(false), allowed_unfurl_domains: ["example.com"] });
  const unfurlInput = {
    operation: "message.send",
    targetIds: ["C1"],
    preview: { text: "https://example.com/change" },
    payload: { conversation_id: "C1", text: "https://example.com/change", client_msg_id: "manual-unfurl-id", unfurl_links: true, unfurl_media: false },
  };

  it("observes a revocation that commits before final manual-apply authorization", async () => {
    const enteredIdentity = deferred();
    const releaseIdentity = deferred();
    const postMessage = vi.fn();
    const state = await harness({
      async authTest() {
        enteredIdentity.resolve();
        await releaseIdentity.promise;
        return { team_id: "T1", user_id: "U1" };
      },
      postMessage,
    }, unfurlPolicy());
    const staged = await stageAction(state.app, state.context, unfurlInput);

    const applying = applyAction(state.app, staged, staged.approval);
    await enteredIdentity.promise;
    await state.policy.replace(policyValue(false));
    releaseIdentity.resolve();

    await expect(applying).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    expect(postMessage).not.toHaveBeenCalled();
    expect(await state.actions.get(staged.id)).toMatchObject({ state: "planned" });
  });

  it("holds the unfurl policy lease through dispatch and durable outcome", async () => {
    const enteredDispatch = deferred();
    const releaseDispatch = deferred();
    const postMessage = vi.fn(async () => {
      enteredDispatch.resolve();
      await releaseDispatch.promise;
      return { ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", text: "https://example.com/change", user: "U1" } };
    });
    const state = await harness({
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      postMessage,
      async permalink() { return "https://example.slack.com/archives/C1/p1786712345001200"; },
    }, unfurlPolicy());
    const staged = await stageAction(state.app, state.context, unfurlInput);

    const applying = applyAction(state.app, staged, staged.approval);
    await enteredDispatch.promise;
    let revoked = false;
    const revocation = state.policy.replace(policyValue(false)).then(() => { revoked = true; });
    const ordering = await Promise.race([
      revocation.then(() => "revoked" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 75)),
    ]);
    expect(ordering).toBe("blocked");
    expect(revoked).toBe(false);

    releaseDispatch.resolve();
    await expect(applying).resolves.toMatchObject({ state: "applied" });
    await revocation;
    expect(revoked).toBe(true);
    expect(postMessage).toHaveBeenCalledOnce();
  });
});

describe("broadcast mention safety", () => {
  it.each(["<!channel>", "<!everyone>", "<!here>", "<!subteam^S012ABC>", "<!subteam^S012ABC|@release-team>"])("requires explicit opt-in for %s", (mention) => {
    expect(() => validateBroadcastMentions(`Attention ${mention}`, false)).toThrowError(expect.objectContaining({ code: "BROADCAST_MENTION_REQUIRES_OPT_IN", exitCode: 2 }));
    expect(() => validateBroadcastMentions(`Attention ${mention}`, true)).not.toThrow();
  });

  it("rejects broadcast message and upload payloads centrally before staging", async () => {
    const create = vi.fn();
    const app = {
      actions: { create },
      policy: { async validateUnfurls() {}, async validateUploadComment() {} },
    } as unknown as SlackAxiApp;
    const context = { profile: { team_id: "T1", actor_id: "U1" } } as WorkspaceContext;

    await expect(stageAction(app, context, {
      operation: "message.reply",
      targetIds: ["C1"],
      preview: {},
      payload: { text: "<!here> review", unfurl_links: false },
    })).rejects.toMatchObject({ code: "BROADCAST_MENTION_REQUIRES_OPT_IN" });
    await expect(stageAction(app, context, {
      operation: "file.upload",
      targetIds: ["C1"],
      preview: {},
      payload: { initial_comment: "<!channel> report" },
    })).rejects.toMatchObject({ code: "BROADCAST_MENTION_REQUIRES_OPT_IN" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a CLI broadcast before workspace context and exposes --allow-broadcast in help", async () => {
    let contextCalls = 0;
    const app = { async context() { contextCalls += 1; throw new Error("context must not run"); } } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "message", "send", "--to", "C1", "--text", "<!here> deploy"])).rejects.toMatchObject({ code: "BROADCAST_MENTION_REQUIRES_OPT_IN", exitCode: 2 });
    expect(contextCalls).toBe(0);
    const send = createProgram(app).commands.find((command) => command.name() === "message")?.commands.find((command) => command.name() === "send");
    expect(send?.helpInformation()).toContain("--allow-broadcast");
  });

  it("requires a separate broadcast grant for direct apply but not signed manual apply", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", text: "<!here> hello", user: "U1" } }));
    const state = await harness({
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      postMessage,
      async permalink() { return "https://example.slack.com/archives/C1/p1786712345001200"; },
    }, policyValue(true, false));

    await expect(directOrStage(state.app, state.context, sendInput("<!here> hello", true))).rejects.toMatchObject({
      code: "BROADCAST_POLICY_DENIED",
      suggestedCommand: expect.stringContaining("slack-axi action apply"),
    });
    expect(postMessage).not.toHaveBeenCalled();
    const staged = (await state.actions.list())[0]!;
    await expect(applyAction(state.app, staged, staged.approval)).resolves.toMatchObject({ state: "applied" });
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("permits broadcast direct apply only when opt-in and both policy grants are present", async () => {
    const postMessage = vi.fn(async () => ({ ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", text: "<!subteam^S012ABC> hello", user: "U1" } }));
    const state = await harness({
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      postMessage,
      async permalink() { return "https://example.slack.com/archives/C1/p1786712345001200"; },
    }, policyValue(true, true));

    await expect(directOrStage(state.app, state.context, sendInput("<!subteam^S012ABC> hello", true))).resolves.toMatchObject({ state: "applied" });
    expect(postMessage).toHaveBeenCalledOnce();
  });
});

describe("coordinated policy replacement CLI", () => {
  it("validates and atomically applies a policy through PolicyStore.replace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-cli-"));
    const policyFile = path.join(root, "installed.json");
    const source = path.join(root, "candidate.json");
    await writeFile(source, JSON.stringify(policyValue(true, true)));
    const policy = new PolicyStore(policyFile, path.join(root, "project.json"));
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram({ policy } as unknown as SlackAxiApp).parseAsync(["node", "slack-axi", "--output", "json", "policy", "apply", source]);
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(chunks.join(""))).toMatchObject({ ok: true, scope: { command: "policy.apply", policy_scope: "global" }, data: { applied: true } });
    await expect(policy.allows("message.send", "C1", true)).resolves.toBe(true);
  });
});
