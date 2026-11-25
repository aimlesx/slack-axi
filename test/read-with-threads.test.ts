import { describe, expect, it, vi } from "vitest";
import type { ActionStore } from "../src/actions.js";
import { SlackAxiApp } from "../src/app.js";
import type { AuthService } from "../src/auth.js";
import type { CacheSnapshot, CacheStore } from "../src/cache.js";
import { createProgram } from "../src/cli.js";
import { PublicSlackClient } from "../src/slack-public.js";
import type { AuthProfile } from "../src/types.js";
import { MemoryCursorIntegrity } from "./helpers.js";

const from = "2026-08-14T12:59:05.000Z";
const to = "2026-08-14T12:59:10.000Z";
const healthy = "1786712345.000001";
const failed = "1786712346.000001";
const empty = "1786712345.000000";
const reply = "1786712347.000001";
const broadcast = "1786712348.000001";
const end = "1786712350.000000";
const windowArgs = ["read", "C1", "--from", from, "--to", to, "--include-threads"];
const profile: AuthProfile = {
  alias: "work", team_id: "T1", team_name: "Fixture", actor_id: "U1", kind: "user_token", timezone: "UTC",
  keychain_accounts: ["user-token:T1"], capabilities: {}, created_at: from, updated_at: from,
};

function page(messages: Record<string, unknown>[], next = "") {
  return Response.json({ ok: true, messages, has_more: Boolean(next), response_metadata: { next_cursor: next } });
}

async function run(app: SlackAxiApp, args: string[]) {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", ...args]);
    return JSON.parse(String(write.mock.calls[0]?.[0]));
  } finally {
    write.mockRestore();
  }
}

