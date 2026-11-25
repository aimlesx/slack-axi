import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const fixture = path.resolve("test/fixtures/claude-discovery.mjs");
const skill = path.resolve("skills/slack-axi");
const ref = "T100/C101/1795502711.000042";
const permalink = "https://orchid-fixture.slack.com/archives/C101/p1795502711000042";
const searchPrompt = "Find the Slack discussion about the Orchid rollout. What decision did the team make? Please link the decision.";
const draftPrompt = "Please prepare a Slack reply in the Orchid rollout decision thread saying we will coordinate the Lisbon pilot. Leave it as a draft.";

describe("Claude Code discovery", () => {
  let directory: string;
  let project: string;
  let state: string;
  let executable: string;
  let environment: { SLACK_AXI_FIXTURE_DIR: string; PATH: string };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "axi-claude-"));
    project = path.join(directory, "project");
    state = path.join(directory, "state");
    const bin = path.join(directory, "bin");
    executable = path.join(bin, "slack-axi");
    const skills = path.join(project, ".claude", "skills");
    await Promise.all([mkdir(skills, { recursive: true }), mkdir(bin), mkdir(state)]);
    await Promise.all([symlink(fixture, executable), symlink(skill, path.join(skills, "slack-axi"))]);
    environment = { SLACK_AXI_FIXTURE_DIR: state, PATH: bin + path.delimiter + process.env.PATH };
    await writeFile(path.join(project, ".claude", "settings.local.json"), JSON.stringify({ env: environment }));
  });

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function cli(...args: string[]) {
    const { stdout } = await execute(executable, ["--output", "json", ...args], {
      cwd: project, env: { ...process.env, ...environment },
    });
    return JSON.parse(stdout).data;
  }
  async function events(): Promise<Array<{ method?: string; argv?: string[] }>> {
    const log = await readFile(path.join(state, "events.jsonl"), "utf8");
    return log.trimEnd().split("\n").map((line) => JSON.parse(line));
  }
  async function providerCalls() {
    return (await events()).flatMap((event) => event.method ? [event.method] : []);
  }
  async function verifyDraft() {
    const { actions } = await cli("action", "list");
    expect(actions).toHaveLength(1);
    // action show reads back both signed plan and state through the actual store.
    const { action } = await cli("action", "show", actions[0].id);
    expect(action).toMatchObject({
      state: "planned", workspace_id: "T100", operation: "message.reply", target_ids: ["C101", "1795502711.000042"],
      preview: { thread_ref: ref, text: expect.stringMatching(/Lisbon pilot/i) },
    });
    expect(action.approval).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const methods = await providerCalls();
    expect(methods.every((method) => ["searchMessages", "messageByTs", "permalink", "replies"].includes(method))).toBe(true);
    const commands = (await events()).flatMap((event) => event.argv ? [event.argv] : []);
    expect(commands.some((argv) => argv.includes("--apply") || (argv.includes("action") && argv.includes("apply")))).toBe(false);
    return action.id;
  }

  it("finds the fixture decision and verifies the staged reply offline", async () => {
    const search = await cli("search", "messages", "Orchid");
    expect(search.messages[0].ref).toBe(ref);
    const result = await cli("message", "cite", ref);
    expect(result.citations[0].permalink).toBe(permalink);
    await cli("message", "reply", "--to", "C101", "--thread", ref, "--text", "We will coordinate the Lisbon pilot.");
    await verifyDraft();
    expect(await providerCalls()).toEqual(["searchMessages", "messageByTs", "permalink"]);
  });

  // Opt in with SLACK_AXI_CLAUDE_E2E=1. Requires the operator's Claude Code login.
  it.skipIf(process.env.SLACK_AXI_CLAUDE_E2E !== "1").each([
    ["citation", searchPrompt], ["draft", draftPrompt],
  ])("discovers the skill in a fresh session for %s", async (task, prompt) => {
    const { stdout } = await execute("claude", [
      "-p", "--output-format", "json", "--permission-prompts", "none", "--no-session-persistence",
      "--setting-sources", "project,local", "--strict-mcp-config", "--tools", "Skill,Bash",
      "--allowedTools", "Skill", "Bash(slack-axi:*)", "--", prompt,
    ], { cwd: project, env: { ...process.env, ...environment }, timeout: 150_000 });
    const result = JSON.parse(stdout);
    expect(result.is_error, result.result).toBe(false);
    expect(await providerCalls()).toContain("searchMessages");
    if (task === "citation") {
      expect(await providerCalls()).toContain("permalink");
      expect(result.result).toContain(permalink);
    } else {
      expect(result.result).toContain(await verifyDraft());
    }
  }, 160_000);
});
