import { describe, expect, it, vi } from "vitest";
import { BrowserSlackClient } from "../src/slack-browser.js";

function client(fetchMock: typeof fetch, baseUrl = "https://acme.slack.com/api"): BrowserSlackClient {
  return new BrowserSlackClient("xoxc-test", "xoxd-test%2Fsession%3D", { baseUrl, fetch: fetchMock });
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const laterItem = {
  item_id: "C1",
  item_type: "message",
  ts: "1786712345.001200",
  state: "saved",
  date_created: 1,
  date_due: 0,
  date_completed: 0,
  date_updated: 1,
  is_archived: false,
  date_snoozed_until: 0,
};

describe("browser capability transport", () => {
  it("normalizes unread counts and sends the browser pair only to the fixed API endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://acme.slack.com/api/client.counts");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe("d=xoxd-test%2Fsession%3D");
      expect(headers.get("authorization")).toBeNull();
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("token")).toBe("xoxc-test");
      expect(body.get("_x_reason")).toBe("client-counts-api/fetchClientCounts");
      expect(body.get("thread_counts_by_channel")).toBe("true");
      expect(body.get("include_file_channels")).toBe("true");
      return json({
        ok: true,
        channels: [{ id: "C1", last_read: "1786712000.000001", latest: "1786713000.000001", mention_count: 2, has_unreads: true }],
        mpims: [],
        ims: [],
      });
    }) as unknown as typeof fetch;

    const slack = client(fetchMock);
    await expect(slack.counts()).resolves.toEqual({
      channels: [{ id: "C1", last_read: "1786712000.000001", latest: "1786713000.000001", mention_count: 2, has_unreads: true }],
      mpims: [],
      ims: [],
    });
    expect(slack.backendCalls).toBe(1);
  });

  it.each([
    "http://acme.slack.com/api",
    "https://evil.example/api",
    "https://api.slack.com/api",
    "https://files.slack.com/api",
    "https://acme.slack.com:444/api",
    "https://user:pass@acme.slack.com/api",
    "https://acme.slack.com/api/client.counts",
    "https://acme.slack.com/api?next=evil",
    "https://acme.slack.com/api#fragment",
  ])("rejects a noncanonical browser API base before dispatch: %s", (baseUrl) => {
    expect(() => client(vi.fn() as unknown as typeof fetch, baseUrl)).toThrowError(expect.objectContaining({ code: "SLACK_URL_INVALID" }));
  });

  it("accepts a multi-label Enterprise Grid workspace host", () => {
    expect(() => client(vi.fn() as unknown as typeof fetch, "https://corp.enterprise.slack.com/api")).not.toThrow();
  });

  it.each([
    ["xoxp-not-browser", "xoxd-valid", "AUTH_INVALID"],
    ["xoxc-valid", "not-a-cookie", "AUTH_INVALID"],
    ["xoxc-valid", "xoxd-valid\r\nX-Evil: true", "AUTH_INVALID"],
    ["xoxc-valid", "xoxd-invalid%ZZ", "AUTH_INVALID"],
  ])("rejects an invalid browser credential pair before dispatch", (token, cookie, code) => {
    expect(() => new BrowserSlackClient(token, cookie, { fetch: vi.fn() as unknown as typeof fetch })).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    { ok: true },
    { ok: true, channels: "changed", mpims: [], ims: [] },
    { ok: true, channels: [{ id: "C1", has_unreads: true }], mpims: [], ims: [] },
    { ok: true, channels: [{ id: "C1", mention_count: -1, has_unreads: true }], mpims: [], ims: [] },
  ])("fails closed when client.counts semantics drift", async (body) => {
    const fetchMock = vi.fn(async () => json(body)) as unknown as typeof fetch;
    await expect(client(fetchMock).counts()).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_CHANGED" });
  });

  it.each([
    {},
    { ok: "true" },
    { ok: false, error: 123 },
    { ok: false, error: "invalid_auth\nforged" },
    { ok: true, error: "invalid_arguments", channels: [], mpims: [], ims: [] },
  ])("fails closed on a malformed or contradictory private response envelope", async (body) => {
    const fetchMock = vi.fn(async () => json(body)) as unknown as typeof fetch;
    await expect(client(fetchMock).counts()).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_CHANGED" });
  });

  it("normalizes mute preferences from the encoded private preference", async () => {
    const rawMock = vi.fn(async (_input: RequestInfo | URL) => json({
      ok: true,
      prefs: {
        all_notifications_prefs: JSON.stringify({
          channels: { C2: { muted: true }, C1: { muted: false }, C3: { muted: true } },
        }),
      },
    }));

    await expect(client(rawMock as unknown as typeof fetch).mutedChannels()).resolves.toEqual(["C2", "C3"]);
    expect(String(rawMock.mock.calls[0]?.[0])).toBe("https://acme.slack.com/api/users.prefs.get");
  });

  it.each([
    { ok: true, prefs: {} },
    { ok: true, prefs: { all_notifications_prefs: "not-json" } },
    { ok: true, prefs: { all_notifications_prefs: JSON.stringify({ channels: [] }) } },
    { ok: true, prefs: { all_notifications_prefs: JSON.stringify({ channels: { C1: { muted: "yes" } } }) } },
  ])("fails closed when mute preference semantics drift", async (body) => {
    const fetchMock = vi.fn(async () => json(body)) as unknown as typeof fetch;
    await expect(client(fetchMock).mutedChannels()).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_CHANGED" });
  });

  it("returns bounded Later data and preserves the continuation", async () => {
    const counts = {
      uncompleted_count: 1,
      uncompleted_overdue_count: 0,
      archived_count: 0,
      completed_count: 2,
      total_count: 3,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("limit")).toBe("100");
      expect(body.get("cursor")).toBe("cursor-1");
      expect(body.get("include_tombstones")).toBe("true");
      expect(body.get("include_completed")).toBeNull();
      return json({ ok: true, saved_items: [laterItem], counts, response_metadata: { next_cursor: "cursor-2" } });
    }) as unknown as typeof fetch;

    await expect(client(fetchMock).laterList("cursor-1", 500)).resolves.toEqual({
      items: [laterItem],
      counts,
      next: "cursor-2",
    });
  });

  it.each([
    { ok: true },
    { ok: true, saved_items: [{ ...laterItem, is_archived: undefined }] },
    { ok: true, saved_items: [{ ...laterItem, ts: "not-a-timestamp" }] },
    { ok: true, saved_items: [{ ...laterItem, item_id: "F1" }] },
    { ok: true, saved_items: [{ ...laterItem, item_type: "file" }] },
    { ok: true, saved_items: [{ ...laterItem, state: "renamed" }] },
    { ok: true, saved_items: Array.from({ length: 101 }, () => laterItem) },
    {
      ok: true,
      saved_items: [],
      counts: {
        uncompleted_count: Number.MAX_SAFE_INTEGER + 1,
        uncompleted_overdue_count: 0,
        archived_count: 0,
        completed_count: 0,
        total_count: 0,
      },
    },
  ])("fails closed when saved.list semantics drift", async (body) => {
    const fetchMock = vi.fn(async () => json(body)) as unknown as typeof fetch;
    await expect(client(fetchMock).laterList()).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_CHANGED" });
  });

  it("honors Retry-After without retrying a rate-limited browser call", async () => {
    const fetchMock = vi.fn(async () => json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "9" })) as unknown as typeof fetch;
    await expect(client(fetchMock).laterList()).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 9,
      details: { dispatch_uncertain: false },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["network error", new TypeError("connection reset"), "BROWSER_NETWORK_ERROR"],
    ["timeout", new DOMException("timed out", "TimeoutError"), "REQUEST_TIMEOUT"],
  ])("classifies a read %s as retryable", async (_label, failure, code) => {
    const fetchMock = vi.fn(async () => { throw failure; }) as unknown as typeof fetch;
    await expect(client(fetchMock).counts()).rejects.toMatchObject({
      code,
      retryable: true,
      details: { dispatch_uncertain: false },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends complete Later identity for complete and snooze updates", async () => {
    const rawMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true }));
    const slack = client(rawMock as unknown as typeof fetch);
    await slack.laterComplete("C1", "1786712345.001200");
    await slack.laterSnooze("C2", "1786712346.001201", 1786800000);

    const complete = new URLSearchParams(String(rawMock.mock.calls[0]?.[1]?.body));
    expect(complete.get("item_id")).toBe("C1");
    expect(complete.get("ts")).toBe("1786712345.001200");
    expect(complete.get("item_type")).toBe("message");
    expect(complete.get("mark")).toBe("completed");
    expect(complete.get("state")).toBeNull();
    expect(complete.get("is_archived")).toBeNull();
    const snooze = new URLSearchParams(String(rawMock.mock.calls[1]?.[1]?.body));
    expect(snooze.get("item_id")).toBe("C2");
    expect(snooze.get("ts")).toBe("1786712346.001201");
    expect(snooze.get("date_due")).toBe("1786800000");
    expect(snooze.get("state")).toBeNull();
    expect(snooze.get("is_archived")).toBeNull();
    expect(rawMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["HTTP 500", () => new Response("upstream", { status: 500 }), "BROWSER_CAPABILITY_UNAVAILABLE"],
    ["HTTP 408", () => new Response("timeout", { status: 408 }), "BROWSER_CAPABILITY_UNAVAILABLE"],
    ["non-JSON success", () => new Response("not-json", { status: 200 }), "BROWSER_CAPABILITY_CHANGED"],
    ["malformed error envelope", () => json({ ok: false, error: 123 }), "BROWSER_CAPABILITY_CHANGED"],
    ["contradictory success envelope", () => json({ ok: true, error: "invalid_arguments" }), "BROWSER_CAPABILITY_CHANGED"],
    ["unknown provider error", () => json({ ok: false, error: "new_provider_error" }), "BROWSER_CAPABILITY_UNAVAILABLE"],
  ])("marks a Later write uncertain after an ambiguous %s response", async (_label, response, code) => {
    const fetchMock = vi.fn(async () => response()) as unknown as typeof fetch;
    await expect(client(fetchMock).laterComplete("C1", "1786712345.001200")).rejects.toMatchObject({
      code,
      retryable: false,
      details: { dispatch_uncertain: true },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not mark an authoritative Later rejection uncertain", async () => {
    const fetchMock = vi.fn(async () => json({ ok: false, error: "invalid_arguments" })) as unknown as typeof fetch;
    await expect(client(fetchMock).laterComplete("C1", "1786712345.001200")).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNAVAILABLE",
      retryable: false,
      details: { slack_error: "invalid_arguments", dispatch_uncertain: false },
    });
  });

  it("marks a write-side network failure uncertain and never retries it", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("connection reset"); }) as unknown as typeof fetch;
    await expect(client(fetchMock).laterSnooze("C1", "1786712345.001200", 1786800000)).rejects.toMatchObject({
      code: "BROWSER_NETWORK_ERROR",
      retryable: false,
      details: { dispatch_uncertain: true },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
