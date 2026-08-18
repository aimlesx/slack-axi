import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SlackAxiApp } from "../src/app.js";
import { cacheIdentity, CacheStore, createCacheCursor, filterHash, parseCacheCursor, type CacheSnapshot } from "../src/cache.js";
import type { AuthService } from "../src/auth.js";
import { credentialAccounts } from "../src/keychain.js";
import type { AuthProfile } from "../src/types.js";
import { MemoryCursorIntegrity } from "./helpers.js";

function snapshot(actorId = "U1", generation = "legacy-test"): CacheSnapshot {
  return {
    version: 2,
    revision: "rev-1",
    team_id: "T1",
    actor_id: actorId,
    credential_generation: generation,
    synced_at: "2026-08-15T10:00:00.000Z",
    conversations: [],
    users: [],
    emoji: {},
    coverage: {
      conversations: { scanned: 0, complete: false },
      users: { scanned: 0, complete: true },
      emoji: { scanned: 0, complete: true },
      inbox: { scanned: 0, complete: false },
      backend_calls: 0,
    },
  };
}

describe("cache coverage and cursors", () => {
  it("authenticates cache cursors and binds them to snapshot identity, revision, and filters", async () => {
    const value = snapshot();
    const query = filterHash({ type: "channel" });
    const integrity = new MemoryCursorIntegrity();
    const cursor = await createCacheCursor(value, query, 20, integrity);
    await expect(parseCacheCursor(cursor, value, query, "slack-axi conversation list", integrity)).resolves.toBe(20);
    await expect(parseCacheCursor(cursor, { ...value, revision: "rev-2" }, query, "slack-axi conversation list", integrity)).rejects.toThrowError(/stale/i);
    await expect(parseCacheCursor(cursor, { ...value, credential_generation: "replacement" }, query, "slack-axi conversation list", integrity)).rejects.toThrowError(/credential generation/i);
    await expect(parseCacheCursor(cursor, value, filterHash({ type: "dm" }), "slack-axi conversation list", integrity)).rejects.toThrowError(/filter/i);

    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const tampered = Buffer.from(JSON.stringify({ ...decoded, o: 9_000_000 })).toString("base64url");
    await expect(parseCacheCursor(tampered, value, query, "slack-axi conversation list", integrity)).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("isolates snapshots across actors and credential generations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-cache-"));
    const cache = new CacheStore(root);
    const u1g1 = { team_id: "T1", actor_id: "U1", credential_generation: "generation-one" };
    const u1g2 = { team_id: "T1", actor_id: "U1", credential_generation: "generation-two" };
    const u2g1 = { team_id: "T1", actor_id: "U2", credential_generation: "generation-one" };
    await cache.save({ ...snapshot("U1", "generation-one"), revision: "u1-g1" });

    await expect(cache.load(u1g1)).resolves.toMatchObject({ revision: "u1-g1", actor_id: "U1", credential_generation: "generation-one" });
    await expect(cache.load(u1g2)).resolves.toBeUndefined();
    await expect(cache.load(u2g1)).resolves.toBeUndefined();

    await cache.save({ ...snapshot("U1", "generation-two"), revision: "u1-g2" });
    await cache.save({ ...snapshot("U2", "generation-one"), revision: "u2-g1" });
    await expect(cache.load(u1g1)).resolves.toMatchObject({ revision: "u1-g1" });
    await expect(cache.load(u1g2)).resolves.toMatchObject({ revision: "u1-g2" });
    await expect(cache.load(u2g1)).resolves.toMatchObject({ revision: "u2-g1" });
  });

  it("purges every actor and credential generation for a removed team", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-cache-"));
    const cache = new CacheStore(root);
    const identities = [
      { team_id: "T1", actor_id: "U1", credential_generation: "generation-one" },
      { team_id: "T1", actor_id: "U1", credential_generation: "generation-two" },
      { team_id: "T1", actor_id: "U2", credential_generation: "generation-three" },
    ];
    for (const [index, identity] of identities.entries()) {
      await cache.save({ ...snapshot(identity.actor_id, identity.credential_generation), revision: `t1-${index}` });
    }
    const retained = { team_id: "T2", actor_id: "U9", credential_generation: "generation-other" };
    await cache.save({ ...snapshot("U9", "generation-other"), team_id: "T2", revision: "t2" });
    const legacy = path.join(root, "T1");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "snapshot.json"), `${JSON.stringify(snapshot("U1", "legacy-team-only"))}\n`, "utf8");

    const purged = await cache.purgeTeams(["T1"]);

    expect(purged).toMatchObject({ team_ids: ["T1"], removed_scopes: 3, removed_legacy_scopes: 1 });
    for (const identity of identities) await expect(cache.load(identity)).resolves.toBeUndefined();
    await expect(access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(cache.load(retained)).resolves.toMatchObject({ revision: "t2", team_id: "T2" });
  });

  it("rejects mutation under an already published cache revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-cache-"));
    const cache = new CacheStore(root);
    const value = snapshot("U1", "generation-one");
    await cache.save(value);

    await expect(cache.save({ ...value, conversations: [{ id: "C1" }] })).rejects.toMatchObject({ code: "CACHE_REVISION_REUSED" });
    await expect(cache.load(value)).resolves.toMatchObject({ revision: "rev-1", conversations: [] });
  });

  it("never falls back to a legacy team-only snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-cache-"));
    const legacyDirectory = path.join(root, "T1");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(path.join(legacyDirectory, "snapshot.json"), `${JSON.stringify(snapshot("U1", "legacy-unsafe"))}\n`, "utf8");
    const cache = new CacheStore(root);
    await expect(cache.load({ team_id: "T1", actor_id: "U1", credential_generation: "legacy-unsafe" })).resolves.toBeUndefined();
  });

  it("derives distinct cache identities for actor and generation replacements", () => {
    const legacy = {
      alias: "work", team_id: "T1", team_name: "Acme", actor_id: "U1", timezone: "UTC", kind: "user_token",
      keychain_accounts: ["T1:user:xoxp"], capabilities: {}, created_at: "2026-08-15T10:00:00Z", updated_at: "2026-08-15T10:00:00Z",
    } satisfies AuthProfile;
    const sameLegacy = cacheIdentity(structuredClone(legacy));
    expect(sameLegacy.credential_generation).toMatch(/^legacy-/);
    expect(cacheIdentity(structuredClone(legacy))).toEqual(sameLegacy);
    expect(cacheIdentity({ ...legacy, actor_id: "U2" })).not.toEqual(sameLegacy);
    expect(cacheIdentity({ ...legacy, keychain_accounts: credentialAccounts("T1", "abcdefghijklmnop") })).not.toEqual(sameLegacy);
  });

  it("forces a sync when the same actor switches credential generations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-cache-"));
    const cache = new CacheStore(root);
    const base = {
      alias: "work", team_id: "T1", team_name: "Acme", actor_id: "U1", timezone: "UTC", kind: "user_token",
      capabilities: {}, created_at: "2026-08-15T10:00:00Z", updated_at: "2026-08-15T10:00:00Z",
    } as const;
    const oldProfile = { ...base, keychain_accounts: credentialAccounts("T1", "generation-old-1") } satisfies AuthProfile;
    const newProfile = { ...base, keychain_accounts: credentialAccounts("T1", "generation-new-2") } satisfies AuthProfile;
    await cache.save({ ...snapshot("U1", "generation-old-1"), revision: "old-cache" });
    let conversationCalls = 0;
    const publicClient = {
      backendCalls: 0,
      async listConversations() { conversationCalls += 1; return { items: [] }; },
      async listUsers() { return { items: [] }; },
      async emoji() { return {}; },
    };
    const auth = { async clients() { return { profile: newProfile, public: publicClient }; } } as unknown as AuthService;

    const result = await new SlackAxiApp({ auth, cache }).context("work");
    expect(conversationCalls).toBe(1);
    expect(result.snapshot.credential_generation).toBe("generation-new-2");
    expect(result.snapshot.revision).not.toBe("old-cache");
    await expect(cache.load(cacheIdentity(oldProfile))).resolves.toMatchObject({ revision: "old-cache" });
  });

  it("keeps a cache-miss context on one credential generation while replacement waits", async () => {
    const oldProfile = {
      alias: "work", team_id: "T1", team_name: "Acme", actor_id: "U1", timezone: "UTC", kind: "user_token",
      keychain_accounts: credentialAccounts("T1", "generation-old-1"), capabilities: {}, created_at: "2026-08-15T10:00:00Z", updated_at: "2026-08-15T10:00:00Z",
    } satisfies AuthProfile;
    const replacementProfile = {
      ...oldProfile,
      actor_id: "U2",
      keychain_accounts: credentialAccounts("T1", "generation-new-2"),
    } satisfies AuthProfile;
    const gate = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const cacheLoadEntered = gate();
    const allowCacheMiss = gate();
    const replacementRequested = gate();
    const leaseReleased = gate();
    let active = oldProfile;
    let leaseActive = false;
    let replacementSettled = false;
    const clientsFor = (profile: AuthProfile) => ({
      profile,
      public: {
        backendCalls: 0,
        async listConversations() { return { items: [{ id: profile.actor_id === "U1" ? "COLD" : "CNEW", name: "identity" }] }; },
        async listUsers() { return { items: [] }; },
        async emoji() { return {}; },
      },
    });
    const auth = {
      async clients() { return clientsFor(active); },
      async withCredentialLease<T>(_selector: string | undefined, operation: (clients: ReturnType<typeof clientsFor>) => Promise<T>) {
        const clients = clientsFor(active);
        leaseActive = true;
        try {
          return await operation(clients);
        } finally {
          leaseActive = false;
          leaseReleased.resolve();
        }
      },
      async withClients<T>(selector: string | undefined, operation: (clients: ReturnType<typeof clientsFor>) => Promise<T>) {
        return this.withCredentialLease(selector, operation);
      },
      async replace() {
        replacementRequested.resolve();
        if (leaseActive) await leaseReleased.promise;
        active = replacementProfile;
        replacementSettled = true;
      },
    };
    const saved: CacheSnapshot[] = [];
    const cache = {
      async transaction<T>(operation: () => Promise<T>) { return operation(); },
      async load() {
        cacheLoadEntered.resolve();
        await allowCacheMiss.promise;
        return undefined;
      },
      async save(value: CacheSnapshot) { saved.push(structuredClone(value)); },
    } as unknown as CacheStore;
    const app = new SlackAxiApp({ auth: auth as unknown as AuthService, cache, revisionFactory: () => `race-${saved.length + 1}` });

    const contextPromise = app.context("work");
    await cacheLoadEntered.promise;
    const replacement = auth.replace();
    await replacementRequested.promise;
    expect(replacementSettled).toBe(false);
    allowCacheMiss.resolve();

    const context = await contextPromise;
    await replacement;
    expect(context.profile).toBe(oldProfile);
    expect(context.snapshot).toMatchObject({
      team_id: "T1",
      actor_id: "U1",
      credential_generation: "generation-old-1",
      conversations: [{ id: "COLD" }],
    });
    expect(context.snapshot.actor_id).toBe(context.profile.actor_id);
    expect(context.snapshot.credential_generation).toBe(cacheIdentity(context.profile).credential_generation);
    expect(active).toBe(replacementProfile);
  });

  it("persists successful partial pages, continuation cursors, and per-source errors", async () => {
    const saved: CacheSnapshot[] = [];
    let conversationCalls = 0;
    const publicClient = {
      backendCalls: 0,
      async listConversations() {
        conversationCalls += 1;
        if (conversationCalls === 1) return { items: [{ id: "C1", name: "eng" }], next: "next-conversations" };
        throw Object.assign(new Error("injected later-page failure"), { code: "SLACK_HTTP_ERROR" });
      },
      async listUsers() { return { items: [] }; },
      async emoji() { return {}; },
    };
    const profile = { alias: "work", team_id: "T1", team_name: "Acme", actor_id: "U1", timezone: "UTC", kind: "user_token", keychain_accounts: ["T1:user:xoxp"], capabilities: {}, created_at: "2026-08-15T10:00:00Z", updated_at: "2026-08-15T10:00:00Z" } as const;
    const auth = { async clients() { return { profile, public: publicClient }; } } as unknown as AuthService;
    const cache = { async save(value: CacheSnapshot) { saved.push(structuredClone(value)); }, async load() { return undefined; } } as unknown as CacheStore;
    const app = new SlackAxiApp({ auth, cache });
    const result = await app.sync("work", { maxPages: 3 });
    expect(result.snapshot.conversations).toHaveLength(1);
    expect(result.snapshot.coverage.conversations).toMatchObject({ scanned: 1, complete: false, next_cursor: "next-conversations", error: { code: "SLACK_HTTP_ERROR" } });
    expect(result.snapshot.coverage.users.complete).toBe(true);
    expect(result.snapshot.coverage.inbox).toMatchObject({ complete: false, error: { code: "INBOX_FALLBACK_REQUIRED" } });
    expect(saved.some((value) => value.coverage.conversations.scanned === 1 && value.coverage.conversations.next_cursor === "next-conversations")).toBe(true);
  });

  it("invalidates a cursor issued from a progressively published snapshot when the snapshot grows", async () => {
    const saved: CacheSnapshot[] = [];
    let conversationPage = 0;
    const publicClient = {
      backendCalls: 0,
      async listConversations() {
        conversationPage += 1;
        return conversationPage === 1
          ? { items: [{ id: "C1", name: "first" }], next: "page-two" }
          : { items: [{ id: "C2", name: "second" }] };
      },
      async listUsers() { return { items: [] }; },
      async emoji() { return {}; },
    };
    const profile = { alias: "work", team_id: "T1", team_name: "Acme", actor_id: "U1", timezone: "UTC", kind: "user_token", keychain_accounts: ["T1:user:xoxp"], capabilities: {}, created_at: "2026-08-15T10:00:00Z", updated_at: "2026-08-15T10:00:00Z" } as const;
    const auth = { async clients() { return { profile, public: publicClient }; } } as unknown as AuthService;
    const cache = {
      async transaction<T>(operation: () => Promise<T>) { return operation(); },
      async save(value: CacheSnapshot) { saved.push(structuredClone(value)); },
      async load() { return undefined; },
    } as unknown as CacheStore;

    let revision = 0;
    const result = await new SlackAxiApp({ auth, cache, revisionFactory: () => `progress-${revision += 1}` }).sync("work", { maxPages: 2 });
    const firstPage = saved.find((value) => value.conversations.length === 1)!;
    const query = filterHash({ command: "conversation.list" });
    const integrity = new MemoryCursorIntegrity();
    const cursor = await createCacheCursor(firstPage, query, 1, integrity);

    expect(result.snapshot.conversations).toHaveLength(2);
    expect(new Set(saved.map((value) => value.revision)).size).toBe(saved.length);
    expect(saved.map((value) => value.revision)).toEqual(saved.map((_value, index) => `progress-${index + 2}`));
    await expect(parseCacheCursor(cursor, result.snapshot, query, "slack-axi conversation list", integrity)).rejects.toThrowError(/stale/i);
  });

  it("persists exact browser inbox totals when every conversation is classified", async () => {
    const publicClient = {
      backendCalls: 0,
      async listConversations() {
        return {
          items: [
            { id: "C1", name: "eng", is_ext_shared: false },
            { id: "D1", is_im: true, user: "U2", is_ext_shared: true },
          ],
        };
      },
      async listUsers() { return { items: [] }; },
      async emoji() { return {}; },
    };
    const browserClient = {
      backendCalls: 0,
      async counts() {
        return {
          channels: [{ id: "C1", has_unreads: false, mention_count: 0 }],
          mpims: [],
          ims: [{ id: "D1", has_unreads: true, mention_count: 2 }],
        };
      },
    };
    const profile = {
      alias: "work",
      team_id: "T1",
      team_name: "Acme",
      workspace_url: "https://acme.slack.com/",
      actor_id: "U1",
      timezone: "UTC",
      kind: "browser",
      keychain_accounts: credentialAccounts("T1", "browser", "generation-browser-1"),
      capabilities: {},
      created_at: "2026-08-15T10:00:00Z",
      updated_at: "2026-08-15T10:00:00Z",
    } satisfies AuthProfile;
    const auth = { async clients() { return { profile, public: publicClient, browser: browserClient }; } } as unknown as AuthService;
    const saved: CacheSnapshot[] = [];
    const cache = {
      async save(value: CacheSnapshot) { saved.push(structuredClone(value)); },
      async load() { return undefined; },
    } as unknown as CacheStore;

    const result = await new SlackAxiApp({ auth, cache }).sync("work", { maxPages: 1 });

    expect(result.snapshot.inbox).toMatchObject({ unread_conversations: 1, mentions: 2, exact: true });
    expect(result.snapshot.coverage.inbox).toEqual({ scanned: 2, complete: true });
    expect(saved.at(-1)?.inbox).toMatchObject({ unread_conversations: 1, mentions: 2, exact: true });
  });

});
