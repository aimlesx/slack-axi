import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { decode } from "@toon-format/toon";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionStore, sha256, uuidv7 } from "../src/actions.js";
import { AxiError, redact, toErrorEnvelope } from "../src/errors.js";
import { ACTION_SIGNING_ACCOUNT } from "../src/keychain.js";
import { applyAction } from "../src/mutations.js";
import { serialize } from "../src/output.js";
import { PolicyStore } from "../src/policy.js";
import { createMessageRef, parseMessageRef } from "../src/refs.js";
import type { SlackAxiApp } from "../src/app.js";
import { MemorySecrets } from "./helpers.js";

const exec = promisify(execFile);

async function waitForFile(filename: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filename);
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for '${filename}'.`);
}

async function waitForFileContents(filename: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = (await readFile(filename, "utf8")).trim();
      if (contents.length > 0) return contents;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for non-empty contents in '${filename}'.`);
}

async function killChild(child: ReturnType<typeof execFile>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

afterEach(() => vi.useRealTimers());

describe("structured contracts", () => {
  it("emits strict TOON and preserves the envelope during field projection", () => {
    const value = { schema: "slack-axi/v1", ok: true, data: { messages: [{ ref: "a", text: "secret", extra: 1 }] } };
    const encoded = serialize(value, "toon", ["ref"]);
    expect(decode(encoded, { strict: true })).toEqual({ schema: "slack-axi/v1", ok: true, data: { messages: [{ ref: "a" }] } });
  });

  it("normalizes undefined without mutating the caller so TOON and JSON stay equivalent", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = "kept";
    const value = {
      schema: "slack-axi/v1",
      ok: true,
      optional: undefined,
      data: { rows: [{ id: "one", optional: undefined }, undefined, { id: "two" }], sparse },
    };
    const json = JSON.parse(serialize(value, "json"));
    const toon = decode(serialize(value, "toon"), { strict: true });

    expect(toon).toEqual(json);
    expect(json).toEqual({ schema: "slack-axi/v1", ok: true, data: { rows: [{ id: "one" }, null, { id: "two" }], sparse: [null, "kept"] } });
    expect(Object.hasOwn(value, "optional")).toBe(true);
    expect(Object.hasOwn(value.data.rows[0]!, "optional")).toBe(true);
    expect(value.data.rows[1]).toBeUndefined();
    expect(Object.hasOwn(sparse, 0)).toBe(false);
  });

  it("projects singleton detail records without altering envelope metadata or hints", () => {
    const value = {
      schema: "slack-axi/v1",
      ok: true,
      workspace: { id: "T1", alias: "work", actor_id: "U1", auth_kind: "user_token" },
      scope: { command: "user.get" },
      data: { user: { id: "U2", name: "alice", display_name: "Alice", email: "alice@example.com" } },
      hints: [{ command: "slack-axi user search alice", reason: "Search again." }],
    };
    const encoded = serialize(value, "toon", ["id"], ["id", "name", "display_name", "email"]);
    expect(decode(encoded, { strict: true })).toEqual({
      ...value,
      data: { user: { id: "U2" } },
    });
  });

  it("does not expose a full singleton when an optional requested field is absent", () => {
    const value = { schema: "slack-axi/v1", ok: true, data: { user: { id: "U2", name: "alice", display_name: "Alice" } } };
    const encoded = serialize(value, "json", ["email"], ["id", "name", "display_name", "email"]);
    expect(JSON.parse(encoded)).toEqual({ schema: "slack-axi/v1", ok: true, data: { user: {} } });
  });

  it("preserves aggregate wrappers that share a field name with projected rows", () => {
    const value = { schema: "slack-axi/v1", ok: true, data: { ref: "T1/C1/1.000001", count: 2, reactions: [{ name: "eyes", count: 1, mine: false }, { name: "done", count: 3, mine: true }] } };
    const encoded = serialize(value, "json", ["count"], ["name", "count", "mine"]);
    expect(JSON.parse(encoded)).toEqual({ schema: "slack-axi/v1", ok: true, data: { ref: "T1/C1/1.000001", count: 2, reactions: [{ count: 1 }, { count: 3 }] } });
  });

  it("emits JSONL as one complete envelope", () => {
    const encoded = serialize({ schema: "slack-axi/v1", ok: true, data: { items: [] } }, "jsonl");
    expect(encoded.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(encoded)).toMatchObject({ ok: true, data: { items: [] } });
  });

  it("redacts credential forms from nested errors", () => {
    const secret = "xoxp-a_b.c~d+e/f=g";
    const cookie = "xoxd-one%2Ftwo%3D";
    const diagnostic = `Bearer ${secret}, d=${cookie}; xoxd=${cookie}. keep this prose`;
    expect(redact(diagnostic)).toBe("[REDACTED], [REDACTED]; [REDACTED]. keep this prose");
    expect(redact(`Error: request failed with ${cookie}\n    at verbose (file.ts:1:2)`)).toBe("Error: request failed with [REDACTED]\n    at verbose (file.ts:1:2)");
    const result = toErrorEnvelope(new AxiError({
      code: "AUTH_INVALID",
      message: `bad ${secret}`,
      candidates: [{ cookie }],
      details: { nested: { values: [secret, { cookie }] }, [cookie]: "credential-shaped keys are redacted too" },
      suggestedCommand: `retry --token ${secret}`,
    }));
    expect(result.envelope.error.message).toBe("bad [REDACTED]");
    expect(JSON.stringify(result.envelope)).not.toContain("xox");
    expect(result.envelope.error.suggested_command).toBe("retry --token [REDACTED]");
  });
});

