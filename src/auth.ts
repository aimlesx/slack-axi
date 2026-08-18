import { AxiError, redact } from "./errors.js";
import type { ActionStore, WorkspaceActionPurgeResult } from "./actions.js";
import type { CachePurgeResult, CacheStore } from "./cache.js";
import { ConfigStore } from "./config.js";
import { credentialAccounts, newCredentialGeneration, type SecretStore } from "./keychain.js";
import { BrowserSlackClient } from "./slack-browser.js";
import { PublicSlackClient, slackGrantedScopes, slackRecord } from "./slack-public.js";
import type { AuthKind, AuthProfile, CapabilityStatus } from "./types.js";

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const browserTokenPattern = /^xoxc-(?:[A-Za-z0-9._~+/=-]|%[A-Fa-f0-9]{2})+$/;
const browserCookiePattern = /^xoxd-(?:[A-Za-z0-9._~+/=-]|%[A-Fa-f0-9]{2})+$/;
const userTokenPattern = /^xoxp-[A-Za-z0-9._~+/=-]+$/;

function browserApiBaseUrl(workspaceUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(workspaceUrl);
  } catch (cause) {
    throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack authentication returned an invalid browser workspace URL.", cause });
  }
  const host = parsed.hostname.toLowerCase();
  const labels = host.endsWith(".slack.com") ? host.slice(0, -".slack.com".length).split(".") : [];
  if (parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || !["", "/"].includes(parsed.pathname)
    || labels.length === 0
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /^(?:api|app|edge|files|hooks|downloads?|status)(?:-|$)/.test(labels[0]!)) {
    throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack authentication did not return a supported HTTPS workspace URL for browser capabilities." });
  }
  return `${parsed.origin}/api`;
}

export interface WorkspaceClients {
  profile: AuthProfile;
  public: PublicSlackClient;
  browser?: BrowserSlackClient;
}

export interface AuthRemovalResult {
  profile: AuthProfile;
  credentials_removed: boolean;
  cache_scopes_removed: number;
  action_records_removed: number;
}

export interface CapabilityDiagnostic {
  status: CapabilityStatus;
  detail?: string;
  required_scopes?: string[];
  missing_scopes?: string[];
}

export const AUTH_SCOPE_REQUIREMENTS = Object.freeze({
  conversations: ["channels:read", "groups:read", "im:read", "mpim:read"],
  message_history: ["channels:history", "groups:history", "im:history", "mpim:history"],
  users: ["users:read"],
  user_email: ["users:read.email"],
  usergroups: ["usergroups:read"],
  emoji: ["emoji:read"],
  search: ["search:read"],
  reaction_read: ["reactions:read"],
  reaction_write: ["reactions:write"],
  message_write: ["chat:write"],
  file_read: ["files:read"],
  file_write: ["files:write"],
  mark_read: ["channels:write", "groups:write", "im:write", "mpim:write"],
  dm_open: ["im:write"],
} as const);

type PublicClientFactory = (token: string, cookie?: string) => PublicSlackClient;
type BrowserClientFactory = (token: string, cookie: string, baseUrl: string) => BrowserSlackClient;
type CredentialGenerationFactory = () => string;

function sameAccounts(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((account, index) => account === right[index]);
}

function scopeCapabilities(grantedScopes: string[] | undefined): Record<string, CapabilityDiagnostic> {
  const granted = new Set(grantedScopes ?? []);
  return Object.fromEntries(Object.entries(AUTH_SCOPE_REQUIREMENTS).map(([name, required]) => {
    const requiredScopes = [...required];
    if (grantedScopes === undefined) {
      return [name, {
        status: "degraded",
        required_scopes: requiredScopes,
        detail: "Slack did not expose granted OAuth scopes; support could not be verified.",
      } satisfies CapabilityDiagnostic];
    }
    const missingScopes = requiredScopes.filter((scope) => !granted.has(scope));
    const present = requiredScopes.length - missingScopes.length;
    const status: CapabilityStatus = missingScopes.length === 0
      ? "supported"
      : present > 0
        ? "degraded"
        : "unavailable";
    return [name, {
      status,
      required_scopes: requiredScopes,
      ...(missingScopes.length ? { missing_scopes: missingScopes } : {}),
      ...(missingScopes.length ? { detail: `Missing OAuth scopes: ${missingScopes.join(", ")}.` } : {}),
    } satisfies CapabilityDiagnostic];
  }));
}

