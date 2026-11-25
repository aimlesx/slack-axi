import { describe, expect, it, vi } from "vitest";
import type { SlkyApp } from "../src/app.js";
import type { CacheSnapshot } from "../src/cache.js";
import { createProgram } from "../src/cli.js";
import { entityMaps, normalizeMessage } from "../src/domain.js";

const ts = "1786712345.001200";
const ref = `T1/C1/${ts}`;
const users = [
  { id: "U2", team_id: "T1", profile: { display_name: "Sam" } },
  { id: "U3", team_id: "T2", profile: { display_name: "Sam" } },
  { id: "U4", team_id: "T1", is_bot: true },
  { id: "U5", team_id: "T2", enterprise_user: { enterprise_id: "E1", teams: ["T2", "T1"] } },
  { id: "U6", team_id: "T2", enterprise_user: { enterprise_id: "E1", teams: ["T2", "T3"] } },
  { id: "U7", team_id: "T1", enterprise_user: { teams: ["T2", "T3"] } },
];

function fixtures(cachedUsers: Record<string, unknown>[] = users) {
  const snapshot = {
    users: cachedUsers,
    conversations: [
      { id: "C1", name: "shared", is_ext_shared: true },
      { id: "C2", name: "local", is_ext_shared: false },
    ],
    coverage: { conversations: { complete: true }, users: { complete: false } },
  } as unknown as CacheSnapshot;
  const shared = [
    { user: "U2", ts, text: "Agreed", reply_count: 2 },
    { user: "U3", ts: "1786712345.001201", text: "Confirmed" },
    { user: "U4", ts: "1786712345.001202", text: "Forwarded from Sam in support" },
  ];
  const local = [{ user: "U99", ts, text: "I work here" }];
  const userInfo = vi.fn(() => { throw new Error("unexpected directory lookup"); });
  const ctx = {
    ...entityMaps(snapshot),
    snapshot,
    profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
    public: {
      userInfo,
      async history({ channel }: { channel: string }) { return { items: channel === "C1" ? shared : local, complete: true }; },
      async replies() { return { items: shared, complete: true }; },
      async messageByTs() { return shared[0]; },
      async permalink() { return "https://fixture.slack.com/archives/C1/p1786712345001200"; },
      async searchMessages() {
        const items = [{ ...shared[1], channel: { id: "C1" } }, { ...local[0], channel: { id: "C2" } }];
        return { items, total: items.length, pages: 1 };
      },
    },
  };
  const app = { async context() { return ctx; } } as unknown as SlkyApp;
  return { app, ctx, userInfo };
}

async function run(app: SlkyApp, args: string[]) {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { chunks.push(String(chunk)); return true; });
  try {
    await createProgram(app).parseAsync(["node", "slky", "--output", "json", ...args]);
    return JSON.parse(chunks.join(""));
  } finally {
    write.mockRestore();
  }
}

describe("per-message author origin", () => {
  it.each<[Record<string, unknown>, string]>([
    [{ user: "U1" }, "self"],
    [{ user: "U1", team: "T2" }, "unknown"],
    [{ user: "U2" }, "same_workspace"],
    [{ user: "U3" }, "other_workspace"],
    [{ user: "U4" }, "app_or_bot"],
    [{ subtype: "bot_message", text: "signed, U1" }, "app_or_bot"],
    [{ user: "U1", app_id: "A123" }, "unknown"],
    [{ user: "U5", team: "T2" }, "same_workspace"],
    [{ user: "U6", team: "T2" }, "other_workspace"],
    [{ user: "U7" }, "unknown"],
    [{ user: "U2", team: "T2" }, "unknown"],
    [{ user: "U8", team: "T1", user_team: "T2" }, "unknown"],
    [{ user: "U8", user_team: "T2" }, "other_workspace"],
    [{ user: "U8", user_profile: { id: "U8", team: "T1" } }, "same_workspace"],
    [{ user: "U3", user_profile: { id: "U8", team: "T2" } }, "unknown"],
    [{ username: "Sam", text: "U2", team: "T1" }, "unknown"],
    [{ user: "U8", channel: { is_ext_shared: false, context_team_id: "T1" } }, "unknown"],
  ])("classifies %j as %s", (raw, expected) => {
    const { ctx } = fixtures();
    expect(normalizeMessage({ ts, ...raw }, "T1", "C1", ctx.userMap, false, "U1").author_origin).toBe(expected);
  });

  it("leaves conflicting directory rows unresolved in either scan order", () => {
    const first = { id: "U2", team_id: "T1" };
    const second = { id: "U2", team_id: "T2" };
    for (const rows of [[first, second], [second, first, second]]) {
      const { ctx } = fixtures(rows);
      expect(normalizeMessage({ ts, user: "U2" }, "T1", "C1", ctx.userMap).author_origin).toBe("unknown");
    }
  });

  it("projects each shared timeline and thread row, and each hit's own conversation", async () => {
    const { app, userInfo } = fixtures();
    for (const args of [["read", "C1"], ["thread", ref]]) {
      const result = await run(app, [...args, "--fields", "author_origin"]);
      expect(result.data.messages).toEqual([
        { author_origin: "same_workspace" }, { author_origin: "other_workspace" }, { author_origin: "app_or_bot" },
      ]);
    }
    const search = await run(app, ["search", "messages", "agreement", "--fields", "ref,author_origin"]);
    expect(search.data.messages).toEqual([
      { ref: "T1/C1/1786712345.001201", author_origin: "other_workspace" },
      { ref: `T1/C2/${ts}`, author_origin: "unknown" },
    ]);
    expect(userInfo).not.toHaveBeenCalled();
  });

  it("projects catchup preview rows in their conversation and labels cold-cache citations and detail", async () => {
    const { app, userInfo } = fixtures([]);
    const catchup = await run(app, ["catchup", "--fields", "id,author_origin"]);
    expect(catchup.data.conversations).toEqual([
      { conversation: { id: "C2" }, messages: [{ author_origin: "unknown" }] },
      { conversation: { id: "C1" }, messages: Array(3).fill({ author_origin: "unknown" }) },
    ]);
    const previews = await run(app, ["catchup", "--fields", "messages"]);
    expect(previews.data.conversations[0].messages[0]).toMatchObject({ text: "I work here", author_origin: "unknown" });
    const get = await run(app, ["message", "get", ref, "--fields", "author_origin"]);
    expect(get.data.message).toEqual({ author_origin: "unknown" });
    const cite = await run(app, ["message", "cite", ref, "--fields", "author_origin"]);
    expect(cite.data.citations).toEqual([{ author_origin: "unknown" }]);
    expect(userInfo).not.toHaveBeenCalled();
  });
});
