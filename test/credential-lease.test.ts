import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import { SlackAxiApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { cacheIdentity, CacheStore, type CacheSnapshot } from "../src/cache.js";
import { ConfigStore } from "../src/config.js";
import { credentialAccounts } from "../src/keychain.js";
import { applyAction, reconcileAction } from "../src/mutations.js";
import type { PublicSlackClient } from "../src/slack-public.js";
import type { AuthProfile } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function profile(): AuthProfile {
  return {
    alias: "work",
    team_id: "T1",
    team_name: "Acme",
    actor_id: "U1",
    actor_name: "Alice",
    timezone: "UTC",
    kind: "user_token",
    keychain_accounts: credentialAccounts("T1", "oldgeneration0001"),
    capabilities: { public_api: "supported" },
    created_at: "2026-08-15T10:00:00.000Z",
    updated_at: "2026-08-15T10:00:00.000Z",
  };
}

function snapshot(active: AuthProfile): CacheSnapshot {
  return {
    version: 2,
    revision: "lease-cache-1",
    ...cacheIdentity(active),
    synced_at: "2026-08-15T10:00:00.000Z",
    conversations: [],
    users: [],
    emoji: {},
    coverage: {
      conversations: { scanned: 0, complete: true },
      users: { scanned: 0, complete: true },
      emoji: { scanned: 0, complete: true },
      inbox: { scanned: 0, complete: false },
      backend_calls: 0,
    },
  };
}

function identityClient(actorId: string, postMessage: ReturnType<typeof vi.fn>): PublicSlackClient {
  return {
    backendCalls: 0,
    async authTest() { return { team_id: "T1", user_id: actorId, team: "Acme", user: actorId, url: "https://acme.slack.com/" }; },
    async userInfo() { return { id: actorId, tz: "UTC" }; },
    postMessage,
    async permalink() { return "https://acme.slack.com/archives/C1/p1786712345001200"; },
  } as unknown as PublicSlackClient;
}

async function harness(secrets: MemorySecrets, oldClient: PublicSlackClient, newClient = identityClient("U2", vi.fn())): Promise<{
  app: SlackAxiApp;
  auth: AuthService;
  actions: ActionStore;
  config: ConfigStore;
  action: Awaited<ReturnType<ActionStore["create"]>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-credential-lease-"));
  const config = new ConfigStore(path.join(root, "config.json"));
  const active = profile();
  await config.save({ version: 1, default_workspace: active.alias, profiles: [active] });
  secrets.values.set(active.keychain_accounts[0]!, "xoxp-old");
  const cache = new CacheStore(path.join(root, "cache"));
  await cache.save(snapshot(active));
  const actions = new ActionStore(path.join(root, "actions"), secrets);
  const action = await actions.create({
    workspace_id: "T1",
    actor_id: "U1",
    operation: "message.send",
    target_ids: ["C1"],
    preview: { text: "lease test" },
    payload: { conversation_id: "C1", text: "lease test", client_msg_id: "lease-client-id" },
  });
  const auth = new AuthService(
    config,
    secrets,
    (token) => token === "xoxp-old" ? oldClient : newClient,
    () => "newgeneration0001",
    cache,
    actions,
  );
  const app = new SlackAxiApp({ config, auth, cache, actions, secrets });
  return { app, auth, actions, config, action };
}

describe("credential-generation mutation leases", () => {
  it("does not let auth removal complete before a dispatched action is terminal", async () => {
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const postMessage = vi.fn(async () => {
      events.push("dispatch");
      entered.resolve();
      await release.promise;
      return { ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", user: "U1", text: "lease test" } };
    });
    const state = await harness(new MemorySecrets(), identityClient("U1", postMessage));

    const applying = applyAction(state.app, state.action, state.action.approval).then((result) => {
      events.push("apply-terminal");
      return result;
    });
    await entered.promise;
    let removalFinished = false;
    const removing = state.auth.remove("work").then((result) => {
      removalFinished = true;
      events.push("remove-complete");
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(removalFinished).toBe(false);

    release.resolve();
    const [applied] = await Promise.all([applying, removing]);

    expect(applied.state).toBe("applied");
    expect(events).toEqual(["dispatch", "apply-terminal", "remove-complete"]);
    expect(postMessage).toHaveBeenCalledOnce();
    await expect(state.actions.get(state.action.id)).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
  });

  it("does not let reauthentication switch generations before a dispatched action is terminal", async () => {
    const entered = deferred();
    const release = deferred();
    const newIdentityRead = deferred();
    const postMessage = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", user: "U1", text: "lease test" } };
    });
    const newClient = {
      ...identityClient("U2", vi.fn()),
      async authTest() {
        newIdentityRead.resolve();
        return { team_id: "T1", user_id: "U2", team: "Acme", user: "U2", url: "https://acme.slack.com/" };
      },
    } as unknown as PublicSlackClient;
    const state = await harness(new MemorySecrets(), identityClient("U1", postMessage), newClient);

    const applying = applyAction(state.app, state.action, state.action.approval);
    await entered.promise;
    let replacementFinished = false;
    let stateAtReplacement = "";
    const replacing = state.auth.add({ alias: "work", token: "xoxp-new" }).then(async (result) => {
      stateAtReplacement = (await state.actions.get(state.action.id)).state;
      replacementFinished = true;
      return result;
    });
    await newIdentityRead.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replacementFinished).toBe(false);

    release.resolve();
    const [applied, replacement] = await Promise.all([applying, replacing]);

    expect(applied.state).toBe("applied");
    expect(stateAtReplacement).toBe("applied");
    expect(replacement.actor_id).toBe("U2");
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("never dispatches with a retained client after removal won the lease", async () => {
    const deleteEntered = deferred();
    const deleteRelease = deferred();
    class BlockingDeleteSecrets extends MemorySecrets {
      override async delete(account: string): Promise<boolean> {
        if (account.includes("oldgeneration0001")) {
          deleteEntered.resolve();
          await deleteRelease.promise;
        }
        return super.delete(account);
      }
    }
    const postMessage = vi.fn();
    const state = await harness(new BlockingDeleteSecrets(), identityClient("U1", postMessage));

    const removing = state.auth.remove("work");
    await deleteEntered.promise;
    const applying = applyAction(state.app, state.action, state.action.approval).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    deleteRelease.resolve();
    await removing;

    const outcome = await applying;
    expect(outcome).toMatchObject({ ok: false, error: { code: "ACTION_NOT_FOUND" } });
    expect(postMessage).not.toHaveBeenCalled();
    await expect(state.actions.get(state.action.id)).rejects.toMatchObject({ code: "ACTION_NOT_FOUND" });
  });

  it("never dispatches with a retained client after reauthentication won the lease", async () => {
    const setEntered = deferred();
    const setRelease = deferred();
    class BlockingSetSecrets extends MemorySecrets {
      override async set(account: string, secret: string): Promise<void> {
        if (account.includes("newgeneration0001")) {
          setEntered.resolve();
          await setRelease.promise;
        }
        await super.set(account, secret);
      }
    }
    const postMessage = vi.fn();
    const state = await harness(new BlockingSetSecrets(), identityClient("U1", postMessage));

    const replacing = state.auth.add({ alias: "work", token: "xoxp-new" });
    await setEntered.promise;
    const applying = applyAction(state.app, state.action, state.action.approval);
    setRelease.resolve();
    const replacement = await replacing;

    expect(replacement.actor_id).toBe("U2");
    await expect(applying).rejects.toMatchObject({ code: "ACTION_IDENTITY_MISMATCH" });
    expect(postMessage).not.toHaveBeenCalled();
    expect((await state.actions.get(state.action.id)).state).toBe("planned");
    expect((await state.config.resolve()).actor_id).toBe("U2");
  });

  it("holds the same generation lease through reconciliation state persistence", async () => {
    const readEntered = deferred();
    const readRelease = deferred();
    const newIdentityRead = deferred();
    const oldClient = {
      ...identityClient("U1", vi.fn()),
      async history() {
        readEntered.resolve();
        await readRelease.promise;
        return { items: [{ ts: "1786712345.001200", client_msg_id: "lease-client-id" }], complete: true };
      },
    } as unknown as PublicSlackClient;
    const newClient = {
      ...identityClient("U2", vi.fn()),
      async authTest() {
        newIdentityRead.resolve();
        return { team_id: "T1", user_id: "U2", team: "Acme", user: "U2", url: "https://acme.slack.com/" };
      },
    } as unknown as PublicSlackClient;
    const state = await harness(new MemorySecrets(), oldClient, newClient);
    const applying = await state.actions.transition(state.action, "applying");
    const unknown = await state.actions.transition(applying, "unknown", {
      result: { recovery: { conversation_id: "C1", client_msg_id: "lease-client-id" } },
      last_error: { code: "REQUEST_TIMEOUT", message: "uncertain", at: new Date().toISOString() },
    });

    const reconciling = reconcileAction(state.app, unknown);
    await readEntered.promise;
    let replacementFinished = false;
    const replacing = state.auth.add({ alias: "work", token: "xoxp-new" }).then(async (result) => {
      expect((await state.actions.get(state.action.id)).state).toBe("applied");
      replacementFinished = true;
      return result;
    });
    await newIdentityRead.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(replacementFinished).toBe(false);

    readRelease.resolve();
    const [reconciled, replacement] = await Promise.all([reconciling, replacing]);

    expect(reconciled.state).toBe("applied");
    expect(replacement.actor_id).toBe("U2");
  });
});
