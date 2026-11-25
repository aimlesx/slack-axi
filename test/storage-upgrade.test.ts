import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlkyApp } from "../src/app.js";
import { CacheStore, cacheIdentity } from "../src/cache.js";
import { NativeKeychain } from "../src/keychain.js";
import { appPaths } from "../src/paths.js";

const keychain = vi.hoisted(() => new Map<string, string>());
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    private readonly key: string;
    constructor(service: string, account: string) {
      this.key = service + "/" + account;
    }
    async getPassword() { return keychain.get(this.key); }
    async setPassword(value: string) { keychain.set(this.key, value); }
    async deleteCredential() { return keychain.delete(this.key); }
  },
}));

describe("on-disk upgrade from slack-axi", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "slky-upgrade-"));
    vi.stubEnv("HOME", home);
    keychain.clear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it("selects the slky layout on a fresh installation without creating files on discovery", async () => {
    const data = path.join(home, "Library", "Application Support", "slky");
    const paths = appPaths();
    expect(paths).toMatchObject({ data, cache: path.join(home, "Library", "Caches", "slky"), keychainService: "dev.slky" });
    const app = new SlkyApp();
    await expect(app.config.load()).resolves.toMatchObject({ profiles: [] });
    expect(await readdir(home)).toEqual([]);
    await app.config.save({ version: 1, profiles: [] });
    expect(JSON.parse(await readFile(path.join(data, "config.json"), "utf8"))).toEqual({ version: 1, profiles: [] });
    await new NativeKeychain().set("example", "fixture");
    expect(keychain.get("dev.slky/example")).toBe("fixture");
  });

  it("treats a cache-only legacy installation as a single legacy layout", async () => {
    const cache = path.join(home, "Library", "Caches", "slack-axi");
    await mkdir(cache, { recursive: true });
    expect(appPaths()).toMatchObject({
      data: path.join(home, "Library", "Application Support", "slack-axi"), cache, keychainService: "dev.slack-axi",
    });
  });

  it("refuses competing layouts before opening a store, including split data and cache roots", async () => {
    const data = path.join(home, "Library", "Application Support", "slack-axi");
    const cache = path.join(home, "Library", "Caches", "slky");
    await mkdir(data, { recursive: true });
    await mkdir(cache, { recursive: true });
    const result = spawnSync(process.execPath, ["dist/index.js", "--output", "json", "policy", "init"], {
      encoding: "utf8", env: { ...process.env, HOME: home },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: "slky/v1", ok: false, error: { code: "STORAGE_LAYOUT_CONFLICT" } });
    expect(await readdir(data)).toEqual([]);
    expect(await readdir(cache)).toEqual([]);
    expect(keychain.size).toBe(0);
  });

  it("reuses a v0.1 profile, cache, signed action, and cursor without rotating its Keychain entries", async () => {
    const data = path.join(home, "Library", "Application Support", "slack-axi");
    const cache = path.join(home, "Library", "Caches", "slack-axi");
    const id = "019acd00-0000-7000-8000-000000000001";
    const actionDir = path.join(data, "actions", id);
    await mkdir(actionDir, { recursive: true });

    const timestamp = "2026-01-01T00:00:00.000Z";
    const account = "T1:user:existinggeneration:xoxp";
    const profile = {
      team_id: "T1", actor_id: "U1", team_name: "Fixture", alias: "work", kind: "user_token" as const, timezone: "UTC",
      created_at: timestamp, updated_at: timestamp, capabilities: {}, keychain_accounts: [account],
    };
    const config = { version: 1, profiles: [profile], default_workspace: "work", pending_credential_cleanup: ["retired-account"] };
    await writeFile(path.join(data, "config.json"), JSON.stringify(config));
    const identity = cacheIdentity(profile);
    const covered = { scanned: 0, complete: true };
    await new CacheStore(cache).save({
      version: 2, revision: "before-rename", ...identity, synced_at: timestamp, conversations: [], users: [], emoji: {},
      coverage: { conversations: covered, users: covered, emoji: covered, inbox: covered, backend_calls: 0 },
    });

    // Fixed v0.1 signatures ensure that a changed signing domain, action
    // encoding, or signing account cannot validate a fixture made by itself.
    const emptyHash = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    const approval = "BAxjCOO2MzsA8_Bqww6kt7JqDGe89ZA6YrIeBKAiHcw";
    const plan = {
      version: 2, id, workspace_id: "T1", actor_id: "U1", operation: "message.reply", target_ids: ["C1"],
      preview_hash: emptyHash, payload_hash: emptyHash, created_at: timestamp, expires_at: "2026-01-01T00:15:00.000Z",
    };
    const state = { version: 2, action_id: id, state: "planned", revision: 0, updated_at: timestamp };
    await writeFile(path.join(actionDir, "plan.json"), JSON.stringify({ data: plan, signature: approval }));
    await writeFile(path.join(actionDir, "state.json"), JSON.stringify({ data: state, signature: "WomfaX11oyolm5dE3-zOalaM5BH9Q-BHko7UVgzanN8" }));
    await writeFile(path.join(actionDir, "preview.json"), "{}");
    await writeFile(path.join(actionDir, "payload.json"), "{}");
    keychain.set("dev.slack-axi/" + account, "fixture-user-token");
    keychain.set("dev.slack-axi/local:action-signing:v1", Buffer.alloc(32, 0x42).toString("base64url"));
    const originalEntries = new Map(keychain);

    const app = new SlkyApp();
    expect(await app.config.load()).toEqual(config);
    expect((await app.auth.clients()).profile).toEqual(profile);
    expect(await app.cache.load(identity)).toMatchObject({ revision: "before-rename" });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp));
    expect(await app.actions.get(id)).toMatchObject({ id, state: "planned", approval });
    expect(await app.actions.verifyCursor({ page: 2 }, "2hE262TDCtpOyL8AN44ricaB7sn58G9TwmFdjE_g56E")).toBe(true);
    expect(keychain).toEqual(originalEntries);
    expect(await readdir(path.dirname(data))).toEqual(["slack-axi"]);
    expect(await readdir(path.dirname(cache))).toEqual(["slack-axi"]);
  });
});
