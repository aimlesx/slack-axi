import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { SlackAxiApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { cacheIdentity, CacheStore, type CachePurgeResult, type CacheSnapshot } from "../src/cache.js";
import { ConfigStore } from "../src/config.js";
import { AxiError } from "../src/errors.js";
import { credentialAccounts, credentialGeneration, KEYCHAIN_SERVICE } from "../src/keychain.js";
import { OwnedFileLock } from "../src/owned-lock.js";
import { appPaths } from "../src/paths.js";
import type { BrowserSlackClient } from "../src/slack-browser.js";
import type { PublicSlackClient } from "../src/slack-public.js";
import type { AuthProfile } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

const execFileAsync = promisify(execFile);

function profile(alias = "work"): AuthProfile {
  return { alias, team_id: "T1", team_name: "Acme", actor_id: "U1", timezone: "UTC", kind: "user_token", keychain_accounts: ["T1:user:xoxp"], capabilities: { public_api: "supported" }, created_at: "2026-08-15T10:00:00Z", updated_at: "2026-08-15T10:00:00Z" };
}

function browserProfile(alias = "work", generation?: string): AuthProfile {
  return {
    ...profile(alias),
    workspace_url: "https://acme.slack.com/",
    kind: "browser",
    keychain_accounts: generation
      ? credentialAccounts("T1", "browser", generation)
      : ["T1:browser:xoxc", "T1:browser:xoxd"],
  };
}

function profileFor(alias: string, teamId: string, actorId: string, account: string): AuthProfile {
  return {
    ...profile(alias),
    team_id: teamId,
    team_name: teamId,
    actor_id: actorId,
    actor_name: actorId,
    keychain_accounts: [account],
  };
}

function cached(teamId: string, actorId: string, generation: string, revision: string): CacheSnapshot {
  return {
    version: 2,
    revision,
    team_id: teamId,
    actor_id: actorId,
    credential_generation: generation,
    synced_at: "2026-08-15T10:00:00.000Z",
    conversations: [{ id: `${teamId}-private` }],
    users: [],
    emoji: {},
    coverage: {
      conversations: { scanned: 1, complete: true },
      users: { scanned: 0, complete: true },
      emoji: { scanned: 0, complete: true },
      inbox: { scanned: 0, complete: false },
      backend_calls: 1,
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const fakePublic = {
  async authTest() { return { team_id: "T1", user_id: "U1", team: "Acme", user: "Alice", url: "https://acme.slack.com/" }; },
  async userInfo() { return { id: "U1", tz: "UTC" }; },
} as unknown as PublicSlackClient;

const emptyActionPurger = {
  async purgeWorkspace(workspaceId: string) {
    return { workspace_id: workspaceId, scanned: 0, removed: 0, skipped: 0, complete: true, failed: [] };
  },
};

function publicIdentity(actorId: string): PublicSlackClient {
  return {
    async authTest() { return { team_id: "T1", user_id: actorId, team: "Acme", user: actorId, url: "https://acme.slack.com/" }; },
    async userInfo() { return { id: actorId, tz: "UTC" }; },
  } as unknown as PublicSlackClient;
}

describe("fresh namespace and transactional authentication", () => {
  it("uses the release package state and Keychain namespaces", () => {
    expect(appPaths("/Users/test").data).toContain("Application Support/slack-axi");
    expect(appPaths("/Users/test").cache).toContain("Caches/slack-axi");
    expect(KEYCHAIN_SERVICE).toBe("dev.slack-axi");
  });

  it("updates a stale default alias when the same team is re-aliased", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "old", profiles: [profile("old")] });
    const updated = await config.upsert(profile("new"));
    expect(updated.default_workspace).toBe("new");
    await expect(config.resolve()).resolves.toMatchObject({ alias: "new", team_id: "T1" });
  });

  it("derives a stable cache generation for an existing legacy profile", () => {
    const legacy = profile();
    const first = credentialGeneration(legacy);
    expect(first).toMatch(/^legacy-/);
    expect(credentialGeneration(structuredClone(legacy))).toBe(first);
    expect(credentialGeneration({ ...legacy, keychain_accounts: credentialAccounts("T1", "abcdefghijklmnop") })).toBe("abcdefghijklmnop");
  });

  it("commits a first profile without leaving its active generation pending cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const secrets = new MemorySecrets();
    const auth = new AuthService(config, secrets, () => fakePublic, () => "abcdefghijklmnop");

    const added = await auth.add({ alias: "work", token: "xoxp-new" });
    expect((await config.load()).pending_credential_cleanup).toBeUndefined();
    expect(secrets.values.get(added.keychain_accounts[0]!)).toBe("xoxp-new");
  });

  it("stages and commits a browser credential pair as one generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const secrets = new MemorySecrets();
    const auth = new AuthService(config, secrets, () => fakePublic, () => "abcdefghijklmnop");

    const added = await auth.add({ alias: "work", kind: "browser", token: "xoxc-new", cookie: "xoxd-new" });

    expect(added).toMatchObject({
      kind: "browser",
      workspace_url: "https://acme.slack.com/",
      keychain_accounts: ["T1:browser:abcdefghijklmnop:xoxc", "T1:browser:abcdefghijklmnop:xoxd"],
    });
    expect(Object.fromEntries(secrets.values)).toEqual({
      "T1:browser:abcdefghijklmnop:xoxc": "xoxc-new",
      "T1:browser:abcdefghijklmnop:xoxd": "xoxd-new",
    });
    expect((await config.load()).pending_credential_cleanup).toBeUndefined();
  });

  it("rolls back a partially written browser generation without touching the active pair", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const old = browserProfile();
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxc-old");
    secrets.values.set(old.keychain_accounts[1]!, "xoxd-old");
    secrets.failSet.add("T1:browser:abcdefghijklmnop:xoxd");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    await expect(auth.add({ alias: "work", kind: "browser", token: "xoxc-new", cookie: "xoxd-new" })).rejects.toMatchObject({ code: "KEYCHAIN_WRITE_FAILED" });

    expect((await config.resolve()).keychain_accounts).toEqual(old.keychain_accounts);
    expect(Object.fromEntries(secrets.values)).toEqual({
      "T1:browser:xoxc": "xoxc-old",
      "T1:browser:xoxd": "xoxd-old",
    });
    expect((await config.load()).pending_credential_cleanup).toBeUndefined();
  });

  it("retires and removes both secrets of a replaced browser generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const old = browserProfile();
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxc-old");
    secrets.values.set(old.keychain_accounts[1]!, "xoxd-old");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop", undefined, emptyActionPurger);

    const added = await auth.add({ alias: "work", kind: "browser", token: "xoxc-new", cookie: "xoxd-new" });

    expect([...secrets.values.keys()].sort()).toEqual([...added.keychain_accounts].sort());
    expect(secrets.values.get(added.keychain_accounts[0]!)).toBe("xoxc-new");
    expect(secrets.values.get(added.keychain_accounts[1]!)).toBe("xoxd-new");
    await expect(auth.remove("work")).resolves.toMatchObject({ credentials_removed: true });
    expect(secrets.values.size).toBe(0);
    expect((await config.load()).profiles).toEqual([]);
  });

  it("retires every obsolete Keychain pointer when switching authentication kinds", async () => {
    for (const direction of ["browser_to_user", "user_to_browser"] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `slack-axi-auth-kind-${direction}-`));
      const config = new ConfigStore(path.join(root, "config.json"));
      const old = direction === "browser_to_user" ? browserProfile() : profile();
      await config.save({ version: 1, default_workspace: "work", profiles: [old] });
      const secrets = new MemorySecrets();
      for (const account of old.keychain_accounts) secrets.values.set(account, `old-${account}`);
      const auth = new AuthService(config, secrets, () => fakePublic, () => "abcdefghijklmnop");

      const added = direction === "browser_to_user"
        ? await auth.add({ alias: "work", kind: "user_token", token: "xoxp-new" })
        : await auth.add({ alias: "work", kind: "browser", token: "xoxc-new", cookie: "xoxd-new" });

      expect(added.kind).toBe(direction === "browser_to_user" ? "user_token" : "browser");
      expect([...secrets.values.keys()].sort()).toEqual([...added.keychain_accounts].sort());
      for (const account of old.keychain_accounts) expect(secrets.values.has(account)).toBe(false);
    }
  });

  it("loads both browser secrets into isolated public and browser clients", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const active = browserProfile("work", "abcdefghijklmnop");
    await config.save({ version: 1, default_workspace: "work", profiles: [active] });
    const secrets = new MemorySecrets();
    secrets.values.set(active.keychain_accounts[0]!, "xoxc-session");
    secrets.values.set(active.keychain_accounts[1]!, "xoxd-cookie");
    const publicFactory = vi.fn((_token: string, _cookie?: string) => fakePublic);
    const browserClient = { counts: vi.fn() } as unknown as BrowserSlackClient;
    const browserFactory = vi.fn((_token: string, _cookie: string, _baseUrl: string) => browserClient);
    const auth = new AuthService(config, secrets, publicFactory, undefined, undefined, undefined, browserFactory);

    const clients = await auth.clients("work");

    expect(publicFactory).toHaveBeenCalledWith("xoxc-session", "xoxd-cookie");
    expect(browserFactory).toHaveBeenCalledWith("xoxc-session", "xoxd-cookie", "https://acme.slack.com/api");
    expect(clients).toMatchObject({ profile: active, public: fakePublic, browser: browserClient });
  });

  it("probes browser capabilities independently when another probe fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const active = browserProfile("work", "abcdefghijklmnop");
    await config.save({ version: 1, default_workspace: "work", profiles: [active] });
    const secrets = new MemorySecrets();
    secrets.values.set(active.keychain_accounts[0]!, "xoxc-session");
    secrets.values.set(active.keychain_accounts[1]!, "xoxd-cookie");
    const brokenPublic = {
      async authTest() { throw new AxiError({ code: "AUTH_INVALID", message: "public failed" }); },
    } as unknown as PublicSlackClient;
    const counts = vi.fn(async () => ({ channels: [], mpims: [], ims: [] }));
    const mutedChannels = vi.fn(async () => { throw new AxiError({ code: "BROWSER_CAPABILITY_CHANGED", message: "prefs changed" }); });
    const laterList = vi.fn(async () => ({ items: [] }));
    const browserClient = { counts, mutedChannels, laterList } as unknown as BrowserSlackClient;
    const auth = new AuthService(config, secrets, () => brokenPublic, undefined, undefined, undefined, () => browserClient);

    const result = await auth.doctor("work");

    expect(result.status).toBe("unavailable");
    expect(result.capabilities).toMatchObject({
      public_api: { status: "unavailable" },
      unread_counts: { status: "supported" },
      mention_counts: { status: "supported" },
      muted_channels: { status: "unavailable" },
      later: { status: "supported" },
    });
    expect(counts).toHaveBeenCalledTimes(1);
    expect(mutedChannels).toHaveBeenCalledTimes(1);
    expect(laterList).toHaveBeenCalledWith(undefined, 1);
    expect((await config.resolve("work")).capabilities).toMatchObject({
      public_api: "unavailable",
      unread_counts: "supported",
      mention_counts: "supported",
      muted_channels: "unavailable",
      later: "supported",
    });
  });

  it("fails closed before credential staging when the actor timezone cannot be read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const secrets = new MemorySecrets();
    const publicWithoutTimezone = {
      async authTest() { return { team_id: "T1", user_id: "U1", team: "Acme", user: "Alice" }; },
      async userInfo() { return { id: "U1", name: "alice", deleted: false, is_bot: false, profile: { display_name: "Alice", real_name: "Alice" } }; },
    } as unknown as PublicSlackClient;
    const auth = new AuthService(config, secrets, () => publicWithoutTimezone, () => "abcdefghijklmnop");

    await expect(auth.add({ alias: "work", token: "xoxp-new" })).rejects.toMatchObject({ code: "SLACK_RESPONSE_INVALID" });
    expect((await config.load()).profiles).toEqual([]);
    expect(secrets.values.size).toBe(0);
  });

  it("keeps the old actor and credential usable throughout an interrupted generation replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const old = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");

    // This is the durable state left by a process death after fresh Keychain
    // writes but before the atomic profile-pointer switch.
    const staged = credentialAccounts("T1", "abcdefghijklmnop");
    await config.addPendingCleanup(staged);
    secrets.values.set(staged[0]!, "xoxp-new");

    let selectedToken = "";
    const auth = new AuthService(config, secrets, (token) => {
      selectedToken = token;
      return fakePublic;
    });
    const clients = await auth.clients();
    expect(clients.profile).toMatchObject({ actor_id: "U1", keychain_accounts: old.keychain_accounts });
    expect(selectedToken).toBe("xoxp-old");
    expect((await config.load()).pending_credential_cleanup).toEqual(staged);

    await auth.doctor();
    expect(secrets.values.has(staged[0]!)).toBe(false);
    expect(secrets.values.get(old.keychain_accounts[0]!)).toBe("xoxp-old");
    expect((await config.load()).pending_credential_cleanup).toBeUndefined();
  });

  it("switches to a fresh generation atomically and preserves a replaced default alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const old = profile("old");
    await config.save({ version: 1, default_workspace: "old", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    const added = await auth.add({ alias: "new", token: "xoxp-new" });
    expect(added).toMatchObject({ alias: "new", actor_id: "U2", keychain_accounts: ["T1:user:abcdefghijklmnop:xoxp"] });
    const saved = await config.load();
    expect(saved.default_workspace).toBe("new");
    expect(saved.profiles).toEqual([added]);
    expect(saved.pending_credential_cleanup).toBeUndefined();
    expect(secrets.values.get(added.keychain_accounts[0]!)).toBe("xoxp-new");
    expect(secrets.values.has(old.keychain_accounts[0]!)).toBe(false);
  });

  it("refuses to reuse an active generation even if the generation source repeats", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const old = { ...profile(), keychain_accounts: credentialAccounts("T1", "abcdefghijklmnop") };
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    await expect(auth.add({ alias: "work", token: "xoxp-new" })).rejects.toMatchObject({ code: "CREDENTIAL_GENERATION_FAILED" });
    expect(secrets.values.get(old.keychain_accounts[0]!)).toBe("xoxp-old");
    expect((await config.resolve()).actor_id).toBe("U1");
  });

  it("does not delete a freshly committed generation when config persistence reports a late failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class CommitThenFailConfig extends ConfigStore {
      override async upsert(next: AuthProfile): Promise<never> {
        await super.upsert(next);
        throw new Error("injected failure after visible commit");
      }
    }
    const config = new CommitThenFailConfig(path.join(root, "config.json"));
    const old = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    const added = await auth.add({ alias: "work", token: "xoxp-new" });
    expect((await config.resolve()).actor_id).toBe("U2");
    expect(secrets.values.get(added.keychain_accounts[0]!)).toBe("xoxp-new");
    expect(secrets.values.has(old.keychain_accounts[0]!)).toBe(false);
  });

  it("retains a fresh generation when an ambiguous config commit cannot be reloaded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class CommitThenFailAndHideOnceConfig extends ConfigStore {
      private hideLoads = 0;

      override async upsert(next: AuthProfile): Promise<never> {
        await super.upsert(next);
        this.hideLoads = 1;
        throw new Error("injected failure after visible commit");
      }

      override async load() {
        if (this.hideLoads > 0) {
          this.hideLoads -= 1;
          throw new Error("injected transient reload failure");
        }
        return super.load();
      }
    }
    const config = new CommitThenFailAndHideOnceConfig(path.join(root, "config.json"));
    const old = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    await expect(auth.add({ alias: "work", token: "xoxp-new" })).rejects.toMatchObject({
      code: "AUTH_COMMIT_UNKNOWN",
      retryable: false,
      details: { pointer_verification_complete: false, fresh_credentials_retained: true },
    });
    const active = await config.resolve();
    expect(active).toMatchObject({ actor_id: "U2", keychain_accounts: ["T1:user:abcdefghijklmnop:xoxp"] });
    expect(secrets.values.get(active.keychain_accounts[0]!)).toBe("xoxp-new");
    expect(secrets.values.get(old.keychain_accounts[0]!)).toBe("xoxp-old");
    expect((await config.load()).pending_credential_cleanup).toEqual(old.keychain_accounts);
  });

  it("leaves the active generation intact and records failed retirement of the old one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const old = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    secrets.failDelete.add(old.keychain_accounts[0]!);
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    await expect(auth.add({ alias: "work", token: "xoxp-new" })).rejects.toMatchObject({ code: "AUTH_REMOVE_PARTIAL" });
    const saved = await config.load();
    expect(saved.profiles[0]).toMatchObject({ actor_id: "U2", keychain_accounts: ["T1:user:abcdefghijklmnop:xoxp"] });
    expect(saved.pending_credential_cleanup).toEqual(old.keychain_accounts);
    expect(secrets.values.get("T1:user:abcdefghijklmnop:xoxp")).toBe("xoxp-new");
  });

  it("reports cleanup-bookkeeping failure without masking a committed profile replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class FailingCleanupTrackingConfig extends ConfigStore {
      override async clearPendingCleanup(): Promise<never> {
        throw new Error("injected config cleanup bookkeeping failure");
      }
    }
    const config = new FailingCleanupTrackingConfig(path.join(root, "config.json"));
    const old = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    await expect(auth.add({ alias: "work", token: "xoxp-new" })).rejects.toMatchObject({
      code: "AUTH_REMOVE_PARTIAL",
      retryable: false,
      suggestedCommand: "slack-axi auth doctor",
      details: {
        profile_alias: "work",
        profile_active: true,
        cleanup_tracking: { code: "CREDENTIAL_CLEANUP_TRACKING_FAILED", cleanup_tracking_complete: false },
      },
    });
    const active = await config.resolve();
    expect(active).toMatchObject({ actor_id: "U2", keychain_accounts: ["T1:user:abcdefghijklmnop:xoxp"] });
    expect(secrets.values.get(active.keychain_accounts[0]!)).toBe("xoxp-new");
    expect(secrets.values.has(old.keychain_accounts[0]!)).toBe(false);
    expect((await config.load()).pending_credential_cleanup).toEqual(old.keychain_accounts);
  });

  it("restores the previous Keychain value if configuration saving fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class FailingConfig extends ConfigStore {
      override async upsert(): Promise<never> { throw new Error("injected config failure"); }
    }
    const config = new FailingConfig(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "work", profiles: [profile()] });
    const secrets = new MemorySecrets();
    secrets.values.set("T1:user:xoxp", "xoxp-old");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);
    await expect(auth.add({ alias: "work", token: "xoxp-new" })).rejects.toThrowError(/injected/);
    expect(secrets.values.get("T1:user:xoxp")).toBe("xoxp-old");
    expect([...secrets.values.keys()]).toEqual(["T1:user:xoxp"]);
    expect((await config.resolve()).actor_id).toBe("U1");
  });

  it("records failed credential deletion and doctor clears it before probing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "work", profiles: [profile()] });
    const secrets = new MemorySecrets();
    secrets.values.set("T1:user:xoxp", "xoxp-test");
    secrets.failDelete.add("orphan");
    await config.addPendingCleanup(["orphan"]);
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);
    await expect(auth.doctor()).rejects.toMatchObject({ code: "AUTH_REMOVE_PARTIAL" });
    secrets.failDelete.clear();
    const result = await auth.doctor();
    expect(result.status).toBe("degraded");
    expect(result.capabilities.public_api?.status).toBe("supported");
    expect(result.profile.capability_probed_at).toBe(result.probed_at);
    expect((await config.load()).pending_credential_cleanup).toBeUndefined();
  });

  it("never deletes an active credential pointer during pending-cleanup recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const active = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [active], pending_credential_cleanup: [...active.keychain_accounts] });
    const secrets = new MemorySecrets();
    secrets.values.set(active.keychain_accounts[0]!, "xoxp-test");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);

    await auth.doctor();
    expect(secrets.values.get(active.keychain_accounts[0]!)).toBe("xoxp-test");
    expect((await config.load()).pending_credential_cleanup).toBeUndefined();
  });

  it("reports doctor cleanup-ledger failure as AUTH_REMOVE_PARTIAL without deleting an active credential", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class FailingCleanupTrackingConfig extends ConfigStore {
      override async clearPendingCleanup(): Promise<never> {
        throw new Error("injected config cleanup bookkeeping failure");
      }
    }
    const config = new FailingCleanupTrackingConfig(path.join(root, "config.json"));
    const active = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [active], pending_credential_cleanup: [...active.keychain_accounts] });
    const secrets = new MemorySecrets();
    secrets.values.set(active.keychain_accounts[0]!, "xoxp-test");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);

    await expect(auth.doctor()).rejects.toMatchObject({
      code: "AUTH_REMOVE_PARTIAL",
      retryable: false,
      suggestedCommand: "slack-axi auth doctor",
      details: { cleanup_tracking: { code: "CREDENTIAL_CLEANUP_TRACKING_FAILED", cleanup_tracking_complete: false } },
    });
    expect(secrets.values.get(active.keychain_accounts[0]!)).toBe("xoxp-test");
    expect((await config.load()).pending_credential_cleanup).toEqual(active.keychain_accounts);
  });

  it("makes profile removal durable before recording a partial Keychain deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "work", profiles: [profile()] });
    const secrets = new MemorySecrets();
    secrets.values.set("T1:user:xoxp", "xoxp-test");
    secrets.failDelete.add("T1:user:xoxp");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);
    await expect(auth.remove("work")).rejects.toMatchObject({ code: "AUTH_REMOVE_PARTIAL" });
    const saved = await config.load();
    expect(saved.profiles).toHaveLength(0);
    expect(saved.pending_credential_cleanup).toEqual(["T1:user:xoxp"]);
  });

  it("re-durabilizes a visible profile removal before deleting credentials after a late config error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class CommitThenFailRemoveConfig extends ConfigStore {
      private failOnce = true;
      override async remove(selector: string, options: { stageCacheCleanup?: boolean } = {}) {
        const result = await super.remove(selector, options);
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error("injected failure after visible removal");
        }
        return result;
      }
    }
    const config = new CommitThenFailRemoveConfig(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "work", profiles: [profile()] });
    const secrets = new MemorySecrets();
    secrets.values.set("T1:user:xoxp", "xoxp-test");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);

    const result = await auth.remove("work");
    expect(result).toMatchObject({ profile: { alias: "work", team_id: "T1" }, credentials_removed: true });
    expect((await config.load()).profiles).toEqual([]);
    expect((await config.load()).pending_credential_cleanup).toBeUndefined();
    expect(secrets.values.has("T1:user:xoxp")).toBe(false);
  });

  it("retains credentials when a removal error cannot be reloaded for verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class CommitThenFailAndHideRemoveConfig extends ConfigStore {
      private hideLoads = 0;
      override async remove(selector: string, options: { stageCacheCleanup?: boolean } = {}): Promise<never> {
        await super.remove(selector, options);
        this.hideLoads = 1;
        throw new Error("injected failure after visible removal");
      }
      override async load() {
        if (this.hideLoads > 0) {
          this.hideLoads -= 1;
          throw new Error("injected transient reload failure");
        }
        return super.load();
      }
    }
    const config = new CommitThenFailAndHideRemoveConfig(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "work", profiles: [profile()] });
    const secrets = new MemorySecrets();
    secrets.values.set("T1:user:xoxp", "xoxp-test");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);

    await expect(auth.remove("work")).rejects.toMatchObject({
      code: "AUTH_COMMIT_UNKNOWN",
      retryable: false,
      details: { removal_verification_complete: false, credentials_retained: true },
    });
    expect(secrets.values.get("T1:user:xoxp")).toBe("xoxp-test");
    expect((await config.load()).profiles).toEqual([]);
  });

  it("reports cleanup-bookkeeping failure without masking a committed profile removal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    class FailingCleanupTrackingConfig extends ConfigStore {
      override async clearPendingCleanup(): Promise<never> {
        throw new Error("injected config cleanup bookkeeping failure");
      }
    }
    const config = new FailingCleanupTrackingConfig(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "work", profiles: [profile()] });
    const secrets = new MemorySecrets();
    secrets.values.set("T1:user:xoxp", "xoxp-test");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, undefined, emptyActionPurger);

    await expect(auth.remove("work")).rejects.toMatchObject({
      code: "AUTH_REMOVE_PARTIAL",
      retryable: false,
      suggestedCommand: "slack-axi auth doctor",
      details: {
        removed: { alias: "work", team_id: "T1" },
        profile_removed: true,
        cleanup_tracking: { code: "CREDENTIAL_CLEANUP_TRACKING_FAILED", cleanup_tracking_complete: false },
      },
    });
    const saved = await config.load();
    expect(saved.profiles).toEqual([]);
    expect(saved.pending_credential_cleanup).toEqual(["T1:user:xoxp"]);
    expect(secrets.values.has("T1:user:xoxp")).toBe(false);
  });

  it("rejects a split alias/team collision before staging or deleting credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const alpha = profileFor("alpha", "T1", "U1", "old-t1");
    const beta = profileFor("beta", "T2", "U2", "old-t2");
    await config.save({ version: 1, default_workspace: "alpha", profiles: [alpha, beta] });
    const secrets = new MemorySecrets();
    secrets.values.set("old-t1", "xoxp-one");
    secrets.values.set("old-t2", "xoxp-two");
    const auth = new AuthService(config, secrets, () => publicIdentity("U3"), () => "abcdefghijklmnop");

    await expect(auth.add({ alias: "beta", token: "xoxp-new" })).rejects.toMatchObject({ code: "WORKSPACE_ALIAS_CONFLICT" });
    expect(await config.load()).toEqual({ version: 1, default_workspace: "alpha", profiles: [alpha, beta] });
    expect(Object.fromEntries(secrets.values)).toEqual({ "old-t1": "xoxp-one", "old-t2": "xoxp-two" });
  });

  it("serializes direct config mutators across child processes without lost updates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const filename = path.join(root, "config.json");
    await new ConfigStore(filename).save({ version: 1, profiles: [] });
    const fixture = path.join(import.meta.dirname, "fixtures", "config-child.mjs");
    const accounts = Array.from({ length: 16 }, (_, index) => `orphan-${index}`);

    await Promise.all(accounts.map((account) => execFileAsync(process.execPath, [fixture, filename, account])));

    const saved = await new ConfigStore(filename).load();
    expect(saved.pending_credential_cleanup?.toSorted()).toEqual(accounts.toSorted());
  }, 20_000);

  it("keeps a staged add isolated from doctor cleanup until its pointer switch completes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const filename = path.join(root, "config.json");
    const old = profile();
    await new ConfigStore(filename).save({ version: 1, default_workspace: "work", profiles: [old] });
    const entered = deferred();
    const release = deferred();
    const deleted: string[] = [];
    class BlockingSecrets extends MemorySecrets {
      private first = true;
      override async set(account: string, secret: string): Promise<void> {
        if (this.first) {
          this.first = false;
          entered.resolve();
          await release.promise;
        }
        await super.set(account, secret);
      }
      override async delete(account: string): Promise<boolean> {
        deleted.push(account);
        return super.delete(account);
      }
    }
    const secrets = new BlockingSecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const clientForToken = (token: string) => token === "xoxp-new" ? publicIdentity("U2") : fakePublic;
    const add = new AuthService(new ConfigStore(filename), secrets, clientForToken, () => "abcdefghijklmnop");
    const doctor = new AuthService(new ConfigStore(filename), secrets, clientForToken);

    const adding = add.add({ alias: "work", token: "xoxp-new" });
    await entered.promise;
    const probing = doctor.doctor();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deleted).not.toContain("T1:user:abcdefghijklmnop:xoxp");
    release.resolve();
    const [added, diagnosed] = await Promise.all([adding, probing]);

    expect(diagnosed.profile.keychain_accounts).toEqual(added.keychain_accounts);
    expect(deleted).not.toContain(added.keychain_accounts[0]!);
    expect((await new ConfigStore(filename).load()).profiles[0]?.actor_id).toBe("U2");
  });

  it("prevents an in-flight doctor result from overwriting a replacement generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const filename = path.join(root, "config.json");
    const old = profile();
    await new ConfigStore(filename).save({ version: 1, default_workspace: "work", profiles: [old] });
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const entered = deferred();
    const release = deferred();
    const slowProbe = {
      async authTest() {
        entered.resolve();
        await release.promise;
        return { team_id: "T1", user_id: "U1", team: "Acme", user: "Alice", url: "https://acme.slack.com/" };
      },
      async userInfo() { return { id: "U1", tz: "UTC" }; },
    } as unknown as PublicSlackClient;
    const doctor = new AuthService(new ConfigStore(filename), secrets, () => slowProbe);
    const add = new AuthService(new ConfigStore(filename), secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop");

    const probing = doctor.doctor();
    await entered.promise;
    const replacing = add.add({ alias: "work", token: "xoxp-new" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    await Promise.all([probing, replacing]);

    const saved = await new ConfigStore(filename).load();
    expect(saved.profiles[0]).toMatchObject({ actor_id: "U2", keychain_accounts: ["T1:user:abcdefghijklmnop:xoxp"] });
    expect(secrets.values.get("T1:user:abcdefghijklmnop:xoxp")).toBe("xoxp-new");
  });

  it("rejects a stale profile update after the credential generation changed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const stale = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [stale] });
    const replacement = { ...stale, actor_id: "U2", keychain_accounts: ["T1:user:abcdefghijklmnop:xoxp"] };
    await config.upsert(replacement);

    await expect(config.updateProfile({ ...stale, capability_probed_at: new Date().toISOString() })).rejects.toMatchObject({ code: "WORKSPACE_PROFILE_CHANGED" });
    expect((await config.resolve()).keychain_accounts).toEqual(replacement.keychain_accounts);
  });

  it("serializes concurrent use and remove operations into a valid default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const filename = path.join(root, "config.json");
    const alpha = profileFor("alpha", "T1", "U1", "alpha-account");
    const beta = profileFor("beta", "T2", "U2", "beta-account");
    await new ConfigStore(filename).save({ version: 1, default_workspace: "beta", profiles: [alpha, beta] });
    const secrets = new MemorySecrets();
    secrets.values.set("alpha-account", "xoxp-alpha");
    secrets.values.set("beta-account", "xoxp-beta");
    const auth = new AuthService(new ConfigStore(filename), secrets, () => fakePublic, undefined, undefined, emptyActionPurger);

    const [used, removed] = await Promise.allSettled([
      new ConfigStore(filename).use("alpha"),
      auth.remove("alpha"),
    ]);

    expect(removed.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(used.status);
    const saved = await new ConfigStore(filename).load();
    expect(saved).toMatchObject({ default_workspace: "beta", profiles: [{ alias: "beta", team_id: "T2" }] });
    expect(secrets.values.has("alpha-account")).toBe(false);
    expect(secrets.values.get("beta-account")).toBe("xoxp-beta");
  });

  it("never lets a delayed former owner unlink a successor lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-lock-"));
    const filename = path.join(root, "config.lock");
    let alive = true;
    const options = { timeoutMs: 2_000, retryMs: 1, isProcessAlive: () => alive };
    const first = await new OwnedFileLock(filename, options).acquire();
    alive = false;
    const second = await new OwnedFileLock(filename, options).acquire();

    await expect(first.release()).rejects.toMatchObject({ code: "CONFIG_LOCK_LOST" });
    const visible = JSON.parse(await readFile(filename, "utf8")) as { nonce: string };
    expect(visible.nonce).toBe(second.owner.nonce);
    await second.release();
  });

  it("reclaims a shared lock whose live PID belongs to a newer process birth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-lock-"));
    const filename = path.join(root, "config.lock");
    await writeFile(filename, JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: "previouslockowner0000000000000001",
      claimed_at: new Date(1_500).toISOString(),
      process_started_at_ms: 2_000,
      process_instance_id: "previousprocessinstance00000000001",
    }));
    const options = {
      timeoutMs: 2_000,
      retryMs: 1,
      isProcessAlive: () => true,
      processIdentity: async () => ({ startedAtMs: 2_000, instanceId: "currentprocessinstance000000000001" }),
    };

    const lease = await new OwnedFileLock(filename, options).acquire();

    expect(lease.owner).toMatchObject({
      pid: process.pid,
      process_started_at_ms: 2_000,
      process_instance_id: "currentprocessinstance000000000001",
    });
    await lease.release();
  });

  it("serializes concurrent add operations into one coherent active generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-config-"));
    const filename = path.join(root, "config.json");
    await new ConfigStore(filename).save({ version: 1, profiles: [] });
    const secrets = new MemorySecrets();
    const factory = (token: string) => publicIdentity(token === "xoxp-one" ? "U1" : "U2");
    const first = new AuthService(new ConfigStore(filename), secrets, factory, () => "aaaaaaaaaaaaaaaa");
    const second = new AuthService(new ConfigStore(filename), secrets, factory, () => "bbbbbbbbbbbbbbbb");

    await Promise.all([
      first.add({ alias: "work", token: "xoxp-one" }),
      second.add({ alias: "work", token: "xoxp-two" }),
    ]);

    const saved = await new ConfigStore(filename).load();
    expect(saved.profiles).toHaveLength(1);
    expect(saved.pending_credential_cleanup).toBeUndefined();
    const active = saved.profiles[0]!;
    expect(secrets.values.get(active.keychain_accounts[0]!)).toBe(active.actor_id === "U1" ? "xoxp-one" : "xoxp-two");
    expect([...secrets.values.keys()]).toEqual(active.keychain_accounts);
  });

  it("purges all cached actors and generations when authentication is removed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-auth-purge-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const active = { ...profile(), keychain_accounts: credentialAccounts("T1", "generation-active") };
    await config.save({ version: 1, default_workspace: "work", profiles: [active] });
    const cache = new CacheStore(path.join(root, "cache"));
    const removedIdentities = [
      { team_id: "T1", actor_id: "U1", credential_generation: "generation-active" },
      { team_id: "T1", actor_id: "U1", credential_generation: "generation-older-1" },
      { team_id: "T1", actor_id: "U2", credential_generation: "generation-other-2" },
    ];
    for (const [index, identity] of removedIdentities.entries()) {
      await cache.save(cached(identity.team_id, identity.actor_id, identity.credential_generation, `removed-${index}`));
    }
    const retained = { team_id: "T2", actor_id: "U9", credential_generation: "generation-retained" };
    await cache.save(cached(retained.team_id, retained.actor_id, retained.credential_generation, "retained"));
    const secrets = new MemorySecrets();
    secrets.values.set(active.keychain_accounts[0]!, "xoxp-old");
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, cache, emptyActionPurger);

    const result = await auth.remove("work");

    expect(result).toMatchObject({ profile: { alias: "work", team_id: "T1" }, credentials_removed: true, cache_scopes_removed: 3 });
    for (const identity of removedIdentities) await expect(cache.load(identity)).resolves.toBeUndefined();
    await expect(cache.load(retained)).resolves.toMatchObject({ revision: "retained" });
    expect((await config.load()).pending_cache_cleanup).toBeUndefined();
  });

  it("fences an in-flight sync so removal purges its final published cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-auth-purge-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const active = profile();
    await config.save({ version: 1, default_workspace: "work", profiles: [active] });
    const cache = new CacheStore(path.join(root, "cache"));
    const secrets = new MemorySecrets();
    secrets.values.set(active.keychain_accounts[0]!, "xoxp-old");
    const entered = deferred();
    const release = deferred();
    const publicClient = {
      backendCalls: 0,
      async listConversations() {
        entered.resolve();
        await release.promise;
        return { items: [{ id: "C1", name: "private" }] };
      },
      async listUsers() { return { items: [] }; },
      async emoji() { return {}; },
    } as unknown as PublicSlackClient;
    const auth = new AuthService(config, secrets, () => publicClient, undefined, cache, emptyActionPurger);
    const app = new SlackAxiApp({ config, auth, cache, secrets });

    const syncing = app.sync("work", { maxPages: 1 });
    await entered.promise;
    let removalFinished = false;
    const removing = auth.remove("work").then((result) => { removalFinished = true; return result; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(removalFinished).toBe(false);
    release.resolve();
    await Promise.all([syncing, removing]);

    await expect(cache.load(cacheIdentity(active))).resolves.toBeUndefined();
    expect((await config.load()).profiles).toEqual([]);
  });

  it("purges prior cache generations after successful reauthentication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-auth-purge-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    const old = { ...profile(), keychain_accounts: credentialAccounts("T1", "generation-old-01") };
    await config.save({ version: 1, default_workspace: "work", profiles: [old] });
    const cache = new CacheStore(path.join(root, "cache"));
    const oldIdentities = [
      { team_id: "T1", actor_id: "U1", credential_generation: "generation-old-01" },
      { team_id: "T1", actor_id: "U3", credential_generation: "generation-older-2" },
    ];
    for (const [index, identity] of oldIdentities.entries()) await cache.save(cached(identity.team_id, identity.actor_id, identity.credential_generation, `old-${index}`));
    const secrets = new MemorySecrets();
    secrets.values.set(old.keychain_accounts[0]!, "xoxp-old");
    const auth = new AuthService(config, secrets, () => publicIdentity("U2"), () => "abcdefghijklmnop", cache);

    const added = await auth.add({ alias: "work", token: "xoxp-new" });

    expect(added).toMatchObject({ actor_id: "U2", keychain_accounts: ["T1:user:abcdefghijklmnop:xoxp"] });
    for (const identity of oldIdentities) await expect(cache.load(identity)).resolves.toBeUndefined();
    expect((await config.load()).pending_cache_cleanup).toBeUndefined();
  });

  it("reports cache purge failure as durable partial auth cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-auth-purge-"));
    const config = new ConfigStore(path.join(root, "config.json"));
    await config.save({ version: 1, default_workspace: "work", profiles: [profile()] });
    const secrets = new MemorySecrets();
    secrets.values.set("T1:user:xoxp", "xoxp-old");
    class FailingCache extends CacheStore {
      fail = true;
      override async purgeTeams(_teamIds: string[]): Promise<CachePurgeResult> {
        if (this.fail) throw new AxiError({ code: "CACHE_PURGE_FAILED", message: "injected cache purge failure" });
        return super.purgeTeams(_teamIds);
      }
    }
    const cache = new FailingCache(path.join(root, "cache"));
    const auth = new AuthService(config, secrets, () => fakePublic, undefined, cache, emptyActionPurger);

    await expect(auth.remove("work")).rejects.toMatchObject({
      code: "AUTH_REMOVE_PARTIAL",
      details: { cache_cleanup: { code: "CACHE_PURGE_FAILED", team_ids: ["T1"] } },
    });
    expect((await config.load())).toMatchObject({ profiles: [], pending_cache_cleanup: ["T1"] });
    expect(secrets.values.has("T1:user:xoxp")).toBe(false);
    cache.fail = false;
    await expect(auth.doctor()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect((await config.load()).pending_cache_cleanup).toBeUndefined();
  });
});
