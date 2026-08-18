import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionStore, sha256File } from "../src/actions.js";
import { applyAction } from "../src/mutations.js";
import { DEFAULT_DOWNLOAD_MAX_BYTES, PublicSlackClient } from "../src/slack-public.js";
import { createProgram } from "../src/cli.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import type { VerifiedUploadSnapshot } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

function availableConfig() {
  return {
    transaction<T>(operation: () => Promise<T>): Promise<T> { return operation(); },
    assertWorkspaceAvailable(_teamId: string): Promise<void> { return Promise.resolve(); },
  };
}

async function withTestSnapshot<T>(filename: string, operation: (snapshot: VerifiedUploadSnapshot) => Promise<T>): Promise<T> {
  const handle = await open(filename, "r");
  const initial = await handle.stat();
  const expectedHash = createHash("sha256").update(await readFile(filename)).digest("hex");
  let streamClaimed = false;
  const snapshot: VerifiedUploadSnapshot = {
    size: initial.size,
    expected_sha256: expectedHash,
    createReadStream() {
      if (streamClaimed) throw new Error("snapshot stream already claimed");
      streamClaimed = true;
      return handle.createReadStream({ autoClose: false, start: 0 });
    },
    async assertUnchanged() {
      const current = await handle.stat();
      if (current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) {
        throw new Error("test snapshot changed");
      }
    },
  };
  try { return await operation(snapshot); } finally { await handle.close().catch(() => undefined); }
}