describe("expanded conversation reads", () => {
  it("keeps completed, empty, failed and deferred threads distinct across bounded pages", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("oldest")).toBe("1786712344.999999");
      expect(body.get("latest")).toBe("1786712350");
      expect(body.get("inclusive")).toBe("false");
      if (String(input).endsWith("conversations.history")) return page([
        { ts: broadcast, subtype: "thread_broadcast", thread_ts: healthy },
        { ts: failed, text: "deleted thread", thread_ts: failed },
        { ts: healthy, text: "incident", reply_count: 5 },
        { ts: empty, text: "no replies", thread_ts: empty },
      ]);
      expect(String(input)).toMatch(/conversations\.replies$/);
      if (body.get("ts") === failed) return Response.json({ ok: false, error: "thread_not_found" });
      if (body.get("ts") === empty) return page([{ ts: empty, text: "no replies" }]);
      return body.has("cursor")
        ? page([{ ts: reply, thread_ts: healthy }, { ts: broadcast, thread_ts: healthy }, { ts: end, thread_ts: healthy }])
        : page([{ ts: healthy, text: "incident" }, {
          ts: reply, user: "U1", thread_ts: healthy,
          blocks: [{ type: "section", text: { type: "plain_text", text: "Service recovered" } }],
        }], "reply-2");
    });
    const publicClient = new PublicSlackClient("xoxp-fixture", { fetch: fetchMock });
    const context = {
      profile, conversations: [], userMap: new Map(), snapshot: { credential_generation: "generation" }, public: publicClient,
    };
    const app = { actions: new MemoryCursorIntegrity(), async context() { return context; } } as unknown as SlackAxiApp;
    const first = await run(app, [...windowArgs, "--max-requests", "3", "--limit", "5", "--fields", "ref,author_origin,rich_content"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(first).toMatchObject({
      data: {
        count: 4,
        messages: [{ ref: `T1/C1/${failed}` }, { ref: `T1/C1/${healthy}` }, { ref: `T1/C1/${empty}` }],
        threads: [
          { root_ref: `T1/C1/${failed}`, status: "failed", replies: [] },
          { root_ref: `T1/C1/${healthy}`, status: "deferred", replies: [{
            ref: `T1/C1/${reply}`, author_origin: "self", rich_content: { text: "Service recovered" },
          }] },
          { root_ref: `T1/C1/${empty}`, status: "deferred" },
        ],
        expansion: { history_complete: true, pending_threads: 2, requests_used: 3, failed_threads: 1 },
      },
      page: { shown: 4, complete: false, next_cursor: expect.any(String) },
    });
    const next = first.hints[0].command.split(" ").slice(1);
    const second = await run(app, next);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(second).toMatchObject({
      data: {
        count: 1,
        messages: [],
        threads: [
          { root_ref: `T1/C1/${healthy}`, status: "complete", replies: [{ ref: `T1/C1/${broadcast}` }] },
          { root_ref: `T1/C1/${empty}`, status: "empty", replies: [] },
        ],
        expansion: { history_complete: true, pending_threads: 0, requests_used: 2, failed_threads: 1, failure_sample: [{ root_ref: `T1/C1/${failed}` }] },
      },
      page: { shown: 1, total: 5, complete: false, source_complete: false },
    });
    expect(second.page).not.toHaveProperty("next_cursor");
    await expect(run(app, [...windowArgs, "--cursor", `${first.page.next_cursor.slice(0, -4)}XXXX`])).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(run(app, ["read", "C2", "--from", from, "--to", to, "--include-threads", "--cursor", first.page.next_cursor]))
      .rejects.toMatchObject({ code: "CURSOR_STALE" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("counts parents and replies against one message allowance on each page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("limit")).toBe("1");
      if (String(input).endsWith("conversations.history")) return page([{ ts: healthy, reply_count: 1 }]);
      return body.has("cursor") ? page([{ ts: reply, thread_ts: healthy }]) : page([{ ts: healthy }], "child");
    });
    const app = {
      actions: new MemoryCursorIntegrity(),
      async context() {
        return {
          profile, conversations: [], userMap: new Map(), snapshot: { credential_generation: "generation" },
          public: new PublicSlackClient("xoxp-fixture", { fetch: fetchMock }),
        };
      },
    } as unknown as SlackAxiApp;
    const first = await run(app, [...windowArgs, "--limit", "1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ data: { count: 1, expansion: { pending_threads: 1 } }, page: { shown: 1, complete: false } });
    const second = await run(app, first.hints[0].command.split(" ").slice(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(second).toMatchObject({
      data: { count: 1, messages: [], threads: [{ status: "complete", replies: [{ ref: `T1/C1/${reply}` }] }] },
      page: { shown: 1, total: 2, complete: true },
    });
  });

  it("counts cold-cache discovery, leaves the shared cache alone, and resumes by ID", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("users.conversations")) return Response.json({
        ok: true, response_metadata: { next_cursor: "" },
        channels: [{ id: "C1", name: "incident", is_im: false, is_mpim: false, is_group: false, is_private: false, is_archived: false }],
      });
      expect(String(input)).toMatch(/conversations\.history$/);
      return page([{ ts: healthy, text: "ordinary message" }]);
    });
    const publicClient = new PublicSlackClient("xoxp-fixture", { fetch: fetchMock });
    const auth = { async clients() { return { profile, public: publicClient }; } } as unknown as AuthService;
    const save = vi.fn(async (_data: CacheSnapshot) => undefined);
    const cache = {
      save,
      async load() { return undefined; },
    } as unknown as CacheStore;
    const app = new SlackAxiApp({ auth, cache, actions: new MemoryCursorIntegrity() as unknown as ActionStore });
    const first = await run(app, ["read", "#incident", ...windowArgs.slice(2), "--max-requests", "1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ data: { count: 0, expansion: { requests_used: 1, history_complete: false } }, page: { next_cursor: expect.any(String) } });
    const second = await run(app, first.hints[0].command.split(" ").slice(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ data: { count: 1, threads: [{ status: "empty" }], expansion: { requests_used: 1, history_complete: true } }, page: { complete: true } });
    expect(save).not.toHaveBeenCalled();
  });

  it("counts transport retries against the total request limit", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const app = {
      actions: new MemoryCursorIntegrity(),
      async context() {
        return {
          profile, conversations: [], userMap: new Map(), snapshot: { credential_generation: "generation" },
          public: new PublicSlackClient("xoxp-fixture", { fetch: fetchMock }),
        };
      },
    } as unknown as SlackAxiApp;
    await expect(run(app, [...windowArgs, "--max-requests", "1"])).rejects.toMatchObject({ code: "SLACK_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await expect(run(app, [...windowArgs, "--max-requests", "2"])).rejects.toMatchObject({ code: "SLACK_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