function completeCapabilities(publicApi: CapabilityDiagnostic, grantedScopes: string[] | undefined): Record<string, CapabilityDiagnostic> {
  const scoped = scopeCapabilities(grantedScopes);
  const conversations = scoped.conversations!;
  return {
    public_api: publicApi,
    ...scoped,
    unread_counts: {
      status: conversations.status === "unavailable" ? "unavailable" : "degraded",
      detail: conversations.status === "unavailable"
        ? "Unread probing is unavailable without a conversation-read scope."
        : "A bounded public-API fallback is used and cannot establish mention or mute state.",
      ...(conversations.required_scopes ? { required_scopes: conversations.required_scopes } : {}),
      ...(conversations.missing_scopes ? { missing_scopes: conversations.missing_scopes } : {}),
    },
    mention_counts: { status: "unavailable", detail: "Slack exposes no supported public API for exact per-conversation mention counts." },
    muted_channels: { status: "unavailable", detail: "Slack exposes no supported public API for a user's muted-channel preferences." },
    later: { status: "unavailable", detail: "Slack exposes no supported public Save for Later API." },
  };
}

function unprobedBrowserCapabilities(): Record<string, CapabilityDiagnostic> {
  const detail = "The browser-private capability has not been probed; run auth doctor.";
  return {
    public_api: { status: "supported" },
    ...scopeCapabilities(undefined),
    unread_counts: { status: "degraded", detail },
    mention_counts: { status: "degraded", detail },
    muted_channels: { status: "degraded", detail },
    later: { status: "degraded", detail },
  };
}

export class AuthService {
  constructor(
    private readonly config: ConfigStore,
    private readonly secrets: SecretStore,
    private readonly publicFactory: PublicClientFactory = (token, cookie) => new PublicSlackClient(token, { ...(cookie ? { cookie } : {}) }),
    private readonly generationFactory: CredentialGenerationFactory = newCredentialGeneration,
    private readonly cache?: CacheStore,
    private readonly actions?: Pick<ActionStore, "purgeWorkspace">,
    private readonly browserFactory: BrowserClientFactory = (token, cookie, baseUrl) => new BrowserSlackClient(token, cookie, { baseUrl }),
  ) {}

