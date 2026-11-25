import { decode } from "@toon-format/toon";
import { describe, expect, it, vi } from "vitest";
import type { SlkyApp } from "../src/app.js";
import { createProgram } from "../src/cli.js";
import { messageRichFields } from "../src/rich-content.js";

const ts = "1786712345.001200";
const ref = `T1/C1/${ts}`;

const card = {
  ts, user: "U1", text: "", reply_count: 1,
  blocks: [
    { type: "section", text: { type: "mrkdwn", text: "Build failed" },
      fields: [{ type: "plain_text", text: "Service: checkout" }] },
    { type: "rich_text", elements: [{ type: "rich_text_list", elements: [
      { type: "rich_text_section", elements: [{ type: "text", text: "Error " }, { type: "text", text: "E42" }] },
    ] }] },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "View job" }, url: "https://example.com/job", value: "opaque" }] },
    { type: "future_widget", value: "unreadable" },
  ],
  files: [{ id: "F1", name: "build.log" }],
  reactions: [{ name: "eyes", count: 1, users: ["U1"] }],
};

function appWithCard() {
  const searchMessages = vi.fn(async () => ({ items: [{ ts, text: "Build failed", channel_id: "C1" }], total: 1, pages: 1 }));
  const messageByTs = vi.fn(async () => card);
  const slack = {
    history: async () => ({ items: [card], complete: true }),
    replies: async () => ({ items: [card], complete: true }),
    messageByTs, searchMessages, permalink: async () => "https://acme.slack.com/archives/C1/p1786712345001200",
  };
  const app = { context: async () => ({
    profile: { team_id: "T1", actor_id: "U1", kind: "user_token", alias: "work", timezone: "UTC" },
    conversations: [{ id: "C1", name: "general" }], userMap: new Map(), users: [],
    snapshot: { credential_generation: "v1", coverage: { users: { complete: true }, conversations: { complete: true } } },
    public: slack,
  }) } as unknown as SlkyApp;
  return { app, messageByTs, searchMessages };
}

async function run(app: SlkyApp, args: string[], format = "json") {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((data) => { chunks.push(String(data)); return true; });
  try {
    await createProgram(app).parseAsync(["node", "slky", "--output", format, ...args]);
  } finally {
    write.mockRestore();
  }
  const output = chunks.join("");
  return (format === "json" ? JSON.parse(output) : decode(output)) as Record<string, any>;
}

describe("rich message content", () => {
  it("returns compact previews for cards with empty fallback text and expands files, reactions and visible card data together", async () => {
    const { app } = appWithCard();
    const compact = await run(app, ["read", "C1"]);
    expect(compact.data.messages[0]).toMatchObject({ has_rich_content: true, text: "", rich_preview: expect.stringContaining("Error E42") });
    expect(compact.data.messages[0]).not.toHaveProperty("rich_content");
    const expanded = await run(app, ["thread", ref, "--full"]);
    expect(expanded.data.messages[0]).toMatchObject({
      rich_content: { text: "Build failed\nService: checkout\nError E42\nView job https://example.com/job", truncated: false, unsupported_types: ["future_widget"] },
      files: [{ id: "F1", name: "build.log" }], reactions: [{ name: "eyes", count: 1, mine: true }],
    });
  });

  it.each([["read", "C1", "--on", "2026-08-14"], ["thread", ref], ["message", "get", ref]])("projects actual message rows in JSON and TOON for %s", async (...args) => {
    const { app } = appWithCard();
    const options = [...args, "--fields", "ref,rich_content"];
    const json = await run(app, options);
    expect(await run(app, options, "toon")).toEqual(json);
    const row = json.data.message ?? json.data.messages[0];
    expect(Object.keys(row).sort()).toEqual(["ref", "rich_content"]);
    expect(row.ref).toBe(ref);
    expect(row.rich_content.text).toContain("Service: checkout");
  });

  it("reads legacy attachment-only fields and keeps fallback text compact alongside rich content", () => {
    const attachments = [{ title: "Service", fields: [{ title: "checkout", value: "failure" }], fallback: "duplicate" }];
    expect(messageRichFields({ attachments }, true).rich_content).toEqual({ text: "Service\ncheckout: failure", truncated: false, unsupported_types: [] });
    expect(messageRichFields({ attachments, text: "Alert" }, false)).toEqual({ has_rich_content: true });
  });

  it("bounds Unicode text, node count, and nesting depth", () => {
    const emoji = "🪐";
    const large = { blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: emoji.repeat(9000) }] }] }] };
    expect(messageRichFields(large, false).rich_preview).toBe(emoji.repeat(220) + "…");
    expect(messageRichFields(large, true).rich_content).toMatchObject({ text: emoji.repeat(4096), truncated: true });
    expect(messageRichFields({ blocks: Array(257).fill({ type: "divider" }) }, true).rich_content?.truncated).toBe(true);
    let nested: Record<string, unknown> = { type: "text", text: "bottom" };
    for (let i = 0; i < 20; i++) nested = { type: "rich_text_list", elements: [nested] };
    expect(messageRichFields({ blocks: [nested, { type: "text", text: "tail" }] }, true).rich_content).toMatchObject({ text: "tail", truncated: true });
  });

  it("gives a fallback-only search hit its exact scoped detail command without fetching the message", async () => {
    const { app, messageByTs, searchMessages } = appWithCard();
    const result = await run(app, ["search", "messages", "failed", "--fields", "ref,detail_command"]);
    expect(result.data.messages).toEqual([{ ref, detail_command: `slky message get ${ref} --full --workspace work` }]);
    expect(searchMessages).toHaveBeenCalledOnce();
    expect(messageByTs).not.toHaveBeenCalled();
  });
});
