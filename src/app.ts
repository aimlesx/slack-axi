import { randomUUID } from "node:crypto";
import { ActionStore } from "./actions.js";
import { AuthService, type WorkspaceClients } from "./auth.js";
import { cacheIdentity, CacheStore, type CacheSnapshot } from "./cache.js";
import { ConfigStore } from "./config.js";
import { entityMaps } from "./domain.js";
import { AxiError } from "./errors.js";
import { NativeKeychain, type SecretStore } from "./keychain.js";
import { PolicyStore } from "./policy.js";
import { browserCountEntries } from "./slack-browser.js";
import type { AuthProfile, CachedAuthor, Conversation, User, WorkspaceIdentity } from "./types.js";

export interface WorkspaceContext extends WorkspaceClients {
  snapshot: CacheSnapshot;
  conversations: Conversation[];
  users: User[];
  userMap: Map<string, CachedAuthor>;
}

type ColdCacheMode = "sync" | "conversations" | "entities" | "empty";

export class SlackAxiApp {
  readonly config: ConfigStore;
  readonly auth: AuthService;
  readonly cache: CacheStore;
  readonly policy: PolicyStore;
  readonly actions: ActionStore;
  private readonly revisionFactory: () => string;

  constructor(dependencies: {
    config?: ConfigStore;
    auth?: AuthService;
    cache?: CacheStore;
    policy?: PolicyStore;
    actions?: ActionStore;
    secrets?: SecretStore;
    revisionFactory?: () => string;
  } = {}) {
    const secrets = dependencies.secrets ?? new NativeKeychain();
    this.config = dependencies.config ?? new ConfigStore();
    this.cache = dependencies.cache ?? new CacheStore();
    this.policy = dependencies.policy ?? new PolicyStore();
    this.actions = dependencies.actions ?? new ActionStore(undefined, secrets);
    this.auth = dependencies.auth ?? new AuthService(this.config, secrets, undefined, undefined, this.cache, this.actions);
    this.revisionFactory = dependencies.revisionFactory ?? randomUUID;
  }

  identity(profile: AuthProfile): WorkspaceIdentity {
    return { id: profile.team_id, alias: profile.alias, actor_id: profile.actor_id, auth_kind: profile.kind };
  }

  private emptySnapshot(profile: AuthProfile): CacheSnapshot {
    return {
      version: 2,
      revision: this.revisionFactory(),
      ...cacheIdentity(profile),
      synced_at: new Date().toISOString(),
      conversations: [],
      users: [],
      emoji: {},
      coverage: {
        conversations: { scanned: 0, complete: false },
        users: { scanned: 0, complete: false },
        emoji: { scanned: 0, complete: false },
        inbox: { scanned: 0, complete: false },
        backend_calls: 0,
      },
    };
  }

