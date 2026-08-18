import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import { createProgram } from "../src/cli.js";
import type { SlackAxiApp } from "../src/app.js";
import { createCacheCursor, filterHash, type CacheSnapshot } from "../src/cache.js";
import { AxiError } from "../src/errors.js";
import { COMMAND_METADATA, commandKey } from "../src/metadata.js";
import { MemoryCursorIntegrity, MemorySecrets } from "./helpers.js";

const exec = promisify(execFile);
const entry = path.resolve("dist/index.js");

describe("CLI fast and validation paths", () => {
  it("prints a bare version for every fast-path flag", async () => {
    for (const flag of ["-v", "-V", "--version"]) {
      const result = await exec(process.execPath, [entry, flag]);
      expect(result.stdout.trim()).toBe("0.1.0");
      expect(result.stderr).toBe("");
    }
  });

  it("renders help without accessing configuration", async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "slack-axi-home-"));
    const result = await exec(process.execPath, [entry, "--help"], { env: { ...process.env, HOME: fakeHome } });
    expect(result.stdout).toContain("Read and safely act on Slack");
    expect(result.stderr).toBe("");
  });

  it("returns structured usage failures only on stdout", async () => {
    await expect(exec(process.execPath, [entry, "nope", "--output", "json"])).rejects.toMatchObject({
      code: 2,
      stderr: "",
      stdout: expect.stringContaining('"code": "USAGE_ERROR"'),
    });
  });

  it("returns a cache-only setup home envelope", async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "slack-axi-home-"));
    const result = await exec(process.execPath, [entry], { env: { ...process.env, HOME: fakeHome } });
    expect(decode(result.stdout, { strict: true })).toMatchObject({ ok: true, data: { status: "setup_required" } });
  });

  it.each([
    ["implicit browser default", []],
    ["explicit browser synonym", ["--browser"]],
  ])("imports a strict xoxc and xoxd pair with the %s", async (_case, kindFlags) => {
    const add = vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      team_id: "T1",
      team_name: "Acme",
      workspace_url: "https://acme.slack.com/",
      actor_id: "U1",
      timezone: "UTC",
      keychain_accounts: ["redacted-token-account", "redacted-cookie-account"],
      capabilities: {},
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
    }));
    const stream = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ xoxc: "xoxc-session", xoxd: "xoxd-cookie" }); } };
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const app = {
      auth: { add },
      identity(value: { team_id: string; alias: string; actor_id: string; kind: string }) {
        return { id: value.team_id, alias: value.alias, actor_id: value.actor_id, auth_kind: value.kind };
      },
    } as unknown as SlackAxiApp;
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "auth", "add", "work", ...kindFlags, "--from-stdin"]);
    } finally {
      stdout.mockRestore();
      stdin.mockRestore();
    }

    expect(add).toHaveBeenCalledWith({ alias: "work", kind: "browser", token: "xoxc-session", cookie: "xoxd-cookie" });
  });

  it("requires --user-token for xoxp fallback input and rejects conflicting auth kinds before stdin", async () => {
    const add = vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      team_id: "T1",
      team_name: "Acme",
      actor_id: "U1",
      timezone: "UTC",
      keychain_accounts: ["redacted-token-account"],
      capabilities: {},
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
    }));
    const app = {
      auth: { add },
      identity(value: { team_id: string; alias: string; actor_id: string; kind: string }) {
        return { id: value.team_id, alias: value.alias, actor_id: value.actor_id, auth_kind: value.kind };
      },
    } as unknown as SlackAxiApp;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fallbackStream = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ xoxp: "xoxp-fallback" }); } };
    const fallbackStdin = vi.spyOn(process, "stdin", "get").mockReturnValue(fallbackStream as unknown as typeof process.stdin);
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "auth", "add", "work", "--user-token", "--from-stdin"]);
    } finally {
      fallbackStdin.mockRestore();
    }
    expect(add).toHaveBeenLastCalledWith({ alias: "work", kind: "user_token", token: "xoxp-fallback" });

    const defaultStream = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ xoxp: "xoxp-fallback" }); } };
    const defaultStdin = vi.spyOn(process, "stdin", "get").mockReturnValue(defaultStream as unknown as typeof process.stdin);
    try {
      await expect(createProgram(app).parseAsync(["node", "slack-axi", "auth", "add", "work", "--from-stdin"])).rejects.toMatchObject({ code: "STDIN_JSON_INVALID", exitCode: 2 });
    } finally {
      defaultStdin.mockRestore();
    }
    expect(add).toHaveBeenCalledTimes(1);

    const forbiddenStdin = vi.spyOn(process, "stdin", "get").mockImplementation(() => { throw new Error("stdin must not be read"); });
    try {
      await expect(createProgram(app).parseAsync(["node", "slack-axi", "auth", "add", "work", "--browser", "--user-token", "--from-stdin"])).rejects.toMatchObject({ code: "AUTH_KIND_CONFLICT", exitCode: 2 });
    } finally {
      forbiddenStdin.mockRestore();
      stdout.mockRestore();
    }
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid workspace alias before consuming credential stdin", async () => {
    const add = vi.fn();
    const stdin = vi.spyOn(process, "stdin", "get").mockImplementation(() => { throw new Error("stdin must not be read"); });
    try {
      await expect(createProgram({ auth: { add } } as unknown as SlackAxiApp).parseAsync([
        "node", "slack-axi", "auth", "add", "not/valid", "--from-stdin",
      ])).rejects.toMatchObject({ code: "ALIAS_INVALID", exitCode: 2 });
    } finally {
      stdin.mockRestore();
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects unknown projected fields before configuration access", async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "slack-axi-home-"));
    await expect(exec(process.execPath, [entry, "auth", "list", "--fields", "secret", "--output", "json"], { env: { ...process.env, HOME: fakeHome } })).rejects.toMatchObject({
      code: 2,
      stderr: "",
      stdout: expect.stringContaining('"code": "FIELDS_INVALID"'),
    });
  });

  it("applies --fields to a singleton detail record without projecting the envelope", async () => {
    const rawUser = { id: "U2", name: "alice", profile: { display_name: "Alice", real_name: "Alice Example", email: "alice@example.com" }, is_bot: false, deleted: false };
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      users: [],
      public: { async userInfo() { return rawUser; } },
    };
    const app = { async context() { return context; } } as unknown as SlackAxiApp;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "--fields", "id", "user", "get", "U2"]);
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(chunks.join(""))).toEqual({
      schema: "slack-axi/v1",
      ok: true,
      workspace: { id: "T1", alias: "work", actor_id: "U1", auth_kind: "user_token" },
      scope: { command: "user.get", backend_calls: 0 },
      data: { user: { id: "U2" } },
    });
  });

  it("runs cross-option and date preflight before app.context", async () => {
    let contextCalls = 0;
    const app = { async context() { contextCalls += 1; throw new Error("context must not run"); } } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "message", "send", "--to", "C1", "--text", "a", "--text-file", "b"])).rejects.toMatchObject({ code: "MESSAGE_TEXT_REQUIRED" });
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "search", "messages", "incident", "--all"])).rejects.toMatchObject({ code: "MAX_RESULTS_REQUIRED" });
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "read", "C1", "--on", "2026-02-30"])).rejects.toMatchObject({ code: "TIME_INVALID" });
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "--cursor", "opaque", "message", "get", "T1/C1/1786712345.001200"])).rejects.toMatchObject({ code: "CURSOR_UNSUPPORTED", exitCode: 2 });
    expect(contextCalls).toBe(0);
  });

  it.each([
    ["conversation list", ["conversation", "list"], 1000],
    ["conversation members", ["conversation", "members", "C1"], 200],
    ["user search", ["user", "search", "alice"], 1000],
    ["emoji search", ["emoji", "search", "party"], 1000],
    ["inbox", ["inbox"], 1000],
    ["read", ["read", "C1"], 100],
    ["thread", ["thread", "T1/C1/1786712345.001200"], 100],
    ["search messages", ["search", "messages", "incident"], 1000],
    ["search files", ["search", "files", "report"], 1000],
    ["action list", ["action", "list"], 1000],
  ])("rejects oversized limits for %s before dependency access", async (_key, args, maximum) => {
    let contextCalls = 0;
    let actionListCalls = 0;
    const app = {
      async context() { contextCalls += 1; throw new Error("context must not run"); },
      actions: { async list() { actionListCalls += 1; throw new Error("action store must not run"); } },
    } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "--limit", String(maximum + 1), ...args])).rejects.toMatchObject({
      code: "LIMIT_TOO_LARGE",
      message: `Limit cannot exceed ${maximum}.`,
      exitCode: 2,
    });
    expect(contextCalls).toBe(0);
    expect(actionListCalls).toBe(0);
  });

  it("rejects ignored --limit options before workspace access", async () => {
    let contextCalls = 0;
    const app = { async context() { contextCalls += 1; throw new Error("context must not run"); } } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "--limit", "1", "message", "get", "T1/C1/1786712345.001200"])).rejects.toMatchObject({ code: "LIMIT_UNSUPPORTED", exitCode: 2 });
    expect(contextCalls).toBe(0);
  });

  it.each([
    ["read", ["read", "C1", "--since", "0h"]],
    ["catchup", ["catchup", "--since", "999999999999999999999999999999w"]],
  ])("rejects invalid or overflowing --since on %s before workspace access", async (_command, args) => {
    let contextCalls = 0;
    const app = { async context() { contextCalls += 1; throw new Error("context must not run"); } } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", ...args])).rejects.toMatchObject({ code: "TIME_INVALID", exitCode: 2 });
    expect(contextCalls).toBe(0);
  });

  it.each([
    ["inverted dates", ["search", "messages", "incident", "--after", "2026-08-20", "--before", "2026-08-19"], "TIME_RANGE_INVALID"],
    ["empty date range", ["search", "files", "report", "--after", "2026-08-20", "--before", "2026-08-20"], "TIME_RANGE_INVALID"],
    ["competing result bounds", ["--limit", "10", "search", "messages", "incident", "--all", "--max-results", "100"], "SEARCH_OPTION_CONFLICT"],
  ])("rejects search %s before workspace access", async (_case, args, code) => {
    let contextCalls = 0;
    const app = { async context() { contextCalls += 1; throw new Error("context must not run"); } } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", ...args])).rejects.toMatchObject({ code, exitCode: 2 });
    expect(contextCalls).toBe(0);
  });

  it("returns exact filter-preserving restart commands for stale cache cursors", async () => {
    const snapshot: CacheSnapshot = {
      version: 2,
      revision: "current",
      team_id: "T1",
      actor_id: "U1",
      credential_generation: "generation-current",
      synced_at: "2026-08-16T00:00:00.000Z",
      conversations: [],
      users: [],
      emoji: {},
      coverage: {
        conversations: { scanned: 1, complete: true },
        users: { scanned: 1, complete: true },
        emoji: { scanned: 0, complete: true },
        inbox: { scanned: 0, complete: false },
        backend_calls: 0,
      },
    };
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      snapshot,
      conversations: [{ id: "C1", name: "eng team", type: "channel", is_private: false, is_member: true, is_archived: false }],
      users: [{ id: "U2", name: "alice", display_name: "Alice Smith", real_name: "Alice Smith", is_bot: false, deleted: false }],
      userMap: new Map(),
    };
    const integrity = new MemoryCursorIntegrity();
    const app = { actions: integrity, async context() { return context; } } as unknown as SlackAxiApp;
    const stale = { ...snapshot, revision: "stale" };
    const conversationFilters = { type: "channel", query: "eng team", archived: true };
    const conversationCursor = await createCacheCursor(stale, filterHash({ key: "conversation list", filters: conversationFilters }), 1, integrity);
    await expect(createProgram(app).parseAsync([
      "node", "slack-axi", "--cursor", conversationCursor, "--limit", "10", "--fields", "id,name",
      "conversation", "list", "--type", "channel", "--query", "eng team", "--include-archived",
    ])).rejects.toMatchObject({
      code: "CURSOR_STALE",
      suggestedCommand: "slack-axi conversation list --type channel --query 'eng team' --include-archived --limit 10 --fields id,name --workspace work",
    });

    const userCursor = await createCacheCursor(stale, filterHash({ key: "user search", filters: { query: "alice smith" } }), 1, integrity);
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "--cursor", userCursor, "user", "search", "Alice Smith"])).rejects.toMatchObject({
      code: "CURSOR_STALE",
      suggestedCommand: "slack-axi user search 'Alice Smith' --workspace work",
    });
  });

  it("rejects oversized outgoing text before workspace access using Unicode characters", async () => {
    let contextCalls = 0;
    const app = { async context() { contextCalls += 1; throw new Error("context reached"); } } as unknown as SlackAxiApp;

    await expect(createProgram(app).parseAsync(["node", "slack-axi", "message", "send", "--to", "C1", "--text", "😀".repeat(40_001)])).rejects.toMatchObject({ code: "MESSAGE_TOO_LONG", exitCode: 2 });
    expect(contextCalls).toBe(0);

    await expect(createProgram(app).parseAsync(["node", "slack-axi", "message", "send", "--to", "C1", "--text", "😀".repeat(40_000)])).rejects.toThrow("context reached");
    expect(contextCalls).toBe(1);
  });

  it("rejects an oversized upload before workspace access or action staging", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "slack-axi-upload-preflight-"));
    const filename = path.join(directory, "too-large.bin");
    await writeFile(filename, "five!");
    let contextCalls = 0;
    let actionCalls = 0;
    const app = {
      async context() { contextCalls += 1; throw new Error("context must not run"); },
      actions: { async create() { actionCalls += 1; throw new Error("action staging must not run"); } },
    } as unknown as SlackAxiApp;

    await expect(createProgram(app).parseAsync([
      "node", "slack-axi", "file", "upload", filename, "--to", "C1", "--max-bytes", "4",
    ])).rejects.toMatchObject({
      code: "FILE_UPLOAD_LIMIT_EXCEEDED",
      exitCode: 2,
      details: { bytes: 5, maximum_bytes: 4 },
    });
    expect(contextCalls).toBe(0);
    expect(actionCalls).toBe(0);
  });

  it("bounds message files before reading them into memory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "slack-axi-message-"));
    const filename = path.join(directory, "too-large.txt");
    await writeFile(filename, Buffer.alloc(160_001, 0x61));
    let contextCalls = 0;
    const app = { async context() { contextCalls += 1; throw new Error("context must not run"); } } as unknown as SlackAxiApp;
    await expect(createProgram(app).parseAsync(["node", "slack-axi", "message", "reply", "--to", "C1", "--thread", "T1/C1/1786712345.001200", "--text-file", filename])).rejects.toMatchObject({ code: "MESSAGE_TOO_LONG", exitCode: 2 });
    expect(contextCalls).toBe(0);
  });

  it("stages and dispatches bytes from one no-follow message-file handle despite pathname replacement", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "slack-axi-message-race-"));
    const filename = path.join(directory, "message.txt");
    const openedFilename = path.join(directory, "message.opened.txt");
    const replacement = path.join(directory, "replacement.txt");
    const originalText = "original bytes from the opened handle";
    const replacementText = "replacement bytes that must never be sent";
    await writeFile(filename, originalText, "utf8");
    await writeFile(replacement, replacementText, "utf8");

    const actions = new ActionStore(path.join(directory, "actions"), new MemorySecrets());
    const createAction = vi.spyOn(actions, "create");
    const postMessage = vi.fn(async () => ({
      ok: true,
      ts: "1786712345.001200",
      message: { ts: "1786712345.001200", text: originalText, user: "U1" },
    }));
    const workspace = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      snapshot: {
        coverage: {
          conversations: { scanned: 1, complete: true },
          users: { scanned: 0, complete: true },
        },
      },
      conversations: [{ id: "C1", name: "social", type: "channel", is_private: false, is_member: true, is_archived: false }],
      users: [],
      userMap: new Map(),
      public: {
        async authTest() { return { team_id: "T1", user_id: "U1" }; },
        postMessage,
        async permalink() { return "https://axi-playground.slack.com/archives/C1/p1786712345001200"; },
      },
    };
    const policy = {
      async validateUnfurls() {},
      async allows() { return true; },
    };
    const app = {
      actions,
      policy,
      config: {
        transaction<T>(operation: () => Promise<T>): Promise<T> { return operation(); },
        assertWorkspaceAvailable(_teamId: string): Promise<void> { return Promise.resolve(); },
      },
      async context() { return workspace; },
    } as unknown as SlackAxiApp;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram(app, {
        async openMessageFile(requested, flags) {
          expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
          const handle = await open(requested, flags);
          // Swap the pathname only after the exact descriptor has been opened.
          // Any later pathname read would now consume the replacement bytes.
          await rename(requested, openedFilename);
          await symlink(replacement, requested);
          return handle;
        },
      }).parseAsync(["node", "slack-axi", "--output", "json", "message", "send", "--to", "C1", "--text-file", filename, "--apply"]);
    } finally {
      write.mockRestore();
    }

    expect(createAction).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ text: originalText }),
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: originalText }));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ text: replacementText }));
    expect(JSON.parse(chunks.join(""))).toMatchObject({ ok: true, data: { action: { state: "applied" } } });
  });

  it.each(["messages", "files"] as const)("keeps the Slack page size constant across multi-page %s search", async (kind) => {
    const calls: Array<{ count: number; page: number }> = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => kind === "messages"
      ? { ts: `1786712345.${String(index + 1).padStart(6, "0")}`, channel_id: "C1", user: "U1", text: `message-${index + 1}` }
      : { id: `F${index + 1}`, name: `file-${index + 1}`, mimetype: "text/plain" });
    const secondPage = [kind === "messages"
      ? { ts: "1786712346.000101", channel_id: "C1", user: "U1", text: "message-101" }
      : { id: "F101", name: "file-101", mimetype: "text/plain" }];
    const search = vi.fn(async (_query: string, count: number, page: number) => {
      calls.push({ count, page });
      return { items: page === 1 ? firstPage : secondPage, total: 101, pages: 2 };
    });
    const publicClient = kind === "messages" ? { searchMessages: search } : { searchFiles: search };
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      users: [],
      userMap: new Map(),
      public: publicClient,
    };
    const app = { async context() { return context; } } as unknown as SlackAxiApp;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "search", kind, "needle", "--all", "--max-results", "101"]);
    } finally {
      write.mockRestore();
    }

    expect(calls).toEqual([{ count: 100, page: 1 }, { count: 100, page: 2 }]);
    const envelope = JSON.parse(chunks.join(""));
    const rows = envelope.data[kind];
    expect(rows).toHaveLength(101);
    expect(new Set(rows.map((row: Record<string, unknown>) => kind === "messages" ? row.ref : row.id)).size).toBe(101);
    expect(envelope.page).toMatchObject({ shown: 101, complete: true, total: 101 });
  });

  it.each(["messages", "files"] as const)("rejects inconsistent empty %s search pages without provider-directed fan-out", async (kind) => {
    const search = vi.fn(async () => ({ items: [], total: 250, pages: 1_000_000 }));
    const publicClient = kind === "messages" ? { searchMessages: search } : { searchFiles: search };
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      users: [],
      userMap: new Map(),
      public: publicClient,
    };
    const app = { async context() { return context; } } as unknown as SlackAxiApp;

    await expect(createProgram(app).parseAsync([
      "node", "slack-axi", "search", kind, "needle", "--all", "--max-results", "250",
    ])).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("includes two or more examples on every command help page", () => {
    const program = createProgram({} as SlackAxiApp);
    const visit = (command: ReturnType<typeof createProgram>): void => {
      const metadata = COMMAND_METADATA[commandKey(command)];
      expect(metadata, commandKey(command)).toBeDefined();
      expect(metadata!.examples.length, commandKey(command)).toBeGreaterThanOrEqual(2);
      for (const child of command.commands) visit(child as ReturnType<typeof createProgram>);
    };
    visit(program);
  });

  it("includes required values, defaults, and incompatibilities on every help page", () => {
    const program = createProgram({} as SlackAxiApp);
    const visit = (command: ReturnType<typeof createProgram>): void => {
      let help = "";
      const output = command.configureOutput();
      command.configureOutput({ ...output, writeOut: (value) => { help += value; } });
      command.outputHelp();
      command.configureOutput(output);
      expect(help, commandKey(command)).toContain("Contract:");
      expect(help, commandKey(command)).toContain("Required values:");
      expect(help, commandKey(command)).toContain("Defaults:");
      expect(help, commandKey(command)).toContain("Incompatible combinations:");
      for (const child of command.commands) visit(child as ReturnType<typeof createProgram>);
    };
    visit(program);
  });

  it("documents read's rolling 24-hour default truthfully", () => {
    const program = createProgram({} as SlackAxiApp);
    const read = program.commands.find((command) => command.name() === "read")!;
    let help = "";
    const output = read.configureOutput();
    read.configureOutput({ ...output, writeOut: (value) => { help += value; } });
    read.outputHelp();
    read.configureOutput(output);
    expect(help).toContain("rolling 24-hour range ending now");
    expect(help).not.toContain("current local day");
  });

  it("keeps generated shell completions aligned with registry subcommands", async () => {
    const [bash, zsh] = await Promise.all([
      readFile(path.resolve("completions/slack-axi.bash"), "utf8"),
      readFile(path.resolve("completions/_slack-axi"), "utf8"),
    ]);
    for (const key of Object.keys(COMMAND_METADATA).filter((value) => value.includes(" "))) {
      const [root, child] = key.split(" ");
      expect(bash, key).toMatch(new RegExp(`${root}\\).*\\b${child}\\b`));
      expect(zsh, key).toMatch(new RegExp(`${root}\\).*\\b${child}\\b`));
    }
  });

  it("rejects browser-session revocation before creating an action journal entry", async () => {
    const create = vi.fn();
    const loadContext = vi.fn();
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "browser", timezone: "UTC" },
    };
    const app = {
      actions: { create },
      config: { async resolve() { return context.profile; } },
      context: loadContext,
    } as unknown as SlackAxiApp;

    await expect(createProgram(app).parseAsync(["node", "slack-axi", "auth", "revoke", "work"])).rejects.toMatchObject({
      code: "AUTH_REVOCATION_UNSUPPORTED",
      retryable: false,
      suggestedCommand: "slack-axi auth remove work",
    });
    expect(create).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
  });

  it("reports browser-only capability errors for a user-token Later request", async () => {
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      snapshot: { credential_generation: "generation-1" },
    };
    const signCursor = vi.fn();
    const app = {
      actions: { signCursor, verifyCursor: vi.fn() },
      config: { async resolve() { return context.profile; } },
      context: vi.fn(),
    } as unknown as SlackAxiApp;

    await expect(createProgram(app).parseAsync(["node", "slack-axi", "later", "list"])).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNAVAILABLE",
      retryable: false,
      suggestedCommand: "slack-axi auth add work --from-stdin",
    });
    expect(signCursor).not.toHaveBeenCalled();
    expect(app.context).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", async () => { throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Unread semantics are missing." }); }, false, "known"],
    ["zero", async () => ({ id: "C1", unread_count_display: 0, is_ext_shared: false }), true, "exact"],
  ])("distinguishes %s unread semantics from an authoritative empty inbox", async (_case, conversationInboxInfo, complete, totalKind) => {
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      conversations: [{ id: "C1", name: "general", type: "channel", is_archived: false }],
      users: [],
      userMap: new Map(),
      snapshot: {
        revision: "r1",
        coverage: {
          conversations: { scanned: 1, complete: true },
          users: { scanned: 0, complete: true },
          emoji: { scanned: 0, complete: true },
          inbox: { scanned: 0, complete: false },
          backend_calls: 0,
        },
      },
      public: { conversationInboxInfo },
    };
    const app = { async context() { return context; } } as unknown as SlackAxiApp;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "inbox", "--include-muted"]);
    } finally {
      write.mockRestore();
    }
    const envelope = JSON.parse(chunks.join(""));
    expect(envelope).toMatchObject({
      ok: true,
      data: { known_count: 0, conversations: [] },
      page: { complete, source_complete: complete, total: 0, total_kind: totalKind },
      coverage: { requested: 1, scanned: 1, failed: complete ? 0 : 1, complete },
    });
  });

  it("keeps user-token inbox coverage incomplete until unavailable mute filtering is made irrelevant", async () => {
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      conversations: [{ id: "C1", name: "general", type: "channel", is_archived: false }],
      users: [],
      userMap: new Map(),
      snapshot: {
        revision: "r1",
        coverage: {
          conversations: { scanned: 1, complete: true },
          users: { scanned: 0, complete: true },
          emoji: { scanned: 0, complete: true },
          inbox: { scanned: 0, complete: false },
          backend_calls: 0,
        },
      },
      public: { async conversationInboxInfo() { return { id: "C1", unread_count_display: 0, is_ext_shared: false }; } },
    };
    const app = { async context() { return context; } } as unknown as SlackAxiApp;

    const run = async (extra: string[] = []): Promise<Record<string, any>> => {
      const chunks: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
      try {
        await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "inbox", ...extra]);
      } finally {
        write.mockRestore();
      }
      return JSON.parse(chunks.join(""));
    };

    const defaultResult = await run();
    expect(defaultResult).toMatchObject({
      page: { complete: false, source_complete: false, total: 0, total_kind: "known" },
      coverage: { requested: 1, scanned: 1, failed: 0, complete: false, reason: expect.stringContaining("cannot determine mute state") },
      hints: expect.arrayContaining([{ command: "slack-axi inbox --include-muted --workspace work", reason: expect.stringContaining("unavailable mute state") }]),
    });

    const inclusiveResult = await run(["--include-muted"]);
    expect(inclusiveResult).toMatchObject({
      page: { complete: true, source_complete: true, total: 0, total_kind: "exact" },
      coverage: { requested: 1, scanned: 1, failed: 0, complete: true },
    });
  });

  it("uses browser counts and excludes muted conversations exactly", async () => {
    const mutedChannels = vi.fn(async () => new Set(["D1"]));
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "browser", timezone: "UTC" },
      conversations: [
        { id: "D1", name: "muted-dm", type: "dm", is_archived: false, is_external: false },
        { id: "C1", name: "eng", type: "channel", is_archived: false, is_external: false },
      ],
      users: [],
      userMap: new Map(),
      snapshot: {
        revision: "r1",
        coverage: {
          conversations: { scanned: 2, complete: true },
          users: { scanned: 0, complete: true },
          emoji: { scanned: 0, complete: true },
          inbox: { scanned: 2, complete: true },
          backend_calls: 0,
        },
      },
      browser: {
        async counts() {
          return {
            channels: [{ id: "C1", mention_count: 2, has_unreads: true, last_read: "1.000001", latest: "2.000001" }],
            mpims: [],
            ims: [{ id: "D1", mention_count: 1, has_unreads: true }],
          };
        },
        mutedChannels,
      },
    };
    const app = { async context() { return context; } } as unknown as SlackAxiApp;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "inbox"]);
    } finally {
      write.mockRestore();
    }

    expect(mutedChannels).toHaveBeenCalledTimes(1);
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      data: {
        known_count: 1,
        conversations: [{ conversation_id: "C1", unread: true, mentions: 2, muted: false, last_read: "1.000001", latest: "2.000001" }],
      },
      page: { shown: 1, complete: true, source_complete: true, total: 1, total_kind: "exact" },
      coverage: { requested: 2, scanned: 2, failed: 0, complete: true },
    });
  });

  it("reports and authenticates catchup continuation for a busy conversation", async () => {
    const history = vi.fn(async ({ channel, cursor }: { channel: string; cursor?: string }) => cursor
      ? { items: [], complete: true }
      : channel === "C1"
        ? { items: [{ type: "message", ts: "1786712345.001200", user: "U1", text: "busy" }], complete: false, next: "backend-next" }
        : { items: [], complete: true });
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      conversations: [
        { id: "C2", name: "zeta", type: "channel", is_archived: false },
        { id: "C1", name: "alpha", type: "channel", is_archived: false },
      ],
      users: [],
      userMap: new Map(),
      snapshot: {
        credential_generation: "generation-1",
        coverage: {
          conversations: { scanned: 2, complete: true },
          users: { scanned: 0, complete: true },
          emoji: { scanned: 0, complete: true },
          inbox: { scanned: 0, complete: false },
          backend_calls: 0,
        },
      },
      public: { history },
    };
    const integrity = new MemoryCursorIntegrity();
    const app = { actions: integrity, async context() { return context; } } as unknown as SlackAxiApp;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "catchup", "--since", "24h", "--max-conversations", "2", "--per-conversation", "1"]);
    } finally {
      write.mockRestore();
    }
    const envelope = JSON.parse(chunks.join(""));
    expect(history.mock.calls.map(([options]) => options.channel)).toEqual(["C1", "C2"]);
    expect(envelope).toMatchObject({
      data: { totals: { eligible: 2, scanned: 2, returned: 2, incomplete: 1, failed: 0, skipped: 0 }, incomplete: [{ conversation_id: "C1", reason: "history_page_truncated" }] },
      coverage: { requested: 2, scanned: 2, failed: 0, complete: false, reason: expect.stringContaining("additional pages") },
      hints: [{ command: expect.stringContaining("slack-axi read C1"), reason: expect.stringContaining("exact bounded range") }],
    });
    const continuation = String(envelope.data.incomplete[0].continuation_command);
    const encoded = /--cursor ([A-Za-z0-9_-]+)/.exec(continuation)?.[1];
    expect(encoded).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
    expect(decoded).toMatchObject({ kind: "read", backend_cursor: "backend-next", scanned: 1 });
    const { signature, ...unsigned } = decoded;
    expect(await integrity.verifyCursor(unsigned, signature)).toBe(true);

    const continuedOutput: string[] = [];
    const continuedWrite = vi.spyOn(process.stdout, "write").mockImplementation((value) => { continuedOutput.push(String(value)); return true; });
    try {
      await createProgram(app).parseAsync(["node", ...continuation.split(" ")]);
    } finally {
      continuedWrite.mockRestore();
    }
    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "C1", cursor: "backend-next", limit: 1 }));
  });

  it("keeps catchup omission reporting bounded in a very large workspace", async () => {
    const conversations = Array.from({ length: 5_000 }, (_, index) => ({
      id: `C${String(index).padStart(6, "0")}`,
      name: `channel-${String(index).padStart(6, "0")}`,
      type: "channel",
      is_archived: false,
    }));
    const history = vi.fn(async () => ({ items: [], complete: true }));
    const context = {
      profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
      conversations,
      users: [],
      userMap: new Map(),
      snapshot: {
        credential_generation: "generation-1",
        coverage: {
          conversations: { scanned: conversations.length, complete: true },
          users: { scanned: 0, complete: true },
          emoji: { scanned: 0, complete: true },
          inbox: { scanned: 0, complete: false },
          backend_calls: 0,
        },
      },
      public: { history },
    };
    const app = { actions: new MemoryCursorIntegrity(), async context() { return context; } } as unknown as SlackAxiApp;
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "catchup"]);
    } finally {
      write.mockRestore();
    }
    const output = chunks.join("");
    const envelope = JSON.parse(output);
    expect(history).toHaveBeenCalledTimes(20);
    expect(envelope.data).toMatchObject({
      totals: { eligible: 5_000, scanned: 20, returned: 20, skipped: 4_980 },
      skipped_count: 4_980,
    });
    expect(envelope.data.skipped_sample).toHaveLength(5);
    expect(envelope.data).not.toHaveProperty("skipped");
    expect(output.length).toBeLessThan(30_000);
  });
});
