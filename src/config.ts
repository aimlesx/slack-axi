import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { AxiError } from "./errors.js";
import { atomicWriteJson, readJson } from "./fs-store.js";
import { preserveActionOutcome, withOwnedRelease } from "./lease-outcome.js";
import { OwnedFileLock, type OwnedLockOptions } from "./owned-lock.js";
import { appPaths } from "./paths.js";
import type { AppConfig, AuthProfile } from "./types.js";

const capabilitySchema = z.enum(["supported", "degraded", "unavailable"]);
const aliasSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i);
const profileSchema = z.object({
  alias: aliasSchema,
  team_id: z.string().min(1),
  team_name: z.string().min(1),
  workspace_url: z.string().url().optional(),
  actor_id: z.string().min(1),
  actor_name: z.string().optional(),
  timezone: z.string().min(1),
  kind: z.enum(["browser", "user_token"]),
  keychain_accounts: z.array(z.string()),
  capabilities: z.record(z.string(), capabilitySchema),
  capability_probed_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).superRefine((profile, context) => {
  const expectedAccounts = profile.kind === "browser" ? 2 : 1;
  if (profile.keychain_accounts.length !== expectedAccounts) {
    context.addIssue({
      code: "custom",
      path: ["keychain_accounts"],
      message: `${profile.kind} profiles require exactly ${expectedAccounts} Keychain account pointer${expectedAccounts === 1 ? "" : "s"}.`,
    });
  }
  if (profile.kind === "browser" && !profile.workspace_url) {
    context.addIssue({ code: "custom", path: ["workspace_url"], message: "browser profiles require the workspace URL returned by Slack." });
  }
});

const configSchema = z.object({
  version: z.literal(1),
  default_workspace: z.string().optional(),
  profiles: z.array(profileSchema),
  pending_credential_cleanup: z.array(z.string()).optional(),
  pending_cache_cleanup: z.array(z.string()).optional(),
  removing_workspaces: z.array(z.string().min(1)).refine((items) => new Set(items).size === items.length, { message: "removing workspace IDs must be unique" }).optional(),
});

export class ConfigStore {
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private readonly lock: OwnedFileLock;

  constructor(private readonly filename = appPaths().config, lockOptions: OwnedLockOptions = {}) {
    this.lock = new OwnedFileLock(`${filename}.transaction.lock`, lockOptions);
  }

  async transaction<T>(operation: () => Promise<T>, options: { preserveActionOutcome?: boolean } = {}): Promise<T> {
    if (this.transactionContext.getStore()) return operation();
    const lease = await this.lock.acquire();
    return withOwnedRelease(
      () => this.transactionContext.run(true, operation),
      () => lease.release(),
      options.preserveActionOutcome
        ? (value, cause) => preserveActionOutcome(value, cause, "credential")
        : undefined,
    );
  }

  async load(): Promise<AppConfig> {
    const raw = await readJson<unknown>(this.filename, { version: 1, profiles: [] });
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AxiError({ code: "CONFIG_INVALID", message: "Slack AXI configuration is invalid.", details: { issues: parsed.error.issues } });
    }
    return {
      version: 1,
      profiles: parsed.data.profiles.map((profile) => ({
        alias: profile.alias,
        team_id: profile.team_id,
        team_name: profile.team_name,
        ...(profile.workspace_url ? { workspace_url: profile.workspace_url } : {}),
        actor_id: profile.actor_id,
        ...(profile.actor_name ? { actor_name: profile.actor_name } : {}),
        timezone: profile.timezone,
        kind: profile.kind,
        keychain_accounts: profile.keychain_accounts,
        capabilities: profile.capabilities,
        ...(profile.capability_probed_at ? { capability_probed_at: profile.capability_probed_at } : {}),
        created_at: profile.created_at,
        updated_at: profile.updated_at,
      })),
      ...(parsed.data.default_workspace ? { default_workspace: parsed.data.default_workspace } : {}),
      ...(parsed.data.pending_credential_cleanup?.length ? { pending_credential_cleanup: parsed.data.pending_credential_cleanup } : {}),
      ...(parsed.data.pending_cache_cleanup?.length ? { pending_cache_cleanup: parsed.data.pending_cache_cleanup } : {}),
      ...(parsed.data.removing_workspaces?.length ? { removing_workspaces: parsed.data.removing_workspaces } : {}),
    };
  }

  async save(config: AppConfig): Promise<void> {
    await this.transaction(async () => {
      await atomicWriteJson(this.filename, configSchema.parse(config));
    });
  }

  async upsert(profile: AuthProfile, options: { cacheCleanupTeamIds?: string[] } = {}): Promise<AppConfig> {
    return this.transaction(async () => {
      const config = await this.load();
      const aliasMatch = config.profiles.find((item) => item.alias === profile.alias);
      const teamMatch = config.profiles.find((item) => item.team_id === profile.team_id);
      const removing = new Set(config.removing_workspaces ?? []);
      const blockedProfile = [aliasMatch, teamMatch].find((item) => item && removing.has(item.team_id));
      if (removing.has(profile.team_id) || blockedProfile) {
        throw new AxiError({
          code: "WORKSPACE_REMOVING",
          message: `Slack team '${blockedProfile?.team_id ?? profile.team_id}' is being removed; finish auth remove before importing another token.`,
          retryable: true,
        });
      }
      if (aliasMatch && teamMatch && aliasMatch !== teamMatch) {
        throw new AxiError({
          code: "WORKSPACE_ALIAS_CONFLICT",
          message: `Workspace alias '${profile.alias}' and Slack team '${profile.team_id}' belong to different configured profiles.`,
          exitCode: 2,
          details: {
            alias_profile: { alias: aliasMatch.alias, team_id: aliasMatch.team_id },
            team_profile: { alias: teamMatch.alias, team_id: teamMatch.team_id },
          },
        });
      }
      const replaced = config.profiles.filter((item) => item.alias === profile.alias || item.team_id === profile.team_id);
      const profiles = config.profiles.filter((item) => item.alias !== profile.alias && item.team_id !== profile.team_id);
      profiles.push(profile);
      const replacedDefault = replaced.some((item) => item.alias === config.default_workspace);
      const obsoleteAccounts = replaced.flatMap((item) => item.keychain_accounts).filter((account) => !profile.keychain_accounts.includes(account));
      // The new accounts are staged as pending cleanup before Keychain writes so
      // an interrupted replacement has a recoverable orphan. This atomic save is
      // the commit point: make the new pointer active, retire old pointers, and
      // remove the active generation from cleanup in one durable config update.
      const activeAccounts = new Set(profile.keychain_accounts);
      const pending = [...new Set([
        ...(config.pending_credential_cleanup ?? []).filter((account) => !activeAccounts.has(account)),
        ...obsoleteAccounts,
      ])];
      const updated: AppConfig = { ...config, profiles, default_workspace: replacedDefault || !config.default_workspace ? profile.alias : config.default_workspace };
      if (pending.length) updated.pending_credential_cleanup = pending;
      else delete updated.pending_credential_cleanup;
      const pendingCache = [...new Set([...(config.pending_cache_cleanup ?? []), ...(options.cacheCleanupTeamIds ?? [])])];
      if (pendingCache.length) updated.pending_cache_cleanup = pendingCache;
      else delete updated.pending_cache_cleanup;
      await this.save(updated);
      return updated;
    });
  }

  async updateProfile(profile: AuthProfile): Promise<AppConfig> {
    return this.transaction(async () => {
      const config = await this.load();
      const current = config.profiles.find((item) => item.team_id === profile.team_id);
      if (!current) {
        throw new AxiError({ code: "WORKSPACE_NOT_FOUND", message: `Workspace '${profile.team_id}' is not configured.` });
      }
      this.assertProfileAvailable(config, current);
      if (current.actor_id !== profile.actor_id
        || current.kind !== profile.kind
        || current.keychain_accounts.length !== profile.keychain_accounts.length
        || current.keychain_accounts.some((account, index) => account !== profile.keychain_accounts[index])) {
        throw new AxiError({
          code: "WORKSPACE_PROFILE_CHANGED",
          message: "The workspace credential profile changed while it was being updated; refusing to overwrite the newer generation.",
          retryable: true,
        });
      }
      const aliasOwner = config.profiles.find((item) => item.alias === profile.alias);
      if (aliasOwner && aliasOwner.team_id !== profile.team_id) {
        throw new AxiError({ code: "WORKSPACE_ALIAS_CONFLICT", message: `Workspace alias '${profile.alias}' is already assigned to another Slack team.`, exitCode: 2 });
      }
      const updated = { ...config, profiles: config.profiles.map((item) => item.team_id === profile.team_id ? profile : item) };
      await this.save(updated);
      return updated;
    });
  }

  async addPendingCleanup(accounts: string[]): Promise<AppConfig> {
    return this.transaction(async () => {
      const config = await this.load();
      const pending = [...new Set([...(config.pending_credential_cleanup ?? []), ...accounts])];
      const updated: AppConfig = { ...config, ...(pending.length ? { pending_credential_cleanup: pending } : {}) };
      await this.save(updated);
      return updated;
    });
  }

  async clearPendingCleanup(accounts: string[]): Promise<AppConfig> {
    return this.transaction(async () => {
      const config = await this.load();
      const cleared = new Set(accounts);
      const pending = (config.pending_credential_cleanup ?? []).filter((account) => !cleared.has(account));
      const updated: AppConfig = { ...config };
      if (pending.length) updated.pending_credential_cleanup = pending;
      else delete updated.pending_credential_cleanup;
      await this.save(updated);
      return updated;
    });
  }

  async clearPendingCacheCleanup(teamIds: string[]): Promise<AppConfig> {
    return this.transaction(async () => {
      const config = await this.load();
      const cleared = new Set(teamIds);
      const pending = (config.pending_cache_cleanup ?? []).filter((teamId) => !cleared.has(teamId));
      const updated: AppConfig = { ...config };
      if (pending.length) updated.pending_cache_cleanup = pending;
      else delete updated.pending_cache_cleanup;
      await this.save(updated);
      return updated;
    });
  }

  async use(selector: string): Promise<AppConfig> {
    return this.transaction(async () => {
      const config = await this.load();
      const matches = config.profiles.filter((profile) => profile.alias === selector || profile.team_id === selector);
      if (matches.length !== 1) throw new AxiError({ code: "WORKSPACE_NOT_FOUND", message: `Workspace '${selector}' is not configured.`, exitCode: 2 });
      this.assertProfileAvailable(config, matches[0]!);
      const updated = { ...config, default_workspace: matches[0]!.alias };
      await this.save(updated);
      return updated;
    });
  }

  async remove(selector: string, options: { stageCacheCleanup?: boolean } = {}): Promise<{ config: AppConfig; removed: AuthProfile }> {
    return this.transaction(async () => {
      const config = await this.load();
      const removed = config.profiles.find((profile) => profile.alias === selector || profile.team_id === selector);
      if (!removed) throw new AxiError({ code: "WORKSPACE_NOT_FOUND", message: `Workspace '${selector}' is not configured.`, exitCode: 2 });
      if (!config.removing_workspaces?.includes(removed.team_id)) {
        throw new AxiError({ code: "WORKSPACE_REMOVAL_NOT_STARTED", message: `Workspace '${removed.alias}' must enter the removal barrier before its profile can be deleted.` });
      }
      const profiles = config.profiles.filter((profile) => profile !== removed);
      const updated: AppConfig = {
        version: 1,
        profiles,
        ...(config.default_workspace && config.default_workspace !== removed.alias
          ? { default_workspace: config.default_workspace }
          : profiles[0] ? { default_workspace: profiles[0].alias } : {}),
        pending_credential_cleanup: [...new Set([...(config.pending_credential_cleanup ?? []), ...removed.keychain_accounts])],
        ...(options.stageCacheCleanup
          ? { pending_cache_cleanup: [...new Set([...(config.pending_cache_cleanup ?? []), removed.team_id])] }
          : config.pending_cache_cleanup?.length ? { pending_cache_cleanup: config.pending_cache_cleanup } : {}),
        ...((config.removing_workspaces ?? []).filter((teamId) => teamId !== removed.team_id).length
          ? { removing_workspaces: (config.removing_workspaces ?? []).filter((teamId) => teamId !== removed.team_id) }
          : {}),
      };
      await this.save(updated);
      return { config: updated, removed };
    });
  }

  async resolve(selector?: string): Promise<AuthProfile> {
    const config = await this.load();
    const wanted = selector ?? config.default_workspace;
    if (!wanted) {
      if (config.profiles.length === 0) {
        throw new AxiError({ code: "AUTH_REQUIRED", message: "No Slack workspace is configured.", suggestedCommand: "slack-axi auth add <alias> --from-stdin" });
      }
      if (config.profiles.length > 1) {
        throw new AxiError({ code: "WORKSPACE_REQUIRED", message: "Multiple Slack workspaces are configured; pass --workspace.", exitCode: 2, candidates: config.profiles.map(({ alias, team_id }) => ({ alias, team_id })) });
      }
      const profile = config.profiles[0]!;
      this.assertProfileAvailable(config, profile);
      return profile;
    }
    const matches = config.profiles.filter((profile) => profile.alias === wanted || profile.team_id === wanted);
    if (matches.length !== 1) {
      throw new AxiError({ code: "WORKSPACE_NOT_FOUND", message: `Workspace '${wanted}' is not configured.`, exitCode: 2, candidates: config.profiles.map(({ alias, team_id }) => ({ alias, team_id })) });
    }
    const profile = matches[0]!;
    this.assertProfileAvailable(config, profile);
    return profile;
  }

  private assertProfileAvailable(config: AppConfig, profile: AuthProfile): void {
    if (config.removing_workspaces?.includes(profile.team_id)) {
      throw new AxiError({ code: "WORKSPACE_REMOVING", message: `Workspace '${profile.alias}' is being removed; rerun auth remove to finish local cleanup.`, retryable: true, suggestedCommand: `slack-axi auth remove ${profile.alias}` });
    }
  }

  async assertWorkspaceAvailable(teamId: string): Promise<void> {
    const config = await this.load();
    if (config.removing_workspaces?.includes(teamId)) {
      throw new AxiError({ code: "WORKSPACE_REMOVING", message: `Slack team '${teamId}' is being removed; no new action can be staged.`, retryable: true });
    }
  }

  async beginRemoval(selector: string): Promise<AuthProfile> {
    return this.transaction(async () => {
      const config = await this.load();
      const matches = config.profiles.filter((profile) => profile.alias === selector || profile.team_id === selector);
      if (matches.length !== 1) throw new AxiError({ code: "WORKSPACE_NOT_FOUND", message: `Workspace '${selector}' is not configured.`, exitCode: 2 });
      const profile = matches[0]!;
      const removing = [...new Set([...(config.removing_workspaces ?? []), profile.team_id])];
      await this.save({ ...config, removing_workspaces: removing });
      return profile;
    });
  }
}