  private async deleteAccounts(accounts: string[]): Promise<{ deleted: string[]; failed: string[] }> {
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const account of accounts) {
      try {
        await this.secrets.delete(account);
        deleted.push(account);
      } catch {
        failed.push(account);
      }
    }
    return { deleted, failed };
  }

  private async clearCredentialCleanupRecords(accounts: string[]): Promise<{ code: string; cleanup_tracking_complete: false } | undefined> {
    if (accounts.length === 0) return undefined;
    try {
      await this.config.clearPendingCleanup(accounts);
      return undefined;
    } catch {
      // Clearing the ledger is bookkeeping, not proof that the underlying
      // profile mutation or deletion did not happen. Leaving entries in place
      // is conservative: doctor retries missing-account deletion idempotently,
      // and never deletes an account referenced by an active profile.
      return { code: "CREDENTIAL_CLEANUP_TRACKING_FAILED", cleanup_tracking_complete: false };
    }
  }

  private async purgeCacheTeams(teamIds: string[]): Promise<{ result?: CachePurgeResult; failure?: { code: string; message: string; team_ids: string[] } }> {
    const requested = [...new Set(teamIds)];
    if (!this.cache || requested.length === 0) return {};
    try {
      const result = await this.cache.purgeTeams(requested);
      await this.config.clearPendingCacheCleanup(requested);
      return { result };
    } catch (error) {
      return {
        failure: {
          code: error instanceof Error && "code" in error ? String(error.code) : "CACHE_PURGE_FAILED",
          message: redact(error instanceof Error ? error.message : String(error)),
          team_ids: requested,
        },
      };
    }
  }

  async add(options: { alias: string; kind?: AuthKind; token: string; cookie?: string }): Promise<AuthProfile> {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(options.alias)) throw new AxiError({ code: "ALIAS_INVALID", message: "Workspace alias must contain only letters, numbers, underscores, and hyphens.", exitCode: 2 });
    const kind: AuthKind = options.kind ?? (options.token.startsWith("xoxc-") ? "browser" : "user_token");
    if (kind === "browser" && (!browserTokenPattern.test(options.token) || !options.cookie || !browserCookiePattern.test(options.cookie))) {
      throw new AxiError({ code: "CREDENTIAL_INVALID", message: "Browser authentication requires xoxc and xoxd credentials.", exitCode: 2 });
    }
    if (kind === "user_token" && (!userTokenPattern.test(options.token) || options.cookie !== undefined)) {
      throw new AxiError({ code: "CREDENTIAL_INVALID", message: "User-token authentication requires an xoxp credential.", exitCode: 2 });
    }
    const client = this.publicFactory(options.token, kind === "browser" ? options.cookie : undefined);
    const identity = await client.authTest();
    const grantedScopes = kind === "user_token" ? slackGrantedScopes(identity) : undefined;
    const teamId = string(identity.team_id);
    const actorId = string(identity.user_id);
    if (!teamId || !actorId) throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack authentication did not return team and user IDs." });
    const workspaceUrl = string(identity.url);
    if (kind === "browser") browserApiBaseUrl(workspaceUrl);
    // Date-only and offset-free command ranges are interpreted in the Slack
    // actor's timezone. Never substitute the local Mac timezone when the
    // authoritative users.info read fails or drifts: that would silently move
    // read/catch-up windows by hours (and across DST boundaries).
    const self = slackRecord(await client.userInfo(actorId));
    const timezone = string(self.tz);
    if (!timezone) throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack users.info did not return the authenticated actor's timezone." });
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch (cause) {
      throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack users.info returned an invalid authenticated-actor timezone.", cause });
    }
    return this.config.transaction(async () => {
    const configBefore = await this.config.load();
    const aliasMatch = configBefore.profiles.find((item) => item.alias === options.alias);
    const teamMatch = configBefore.profiles.find((item) => item.team_id === teamId);
    if (aliasMatch && teamMatch && aliasMatch !== teamMatch) {
      throw new AxiError({
        code: "WORKSPACE_ALIAS_CONFLICT",
        message: `Workspace alias '${options.alias}' is already assigned to a different Slack team.`,
        exitCode: 2,
        details: {
          alias_profile: { alias: aliasMatch.alias, team_id: aliasMatch.team_id },
          authenticated_team: { alias: teamMatch.alias, team_id: teamMatch.team_id },
        },
      });
    }
    const reservedAccounts = new Set([
      ...configBefore.profiles.flatMap((profile) => profile.keychain_accounts),
      ...(configBefore.pending_credential_cleanup ?? []),
    ]);
    let accounts: string[] | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = this.generationFactory();
      if (!/^[A-Za-z0-9_-]{16,}$/.test(generation)) throw new AxiError({ code: "CREDENTIAL_GENERATION_INVALID", message: "The local credential generation identifier is invalid." });
      const candidate = credentialAccounts(teamId, kind, generation);
      if (candidate.every((account) => !reservedAccounts.has(account))) {
        accounts = candidate;
        break;
      }
    }
    if (!accounts) throw new AxiError({ code: "CREDENTIAL_GENERATION_FAILED", message: "Could not allocate a fresh Keychain credential generation." });
    const replaced = configBefore.profiles.filter((item) => item.alias === options.alias || item.team_id === teamId);
    const cacheCleanupTeams = [...new Set([teamId, ...replaced.map((item) => item.team_id)])];
    const oldAccounts = [...new Set(replaced.flatMap((profile) => profile.keychain_accounts))];
    // Record the fresh generation as cleanup work before writing it. If the
    // process dies before the profile pointer switch, doctor can safely remove
    // the orphan while the old profile and credentials remain untouched.
    await this.config.addPendingCleanup(accounts);
    try {
      await this.secrets.set(accounts[0]!, options.token);
      if (kind === "browser") await this.secrets.set(accounts[1]!, options.cookie!);
    } catch (error) {
      const cleanup = await this.deleteAccounts(accounts);
      if (cleanup.deleted.length) await this.config.clearPendingCleanup(cleanup.deleted).catch(() => undefined);
      throw error;
    }
    const now = new Date().toISOString();
    const capabilities = kind === "browser"
      ? unprobedBrowserCapabilities()
      : completeCapabilities({ status: "supported" }, grantedScopes);
    const profile: AuthProfile = {
      alias: options.alias,
      team_id: teamId,
      team_name: string(identity.team, teamId),
      ...(workspaceUrl ? { workspace_url: workspaceUrl } : {}),
      actor_id: actorId,
      actor_name: string(identity.user, actorId),
      timezone,
      kind,
      keychain_accounts: accounts,
      capabilities: Object.fromEntries(Object.entries(capabilities).map(([name, value]) => [name, value.status])),
      ...(kind === "user_token" ? { capability_probed_at: now } : {}),
      created_at: replaced[0]?.created_at ?? now,
      updated_at: now,
    };
    let switched = false;
    try {
      await this.config.upsert(profile, { ...(this.cache ? { cacheCleanupTeamIds: cacheCleanupTeams } : {}) });
      switched = true;
    } catch (error) {
      // A config write can fail after rename. Reload before rollback so fresh
      // credentials are never deleted out from under a visible active pointer.
      let visible;
      try {
        visible = await this.config.load();
      } catch (verificationError) {
        // An unreadable verification is not evidence that the atomic pointer
        // switch lost. Keep the fresh generation: it is either the active
        // credential or remains durably listed as pending cleanup for doctor.
        throw new AxiError({
          code: "AUTH_COMMIT_UNKNOWN",
          message: "The authentication profile update could not be verified; fresh credentials were retained to avoid breaking a possibly active profile.",
          suggestedCommand: "slack-axi auth list",
          details: { pointer_verification_complete: false, fresh_credentials_retained: true },
          cause: verificationError,
        });
      }
      switched = visible.profiles.some((item) =>
        item.alias === profile.alias
        && item.team_id === profile.team_id
        && item.actor_id === profile.actor_id
        && item.kind === profile.kind
        && sameAccounts(item.keychain_accounts, accounts));
      if (!switched) {
        const cleanup = await this.deleteAccounts(accounts);
        if (cleanup.deleted.length) await this.config.clearPendingCleanup(cleanup.deleted).catch(() => undefined);
        throw error;
      }
      // Visibility after a failed parent-directory sync is not enough before
      // retiring the old credential generation. Rewrite the verified target
      // under the same transaction so a successful return proves the pointer
      // durable; otherwise retain both generations and report uncertainty.
      try {
        await this.config.save(visible);
      } catch (durabilityError) {
        throw new AxiError({
          code: "AUTH_COMMIT_UNKNOWN",
          message: "The authentication profile is visible but could not be verified durable; old and fresh credentials were retained.",
          suggestedCommand: "slack-axi auth list",
          details: { pointer_visibility_verified: true, pointer_durability_verified: false, credentials_retained: true },
          cause: durabilityError,
        });
      }
    }

    const obsolete = oldAccounts.filter((account) => !accounts.includes(account));
    const cleanup = await this.deleteAccounts(obsolete);
    const cleanupTracking = await this.clearCredentialCleanupRecords(cleanup.deleted);
    const cacheCleanup = await this.purgeCacheTeams(cacheCleanupTeams);
    if (cleanup.failed.length || cleanupTracking || cacheCleanup.failure) {
      throw new AxiError({
        code: "AUTH_REMOVE_PARTIAL",
        message: "The new profile is active, but obsolete local authentication data could not all be removed.",
        suggestedCommand: "slack-axi auth doctor",
        details: {
          profile_alias: profile.alias,
          profile_active: true,
          ...(cleanup.failed.length ? { pending_cleanup: cleanup.failed } : {}),
          ...(cleanupTracking ? { cleanup_tracking: cleanupTracking } : {}),
          ...(cacheCleanup.failure ? { cache_cleanup: cacheCleanup.failure } : {}),
        },
      });
    }
    return profile;
    });
  }

  async clients(selector?: string): Promise<WorkspaceClients> {
    return this.config.transaction(async () => {
      const profile = await this.config.resolve(selector);
      const token = await this.secrets.get(profile.keychain_accounts[0]!);
      if (profile.kind === "browser") {
        const cookieAccount = profile.keychain_accounts[1];
        if (!cookieAccount || !profile.workspace_url) {
          throw new AxiError({ code: "AUTH_PROFILE_INVALID", message: "The browser authentication profile is incomplete." });
        }
        const cookie = await this.secrets.get(cookieAccount);
        return {
          profile,
          public: this.publicFactory(token, cookie),
          browser: this.browserFactory(token, cookie, browserApiBaseUrl(profile.workspace_url)),
        };
      }
      return { profile, public: this.publicFactory(token) };
    });
  }

  /**
   * Hold the process-owned configuration lease for the selected credential
   * generation until the caller's identity-sensitive work is durably done.
   * Auth replacement and removal use the same lock and therefore cannot
   * retire this client's Keychain pointers while the lease is live.
   */
  async withCredentialLease<T>(selector: string | undefined, operation: (clients: WorkspaceClients) => Promise<T>): Promise<T> {
    return this.config.transaction(async () => operation(await this.clients(selector)), { preserveActionOutcome: true });
  }

  async withClients<T>(selector: string | undefined, operation: (clients: WorkspaceClients) => Promise<T>): Promise<T> {
    return this.withCredentialLease(selector, operation);
  }

  async remove(selector: string): Promise<AuthRemovalResult> {
    if (!this.actions) {
      throw new AxiError({
        code: "ACTION_CLEANUP_UNAVAILABLE",
        message: "Authentication removal requires the workspace action store so local action data can be purged safely.",
      });
    }
    const removed = await this.config.beginRemoval(selector);
    let actionCleanup: WorkspaceActionPurgeResult;
    try {
      actionCleanup = await this.actions.purgeWorkspace(removed.team_id);
    } catch (error) {
      throw new AxiError({
        code: "AUTH_REMOVE_PARTIAL",
        message: "Workspace removal is paused because local action data could not be purged safely.",
        retryable: true,
        suggestedCommand: `slack-axi auth remove ${removed.alias}`,
        details: {
          removed: { alias: removed.alias, team_id: removed.team_id },
          profile_removed: false,
          workspace_removing: true,
          action_cleanup: {
            code: error instanceof Error && "code" in error ? String(error.code) : "ACTION_PURGE_FAILED",
            message: redact(error instanceof Error ? error.message : String(error)),
          },
        },
        cause: error,
      });
    }
    if (!actionCleanup.complete) {
      throw new AxiError({
        code: "AUTH_REMOVE_PARTIAL",
        message: "Workspace removal is paused because some local action data could not be classified or deleted safely.",
        retryable: true,
        suggestedCommand: `slack-axi auth remove ${removed.alias}`,
        details: {
          removed: { alias: removed.alias, team_id: removed.team_id },
          profile_removed: false,
          workspace_removing: true,
          action_cleanup: actionCleanup,
        },
      });
    }

    return this.config.transaction(async () => {
      try {
        await this.config.remove(selector, { stageCacheCleanup: Boolean(this.cache) });
      } catch (error) {
        let visible;
        try {
          visible = await this.config.load();
        } catch (verificationError) {
          throw new AxiError({
            code: "AUTH_COMMIT_UNKNOWN",
            message: "The workspace removal could not be verified; credentials were retained to avoid breaking a possibly active profile.",
            suggestedCommand: "slack-axi auth list",
            details: { removal_verification_complete: false, credentials_retained: true },
            cause: verificationError,
          });
        }
        const stillActive = visible.profiles.some((profile) =>
          profile.alias === removed.alias
          && profile.team_id === removed.team_id
          && profile.actor_id === removed.actor_id
          && profile.kind === removed.kind
          && sameAccounts(profile.keychain_accounts, removed.keychain_accounts));
        if (stillActive) throw error;
        // The all-or-nothing remove record (profile absent + cleanup pending)
        // is visible. Re-persist it before touching Keychain so a late rename
        // error can never leave a restored profile pointing at deleted secrets.
        try {
          await this.config.save(visible);
        } catch (durabilityError) {
          throw new AxiError({
            code: "AUTH_COMMIT_UNKNOWN",
            message: "The workspace removal is visible but could not be verified durable; credentials were retained.",
            suggestedCommand: "slack-axi auth list",
            details: { removal_visibility_verified: true, removal_durability_verified: false, credentials_retained: true },
            cause: durabilityError,
          });
        }
      }
      const cleanup = await this.deleteAccounts(removed.keychain_accounts);
      const cleanupTracking = await this.clearCredentialCleanupRecords(cleanup.deleted);
      const cacheCleanup = await this.purgeCacheTeams([removed.team_id]);
      if (cleanup.failed.length || cleanupTracking || cacheCleanup.failure) {
        throw new AxiError({
          code: "AUTH_REMOVE_PARTIAL",
          message: "The workspace profile was removed, but some local authentication data remains pending cleanup.",
          suggestedCommand: "slack-axi auth doctor",
          details: {
            removed: { alias: removed.alias, team_id: removed.team_id },
            profile_removed: true,
            ...(cleanup.failed.length ? { pending_cleanup: cleanup.failed } : {}),
            ...(cleanupTracking ? { cleanup_tracking: cleanupTracking } : {}),
            ...(cacheCleanup.failure ? { cache_cleanup: cacheCleanup.failure } : {}),
          },
        });
      }
      return {
        profile: removed,
        credentials_removed: true,
        action_records_removed: actionCleanup.removed,
        cache_scopes_removed: cacheCleanup.result
          ? cacheCleanup.result.removed_scopes + cacheCleanup.result.removed_legacy_scopes
          : 0,
      };
    });
  }

  private async retryPendingCleanup(): Promise<string[]> {
    const config = await this.config.load();
    const active = new Set(config.profiles.flatMap((profile) => profile.keychain_accounts));
    const staleActiveEntries = (config.pending_credential_cleanup ?? []).filter((account) => active.has(account));
    const staleTracking = await this.clearCredentialCleanupRecords(staleActiveEntries);
    if (staleTracking) {
      throw new AxiError({
        code: "AUTH_REMOVE_PARTIAL",
        message: "Authentication cleanup records could not be reconciled.",
        suggestedCommand: "slack-axi auth doctor",
        details: { cleanup_tracking: staleTracking },
      });
    }
    const pending = (config.pending_credential_cleanup ?? []).filter((account) => !active.has(account));
    if (!pending.length) return [];
    const result = await this.deleteAccounts(pending);
    const deletedTracking = await this.clearCredentialCleanupRecords(result.deleted);
    if (deletedTracking) {
      throw new AxiError({
        code: "AUTH_REMOVE_PARTIAL",
        message: "Obsolete credentials were deleted, but their cleanup records could not be reconciled.",
        suggestedCommand: "slack-axi auth doctor",
        details: { cleanup_tracking: deletedTracking },
      });
    }
    return result.failed;
  }

  private async retryPendingCacheCleanup(): Promise<{ code: string; message: string; team_ids: string[] } | undefined> {
    const pending = (await this.config.load()).pending_cache_cleanup ?? [];
    return (await this.purgeCacheTeams(pending)).failure;
  }

  async doctor(selector?: string): Promise<{
    profile: AuthProfile;
    status: CapabilityStatus;
    capabilities: Record<string, CapabilityDiagnostic>;
    granted_scopes: string[];
    scope_metadata_available: boolean;
    backend_calls: number;
    probed_at: string;
  }> {
    return this.config.transaction(async () => {
      const pending = await this.retryPendingCleanup();
      const cachePending = await this.retryPendingCacheCleanup();
      if (pending.length || cachePending) throw new AxiError({
        code: "AUTH_REMOVE_PARTIAL",
        message: "Some obsolete local authentication data still could not be removed.",
        details: {
          ...(pending.length ? { pending_cleanup: pending } : {}),
          ...(cachePending ? { cache_cleanup: cachePending } : {}),
        },
      });
      const clients = await this.clients(selector);
      let grantedScopes: string[] | undefined;
      let publicApi: CapabilityDiagnostic;
      try {
        const identity = await clients.public.authTest();
        if (clients.profile.kind === "user_token") grantedScopes = slackGrantedScopes(identity);
        publicApi = { status: "supported" };
      } catch (error) {
        publicApi = { status: "unavailable", detail: redact(error instanceof Error ? error.message : String(error)) };
      }
      let capabilities: Record<string, CapabilityDiagnostic>;
      let status: CapabilityStatus;
      if (clients.profile.kind === "browser") {
        const browser = clients.browser;
        if (!browser) throw new AxiError({ code: "AUTH_PROFILE_INVALID", message: "The browser authentication profile has no browser capability client." });
        let counts: CapabilityDiagnostic;
        try {
          await browser.counts();
          counts = { status: "supported" };
        } catch (error) {
          counts = { status: "unavailable", detail: redact(error instanceof Error ? error.message : String(error)) };
        }
        let mutes: CapabilityDiagnostic;
        try {
          await browser.mutedChannels();
          mutes = { status: "supported" };
        } catch (error) {
          mutes = { status: "unavailable", detail: redact(error instanceof Error ? error.message : String(error)) };
        }
        let later: CapabilityDiagnostic;
        try {
          await browser.laterList(undefined, 1);
          later = { status: "supported", detail: "Private Slack browser capability; best-effort and schema-gated." };
        } catch (error) {
          later = { status: "unavailable", detail: redact(error instanceof Error ? error.message : String(error)) };
        }
        capabilities = {
          public_api: publicApi,
          ...scopeCapabilities(undefined),
          unread_counts: counts,
          mention_counts: counts,
          muted_channels: mutes,
          later,
        };
        status = publicApi.status === "unavailable"
          ? "unavailable"
          : [counts, mutes, later].every((capability) => capability.status === "supported")
            ? "supported"
            : "degraded";
      } else {
        capabilities = completeCapabilities(publicApi, grantedScopes);
        status = publicApi.status === "unavailable" ? "unavailable" : "degraded";
      }
      const probedAt = new Date().toISOString();
      const updated: AuthProfile = {
        ...clients.profile,
        capabilities: Object.fromEntries(Object.entries(capabilities).map(([name, value]) => [name, value.status])),
        capability_probed_at: probedAt,
        updated_at: probedAt,
      };
      await this.config.updateProfile(updated);
      return {
        profile: updated,
        status,
        capabilities,
        granted_scopes: grantedScopes ?? [],
        scope_metadata_available: grantedScopes !== undefined,
        backend_calls: Number(clients.public.backendCalls ?? 0) + Number(clients.browser?.backendCalls ?? 0),
        probed_at: probedAt,
      };
    });
  }
}