  private async syncForClients(clients: WorkspaceClients, options: { maxPages?: number; transient?: "conversations" | "entities" }): Promise<{ clients: WorkspaceClients; snapshot: CacheSnapshot }> {
    const cacheTransaction = (this.cache as unknown as { transaction?: <T>(operation: () => Promise<T>) => Promise<T> }).transaction;
    const publish = async (): Promise<{ clients: WorkspaceClients; snapshot: CacheSnapshot }> => {
    const maxPages = options.maxPages ?? 2;
    const snapshot = this.emptySnapshot(clients.profile);
    const { conversations, users } = snapshot;
    let backendCalls = 0;
    const save = async (): Promise<void> => {
      // Each visible progressive snapshot is a distinct immutable observation.
      // A cursor issued from any earlier page must become stale after growth.
      snapshot.revision = this.revisionFactory();
      snapshot.coverage.backend_calls = Math.max(backendCalls, clients.public.backendCalls + (clients.browser?.backendCalls ?? 0));
      if (!options.transient) await this.cache.save(snapshot);
    };
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      try {
        backendCalls += 1;
        const result = await clients.public.listConversations(200, cursor);
        conversations.push(...result.items);
        cursor = result.next;
        snapshot.coverage.conversations = { scanned: conversations.length, complete: !cursor, ...(cursor ? { next_cursor: cursor } : {}) };
        await save();
        if (!cursor) break;
      } catch (error) {
        snapshot.coverage.conversations = { scanned: conversations.length, complete: false, ...(cursor ? { next_cursor: cursor } : {}), error: { code: error instanceof Error && "code" in error ? String(error.code) : "SLACK_API_ERROR", message: error instanceof Error ? error.message : String(error) } };
        await save();
        break;
      }
    }
    if (options.transient === "conversations") return { clients, snapshot };
    cursor = undefined;
    for (let page = 0; page < maxPages; page += 1) {
      try {
        backendCalls += 1;
        const result = await clients.public.listUsers(200, cursor);
        users.push(...result.items);
        cursor = result.next;
        snapshot.coverage.users = { scanned: users.length, complete: !cursor, ...(cursor ? { next_cursor: cursor } : {}) };
        await save();
        if (!cursor) break;
      } catch (error) {
        snapshot.coverage.users = { scanned: users.length, complete: false, ...(cursor ? { next_cursor: cursor } : {}), error: { code: error instanceof Error && "code" in error ? String(error.code) : "SLACK_API_ERROR", message: error instanceof Error ? error.message : String(error) } };
        await save();
        break;
      }
    }
    if (options.transient === "entities") return { clients, snapshot };
    try {
      backendCalls += 1;
      snapshot.emoji = await clients.public.emoji();
      snapshot.coverage.emoji = { scanned: Object.keys(snapshot.emoji).length, complete: true };
    } catch (error) {
      snapshot.coverage.emoji = { scanned: 0, complete: false, error: { code: error instanceof Error && "code" in error ? String(error.code) : "SLACK_API_ERROR", message: error instanceof Error ? error.message : String(error) } };
    }
    await save();
    if (clients.browser) {
      try {
        backendCalls += 1;
        const counts = await clients.browser.counts();
        const entries = browserCountEntries(counts);
        snapshot.inbox = {
          unread_conversations: entries.filter((item) => item.timeline?.has_unreads || (item.thread_unread_count ?? 0) > 0 || (item.thread_mentions ?? 0) > 0).length,
          mentions: entries.reduce((total, item) => total + (item.timeline?.mention_count ?? 0), 0),
          thread_coverage: counts.thread_coverage,
          thread_unread_count: counts.threads ? entries.reduce((total, item) => total + (item.thread_unread_count ?? 0), 0) : null,
          thread_mentions: counts.threads ? entries.reduce((total, item) => total + (item.thread_mentions ?? 0), 0) : null,
          exact: counts.thread_coverage === "available",
          synced_at: new Date().toISOString(),
        };
        const conversationById = new Map(conversations.map((item) => [String(item.id ?? ""), item]));
        const unclassified = entries.filter((item) => typeof conversationById.get(item.id)?.is_ext_shared !== "boolean").length;
        snapshot.coverage.inbox = counts.thread_coverage !== "available"
          ? { scanned: entries.length, complete: false, error: { code: "INBOX_THREADS_UNAVAILABLE", message: `The Slack thread counts section is ${counts.thread_coverage}.` } }
          : unclassified === 0 && snapshot.coverage.conversations.complete
          ? { scanned: entries.length, complete: true }
          : {
              scanned: entries.length,
              complete: false,
              error: {
                code: "INBOX_CLASSIFICATION_INCOMPLETE",
                message: `${unclassified} inbox conversations lack authoritative external-sharing metadata.`,
              },
            };
      } catch (error) {
        snapshot.coverage.inbox = {
          scanned: 0,
          complete: false,
          error: {
            code: error instanceof Error && "code" in error ? String(error.code) : "BROWSER_CAPABILITY_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    } else {
      snapshot.coverage.inbox = { scanned: 0, complete: false, error: { code: "INBOX_FALLBACK_REQUIRED", message: "User-token inbox state is probed live with bounded conversations.info calls." } };
    }
    await save();
    return { clients, snapshot };
    };
    return !options.transient && typeof cacheTransaction === "function"
      ? cacheTransaction.call(this.cache, publish) as Promise<{ clients: WorkspaceClients; snapshot: CacheSnapshot }>
      : publish();
  }

  private async withSelectedClients<T>(selector: string | undefined, operation: (clients: WorkspaceClients) => Promise<T>): Promise<T> {
    const leased = (this.auth as unknown as {
      withCredentialLease?: <Value>(selected: string | undefined, callback: (clients: WorkspaceClients) => Promise<Value>) => Promise<Value>;
    }).withCredentialLease;
    return typeof leased === "function"
      ? leased.call(this.auth, selector, operation) as Promise<T>
      : operation(await this.auth.clients(selector));
  }

  async sync(selector?: string, options: { maxPages?: number } = {}): Promise<{ clients: WorkspaceClients; snapshot: CacheSnapshot }> {
    return this.withSelectedClients(selector, (clients) => this.syncForClients(clients, options));
  }

  async context(selector?: string, refresh = false, coldCache: ColdCacheMode = "sync"): Promise<WorkspaceContext> {
    // Resolve clients, select/load (or populate) their exact cache scope, and
    // build the context under one credential-generation lease. Without this,
    // an authentication replacement during a cache miss could pair the old
    // client/profile with a snapshot populated by the replacement client.
    return this.withSelectedClients(selector, (clients) => this.contextForClients(clients, refresh, coldCache));
  }

  private async contextForClients(clients: WorkspaceClients, refresh: boolean, coldCache: ColdCacheMode = "sync"): Promise<WorkspaceContext> {
    const expected = cacheIdentity(clients.profile);
    let snapshot = refresh ? undefined : await this.cache.load(expected);
    if (!snapshot) {
      snapshot = coldCache === "empty" ? this.emptySnapshot(clients.profile)
        : (await this.syncForClients(clients, coldCache === "sync" ? {} : { transient: coldCache })).snapshot;
    }
    if (snapshot.team_id !== expected.team_id
      || snapshot.actor_id !== expected.actor_id
      || snapshot.credential_generation !== expected.credential_generation) {
      throw new AxiError({
        code: "CACHE_IDENTITY_MISMATCH",
        message: "The cache snapshot does not belong to the selected workspace actor and credential generation.",
      });
    }
    const entities = entityMaps(snapshot);
    return { ...clients, snapshot, ...entities };
  }

  async withContextLease<T>(selector: string | undefined, operation: (context: WorkspaceContext) => Promise<T>, refresh = false): Promise<T> {
    return this.withSelectedClients(selector, async (clients) => operation(await this.contextForClients(clients, refresh)));
  }
}
