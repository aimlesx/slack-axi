import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { SlackAxiApp } from "../src/app.js";
import { MemoryCursorIntegrity } from "./helpers.js";

async function jsonOutput(app: SlackAxiApp, args: string[]): Promise<Record<string, any>> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => { chunks.push(String(value)); return true; });
  try {
    await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", ...args]);
  } finally {
    write.mockRestore();
  }
  return JSON.parse(chunks.join(""));
}

function workspaceContext(publicClient: Record<string, unknown>) {
  return {
    profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: "user_token", timezone: "UTC" },
    conversations: [{ id: "C1", name: "general", type: "channel", is_private: false, is_member: true, is_archived: false }],
    users: [],
    userMap: new Map(),
    snapshot: { credential_generation: "generation-current", coverage: { conversations: { scanned: 1, complete: true }, users: { scanned: 0, complete: true } } },
    public: publicClient,
  };
}

function workspaceApp(context: ReturnType<typeof workspaceContext>): SlackAxiApp {
  return { actions: new MemoryCursorIntegrity(), async context() { return context; } } as unknown as SlackAxiApp;
}

describe("live continuation accounting", () => {
  it("reports the cumulative exact member total on a terminal second page", async () => {
    const cursors: Array<string | undefined> = [];
    const conversationMembers = vi.fn(async (_channel: string, _limit: number, cursor?: string) => {
      cursors.push(cursor);
      return cursor ? { items: ["U3"] } : { items: ["U1", "U2"], next: "members-backend-2" };
    });
    const context = workspaceContext({ conversationMembers });
    const app = workspaceApp(context);

    const display = ["--limit", "2", "--fields", "id,name"];
    const first = await jsonOutput(app, ["conversation", "members", "C1", ...display]);
    expect(first.page).toMatchObject({ shown: 2, total: 2, total_kind: "scanned", complete: false });
    expect(first.page.next_cursor).not.toBe("members-backend-2");
    expect(first.hints[0].command).toBe(`slack-axi conversation members C1 --limit 2 --fields id,name --workspace work --cursor ${first.page.next_cursor}`);

    const cursorValue = JSON.parse(Buffer.from(first.page.next_cursor, "base64url").toString("utf8"));
    for (const changed of [
      { ...cursorValue, scanned: 200 },
      { ...cursorValue, binding: "0".repeat(64) },
      { ...cursorValue, backend_cursor: "replacement-backend" },
    ]) {
      const tampered = Buffer.from(JSON.stringify(changed)).toString("base64url");
      await expect(jsonOutput(app, ["--cursor", tampered, "conversation", "members", "C1", ...display])).rejects.toMatchObject({ code: "CURSOR_INVALID", exitCode: 2 });
    }

    const publiclyRecomputed = { ...cursorValue, scanned: 9_000_000 };
    publiclyRecomputed.signature = createHash("sha256")
      .update(JSON.stringify([publiclyRecomputed.kind, publiclyRecomputed.binding, publiclyRecomputed.backend_cursor, publiclyRecomputed.scanned]))
      .digest("base64url");
    await expect(jsonOutput(app, ["--cursor", Buffer.from(JSON.stringify(publiclyRecomputed)).toString("base64url"), "conversation", "members", "C1", ...display])).rejects.toMatchObject({ code: "CURSOR_INVALID", exitCode: 2 });

    context.snapshot.credential_generation = "generation-replaced";
    await expect(jsonOutput(app, ["--cursor", first.page.next_cursor, "conversation", "members", "C1", ...display])).rejects.toMatchObject({ code: "CURSOR_STALE", exitCode: 2 });
    context.snapshot.credential_generation = "generation-current";

    const second = await jsonOutput(app, ["--cursor", first.page.next_cursor, "conversation", "members", "C1", ...display]);
    expect(second.page).toMatchObject({ shown: 1, total: 3, total_kind: "exact", complete: true });
    expect(cursors).toEqual([undefined, "members-backend-2"]);
  });

  it("keeps member PII out of defaults and exposes it only through explicit fields", async () => {
    const member = {
      id: "U2",
      name: "alice",
      display_name: "Alice",
      real_name: "Alice Example",
      email: "alice@example.com",
      timezone: "Europe/Warsaw",
      is_bot: false,
      deleted: false,
    };
    const conversationMembers = vi.fn(async () => ({ items: [member.id] }));
    const usergroupMembers = vi.fn(async () => [member.id]);
    const context = workspaceContext({ conversationMembers, usergroupMembers });
    context.userMap = new Map([[member.id, member]]);
    const app = workspaceApp(context);

    const conversationDefault = await jsonOutput(app, ["conversation", "members", "C1"]);
    expect(conversationDefault.data.members).toEqual([{ id: "U2", name: "alice", display_name: "Alice" }]);
    expect(conversationDefault.data.members[0]).not.toHaveProperty("real_name");
    expect(conversationDefault.data.members[0]).not.toHaveProperty("email");
    expect(conversationDefault.data.members[0]).not.toHaveProperty("timezone");

    const groupDefault = await jsonOutput(app, ["usergroup", "members", "S1"]);
    expect(groupDefault.data.members).toEqual([{ id: "U2", name: "alice", display_name: "Alice" }]);
    expect(groupDefault.data.members[0]).not.toHaveProperty("email");
    expect(groupDefault.data.members[0]).not.toHaveProperty("timezone");

    const fields = ["--fields", "id,email,timezone"];
    const conversationExpanded = await jsonOutput(app, ["conversation", "members", "C1", ...fields]);
    expect(conversationExpanded.data.members).toEqual([{ id: "U2", email: "alice@example.com", timezone: "Europe/Warsaw" }]);

    const groupExpanded = await jsonOutput(app, ["usergroup", "members", "S1", ...fields]);
    expect(groupExpanded.data.members).toEqual([{ id: "U2", email: "alice@example.com", timezone: "Europe/Warsaw" }]);
  });

  it("pages user groups and memberships with snapshot-bound authenticated cursors", async () => {
    const groups = [
      { id: "S3", handle: "three", name: "Three", description: "third" },
      { id: "S1", handle: "one", name: "One", description: "first" },
      { id: "S2", handle: "two", name: "Two", description: "second" },
    ];
    const listUsergroups = vi.fn(async () => groups);
    const usergroupMembers = vi.fn(async () => ["U3", "U1", "U2"]);
    const context = workspaceContext({ listUsergroups, usergroupMembers });
    const app = workspaceApp(context);

    const firstGroups = await jsonOutput(app, ["usergroup", "list", "--limit", "2"]);
    expect(firstGroups.data).toMatchObject({ count: 3, usergroups: [{ id: "S1" }, { id: "S3" }] });
    expect(firstGroups.page).toMatchObject({ shown: 2, total: 3, total_kind: "exact", complete: false, omitted: 1 });
    const secondGroups = await jsonOutput(app, ["--cursor", firstGroups.page.next_cursor, "usergroup", "list", "--limit", "2"]);
    expect(secondGroups.data.usergroups).toEqual([{ id: "S2", handle: "two", name: "Two" }]);
    expect(secondGroups.page).toMatchObject({ shown: 1, total: 3, total_kind: "exact", complete: true });

    const firstMembers = await jsonOutput(app, ["usergroup", "members", "S1", "--limit", "2"]);
    expect(firstMembers.data).toMatchObject({ count: 3, members: [{ id: "U1" }, { id: "U2" }] });
    expect(firstMembers.page).toMatchObject({ shown: 2, total: 3, complete: false, omitted: 1 });
    const secondMembers = await jsonOutput(app, ["--cursor", firstMembers.page.next_cursor, "usergroup", "members", "S1", "--limit", "2"]);
    expect(secondMembers.data.members).toEqual([{ id: "U3" }]);
    expect(secondMembers.page).toMatchObject({ shown: 1, total: 3, complete: true });

    groups[0]!.name = "Changed after page one";
    await expect(jsonOutput(app, ["--cursor", firstGroups.page.next_cursor, "usergroup", "list", "--limit", "2"])).rejects.toMatchObject({ code: "CURSOR_STALE", exitCode: 2 });
  });

  it("reports the cumulative exact timeline total on a terminal second page", async () => {
    const cursors: Array<string | undefined> = [];
    const history = vi.fn(async (options: { cursor?: string }) => {
      cursors.push(options.cursor);
      return options.cursor
        ? { items: [{ ts: "1786712347.000003", user: "U1", text: "third" }], complete: true }
        : { items: [{ ts: "1786712345.000001", user: "U1", text: "first" }, { ts: "1786712346.000002", user: "U1", text: "second" }], next: "read-backend-2", complete: false };
    });
    const context = workspaceContext({ history });
    const app = workspaceApp(context);
    const range = ["--from", "2026-08-16T00:00:00Z", "--to", "2026-08-17T00:00:00Z"];

    const display = ["--limit", "2", "--fields", "ref,text", "--full"];
    const first = await jsonOutput(app, ["read", "C1", ...range, ...display]);
    expect(first.page).toMatchObject({ shown: 2, total: 2, total_kind: "scanned", complete: false });
    expect(first.page.next_cursor).not.toBe("read-backend-2");
    expect(first.hints[0].command).toBe(`slack-axi read C1 --from 2026-08-16T00:00:00.000Z --to 2026-08-17T00:00:00.000Z --limit 2 --fields ref,text --full --workspace work --cursor ${first.page.next_cursor}`);

    const second = await jsonOutput(app, ["--cursor", first.page.next_cursor, "read", "C1", ...range, ...display]);
    expect(second.page).toMatchObject({ shown: 1, total: 3, total_kind: "exact", complete: true });
    expect(cursors).toEqual([undefined, "read-backend-2"]);
  });

  it("keeps both expansion and continuation hints for a truncated timeline page", async () => {
    const history = vi.fn(async () => ({ items: [{ ts: "1786712345.000001", user: "U1", text: "x".repeat(601) }], next: "read-backend-2", complete: false }));
    const context = workspaceContext({ history });
    const app = workspaceApp(context);
    const envelope = await jsonOutput(app, ["read", "C1", "--from", "2026-08-16T00:00:00Z", "--to", "2026-08-17T00:00:00Z", "--limit", "1"]);
    expect(envelope.hints).toHaveLength(2);
    expect(envelope.hints.map((hint: { command: string }) => hint.command)).toEqual([
      "slack-axi read C1 --from 2026-08-16T00:00:00.000Z --to 2026-08-17T00:00:00.000Z --limit 1 --workspace work --full",
      `slack-axi read C1 --from 2026-08-16T00:00:00.000Z --to 2026-08-17T00:00:00.000Z --limit 1 --workspace work --cursor ${envelope.page.next_cursor}`,
    ]);
  });

  it("reports the cumulative exact thread total on a terminal second page", async () => {
    const cursors: Array<string | undefined> = [];
    const replies = vi.fn(async (options: { cursor?: string }) => {
      cursors.push(options.cursor);
      return options.cursor
        ? { items: [{ ts: "1786712347.000003", user: "U1", text: "reply" }], complete: true }
        : { items: [{ ts: "1786712345.000001", user: "U1", text: "root" }], next: "thread-backend-2", complete: false };
    });
    const context = workspaceContext({ replies });
    const app = workspaceApp(context);
    const reference = "T1/C1/1786712345.000001";

    const display = ["--limit", "1", "--fields", "ref,text", "--full"];
    const first = await jsonOutput(app, ["thread", reference, ...display]);
    expect(first.page).toMatchObject({ shown: 1, total: 1, total_kind: "scanned", complete: false });
    expect(first.page.next_cursor).not.toBe("thread-backend-2");
    expect(first.hints[0].command).toBe(`slack-axi thread ${reference} --limit 1 --fields ref,text --full --workspace work --cursor ${first.page.next_cursor}`);

    const second = await jsonOutput(app, ["--cursor", first.page.next_cursor, "thread", reference, ...display]);
    expect(second.page).toMatchObject({ shown: 1, total: 2, total_kind: "exact", complete: true });
    expect(cursors).toEqual([undefined, "thread-backend-2"]);
  });

  it("uses authenticated cumulative cursors and full message refs for Later pages", async () => {
    const cursors: Array<string | undefined> = [];
    const laterList = vi.fn(async (cursor?: string) => {
      cursors.push(cursor);
      const item = (id: string, ts: string) => ({
        item_id: id,
        item_type: "message",
        ts,
        state: "saved",
        date_due: 0,
        date_completed: 0,
        is_archived: false,
      });
      return cursor
        ? { items: [item("C2", "1786712346.000002")], counts: { uncompleted_count: 2 } }
        : { items: [item("C1", "1786712345.000001")], counts: { uncompleted_count: 2 }, next: "later-backend-2" };
    });
    const profile = { alias: "work", team_id: "T1", actor_id: "U1", kind: "browser" as const, timezone: "UTC" };
    const context = {
      ...workspaceContext({}),
      profile,
      browser: { laterList },
    };
    const app = {
      actions: new MemoryCursorIntegrity(),
      config: { async resolve() { return profile; } },
      async context() { return context; },
    } as unknown as SlackAxiApp;

    const first = await jsonOutput(app, ["later", "list", "--limit", "1"]);
    expect(first.data).toMatchObject({
      capability: "browser_private_best_effort",
      items: [{ ref: "T1/C1/1786712345.000001" }],
    });
    expect(first.page).toMatchObject({ shown: 1, total: 2, total_kind: "exact", complete: false });
    expect(first.page.next_cursor).not.toBe("later-backend-2");

    const cursorValue = JSON.parse(Buffer.from(first.page.next_cursor, "base64url").toString("utf8"));
    const tampered = Buffer.from(JSON.stringify({ ...cursorValue, authoritative_total: 200 })).toString("base64url");
    await expect(jsonOutput(app, ["later", "list", "--limit", "1", "--cursor", tampered])).rejects.toMatchObject({ code: "CURSOR_INVALID", exitCode: 2 });

    const second = await jsonOutput(app, ["later", "list", "--limit", "1", "--cursor", first.page.next_cursor]);
    expect(second.data.items).toEqual([expect.objectContaining({ ref: "T1/C2/1786712346.000002" })]);
    expect(second.page).toMatchObject({ shown: 1, total: 2, total_kind: "exact", complete: true });
    expect(cursors).toEqual([undefined, "later-backend-2"]);
  });

  it("fails Later pagination coverage closed when Slack's authoritative count drifts", async () => {
    const laterList = vi.fn(async (cursor?: string) => ({
      items: [{ item_id: "C1", item_type: "message", ts: cursor ? "1786712346.000002" : "1786712345.000001", state: "saved", date_due: 0, date_completed: 0, is_archived: false }],
      counts: { uncompleted_count: cursor ? 3 : 2 },
      ...(cursor ? {} : { next: "later-backend-2" }),
    }));
    const profile = { alias: "work", team_id: "T1", actor_id: "U1", kind: "browser" as const, timezone: "UTC" };
    const context = { ...workspaceContext({}), profile, browser: { laterList } };
    const app = {
      actions: new MemoryCursorIntegrity(),
      config: { async resolve() { return profile; } },
      async context() { return context; },
    } as unknown as SlackAxiApp;

    const first = await jsonOutput(app, ["later", "list", "--limit", "1"]);
    const second = await jsonOutput(app, ["later", "list", "--limit", "1", "--cursor", first.page.next_cursor]);
    expect(second.data.pagination_count_drift).toMatchObject({ initial_total: 2, observed_total: 3, cumulative_scanned: 2 });
    expect(second.page).toMatchObject({ complete: false, source_complete: false, total: 2, total_kind: "scanned" });
    expect(second.coverage).toMatchObject({ requested: 2, scanned: 2, failed: 0, complete: false });
    expect(second.hints[0].command).toBe("slack-axi later list --limit 1 --workspace work");
  });

});