describe("stable references", () => {
  it("round trips references and Slack permalinks", () => {
    const ref = createMessageRef("T012ABC", "C034DEF", "1786712345.001200");
    expect(parseMessageRef(ref, "T012ABC")).toEqual({ teamId: "T012ABC", conversationId: "C034DEF", ts: "1786712345.001200" });
    expect(parseMessageRef("https://acme.slack.com/archives/C034DEF/p1786712345001200")).toEqual({ conversationId: "C034DEF", ts: "1786712345.001200" });
  });

  it("rejects a cross-workspace reference", () => {
    expect(() => parseMessageRef("T012ABC/C034DEF/1786712345.001200", "T999XYZ")).toThrowError(/belongs to/);
  });
});

describe("signed action storage", () => {
  it("stores a signed v2 plan, private content, revisioned state, and terminal cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const secrets = new MemorySecrets();
    const store = new ActionStore(root, secrets);
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: { name: "eyes" }, payload: { name: "eyes", secret_text: "discard me" } });
    expect(plan.id[14]).toBe("7");
    expect(plan.approval).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
    const actionRoot = path.join(root, plan.id);
    expect((await stat(path.join(actionRoot, "plan.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(actionRoot, "state.json"), "utf8"))).toMatchObject({ data: { revision: 0, state: "planned" } });
    const applying = await store.transition(plan, "applying");
    const applied = await store.transition(applying, "applied", { result: { noop: false } });
    expect(applied.payload).toBeUndefined();
    await expect(readFile(path.join(actionRoot, "payload.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.get(plan.id)).state).toBe("applied");
  });

  it("publishes a complete action atomically and cleans a handled pre-publication interruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    let reachedPublish!: (directory: string) => void;
    let resumePublish!: () => void;
    const reached = new Promise<string>((resolve) => { reachedPublish = resolve; });
    const resume = new Promise<void>((resolve) => { resumePublish = resolve; });
    class PausedStore extends ActionStore {
      protected override async beforeActionPublish(stagingDirectory: string): Promise<void> {
        reachedPublish(stagingDirectory);
        await resume;
      }
    }
    const secrets = new MemorySecrets();
    const paused = new PausedStore(root, secrets);
    const creation = paused.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "private until publish" }, payload: { conversation_id: "C1", text: "private until publish", client_msg_id: "atomic-id" } });
    const staging = await reached;

    expect(path.basename(staging)).toMatch(new RegExp(`^\\.creating-[0-9a-f-]{36}-${process.pid}-[a-f0-9]{32}$`, "i"));
    expect(await paused.list()).toEqual([]);
    expect(await paused.gc(0)).toEqual({ removed: 0 });
    await expect(stat(staging)).resolves.toBeDefined();

    resumePublish();
    const action = await creation;
    expect((await paused.list()).map(({ id }) => id)).toEqual([action.id]);
    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root, action.id, "state.json"))).resolves.toBeDefined();

    class InterruptedStore extends ActionStore {
      protected override async beforeActionPublish(): Promise<void> {
        throw new Error("injected interruption");
      }
    }
    const interrupted = new InterruptedStore(root, secrets);
    await expect(interrupted.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "remove this secret" }, payload: { conversation_id: "C1", text: "remove this secret", client_msg_id: "interrupted-id" } })).rejects.toThrow("injected interruption");
    expect((await readdir(root)).filter((name) => name.startsWith(".creating-"))).toEqual([]);
  });

  it("keeps hard-crashed creators out of list and GC purges their message and upload content", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "slack-axi-create-crash-"));
    const root = path.join(fixtureRoot, "actions");
    const keyFile = path.join(fixtureRoot, "key.txt");
    const source = path.join(fixtureRoot, "sensitive-upload.bin");
    const key = Buffer.alloc(32, 17).toString("base64url");
    const uploadBytes = Buffer.from("hard-crash-sensitive-upload-bytes");
    await writeFile(keyFile, key);
    await writeFile(source, uploadBytes);
    const secrets = new MemorySecrets();
    secrets.values.set(ACTION_SIGNING_ACCOUNT, key);
    const store = new ActionStore(root, secrets);
    const fixture = path.resolve("test/fixtures/create-child.mjs");
    const messageReady = path.join(fixtureRoot, "message-ready");
    const uploadReady = path.join(fixtureRoot, "upload-ready");
    const neverRelease = path.join(fixtureRoot, "never-release");
    const messageChild = execFile(process.execPath, [fixture, root, keyFile, messageReady, neverRelease, "message.send", source], () => undefined);
    const uploadChild = execFile(process.execPath, [fixture, root, keyFile, uploadReady, neverRelease, "file.upload", source], () => undefined);

    try {
      const [messageStaging, uploadStaging] = await Promise.all([
        waitForFileContents(messageReady),
        waitForFileContents(uploadReady),
      ]);
      expect(await store.list()).toEqual([]);
      expect(await store.gc(0)).toEqual({ removed: 0 });
      await expect(readFile(path.join(messageStaging, "payload.json"), "utf8")).resolves.toContain("crash-sensitive-message-message.send");
      await expect(readFile(path.join(uploadStaging, "payload.json"), "utf8")).resolves.toContain("crash-sensitive-message-file.upload");
      await expect(readFile(path.join(uploadStaging, "upload.bin"))).resolves.toEqual(uploadBytes);

      await Promise.all([killChild(messageChild), killChild(uploadChild)]);
      expect(await store.list()).toEqual([]);
      expect(await store.gc(0)).toEqual({ removed: 0 });
      for (const staging of [messageStaging, uploadStaging]) {
        for (const entry of await readdir(staging)) await utimes(path.join(staging, entry), new Date(0), new Date(0));
        await utimes(staging, new Date(0), new Date(0));
      }
      expect(await store.gc(0)).toEqual({ removed: 2 });
      await expect(stat(messageStaging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(uploadStaging)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([killChild(messageChild), killChild(uploadChild)]);
    }
  }, 20_000);

  it("purges an aged creation orphan even when its PID has been reused by a live process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const orphan = path.join(root, `.creating-${uuidv7()}-${process.pid}-${"b".repeat(32)}`);
    await mkdir(orphan, { mode: 0o700 });
    const payload = path.join(orphan, "payload.json");
    await writeFile(payload, JSON.stringify({ text: "must not survive PID reuse" }));
    await utimes(payload, new Date(0), new Date(0));
    await utimes(orphan, new Date(0), new Date(0));

    const store = new ActionStore(root, new MemorySecrets());
    expect(await store.gc(0)).toEqual({ removed: 1 });
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists around and garbage-collects aged legacy incomplete action directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const store = new ActionStore(root, new MemorySecrets());
    const valid = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } });
    const orphanId = uuidv7();
    const orphan = path.join(root, orphanId);
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(path.join(orphan, "preview.json"), JSON.stringify({ text: "legacy-sensitive-message" }));
    await writeFile(path.join(orphan, "payload.json"), JSON.stringify({ text: "legacy-sensitive-message" }));
    await writeFile(path.join(orphan, "upload.bin"), "legacy-sensitive-upload");
    await writeFile(path.join(orphan, "plan.json"), "{\"truncated\":");
    for (const filename of [orphan, path.join(orphan, "preview.json"), path.join(orphan, "payload.json"), path.join(orphan, "upload.bin"), path.join(orphan, "plan.json")]) {
      await utimes(filename, new Date(0), new Date(0));
    }

    expect((await store.list()).map(({ id }) => id)).toEqual([valid.id]);
    expect(await store.gc(0)).toEqual({ removed: 1 });
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.list()).map(({ id }) => id)).toEqual([valid.id]);
  });

  it("never regenerates a missing signing key while a creation orphan exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const orphan = path.join(root, `.creating-${uuidv7()}-999999999-${"a".repeat(32)}`);
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(path.join(orphan, "payload.json"), JSON.stringify({ text: "signed-under-a-lost-key" }));
    const insideGrace = new Date(Date.now() - 15 * 60_000 - 10_000);
    await utimes(path.join(orphan, "payload.json"), insideGrace, insideGrace);
    await utimes(orphan, insideGrace, insideGrace);
    const store = new ActionStore(root, new MemorySecrets());

    await expect(store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } })).rejects.toMatchObject({ code: "ACTION_SIGNING_KEY_MISSING" });
    expect(await store.gc()).toEqual({ removed: 0 });
    await utimes(path.join(orphan, "payload.json"), new Date(0), new Date(0));
    await utimes(orphan, new Date(0), new Date(0));
    expect(await store.gc()).toEqual({ removed: 1 });
    await expect(store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } })).resolves.toMatchObject({ state: "planned" });
  });

  it("detects tampering of every signed plan field, state, and payload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const secrets = new MemorySecrets();
    const store = new ActionStore(root, secrets);
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "hello" }, payload: { conversation_id: "C1", text: "hello", client_msg_id: "id" } });
    const planFile = path.join(root, plan.id, "plan.json");
    const original = JSON.parse(await readFile(planFile, "utf8")) as { data: Record<string, unknown>; signature: string };
    for (const field of Object.keys(original.data)) {
      const changed = structuredClone(original);
      changed.data[field] = field === "target_ids" ? ["C2"] : `${String(changed.data[field])}-tampered`;
      await writeFile(planFile, JSON.stringify(changed));
      await expect(store.get(plan.id), field).rejects.toMatchObject({ code: "ACTION_INTEGRITY_FAILED" });
      await writeFile(planFile, JSON.stringify(original));
    }
    const stateFile = path.join(root, plan.id, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.data.revision = 99;
    await writeFile(stateFile, JSON.stringify(state));
    await expect(store.get(plan.id)).rejects.toMatchObject({ code: "ACTION_INTEGRITY_FAILED" });
    await writeFile(stateFile, JSON.stringify({ ...state, data: { ...state.data, revision: 0 } }));
    const payloadFile = path.join(root, plan.id, "payload.json");
    await writeFile(payloadFile, JSON.stringify({ conversation_id: "C2", text: "changed", client_msg_id: "id" }));
    await expect(store.get(plan.id)).rejects.toMatchObject({ code: "ACTION_INTEGRITY_FAILED" });
  });

  it("fails closed for wrong or missing signing keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const secrets = new MemorySecrets();
    const store = new ActionStore(root, secrets);
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } });
    secrets.values.delete(ACTION_SIGNING_ACCOUNT);
    await expect(store.get(plan.id)).rejects.toMatchObject({ code: "ACTION_SIGNING_KEY_MISSING" });
    secrets.values.set(ACTION_SIGNING_ACCOUNT, Buffer.alloc(32, 7).toString("base64url"));
    await expect(store.get(plan.id)).rejects.toMatchObject({ code: "ACTION_INTEGRITY_FAILED" });
    secrets.values.delete(ACTION_SIGNING_ACCOUNT);
    await store.deleteUnverified(plan.id);
    const replacement = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } });
    expect(replacement.approval).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("enforces legal transitions and expires approvals without replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00Z"));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const store = new ActionStore(root, new MemorySecrets());
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } });
    await expect(store.transition(plan, "applied")).rejects.toMatchObject({ code: "ACTION_STATE_INVALID" });
    vi.advanceTimersByTime(16 * 60_000);
    expect((await store.get(plan.id)).state).toBe("expired");
  });

  it("returns ACTION_BUSY for a live lock and recovers a dead applying owner to unknown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const store = new ActionStore(root, new MemorySecrets());
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", text: "once", client_msg_id: "id" } });
    const lock = path.join(root, plan.id, ".lock");
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, nonce: "1".repeat(32), claimed_at: new Date().toISOString() }));
    await expect(store.withLock(plan.id, async () => undefined)).rejects.toMatchObject({ code: "ACTION_BUSY" });
    await rm(lock, { recursive: true });
    const applying = await store.transition(plan, "applying");
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999, nonce: "2".repeat(32), claimed_at: new Date(0).toISOString() }));
    const recovered = await store.withLock(applying.id, async (action) => action);
    expect(recovered.state).toBe("unknown");
    expect(recovered.content_discarded).toBe(true);
  });

  it("fences a reused live PID by its exact process instance and recovers applying to unknown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const processIdentity = async () => ({ startedAtMs: 2_000, instanceId: "currentprocessinstance000000000001" });
    const store = new ActionStore(root, new MemorySecrets(), { isProcessAlive: () => true, processIdentity });
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", text: "once", client_msg_id: "id" } });
    const applying = await store.transition(plan, "applying");
    const ownerFile = path.join(root, plan.id, ".lock", "owner.json");
    await writeFile(ownerFile, JSON.stringify({
      pid: process.pid,
      nonce: "3".repeat(32),
      claimed_at: new Date(1_500).toISOString(),
      process_started_at_ms: 2_000,
      process_instance_id: "currentprocessinstance000000000001",
      process_fence_socket: `/tmp/slack-axi-cli-lock-${process.getuid?.() ?? 0}-${"f".repeat(32)}.sock`,
    }));

    const recovered = await store.withLock(applying.id, async (action) => action);

    expect(recovered).toMatchObject({
      state: "unknown",
      content_discarded: true,
      last_error: { code: "PROCESS_INTERRUPTED" },
    });
    expect(await store.get(plan.id)).toMatchObject({ state: "unknown", content_discarded: true });
  });

  it("fails closed for live or young malformed owners and safely takes over a stale incomplete owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const store = new ActionStore(root, new MemorySecrets());
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", ts: "1.000001", name: "eyes", ref: "T1/C1/1.000001" } });
    const lock = path.join(root, plan.id, ".lock");
    const ownerFile = path.join(lock, "owner.json");
    await mkdir(lock);

    await writeFile(ownerFile, JSON.stringify({ pid: process.pid, claimed_at: new Date(0).toISOString() }));
    await expect(store.withLock(plan.id, async () => undefined)).rejects.toMatchObject({ code: "ACTION_BUSY", details: { owner_pid: process.pid } });

    await writeFile(ownerFile, `{\"pid\":${process.pid},`);
    await utimes(ownerFile, new Date(0), new Date(0));
    await expect(store.withLock(plan.id, async () => undefined)).rejects.toMatchObject({ code: "ACTION_BUSY", details: { owner_pid: process.pid } });

    await writeFile(ownerFile, "{\"pid\":");
    await expect(store.withLock(plan.id, async () => undefined)).rejects.toMatchObject({ code: "ACTION_BUSY" });

    await writeFile(ownerFile, JSON.stringify({ claimed_at: new Date(0).toISOString() }));
    await expect(store.withLock(plan.id, async (action) => action.state)).resolves.toBe("planned");
    await expect(readFile(ownerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases only its own nonce and does not delete a successor owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const store = new ActionStore(root, new MemorySecrets());
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } });
    const ownerFile = path.join(root, plan.id, ".lock", "owner.json");
    const successor = { pid: process.pid, nonce: "4".repeat(32), claimed_at: new Date().toISOString() };

    await store.withLock(plan.id, async () => {
      await writeFile(ownerFile, JSON.stringify(successor));
    });

    expect(JSON.parse(await readFile(ownerFile, "utf8"))).toEqual(successor);
    await rm(ownerFile);
  });

  it("recovers through a new election when the elected stale reclaimer crashed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const store = new ActionStore(root, new MemorySecrets());
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } });
    const lock = path.join(root, plan.id, ".lock");
    const ownerFile = path.join(lock, "owner.json");
    await mkdir(lock);
    const staleOwner = JSON.stringify({ pid: 999_999_999, nonce: "8".repeat(32), claimed_at: new Date(0).toISOString() });
    await writeFile(ownerFile, staleOwner);
    const metadata = await stat(ownerFile);
    const identity = `${metadata.dev.toString(16)}-${metadata.ino.toString(16)}-${createHash("sha256").update(staleOwner).digest("hex").slice(0, 16)}`;
    const rootMarker = path.join(lock, `.takeover-${createHash("sha256").update(`owner:${identity}`).digest("hex")}.json`);
    await writeFile(rootMarker, JSON.stringify({ pid: 999_999_998, nonce: "9".repeat(32), claimed_at: new Date(0).toISOString() }));

    await expect(store.withLock(plan.id, async (action) => action.state)).resolves.toBe("planned");
    await expect(readFile(ownerFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(lock)).filter((name) => name.startsWith(".takeover-"))).toHaveLength(2);
  });

  it("serializes signing-key recovery and force deletion with owned locks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const keyLock = path.join(root, ".signing-key.lock");
    await mkdir(keyLock, { recursive: true });
    await writeFile(path.join(keyLock, "owner.json"), JSON.stringify({ pid: 999_999_999, nonce: "5".repeat(32), claimed_at: new Date(0).toISOString() }));
    const store = new ActionStore(root, new MemorySecrets());
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { name: "eyes" } });
    const actionLock = path.join(root, plan.id, ".lock");
    await mkdir(actionLock);
    await writeFile(path.join(actionLock, "owner.json"), JSON.stringify({ pid: process.pid, nonce: "6".repeat(32), claimed_at: new Date().toISOString() }));

    await expect(store.deleteUnverified(plan.id)).rejects.toMatchObject({ code: "ACTION_BUSY" });
    await expect(stat(path.join(root, plan.id, "plan.json"))).resolves.toBeDefined();
    await rm(path.join(actionLock, "owner.json"));
    await store.deleteUnverified(plan.id);
    await expect(stat(path.join(root, plan.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes 20 child-process applies to exactly one remote call", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const secrets = new MemorySecrets();
    const store = new ActionStore(root, secrets);
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "once" }, payload: { conversation_id: "C1", text: "once", client_msg_id: "fixed-id" } });
    const keyFile = path.join(root, "key.txt");
    const counterFile = path.join(root, "calls.txt");
    await writeFile(keyFile, secrets.values.get(ACTION_SIGNING_ACCOUNT)!);
    await writeFile(counterFile, "");
    const child = path.resolve("test/fixtures/apply-child.mjs");
    await Promise.all(Array.from({ length: 20 }, () => exec(process.execPath, [child, root, keyFile, counterFile, plan.id, plan.approval])));
    expect((await readFile(counterFile, "utf8")).trim().split("\n").filter(Boolean)).toHaveLength(1);
    expect((await store.get(plan.id)).state).toBe("applied");
  }, 20_000);

  it("coordinates 20 stale-lock reclaimers without deleting a successor lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const secrets = new MemorySecrets();
    const store = new ActionStore(root, secrets);
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "once" }, payload: { conversation_id: "C1", text: "once", client_msg_id: "stale-fixed-id" } });
    const lock = path.join(root, plan.id, ".lock");
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999, nonce: "3".repeat(32), claimed_at: new Date(0).toISOString() }));
    const keyFile = path.join(root, "key.txt");
    const counterFile = path.join(root, "calls.txt");
    await writeFile(keyFile, secrets.values.get(ACTION_SIGNING_ACCOUNT)!);
    await writeFile(counterFile, "");
    const child = path.resolve("test/fixtures/apply-child.mjs");

    await Promise.all(Array.from({ length: 20 }, () => exec(process.execPath, [child, root, keyFile, counterFile, plan.id, plan.approval])));

    expect((await readFile(counterFile, "utf8")).trim().split("\n").filter(Boolean)).toEqual(["stale-fixed-id"]);
    expect(await store.get(plan.id)).toMatchObject({
      state: "applied",
      result: { message: { ref: "T1/C1/1786712345.001200" }, noop: false },
    });
    await expect(readFile(path.join(lock, "owner.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("elects one paused stale reclaimer and blocks delayed contenders before unlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const secrets = new MemorySecrets();
    const store = new ActionStore(root, secrets);
    const plan = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "once" }, payload: { conversation_id: "C1", text: "once", client_msg_id: "barrier-fixed-id" } });
    const lock = path.join(root, plan.id, ".lock");
    await mkdir(lock);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999, nonce: "7".repeat(32), claimed_at: new Date(0).toISOString() }));
    const keyFile = path.join(root, "key.txt");
    const counterFile = path.join(root, "calls.txt");
    const barrier = await mkdtemp(path.join(os.tmpdir(), "slack-axi-lock-barrier-"));
    const ready = path.join(barrier, "ready");
    const release = path.join(barrier, "release");
    await writeFile(keyFile, secrets.values.get(ACTION_SIGNING_ACCOUNT)!);
    await writeFile(counterFile, "");
    const child = path.resolve("test/fixtures/apply-child.mjs");
    const elected = exec(process.execPath, [child, root, keyFile, counterFile, plan.id, plan.approval, barrier]);

    try {
      await Promise.race([
        waitForFile(ready),
        elected.then(() => { throw new Error("The elected reclaimer exited before reaching the barrier."); }),
      ]);
      await Promise.all(Array.from({ length: 19 }, () => exec(process.execPath, [child, root, keyFile, counterFile, plan.id, plan.approval])));
      expect(await readFile(counterFile, "utf8")).toBe("");
      await writeFile(release, "continue\n", { flag: "wx" });
      await elected;
    } finally {
      await writeFile(release, "continue\n", { flag: "a" });
    }

    expect((await readFile(counterFile, "utf8")).trim().split("\n").filter(Boolean)).toEqual(["barrier-fixed-id"]);
    expect(await store.get(plan.id)).toMatchObject({ state: "applied", result: { noop: false } });
  }, 20_000);

  it("turns an interrupted applying action into unknown without a remote retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", text: "once", client_msg_id: "id" } });
    const applying = await actions.transition(plan, "applying");
    const app = { actions } as unknown as SlackAxiApp;
    await expect(applyAction(app, applying, applying.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect((await actions.get(plan.id)).state).toBe("unknown");
  });

  it("returns an applied retry as an explicit exit-zero no-op", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", ts: "1.000001", name: "eyes", ref: "T1/C1/1.000001" } });
    const applying = await actions.transition(plan, "applying");
    const applied = await actions.transition(applying, "applied", { result: { noop: false } });
    const result = await applyAction({ actions } as unknown as SlackAxiApp, applied, applied.approval);
    expect(result).toMatchObject({ state: "applied", result: { noop: true, already_applied: true } });
  });

  it("checks the live Slack actor immediately before dispatch and leaves a mismatch replayable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", text: "do not send", client_msg_id: "fixed-id" } });
    const postMessage = vi.fn();
    const context = {
      profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      public: { async authTest() { return { team_id: "T1", user_id: "U2" }; }, postMessage },
      snapshot: {}, conversations: [], users: [], userMap: new Map(),
    };
    const app = { actions, async context() { return context; } } as unknown as SlackAxiApp;
    await expect(applyAction(app, plan, plan.approval)).rejects.toMatchObject({
      code: "ACTION_IDENTITY_MISMATCH",
      details: { signed_actor_id: "U1", live_actor_id: "U2" },
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect((await actions.get(plan.id)).state).toBe("planned");
  });

  it("rechecks expiry after live identity reads and never dispatches a newly expired plan", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00Z"));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", text: "do not send", client_msg_id: "expiry-id" } });
    vi.setSystemTime(new Date(Date.parse(plan.expires_at) - 1));
    const postMessage = vi.fn();
    const context = {
      profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      public: {
        async authTest() {
          vi.setSystemTime(new Date(Date.parse(plan.expires_at) + 1));
          return { team_id: "T1", user_id: "U1" };
        },
        postMessage,
      },
      snapshot: {}, conversations: [], users: [], userMap: new Map(),
    };
    const app = { actions, async context() { return context; } } as unknown as SlackAxiApp;

    await expect(applyAction(app, plan, plan.approval)).rejects.toMatchObject({ code: "ACTION_EXPIRED" });
    expect(postMessage).not.toHaveBeenCalled();
    expect((await actions.get(plan.id)).state).toBe("expired");
  });

  it("does not retain the sent message body in terminal action state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const sensitive = `release-secret-${"x".repeat(5_010)}`;
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: sensitive }, payload: { conversation_id: "C1", text: sensitive, client_msg_id: "privacy-id" } });
    const context = {
      profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      public: {
        async authTest() { return { team_id: "T1", user_id: "U1" }; },
        async postMessage() { return { ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", text: sensitive, user: "U1" } }; },
        async permalink() { return "https://acme.slack.com/archives/C1/p1786712345001200"; },
      },
      snapshot: {}, conversations: [], users: [], userMap: new Map(),
    };
    const app = { actions, async context() { return context; } } as unknown as SlackAxiApp;

    const applied = await applyAction(app, plan, plan.approval);
    expect(applied).toMatchObject({ state: "applied", result: { message: { ref: "T1/C1/1786712345.001200", text_chars: sensitive.length } } });
    expect((applied.result?.message as Record<string, unknown>).text).toBeUndefined();
    const state = await readFile(path.join(root, plan.id, "state.json"), "utf8");
    expect(state).not.toContain("release-secret");
    await expect(readFile(path.join(root, plan.id, "payload.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(root, plan.id, "preview.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires never-read actions during GC and cleans message and upload content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00Z"));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-actions-"));
    const source = path.join(root, "large-upload.bin");
    await writeFile(source, Buffer.alloc(1024 * 1024, 7));
    const store = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    const message = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "forgotten" }, payload: { conversation_id: "C1", text: "forgotten", client_msg_id: "forgotten-id" } });
    const upload = await store.create({ workspace_id: "T1", actor_id: "U1", operation: "file.upload", target_ids: ["C1"], preview: { filename: "large-upload.bin" }, payload: { conversation_id: "C1", filename: "large-upload.bin" }, upload_path: source });
    vi.advanceTimersByTime(31 * 86_400_000);

    await store.gc(10_000);

    for (const action of [message, upload]) {
      expect(await store.get(action.id)).toMatchObject({ state: "expired", content_discarded: true });
      for (const filename of ["preview.json", "payload.json", "upload.bin"]) {
        await expect(readFile(path.join(root, "actions", action.id, filename), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  it("generates time-sortable UUIDv7 prefixes", () => {
    expect(uuidv7(1_700_000_000_000).slice(0, 13) < uuidv7(1_800_000_000_000).slice(0, 13)).toBe(true);
  });
});

describe("policy", () => {
  it("rejects wildcard targets and requires allowlisted unfurls", async () => {
    const store = new PolicyStore("/unused/policy.json");
    expect(() => store.validate({ version: 1, allow_direct_apply: [{ operation: "message.send", conversations: ["*"] }], allowed_unfurl_domains: [] })).toThrowError(/invalid/i);
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-policy-"));
    const globalFile = path.join(root, "policy.json");
    const projectFile = path.join(root, "project.json");
    const narrowed = new PolicyStore(globalFile, projectFile);
    await import("../src/fs-store.js").then(({ atomicWriteJson }) => atomicWriteJson(globalFile, { version: 1, allow_direct_apply: [], allowed_unfurl_domains: ["example.com"] }));
    await expect(narrowed.validateUnfurls("see https://docs.example.com/a", true)).resolves.toBeUndefined();
    await expect(narrowed.validateUnfurls("see https://evil.test/a", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
  });
});
