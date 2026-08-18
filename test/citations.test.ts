import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@toon-format/toon";
import { createProgram } from "../src/cli.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";

afterEach(() => vi.restoreAllMocks());

const longText = "🙂".repeat(700);
const messageRef = "T1/C1/1786712345.001200";
const missingRef = "T1/C1/1786712346.001200";
const anonymousTs = "1786712347.001200";
const anonymousRef = `T1/C1/${anonymousTs}`;
const hostilePermalink = `https://acme.slack.com/archives/C1/p${anonymousTs.replace(".", "")}?thread_ts=$(printf%20pwned)\`printf%20pwned\``;

function citationApp(options: { displayName?: string; permalink?: string } = {}): SlackAxiApp {
  const context = {
    profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
    public: {
      async messageByTs(_channel: string, ts: string) {
        if (ts === "1786712345.001200") return { ts, user: "U1", text: longText };
        if (ts === anonymousTs) return { ts, text: longText };
        return undefined;
      },
      async permalink(_channel: string, ts: string) { return options.permalink ?? `https://acme.slack.com/archives/C1/p${ts.replace(".", "")}`; },
    },
    snapshot: {},
    conversations: [],
    users: [],
    userMap: new Map([["U1", { id: "U1", name: "filip", display_name: options.displayName ?? "Filip", real_name: "Filip", is_bot: false, deleted: false }]]),
  } as unknown as WorkspaceContext;
  return { async context() { return context; } } as unknown as SlackAxiApp;
}

async function citeOutput(args: string[], format: "json" | "toon", app = citationApp()): Promise<string> {
  let output = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { output += String(chunk); return true; });
  try {
    await createProgram(app).parseAsync(["node", "slack-axi", "--output", format, ...args]);
    return output;
  } finally {
    write.mockRestore();
  }
}

async function runCite(args: string[], app = citationApp()): Promise<Record<string, any>> {
  return JSON.parse(await citeOutput(args, "json", app)) as Record<string, any>;
}

describe("message citation previews", () => {
  it("bounds citation text by default and preserves partial-success coverage", async () => {
    const envelope = await runCite(["message", "cite", messageRef, missingRef]);
    const citation = envelope.data.citations[0];
    expect(Array.from(citation.text)).toHaveLength(601);
    expect(citation).toMatchObject({ ref: messageRef, author: "Filip", text_chars: 700, text_truncated: true });
    expect(envelope.data.failed).toMatchObject([{ ref: missingRef, code: "MESSAGE_NOT_FOUND" }]);
    expect(envelope).toMatchObject({
      page: { shown: 1, total: 2, complete: false, source_complete: false },
      coverage: { requested: 2, scanned: 2, failed: 1, complete: false },
    });
    expect(envelope.hints[0].command).toContain("--full");
  });

  it("returns complete citation text only when --full is explicit", async () => {
    const envelope = await runCite(["--full", "message", "cite", messageRef]);
    expect(envelope.data.citations[0]).toMatchObject({ text: longText, text_chars: 700, text_truncated: false });
    expect(envelope.hints).toBeUndefined();
  });

  it("keeps JSON and strict TOON equivalent when a citation has no author and safely quotes hostile permalink hints", async () => {
    const json = JSON.parse(await citeOutput(["message", "cite", hostilePermalink], "json")) as Record<string, any>;
    const toon = decode(await citeOutput(["message", "cite", hostilePermalink], "toon"), { strict: true });

    expect(toon).toEqual(json);
    expect(json.data.citations[0]).toMatchObject({ ref: anonymousRef, markdown: expect.stringContaining("[Slack in C1") });
    expect(json.data.citations[0]).not.toHaveProperty("author");
    expect(json.hints[0].command).toBe(`slack-axi message cite '${hostilePermalink}' --full --workspace work`);
  });

  it("escapes Slack-controlled author text and wraps the validated permalink as a Markdown destination", async () => {
    const displayName = "Mallory](https://evil.example)\n[continue\\";
    const permalink = "https://acme.slack.com/archives/C1/p1786712345001200?thread_ts=1786712300.000100&cid=C1";
    const envelope = await runCite(["message", "cite", messageRef], citationApp({ displayName, permalink }));
    const citation = envelope.data.citations[0];

    expect(citation.author).toBe(displayName);
    expect(citation.permalink).toBe(permalink);
    expect(citation.markdown).toBe(
      "[Mallory\\](https://evil.example) \\[continue\\\\ in C1 at 2026-08-14T12:59:05.000Z](<https://acme.slack.com/archives/C1/p1786712345001200?thread_ts=1786712300.000100&cid=C1>)",
    );
  });
});