describe("authentication stdin bounds", () => {
  it("stops an oversized stream before auth or context access and preserves its size error", async () => {
    let yielded = 0;
    const chunks = [8_000, 8_000, 1_000, 8_000].map((size) => Buffer.alloc(size, 0x61));
    const boundedStream = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index >= chunks.length) return { done: true as const, value: undefined };
            yielded += 1;
            return { done: false as const, value: chunks[index++]! };
          },
          async return() { return { done: true as const, value: undefined }; },
        };
      },
    };
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(boundedStream as unknown as typeof process.stdin);
    const add = vi.fn();
    const context = vi.fn();
    const app = { auth: { add }, context } as unknown as SlackAxiApp;
    try {
      await expect(createProgram(app).parseAsync(["node", "slack-axi", "auth", "add", "work", "--user-token", "--from-stdin"])).rejects.toMatchObject({
        code: "AUTH_INPUT_TOO_LARGE",
        exitCode: 2,
        details: { bytes_read: 17_000, maximum_utf8_bytes: 16_384 },
      });
    } finally {
      stdin.mockRestore();
    }
    expect(yielded).toBe(3);
    expect(add).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
  });

  it("keeps malformed bounded credential input distinct from an oversized stream", async () => {
    const boundedStream = {
      async *[Symbol.asyncIterator]() { yield "not-json"; },
    };
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(boundedStream as unknown as typeof process.stdin);
    const add = vi.fn();
    const app = { auth: { add } } as unknown as SlackAxiApp;
    try {
      await expect(createProgram(app).parseAsync(["node", "slack-axi", "auth", "add", "work", "--user-token", "--from-stdin"])).rejects.toMatchObject({ code: "STDIN_JSON_INVALID", exitCode: 2 });
    } finally {
      stdin.mockRestore();
    }
    expect(add).not.toHaveBeenCalled();
  });
});
