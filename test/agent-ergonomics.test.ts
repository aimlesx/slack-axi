import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import { MemoryCursorIntegrity } from "./helpers.js";

const exec = promisify(execFile);
const entry = path.resolve("dist/index.js");
const messageRef = "T1/C1/1786712345.001200";
const longText = "x".repeat(700);

async function jsonOutput(app: SlackAxiApp, args: string[]): Promise<Record<string, any>> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
  try {
    await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", ...args]);
  } finally {
    write.mockRestore();
  }
  return JSON.parse(chunks.join("")) as Record<string, any>;
}

function contentApp(): SlackAxiApp {
  const context = {
    profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
    snapshot: {
      credential_generation: "generation-current",
      coverage: {
        conversations: { scanned: 1, complete: true },
        users: { scanned: 0, complete: true },
      },
    },
    conversations: [{ id: "C1", name: "general", type: "channel", is_private: false, is_member: true, is_archived: false }],
    users: [],
    userMap: new Map(),
    public: {
      async replies() { return { items: [{ ts: "1786712345.001200", text: longText }], complete: true }; },
      async messageByTs() { return { ts: "1786712345.001200", text: longText }; },
      async permalink() { return "https://acme.slack.com/archives/C1/p1786712345001200"; },
      async fileInfo() { return { id: "F1", name: "report.txt", mimetype: "text/plain", description: longText }; },
    },
  } as unknown as WorkspaceContext;
  return { actions: new MemoryCursorIntegrity(), async context() { return context; } } as unknown as SlackAxiApp;
}

async function executableFailure(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    await exec(process.execPath, [entry, ...args], { env: { ...process.env, HOME: home } });
  } catch (error) {
    return error as { code: number; stdout: string; stderr: string };
  }
  throw new Error(`Expected slack-axi ${args.join(" ")} to fail.`);
}

describe("agent recovery ergonomics", () => {
  it("suggests exact --full replays only when thread, message, or file content is truncated", async () => {
    const app = contentApp();

    const thread = await jsonOutput(app, ["thread", messageRef]);
    expect(thread.data.messages[0]).toMatchObject({ text_chars: 700, text_truncated: true });
    expect(thread.hints).toContainEqual({
      command: `slack-axi thread ${messageRef} --workspace work --full`,
      reason: expect.stringContaining("truncated"),
    });
    const fullThread = await jsonOutput(app, ["--full", "thread", messageRef]);
    expect(fullThread.data.messages[0]).toMatchObject({ text: longText, text_truncated: false });
    expect(fullThread.hints).toBeUndefined();

    const message = await jsonOutput(app, ["message", "get", messageRef]);
    expect(message.data.message).toMatchObject({ text_chars: 700, text_truncated: true });
    expect(message.hints).toEqual([{
      command: `slack-axi message get ${messageRef} --full --workspace work`,
      reason: expect.stringContaining("truncated"),
    }]);
    const fullMessage = await jsonOutput(app, ["--full", "message", "get", messageRef]);
    expect(fullMessage.data.message).toMatchObject({ text: longText, text_truncated: false });
    expect(fullMessage.hints).toBeUndefined();

    const file = await jsonOutput(app, ["file", "info", "F1"]);
    expect(file.data.file).toMatchObject({ description_chars: 700, description_truncated: true });
    expect(file.hints).toEqual([{
      command: "slack-axi file info F1 --full --workspace work",
      reason: expect.stringContaining("truncated"),
    }]);
    const fullFile = await jsonOutput(app, ["--full", "file", "info", "F1"]);
    expect(fullFile.data.file).toMatchObject({ description: longText, description_truncated: false });
    expect(fullFile.hints).toBeUndefined();
  });

  it.each([
    ["conversation name", ["conversation", "resolve", "#missing"]],
    ["user real name", ["user", "get", "Alice Example"]],
    ["direct message", ["conversation", "resolve", "@alice"]],
  ])("keeps the resolved workspace in an incomplete-cache hint for %s", async (_case, args) => {
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      snapshot: {
        credential_generation: "generation-current",
        coverage: {
          conversations: { scanned: 0, complete: false },
          users: { scanned: 1, complete: false },
        },
      },
      conversations: [],
      users: [{ id: "U2", name: "alice", display_name: "Alice", real_name: "Alice Example", is_bot: false, deleted: false }],
      userMap: new Map(),
      public: {},
    } as unknown as WorkspaceContext;
    const app = { async context() { return context; } } as unknown as SlackAxiApp;

    await expect(createProgram(app).parseAsync(["node", "slack-axi", ...args])).rejects.toMatchObject({
      code: "RESOLUTION_INCOMPLETE",
      suggestedCommand: "slack-axi sync --all --max-pages 100 --workspace work",
    });
  });

  it("preserves the concise task description in the configured cache-only home view", async () => {
    const profile = {
      alias: "work",
      team_id: "T1",
      team_name: "Acme",
      actor_id: "U1",
      actor_name: "Alice",
      timezone: "UTC",
      kind: "user_token",
      keychain_accounts: ["T1:user:generation:xoxp"],
      capabilities: { public_api: "supported" },
      created_at: "2026-08-15T10:00:00.000Z",
      updated_at: "2026-08-15T10:00:00.000Z",
    } as const;
    const app = {
      config: {
        async load() { return { version: 1, default_workspace: "work", profiles: [profile] }; },
        async resolve() { return profile; },
      },
      cache: { async load() { return undefined; } },
      identity() { return { id: "T1", alias: "work", actor_id: "U1", auth_kind: "user_token" }; },
    } as unknown as SlackAxiApp;

    const home = await jsonOutput(app, []);
    expect(home).toMatchObject({
      scope: { command: "home", source: "cache" },
      data: {
        description: "Read and safely act on Slack from coding agents.",
        workspace_name: "Acme",
        actor: "Alice",
        cache: { status: "not_synced" },
      },
      hints: [{ command: "slack-axi sync --workspace work" }],
    });
  });

  it("shows inherited global options on leaf help without touching configuration", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "slack-axi-leaf-help-"));
    const result = await exec(process.execPath, [entry, "conversation", "members", "--help"], { env: { ...process.env, HOME: home } });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Global Options:");
    expect(result.stdout).toContain("--workspace <alias|team-id>");
    expect(result.stdout).toContain("--output <format>");
    expect(result.stdout).toContain("--full");
  });

  it("points a leaf usage failure to exact leaf help", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "slack-axi-leaf-error-"));
    const failure = await executableFailure(["--output", "json", "message", "get", messageRef, "--wat"], home);
    const envelope = JSON.parse(failure.stdout) as Record<string, any>;

    expect(failure.code).toBe(2);
    expect(failure.stderr).toBe("");
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: "USAGE_ERROR", suggested_command: "slack-axi message get --help" },
    });
  });

  it("returns a useful structured group error instead of Commander's outputHelp placeholder", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "slack-axi-group-error-"));
    const failure = await executableFailure(["--output", "json", "conversation"], home);
    const envelope = JSON.parse(failure.stdout) as Record<string, any>;

    expect(failure.code).toBe(2);
    expect(failure.stderr).toBe("");
    expect(envelope.error.message).not.toContain("outputHelp");
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: "USAGE_ERROR", suggested_command: "slack-axi conversation --help" },
    });
  });
});
