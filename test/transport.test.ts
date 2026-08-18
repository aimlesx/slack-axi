import { describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { toErrorEnvelope } from "../src/errors.js";
import { serialize } from "../src/output.js";
import { normalizeUploadResponse, PublicSlackClient } from "../src/slack-public.js";

function client(fetchMock: typeof fetch): PublicSlackClient {
  return new PublicSlackClient("xoxp-test", { apiUrl: "https://slack.com/api/", fetch: fetchMock });
}

describe("bounded Slack transport", () => {
  it("normalizes the nested filesUploadV2 completion shape from Slack SDK v8", () => {
    expect(normalizeUploadResponse({ ok: true, files: [{ ok: true, files: [{ id: "F1", name: "probe.txt", size: 12 }] }] })).toEqual({ files: [{ id: "F1", name: "probe.txt", size: 12 }] });
  });

  it("forwards an optional browser cookie to Slack Web API calls", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://slack.com/api/auth.test");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer xoxc-test");
      expect(headers.get("cookie")).toBe("d=xoxd-one%2Ftwo%3D");
      return new Response(JSON.stringify({ ok: true, team_id: "T1", user_id: "U1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const slack = new PublicSlackClient("xoxc-test", {
      apiUrl: "https://slack.com/api/",
      fetch: fetchMock,
      cookie: "xoxd-one%2Ftwo%3D",
    });

    await expect(slack.authTest()).resolves.toMatchObject({ team_id: "T1", user_id: "U1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    "not-a-browser-cookie",
    "xoxd-invalid%ZZ",
    "xoxd-valid\r\nX-Evil: true",
  ])("rejects an unsafe browser cookie before constructing the transport: %s", (cookie) => {
    expect(() => new PublicSlackClient("xoxc-test", { cookie })).toThrowError(expect.objectContaining({ code: "AUTH_INVALID" }));
  });

  it("retries a retryable read exactly once and never uses SDK retries", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream", { status: 503 })) as unknown as typeof fetch;
    await expect(client(fetchMock).authTest()).rejects.toMatchObject({ code: "SLACK_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("performs a write exactly once and classifies an HTTP failure as uncertain", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream", { status: 503 })) as unknown as typeof fetch;
    await expect(client(fetchMock).postMessage({ channel: "C1", text: "once", clientMsgId: "id", unfurlLinks: false, unfurlMedia: false })).rejects.toMatchObject({ code: "SLACK_HTTP_ERROR", details: { dispatch_uncertain: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed write success instead of treating it as committed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ts: "1786712345.001200" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(fetchMock).postMessage({ channel: "C1", text: "once", clientMsgId: "id", unfurlLinks: false, unfurlMedia: false })).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry or sleep after a rate limit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "9" } })) as unknown as typeof fetch;
    await expect(client(fetchMock).authTest()).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back from exact history to replies and selects the requested timestamp", async () => {
    const target = "1786712345.001200";
    const rawMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const call = rawMock.mock.calls.length;
      if (call === 2) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("ts")).toBe(target);
        expect(body.get("oldest")).toBe(target);
        expect(body.get("latest")).toBe(target);
        expect(body.get("inclusive")).toBe("true");
        expect(body.get("limit")).toBe("1");
      }
      return new Response(JSON.stringify(call === 1 ? { ok: true, messages: [] } : { ok: true, messages: [{ ts: target, text: "reply" }], has_more: false, response_metadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const fetchMock = rawMock as unknown as typeof fetch;
    await expect(client(fetchMock).messageByTs("C1", target)).resolves.toMatchObject({ ts: target, text: "reply" });
    expect(rawMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an exact reply lookup still has a continuation", async () => {
    const target = "1786712345.001200";
    const rawMock = vi.fn(async () => {
      const call = rawMock.mock.calls.length;
      return new Response(JSON.stringify(call === 1
        ? { ok: true, messages: [] }
        : { ok: true, messages: [{ ts: "1786712345.001100" }], has_more: true, response_metadata: { next_cursor: "later" } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(client(rawMock as unknown as typeof fetch).messageByTs("C1", target)).rejects.toMatchObject({
      code: "SLACK_RESPONSE_INVALID",
      details: { endpoint: "conversations.replies", continuation_present: true },
    });
    expect(rawMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["history", (slack: PublicSlackClient) => slack.history({ channel: "C1", oldest: "1", latest: "2", limit: 50 })],
    ["replies", (slack: PublicSlackClient) => slack.replies({ channel: "C1", ts: "1786712345.001200", limit: 50 })],
  ])("preserves a valid %s continuation", async (_kind, operation) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: [{ ts: "1786712345.001200" }], has_more: true, response_metadata: { next_cursor: "next-page" } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(operation(client(fetchMock))).resolves.toEqual({ items: [{ ts: "1786712345.001200" }], next: "next-page", complete: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("implements history as [oldest, latest) without dropping the exact oldest timestamp", async () => {
    const oldest = "1786712345.001200";
    const latest = "1786712400.000000";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("oldest")).toBe("1786712345.001199");
      expect(body.get("latest")).toBe(latest);
      expect(body.get("inclusive")).toBe("false");
      return new Response(JSON.stringify({ ok: true, messages: [{ ts: oldest, text: "at lower bound" }], has_more: false, response_metadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(client(fetchMock).history({ channel: "C1", oldest, latest, limit: 50 })).resolves.toEqual({
      items: [{ ts: oldest, text: "at lower bound" }],
      complete: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["history", (slack: PublicSlackClient) => slack.history({ channel: "C1", oldest: "1", latest: "2", limit: 50 })],
    ["replies", (slack: PublicSlackClient) => slack.replies({ channel: "C1", ts: "1786712345.001200", limit: 50 })],
  ])("rejects %s has_more without a usable continuation cursor", async (kind, operation) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: [{ ts: "1786712345.001200" }], has_more: true, response_metadata: {} }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(operation(client(fetchMock))).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID", details: { endpoint: `conversations.${kind}`, has_more: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["message", (slack: PublicSlackClient) => slack.searchMessages("hello", 20), { ok: true, messages: { matches: [] } }],
    ["file", (slack: PublicSlackClient) => slack.searchFiles("hello", 20), { ok: true, files: { matches: [] } }],
  ])("rejects a search.%s success without authoritative totals", async (_kind, search, body) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(search(client(fetchMock))).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an authoritative empty search collection", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: { matches: [], total: 0, paging: { pages: 0 } } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(fetchMock).searchMessages("nothing", 20)).resolves.toEqual({ items: [], total: 0, pages: 0 });
  });

  it("rejects a successful permalink response without a permalink", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(fetchMock).permalink("C1", "1786712345.001200")).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts only the requested message path on a Slack workspace permalink host", async () => {
    const permalink = "https://acme.slack.com/archives/C1/p1786712345001200?thread_ts=1786712300.000100&cid=C1";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, permalink }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(client(fetchMock).permalink("C1", "1786712345.001200")).resolves.toBe(permalink);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    "https://evil.example/archives/C1/p1786712345001200",
    "https://files.slack.com/archives/C1/p1786712345001200",
    "https://acme.slack.com/archives/C2/p1786712345001200",
    "https://acme.slack.com/archives/C1/p1786712346001200",
    "https://acme.slack.com:444/archives/C1/p1786712345001200",
  ])("rejects an unsafe or mismatched provider permalink: %s", async (permalink) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, permalink }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await expect(client(fetchMock).permalink("C1", "1786712345.001200")).rejects.toMatchObject({ code: "SLACK_URL_INVALID" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requires unread semantics for the user-token inbox probe", async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ ok: true, channel: { id: "C1", is_ext_shared: false } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(missing).conversationInboxInfo("C1")).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });

    const empty = vi.fn(async () => new Response(JSON.stringify({ ok: true, channel: { id: "C1", unread_count_display: 0, is_ext_shared: false } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(empty).conversationInboxInfo("C1")).resolves.toMatchObject({ id: "C1", unread_count_display: 0 });
  });

  it.each([
    ["users.list", (slack: PublicSlackClient) => slack.listUsers(), { ok: true, members: [{ id: "U1" }], response_metadata: { next_cursor: "" } }],
    ["users.conversations", (slack: PublicSlackClient) => slack.listConversations(), { ok: true, channels: [{ id: "C1" }], response_metadata: { next_cursor: "" } }],
    ["usergroups.list", (slack: PublicSlackClient) => slack.listUsergroups(), { ok: true, usergroups: [{ id: "S1" }] }],
    ["search.files", (slack: PublicSlackClient) => slack.searchFiles("x", 20), { ok: true, files: { matches: [{ id: "F1" }], total: 1, paging: { pages: 1 } } }],
    ["files.info", (slack: PublicSlackClient) => slack.fileInfo("F1"), { ok: true, file: { id: "F1" } }],
  ])("rejects semantically incomplete %s objects", async (_method, operation, body) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(operation(client(fetchMock))).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
  });

  it("rejects a paged collection without continuation metadata", async () => {
    const user = { id: "U1", name: "filip", deleted: false, is_bot: false, profile: { display_name: "Filip", real_name: "Filip" } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, members: [user] }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(fetchMock).listUsers()).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
  });

  it.each([
    [{ ok: true, message: { reactions: "changed" } }, "reactions.get", (slack: PublicSlackClient) => slack.reactions("C1", "1786712345.001200")],
    [{ ok: true, message: { reactions: [{ name: "eyes", count: 1 }] } }, "reactions.get users", (slack: PublicSlackClient) => slack.reactions("C1", "1786712345.001200")],
    [{ ok: true, channel: { id: "C1" } }, "conversations.info last_read", (slack: PublicSlackClient) => slack.conversationReadState("C1")],
  ])("rejects malformed reconciliation evidence from %s", async (body, _label, operation) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(operation(client(fetchMock))).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
  });

  it.each([
    ["missing", undefined],
    ["string", "1"],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
  ])("rejects a %s reaction count instead of emitting non-authoritative output", async (_label, count) => {
    const reaction = { name: "eyes", users: ["U1"], ...(count === undefined ? {} : { count }) };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, message: { reactions: [reaction] } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const error = await client(fetchMock).reactions("C1", "1786712345.001200").catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
    const envelope = toErrorEnvelope(error).envelope;
    expect(decode(serialize(envelope, "toon"), { strict: true })).toEqual(JSON.parse(serialize(envelope, "json")));
  });

  it("preserves authoritative reaction evidence", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, message: { reactions: [{ name: "eyes", count: 0, users: [] }] } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(fetchMock).reactions("C1", "1786712345.001200")).resolves.toEqual({ reactions: [{ name: "eyes", count: 0, users: [] }] });
  });

  it("rejects malformed reactions embedded in message collections", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, messages: [{ ts: "1786712345.001200", reactions: [{ name: "eyes", users: ["U1"] }] }], has_more: false, response_metadata: {} }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(client(fetchMock).history({ channel: "C1", oldest: "1", latest: "2", limit: 50 })).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
  });
});
