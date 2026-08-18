import { describe, expect, it } from "vitest";
import { normalizeMessage, resolveConversation, resolveUser } from "../src/domain.js";
import { resolveTimeRange } from "../src/time.js";
import type { Conversation, User } from "../src/types.js";

const users: User[] = [
  { id: "U1", name: "alice", display_name: "Alice", real_name: "Alice A", is_bot: false, deleted: false },
  { id: "U2", name: "alicia", display_name: "Alice B", real_name: "Alicia", is_bot: false, deleted: false },
];
const conversations: Conversation[] = [
  { id: "C1", name: "eng", type: "channel", is_private: false, is_member: true, is_archived: false },
  { id: "D1", name: "U1", type: "dm", is_private: true, is_member: true, is_archived: false, member_ids: ["U1"] },
];

describe("time ranges", () => {
  it("uses half-open relative ranges", () => {
    const now = new Date("2026-08-15T12:00:00Z");
    const range = resolveTimeRange({ since: "24h", timezone: "UTC", now });
    expect(range.from.toISOString()).toBe("2026-08-14T12:00:00.000Z");
    expect(range.to).toEqual(now);
  });

  it("honors DST for a calendar day", () => {
    const range = resolveTimeRange({ on: "2026-03-08", timezone: "America/New_York" });
    expect(range.to.getTime() - range.from.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("rejects conflicting selectors", () => {
    expect(() => resolveTimeRange({ since: "1h", from: "2026-01-01", timezone: "UTC" })).toThrowError(/only one/i);
  });

  it.each(["0h", "999999999999999999999999999999w"])("rejects invalid or overflowing relative duration %s", (since) => {
    expect(() => resolveTimeRange({ since, timezone: "UTC" })).toThrowError(/positive duration/i);
  });

  it("rejects invalid calendar dates and ambiguous or nonexistent local times", () => {
    expect(() => resolveTimeRange({ on: "2026-02-30", timezone: "UTC" })).toThrowError(/valid calendar date/i);
    expect(() => resolveTimeRange({ from: "2026-03-08T02:30:00", to: "2026-03-08T04:00:00", timezone: "America/New_York" })).toThrowError(/unambiguous/i);
    expect(() => resolveTimeRange({ from: "2026-11-01T01:30:00", to: "2026-11-01T03:00:00", timezone: "America/New_York" })).toThrowError(/unambiguous/i);
  });

  it("accepts an explicit compatible offset for a DST fold", () => {
    const range = resolveTimeRange({ from: "2026-11-01T01:30:00-04:00", to: "2026-11-01T02:30:00-05:00", timezone: "America/New_York" });
    expect(range.to.getTime() - range.from.getTime()).toBe(2 * 60 * 60 * 1000);
  });
});

describe("normalization and resolution", () => {
  it("truncates previews by Unicode character and summarizes threads", () => {
    const item = normalizeMessage({ ts: "1786712345.001200", user: "U1", text: "🙂".repeat(601), reply_count: 2, reply_users: ["U1"], reactions: [{ name: "eyes", count: 1, users: ["U1"] }] }, "T1", "C1", new Map(users.map((user) => [user.id, user])), false, "U1");
    expect(item.text_chars).toBe(601);
    expect(item.text_truncated).toBe(true);
    expect(item.thread?.replies).toBe(2);
    expect(item.reactions?.[0]?.mine).toBe(true);
  });

  it("resolves IDs, channel names, and DMs while rejecting ambiguity", () => {
    expect(resolveConversation("#eng", conversations, users).id).toBe("C1");
    expect(resolveConversation("@alice", conversations, users).id).toBe("D1");
    expect(resolveUser("U2", users).name).toBe("alicia");
    expect(() => resolveUser("ali", users)).toThrowError(/ambiguous/i);
  });

  it("does not claim not-found or a partial user match from incomplete caches", () => {
    expect(() => resolveUser("ali", users, false)).toThrowError(/cannot be resolved conclusively/i);
    expect(() => resolveConversation("#missing", conversations, users, false, true)).toThrowError(/cannot be resolved conclusively/i);
  });

  it("resolves stable handles but not display names from an incomplete user cache", () => {
    const partialUsers: User[] = [
      { id: "U3", name: "alice.handle", display_name: "Alice", real_name: "Alice Example", email: "alice@example.com", is_bot: false, deleted: false },
    ];
    expect(resolveUser("@alice.handle", partialUsers, false).id).toBe("U3");
    expect(() => resolveUser("@Alice", partialUsers, false)).toThrowError(/cannot be resolved conclusively/i);
    expect(() => resolveUser("alice@example.com", partialUsers, false)).toThrowError(/cannot be resolved conclusively/i);
  });
});
