import { describe, expect, it, vi } from "vitest";
import type { SlackAxiApp } from "../src/app.js";
import { createProgram } from "../src/cli.js";
import { PublicSlackClient } from "../src/slack-public.js";

function fixture(browserMode = true, complete = true) {
  const conversations = Array.from({ length: 55 }, (_, index) => ({
    id: `C${index}`, name: `a-${String(index).padStart(2, "0")}`, type: "channel", is_archived: false,
  }));
  conversations.push({ id: "C99", name: "z-release", type: "channel", is_archived: false });
  const history = vi.fn(async (_options: { channel: string; retry?: boolean }) => ({ items: [], complete: true }));
  const counts = vi.fn(async () => ({
    channels: [
      { id: "C1", latest: "1786712345.000001", has_unreads: true },
      { id: "C8", latest: "1786712345.000001", has_unreads: false },
      { id: "C99", latest: "1786712345.000002", has_unreads: false },
    ],
    ims: [],
    mpims: [],
    thread_coverage: "missing",
  }));
  const context = {
    profile: { alias: "work", team_id: "T1", actor_id: "U1", kind: browserMode ? "browser" : "user_token", timezone: "UTC" },
    conversations,
    users: [],
    userMap: new Map(),
    snapshot: {
      conversations: [] as Record<string, unknown>[],
      coverage: { conversations: { complete }, users: { complete: true } },
    },
    public: { history },
    ...(browserMode ? { browser: { counts } } : {}),
  };
  const app = { async context() { return context; } } as unknown as SlackAxiApp;
  async function run(...args: string[]) {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram(app).parseAsync(["node", "slack-axi", "--output", "json", "catchup", ...args]);
      return JSON.parse(String(write.mock.calls[0]?.[0]));
    } finally {
      write.mockRestore();
    }
  }
  return { run, history, counts, context };
}

describe("catchup conversation selection", () => {
  it("uses latest activity even after the newest conversation has been read", async () => {
    const { run, history, counts } = fixture();
    const envelope = await run();
    expect(counts).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledTimes(20);
    expect(history.mock.calls.slice(0, 4).map(([value]) => value.channel)).toEqual(["C99", "C1", "C8", "C0"]);
    expect(envelope.data).toMatchObject({
      selection: { method: "recent_activity", conversation_cache_complete: true, activity_timestamps: { browser_counts: 3, conversation_cache: 0, unknown: 53 } },
      totals: { eligible: 56, scanned: 20, omitted: 36 },
    });
    expect(envelope.data.conversations[0].conversation.id).toBe("C99");
  });

  it("resolves explicit names across the cache and deduplicates name and ID", async () => {
    const { run, history, counts } = fixture();
    const envelope = await run("--conversation", "#z-release", "--conversation", "C99", "--conversation", "#a-00", "--max-conversations", "2");
    expect(counts).not.toHaveBeenCalled();
    expect(history.mock.calls.map(([value]) => value.channel)).toEqual(["C99", "C0"]);
    expect(envelope.data).toMatchObject({ selection: { method: "explicit" }, totals: { eligible: 2, scanned: 2, omitted: 0 } });
  });

  it("rejects ambiguous and over-budget selections before any history read", async () => {
    const { run, history, context } = fixture();
    await expect(run("--conversation", "C1", "--conversation", "C2", "--max-conversations", "1")).rejects.toMatchObject({ code: "CATCHUP_SELECTION_EXCEEDS_LIMIT" });
    context.conversations.push({ id: "C100", name: "a-00", type: "channel", is_archived: false });
    await expect(run("--conversation", "#a-00")).rejects.toMatchObject({ code: "CONVERSATION_AMBIGUOUS" });
    expect(history).not.toHaveBeenCalled();
  });

  it("reports partial cache coverage and falls back to names where activity is absent", async () => {
    const { run, history, context } = fixture(false, false);
    const first = await run("--max-conversations", "1");
    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "C0" }));
    expect(first.data.selection).toEqual({
      method: "alphabetical",
      conversation_cache_complete: false,
      activity_timestamps: { browser_counts: 0, conversation_cache: 0, unknown: 56 },
    });
    context.snapshot.conversations.push({ id: "C99", latest: { ts: "1786712345.000002" } });
    const second = await run("--max-conversations", "1");
    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "C99" }));
    expect(second.data.selection.activity_timestamps).toEqual({ browser_counts: 0, conversation_cache: 1, unknown: 55 });
  });

  it("uses one transport attempt per selected history even on a retryable failure", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream", { status: 503 }));
    const slack = new PublicSlackClient("xoxp-fixture", { fetch: fetchMock });
    await expect(slack.history({ channel: "C1", oldest: "1", latest: "2", limit: 1, retry: false })).rejects.toMatchObject({ code: "SLACK_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
