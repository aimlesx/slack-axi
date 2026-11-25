#!/usr/bin/env node
// Fixture entry point for fresh Claude sessions. Put a symlink named slack-axi
// on PATH and supply an empty directory in SLACK_AXI_FIXTURE_DIR.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { ActionStore } from "../../dist/actions.js";
import { SlackAxiApp } from "../../dist/app.js";
import { cacheIdentity } from "../../dist/cache.js";
import { createProgram } from "../../dist/cli.js";
import { PolicyStore } from "../../dist/policy.js";

const directory = process.env.SLACK_AXI_FIXTURE_DIR;
if (!directory || !path.isAbsolute(directory)) throw new Error("Set SLACK_AXI_FIXTURE_DIR to an absolute fixture directory.");
const record = (event) => appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify(event) + "\n");
const channel = { id: "C101", name: "release", is_channel: true, is_ext_shared: false };
const ts = "1795502711.000042";
const message = { user: "U22", ts, text: "Orchid rollout decision: start with the Lisbon pilot on Tuesday." };
const link = "https://orchid-fixture.slack.com/archives/C101/p1795502711000042";
const profile = {
  alias: "orchid", team_id: "T100", actor_id: "U11", kind: "user_token",
  team_name: "Orchid", timezone: "UTC", keychain_accounts: [], capabilities: {},
};
const snapshot = {
  ...cacheIdentity(profile), revision: "fixture", synced_at: new Date().toISOString(),
  coverage: { conversations: { complete: true }, users: { complete: true } },
  conversations: [channel], users: [{ id: "U22", name: "rae", profile: { display_name: "Rae" } }],
};
const reads = {
  searchMessages(query) {
    const match = /orchid|rollout|pilot|lisbon/i.test(query);
    return { items: match ? [{ ...message, channel }] : [], total: match ? 1 : 0, pages: 1 };
  },
  messageByTs(id, at) { return id === channel.id && at === ts ? message : undefined; },
  permalink(id, at) {
    if (id !== channel.id || at !== ts) throw new Error("Fixture message does not exist.");
    return link;
  },
  replies({ channel: id, ts: at }) {
    return { items: id === channel.id && at === ts ? [message] : [], complete: true };
  },
};
// Every invoked provider method is recorded, including any attempted writes.
// The fixture has no network transport.
const provider = new Proxy({}, { get(_, method) {
  if (method === "backendCalls") return 0;
  return async (...args) => {
    record({ method, args });
    if (!Object.hasOwn(reads, method)) throw new Error("Unsupported fixture method: " + String(method));
    return reads[method](...args);
  };
} });
const config = {
  async load() { return { profiles: [profile], default_workspace: profile.alias }; },
  async resolve(selector) {
    if (selector && selector !== profile.alias && selector !== profile.team_id) throw new Error("Unknown fixture workspace.");
    return profile;
  },
};
const secrets = { async get() { return Buffer.alloc(32, 0x71).toString("base64url"); } };
const app = new SlackAxiApp({
  config, secrets,
  cache: { async load() { return snapshot; } },
  auth: { async clients(selector) { return { profile: await config.resolve(selector), public: provider }; } },
  actions: new ActionStore(path.join(directory, "actions"), secrets),
  policy: new PolicyStore(path.join(directory, "policy.json"), path.join(directory, "project-policy.json")),
});
record({ argv: process.argv.slice(2) });
try {
  await createProgram(app).parseAsync(process.argv);
} catch (error) {
  if (!["commander.helpDisplayed", "commander.version"].includes(error.code)) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