describe("file exactness and transport", () => {
  it("streams the exact snapshot through Slack's three-step external upload without forwarding credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-stream-upload-"));
    const snapshot = path.join(root, "snapshot.bin");
    // Keep this fixture large enough to cross the stream high-water mark while
    // remaining fast on both native Intel and Apple Silicon CI runners.
    const expected = Buffer.alloc(256 * 1024, 0x5a);
    await writeFile(snapshot, expected);
    const requests: string[] = [];
    let uploaded = Buffer.alloc(0);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("files.getUploadURLExternal")) {
        expect(new Headers(init?.headers).get("cookie")).toBe("d=xoxd-upload%2Fsession%3D");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("filename")).toBe("report.bin");
        expect(body.get("length")).toBe(String(expected.length));
        return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/signed", file_id: "F1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://files.slack.com/upload/v1/signed") {
        expect(Buffer.isBuffer(init?.body)).toBe(false);
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(new Headers(init?.headers).get("cookie")).toBeNull();
        const chunks: Buffer[] = [];
        for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return new Response("OK", { status: 200 });
      }
      if (url.includes("files.completeUploadExternal")) {
        expect(new Headers(init?.headers).get("cookie")).toBe("d=xoxd-upload%2Fsession%3D");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("channel_id")).toBe("C1");
        expect(JSON.parse(body.get("files") ?? "[]")).toEqual([{ id: "F1", title: "report.bin" }]);
        return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", name: "report.bin", size: expected.length }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;

    const client = new PublicSlackClient("xoxc-secret", {
      apiUrl: "https://slack.com/api/",
      fetch: fetchMock,
      cookie: "xoxd-upload%2Fsession%3D",
    });
    await expect(withTestSnapshot(snapshot, (opened) => client.uploadFile({ snapshot: opened, displayFilename: "report.bin", channel: "C1" }))).resolves.toEqual({ files: [{ id: "F1", name: "report.bin", size: expected.length }] });
    expect(uploaded).toEqual(expected);
    expect(requests).toHaveLength(3);
    expect(client.backendCalls).toBe(3);
  }, 30_000);

  it("never completes or retries an external upload whose byte transfer fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-stream-upload-failure-"));
    const snapshot = path.join(root, "snapshot.bin");
    await writeFile(snapshot, "once");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("files.getUploadURLExternal")) {
        return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/signed", file_id: "F1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://files.slack.com/upload/v1/signed") return new Response("upstream", { status: 503 });
      throw new Error("Completion must not run after a failed byte upload.");
    }) as unknown as typeof fetch;
    const client = new PublicSlackClient("xoxp-secret", { apiUrl: "https://slack.com/api/", fetch: fetchMock });

    await expect(withTestSnapshot(snapshot, (opened) => client.uploadFile({ snapshot: opened, displayFilename: "snapshot.bin", channel: "C1" }))).rejects.toMatchObject({
      code: "FILE_UPLOAD_FAILED",
      details: { dispatch_uncertain: true, upload_phase: "external_bytes", http_status: 503 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-Slack signed upload URL before any bytes or credentials leave the process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-stream-upload-host-"));
    const snapshot = path.join(root, "snapshot.bin");
    await writeFile(snapshot, "private");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("files.getUploadURLExternal")) {
        return new Response(JSON.stringify({ ok: true, upload_url: "https://evil.example/upload", file_id: "F1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("The untrusted upload URL must never be requested.");
    }) as unknown as typeof fetch;
    const client = new PublicSlackClient("xoxp-secret", { apiUrl: "https://slack.com/api/", fetch: fetchMock });

    await expect(withTestSnapshot(snapshot, (opened) => client.uploadFile({ snapshot: opened, displayFilename: "snapshot.bin", channel: "C1" }))).rejects.toMatchObject({ code: "SLACK_URL_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a completion rejection uncertain after Slack accepted the file bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-stream-completion-failure-"));
    const snapshot = path.join(root, "snapshot.bin");
    await writeFile(snapshot, "once");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("files.getUploadURLExternal")) {
        return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/signed", file_id: "F1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://files.slack.com/upload/v1/signed") {
        for await (const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>) { /* consume the request body */ }
        return new Response("OK", { status: 200 });
      }
      if (url.includes("files.completeUploadExternal")) {
        return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const client = new PublicSlackClient("xoxp-secret", { apiUrl: "https://slack.com/api/", fetch: fetchMock });

    await expect(withTestSnapshot(snapshot, (opened) => client.uploadFile({ snapshot: opened, displayFilename: "snapshot.bin", channel: "C1" }))).rejects.toMatchObject({
      code: "CHANNEL_NOT_FOUND",
      details: { dispatch_uncertain: true, upload_phase: "completion" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never completes bytes whose transfer digest differs from the signed snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-stream-digest-mismatch-"));
    const filename = path.join(root, "snapshot.bin");
    await writeFile(filename, "approved bytes");
    let completionCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("files.getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/signed", file_id: "F1" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://files.slack.com/upload/v1/signed") {
        for await (const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>) { /* consume the request body */ }
        return new Response("OK", { status: 200 });
      }
      if (url.includes("files.completeUploadExternal")) {
        completionCalls += 1;
        throw new Error("Digest-mismatched bytes must never be completed.");
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const client = new PublicSlackClient("xoxp-secret", { apiUrl: "https://slack.com/api/", fetch: fetchMock });

    await expect(withTestSnapshot(filename, (opened) => client.uploadFile({
      snapshot: { ...opened, expected_sha256: "0".repeat(64) },
      displayFilename: "snapshot.bin",
      channel: "C1",
    }))).rejects.toMatchObject({
      code: "ACTION_INTEGRITY_FAILED",
      details: { dispatch_uncertain: true, upload_phase: "external_bytes" },
    });
    expect(completionCalls).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uploads the immutable staged snapshot after the original path is replaced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-files-"));
    const source = path.join(root, "source.bin");
    await writeFile(source, Buffer.from("signed original bytes"));
    const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "file.upload", target_ids: ["C1"], preview: { filename: "source.bin" }, payload: { conversation_id: "C1", filename: "source.bin" }, upload_path: source, assertWorkspaceAvailable: () => Promise.resolve() });
    await writeFile(source, Buffer.from("replacement bytes"));
    let uploaded = Buffer.alloc(0);
    let displayFilename: string | undefined;
    const publicClient = {
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      async uploadFile(options: { snapshot: VerifiedUploadSnapshot; displayFilename: string }) {
        const chunks: Buffer[] = [];
        for await (const chunk of options.snapshot.createReadStream()) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        displayFilename = options.displayFilename;
        return { ok: true, files: [{ id: "F1" }] };
      },
    };
    const context = { profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token" }, public: publicClient, snapshot: {}, conversations: [], users: [], userMap: new Map() } as unknown as WorkspaceContext;
    const app = { actions, async context() { return context; } } as unknown as SlackAxiApp;
    const result = await applyAction(app, plan, plan.approval);
    expect(result.state).toBe("applied");
    expect(uploaded.toString()).toBe("signed original bytes");
    expect(displayFilename).toBe("source.bin");
    await expect(stat(path.join(root, "actions", plan.id, "upload.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the approved inode bound through a same-size path replacement at transport entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-upload-entry-race-"));
    const source = path.join(root, "source.bin");
    const approved = Buffer.from("APPROVED");
    const replacement = Buffer.from("REJECTED");
    expect(replacement).toHaveLength(approved.length);
    await writeFile(source, approved);
    const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "file.upload", target_ids: ["C1"], preview: { filename: "source.bin" }, payload: { conversation_id: "C1", filename: "source.bin" }, upload_path: source, assertWorkspaceAvailable: () => Promise.resolve() });
    const uploadPath = plan.upload_snapshot!;
    const displacedPath = path.join(root, "displaced-approved.bin");
    let uploaded = Buffer.alloc(0);
    let completionCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("files.getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/signed", file_id: "F1" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://files.slack.com/upload/v1/signed") {
        const chunks: Buffer[] = [];
        for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return new Response("OK", { status: 200 });
      }
      if (url.includes("files.completeUploadExternal")) {
        completionCalls += 1;
        return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", name: "source.bin", size: approved.length }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const transport = new PublicSlackClient("xoxp-secret", { apiUrl: "https://slack.com/api/", fetch: fetchMock });
    const publicClient = {
      async authTest() { return { team_id: "T1", user_id: "U1" }; },
      async uploadFile(options: Parameters<PublicSlackClient["uploadFile"]>[0]) {
        // ActionStore has already completed the signed hash on one open fd.
        // Replacing its pathname here must not redirect the transport.
        await rename(uploadPath, displacedPath);
        await writeFile(uploadPath, replacement);
        return transport.uploadFile(options);
      },
    };
    const context = { profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token" }, public: publicClient, snapshot: {}, conversations: [], users: [], userMap: new Map() } as unknown as WorkspaceContext;
    const app = { actions, async context() { return context; } } as unknown as SlackAxiApp;

    const result = await applyAction(app, plan, plan.approval);
    expect(result.state).toBe("applied");
    expect(uploaded).toEqual(approved);
    expect(uploaded).not.toEqual(replacement);
    expect(completionCalls).toBe(1);
    await rm(displacedPath, { force: true });
  });

  it("never completes an upload whose open inode changes during the raw transfer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-upload-inplace-race-"));
    const source = path.join(root, "source.bin");
    const approved = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const replacement = Buffer.alloc(approved.length, 0x42);
    await writeFile(source, approved);
    const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "file.upload", target_ids: ["C1"], preview: { filename: "source.bin" }, payload: { conversation_id: "C1", filename: "source.bin" }, upload_path: source, assertWorkspaceAvailable: () => Promise.resolve() });
    const uploadPath = plan.upload_snapshot!;
    let rawCalls = 0;
    let completionCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("files.getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.com/upload/v1/signed", file_id: "F1" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://files.slack.com/upload/v1/signed") {
        rawCalls += 1;
        let chunks = 0;
        for await (const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
          chunks += 1;
          if (chunks === 1) {
            await writeFile(uploadPath, replacement);
            const future = new Date(Date.now() + 2_000);
            await utimes(uploadPath, future, future);
          }
        }
        return new Response("OK", { status: 200 });
      }
      if (url.includes("files.completeUploadExternal")) {
        completionCalls += 1;
        throw new Error("A changed upload must never be completed.");
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const transport = new PublicSlackClient("xoxp-secret", { apiUrl: "https://slack.com/api/", fetch: fetchMock });
    const context = { profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token" }, public: { async authTest() { return { team_id: "T1", user_id: "U1" }; }, uploadFile: transport.uploadFile.bind(transport) }, snapshot: {}, conversations: [], users: [], userMap: new Map() } as unknown as WorkspaceContext;
    const app = { actions, async context() { return context; } } as unknown as SlackAxiApp;

    await expect(applyAction(app, plan, plan.approval)).rejects.toMatchObject({ code: "ACTION_COMMIT_UNKNOWN" });
    expect(rawCalls).toBe(1);
    expect(completionCalls).toBe(0);
    await expect(actions.get(plan.id)).resolves.toMatchObject({ state: "unknown", content_discarded: true });
  });

  it("derives the signed upload preview from the exact snapshot after a preflight path replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-preview-race-"));
    const source = path.join(root, "source.bin");
    const original = Buffer.from("short preflight bytes");
    const replacement = Buffer.from("different replacement bytes selected at the staging boundary");
    await writeFile(source, original);

    let contextEntered!: () => void;
    let releaseContext!: () => void;
    const entered = new Promise<void>((resolve) => { contextEntered = resolve; });
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    const context = {
      profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      snapshot: { coverage: { conversations: { scanned: 1, complete: true }, users: { scanned: 0, complete: true } } },
      conversations: [{ id: "C1", name: "social", type: "channel", is_private: false, is_member: true, is_archived: false }],
      users: [],
      userMap: new Map(),
      public: {},
    } as unknown as WorkspaceContext;
    const app = {
      actions,
      config: availableConfig(),
      async context() {
        contextEntered();
        await contextGate;
        return context;
      },
    } as unknown as SlackAxiApp;

    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { output += String(chunk); return true; });
    try {
      const command = createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "file", "upload", source, "--to", "C1"]);
      await entered;
      await rename(source, `${source}.preflight`);
      await writeFile(source, replacement);
      releaseContext();
      await command;
    } finally {
      write.mockRestore();
      releaseContext();
    }

    const envelope = JSON.parse(output) as { data: { action: { id: string; preview: Record<string, unknown> } } };
    const expectedHash = await sha256File(source);
    expect(envelope.data.action.preview).toMatchObject({
      filename: "source.bin",
      size: replacement.byteLength,
      sha256: expectedHash,
    });
    expect(envelope.data.action.preview.size).not.toBe(original.byteLength);

    const staged = await actions.get(envelope.data.action.id);
    expect(staged.preview).toEqual(envelope.data.action.preview);
    expect(staged.payload).toMatchObject({ snapshot_hash: expectedHash, snapshot_size: replacement.byteLength });
    await expect(readFile(staged.upload_snapshot!)).resolves.toEqual(replacement);
  });

  it("rejects an upload source that exceeds the action-store byte bound without publishing partial staging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-upload-bound-"));
    const source = path.join(root, "source.bin");
    const actionsDirectory = path.join(root, "actions");
    await writeFile(source, "five!");
    const actions = new ActionStore(actionsDirectory, new MemorySecrets());

    await expect(actions.create({
      workspace_id: "T1",
      actor_id: "U1",
      operation: "file.upload",
      target_ids: ["C1"],
      preview: { filename: "source.bin" },
      payload: { conversation_id: "C1", filename: "source.bin" },
      upload_path: source,
      upload_max_bytes: 4,
      assertWorkspaceAvailable: () => Promise.resolve(),
    })).rejects.toMatchObject({
      code: "FILE_UPLOAD_LIMIT_EXCEEDED",
      exitCode: 2,
      details: { bytes: 5, maximum_bytes: 4 },
    });

    const published = (await readdir(actionsDirectory)).filter((name) => name.startsWith(".creating-") || /^[0-9a-f-]{36}$/i.test(name));
    expect(published).toEqual([]);
  });

  it("rechecks the upload bound after CLI preflight when the source path grows before snapshotting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-upload-preflight-growth-"));
    const source = path.join(root, "source.bin");
    await writeFile(source, "tiny");

    let contextEntered!: () => void;
    let releaseContext!: () => void;
    const entered = new Promise<void>((resolve) => { contextEntered = resolve; });
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    const context = {
      profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      snapshot: { coverage: { conversations: { scanned: 1, complete: true }, users: { scanned: 0, complete: true } } },
      conversations: [{ id: "C1", name: "social", type: "channel", is_private: false, is_member: true, is_archived: false }],
      users: [],
      userMap: new Map(),
      public: {},
    } as unknown as WorkspaceContext;
    const app = {
      actions,
      config: availableConfig(),
      async context() {
        contextEntered();
        await contextGate;
        return context;
      },
    } as unknown as SlackAxiApp;

    const command = createProgram(app).parseAsync([
      "node", "slack-axi", "--output", "json", "file", "upload", source, "--to", "C1", "--max-bytes", "4",
    ]);
    try {
      await entered;
      await writeFile(source, "now-too-large");
      releaseContext();
      await expect(command).rejects.toMatchObject({
        code: "FILE_UPLOAD_LIMIT_EXCEEDED",
        exitCode: 2,
        details: { bytes: 13, maximum_bytes: 4 },
      });
    } finally {
      releaseContext();
    }

    const published = (await readdir(path.join(root, "actions"))).filter((name) => name.startsWith(".creating-") || /^[0-9a-f-]{36}$/i.test(name));
    expect(published).toEqual([]);
  });

  it("rejects symlink upload sources and streams a large snapshot hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-files-"));
    const source = path.join(root, "large.bin");
    const alias = path.join(root, "alias.bin");
    await writeFile(source, Buffer.alloc(8 * 1024 * 1024, 0x5a));
    await symlink(source, alias);
    const actions = new ActionStore(path.join(root, "actions"), new MemorySecrets());
    await expect(actions.create({ workspace_id: "T1", actor_id: "U1", operation: "file.upload", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1" }, upload_path: alias, assertWorkspaceAvailable: () => Promise.resolve() })).rejects.toBeTruthy();
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "file.upload", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1" }, upload_path: source, assertWorkspaceAvailable: () => Promise.resolve() });
    expect(plan.payload?.snapshot_hash).toBe(await sha256File(source));
    expect(plan.payload?.snapshot_size).toBe(8 * 1024 * 1024);
    expect(plan.preview).toMatchObject({ sha256: plan.payload?.snapshot_hash, size: plan.payload?.snapshot_size });
  });

  it("forwards the browser pair to a Slack-owned file download", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://files.slack.com/files-pri/T1-F1/file");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer xoxc-secret");
      expect(headers.get("cookie")).toBe("d=xoxd-download%2Fsession%3D");
      return new Response("abc", { status: 200, headers: { "content-length": "3" } });
    }) as unknown as typeof fetch;
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-cookie-"));
    const client = new PublicSlackClient("xoxc-secret", {
      fetch: fetchMock,
      cookie: "xoxd-download%2Fsession%3D",
    });

    await expect(client.download(
      "https://files.slack.com/files-pri/T1-F1/file",
      path.join(root, "download.bin"),
      3,
    )).resolves.toMatchObject({ bytes: 3, redirects: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not widen the browser cookie domain to other Slack-owned download hosts", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer xoxc-secret");
      expect(headers.get("cookie")).toBeNull();
      return new Response("abc", { status: 200, headers: { "content-length": "3" } });
    }) as unknown as typeof fetch;
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-cookie-scope-"));
    const client = new PublicSlackClient("xoxc-secret", { fetch: fetchMock, cookie: "xoxd-download%2Fsession%3D" });

    await expect(client.download(
      "https://cdn.slack-files.com/files-pri/T1-F1/file",
      path.join(root, "download.bin"),
      3,
    )).resolves.toMatchObject({ bytes: 3 });
  });

  it("rejects redirects to non-Slack hosts before forwarding credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/download" } }));
    vi.stubGlobal("fetch", fetchMock);
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-"));
    await expect(new PublicSlackClient("xoxp-secret").download("https://files.slack.com/files-pri/T1-F1/file", path.join(root, "tmp"))).rejects.toMatchObject({ code: "SLACK_URL_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a completed download whose size differs from Slack metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("abc", { status: 200, headers: { "content-length": "3" } })));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-"));
    await expect(new PublicSlackClient("xoxp-secret").download("https://files.slack.com/files-pri/T1-F1/file", path.join(root, "tmp"), 4)).rejects.toMatchObject({ code: "FILE_SIZE_MISMATCH" });
  });

  it("aborts a chunked download as soon as it exceeds Slack's expected size", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024, 0x61);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(oversized, { status: 200 })));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-stream-limit-"));
    const output = path.join(root, "tmp");

    await expect(new PublicSlackClient("xoxp-secret").download(
      "https://files.slack.com/files-pri/T1-F1/file",
      output,
      1_024,
      1024 * 1024,
    )).rejects.toMatchObject({ code: "FILE_SIZE_MISMATCH", details: { maximum_bytes: 1_024 } });
    const partial = await stat(output).catch(() => undefined);
    expect(partial?.size ?? 0).toBeLessThanOrEqual(1_024);
  });

  it("enforces an explicit byte ceiling when Slack omits file size metadata", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024, 0x62);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(oversized, { status: 200 })));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-default-limit-"));
    const output = path.join(root, "tmp");

    await expect(new PublicSlackClient("xoxp-secret").download(
      "https://files.slack.com/files-pri/T1-F1/file",
      output,
      undefined,
      2_048,
    )).rejects.toMatchObject({ code: "FILE_DOWNLOAD_LIMIT_EXCEEDED", details: { maximum_bytes: 2_048 } });
    const partial = await stat(output).catch(() => undefined);
    expect(partial?.size ?? 0).toBeLessThanOrEqual(2_048);
  });

  it("preserves a destination created during the no-clobber race", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-"));
    const output = path.join(root, "report.txt");
    const publicClient = {
      async fileInfo() { return { id: "F1", size: 3, url_private_download: "https://files.slack.com/file" }; },
      async download(_url: string, temporary: string) {
        await writeFile(temporary, "new");
        await writeFile(output, "racer");
        return { path: temporary, bytes: 3, redirects: 0 };
      },
    };
    const context = { profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token" }, public: publicClient } as unknown as WorkspaceContext;
    const app = { async context() { return context; } } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "file", "get", "F1", "--out", output])).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(await readFile(output, "utf8")).toBe("racer");
  });

  it("passes a mandatory default or explicit download byte bound from the CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-download-cli-limit-"));
    const download = vi.fn(async (_url: string, temporary: string, _expected: number | undefined, _maximum: number) => {
      await writeFile(temporary, "new");
      return { path: temporary, bytes: 3, redirects: 0 };
    });
    const publicClient = {
      async fileInfo() { return { id: "F1", mimetype: "text/plain", url_private_download: "https://files.slack.com/file" }; },
      download,
    };
    const context = { profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token" }, public: publicClient } as unknown as WorkspaceContext;
    const app = { async context() { return context; } } as unknown as SlackAxiApp;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "file", "get", "F1", "--out", path.join(root, "default.txt")]);
      await createProgram(app).parseAsync(["node", "slack-axi", "file", "get", "F1", "--out", path.join(root, "explicit.txt"), "--max-bytes", "2048"]);
    } finally {
      write.mockRestore();
    }
    expect(download.mock.calls[0]?.[3]).toBe(DEFAULT_DOWNLOAD_MAX_BYTES);
    expect(download.mock.calls[1]?.[3]).toBe(2_048);
  });
});
