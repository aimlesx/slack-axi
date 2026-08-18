import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AxiError } from "./errors.js";
import { atomicWriteJson, readJson } from "./fs-store.js";
import { credentialGeneration } from "./keychain.js";
import { OwnedFileLock } from "./owned-lock.js";
import { appPaths } from "./paths.js";
import type { AuthProfile } from "./types.js";

const sourceCoverageSchema = z.object({
  scanned: z.number().int().nonnegative(),
  complete: z.boolean(),
  next_cursor: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const snapshotSchema = z.object({
  version: z.literal(2),
  revision: z.string(),
  team_id: z.string(),
  actor_id: z.string(),
  credential_generation: z.string(),
  synced_at: z.string(),
  conversations: z.array(z.record(z.string(), z.unknown())),
  users: z.array(z.record(z.string(), z.unknown())),
  emoji: z.record(z.string(), z.string()),
  coverage: z.object({
    conversations: sourceCoverageSchema,
    users: sourceCoverageSchema,
    emoji: sourceCoverageSchema,
    inbox: sourceCoverageSchema,
    backend_calls: z.number().int().nonnegative(),
  }),
  inbox: z.object({ unread_conversations: z.number(), mentions: z.number(), exact: z.boolean(), synced_at: z.string() }).optional(),
});

export type SourceCoverage = z.infer<typeof sourceCoverageSchema>;
export type CacheSnapshot = z.infer<typeof snapshotSchema>;
export interface CacheIdentity {
  team_id: string;
  actor_id: string;
  credential_generation: string;
}

export interface CursorIntegrity {
  signCursor(value: unknown): Promise<string>;
  verifyCursor(value: unknown, signature: string): Promise<boolean>;
}

export interface CachePurgeResult {
  team_ids: string[];
  removed_scopes: number;
  removed_unclassified_scopes: number;
  removed_legacy_scopes: number;
}

export function cacheIdentity(profile: Pick<AuthProfile, "team_id" | "actor_id" | "kind" | "keychain_accounts">): CacheIdentity {
  return {
    team_id: profile.team_id,
    actor_id: profile.actor_id,
    credential_generation: credentialGeneration(profile),
  };
}

export function filterHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);
}

const cacheCursorSchema = z.object({
  v: z.literal(2),
  t: z.string().min(1),
  a: z.string().min(1),
  g: z.string().min(1),
  r: z.string().min(1),
  f: z.string().min(1),
  o: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  s: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

function unsignedCacheCursor(value: z.infer<typeof cacheCursorSchema>): Omit<z.infer<typeof cacheCursorSchema>, "s"> {
  const { s: _signature, ...unsigned } = value;
  return unsigned;
}

export async function createCacheCursor(snapshot: CacheSnapshot, queryHash: string, offset: number, integrity: CursorIntegrity): Promise<string> {
  const value = {
    v: 2 as const,
    t: snapshot.team_id,
    a: snapshot.actor_id,
    g: snapshot.credential_generation,
    r: snapshot.revision,
    f: queryHash,
    o: offset,
  };
  return Buffer.from(JSON.stringify({ ...value, s: await integrity.signCursor(value) })).toString("base64url");
}

export async function parseCacheCursor(cursor: string | undefined, snapshot: CacheSnapshot, queryHash: string, restartCommand: string, integrity: CursorIntegrity): Promise<number> {
  if (!cursor) return 0;
  let value: z.infer<typeof cacheCursorSchema>;
  try {
    value = cacheCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch (cause) {
    throw new AxiError({ code: "CURSOR_INVALID", message: "The cache cursor is malformed or is not a supported Slack AXI cursor.", exitCode: 2, suggestedCommand: restartCommand, cause });
  }
  if (!await integrity.verifyCursor(unsignedCacheCursor(value), value.s)) {
    throw new AxiError({ code: "CURSOR_INVALID", message: "The cache cursor failed its integrity check.", exitCode: 2, suggestedCommand: restartCommand });
  }
  if (value.t !== snapshot.team_id
    || value.a !== snapshot.actor_id
    || value.g !== snapshot.credential_generation
    || value.r !== snapshot.revision
    || value.f !== queryHash) {
    throw new AxiError({ code: "CURSOR_STALE", message: "The cache cursor is stale or belongs to a different workspace, credential generation, or filter.", exitCode: 2, suggestedCommand: restartCommand });
  }
  return value.o;
}

export class CacheStore {
  private readonly transactionContext = new AsyncLocalStorage<boolean>();
  private readonly lock: OwnedFileLock;

  constructor(private readonly root = appPaths().cache) {
    this.lock = new OwnedFileLock(path.join(root, ".cache.transaction.lock"));
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return operation();
    const lease = await this.lock.acquire();
    try {
      return await this.transactionContext.run(true, operation);
    } finally {
      await lease.release();
    }
  }

  private filename(identity: CacheIdentity): string {
    const scope = createHash("sha256")
      .update(JSON.stringify([identity.team_id, identity.actor_id, identity.credential_generation]))
      .digest("base64url");
    return path.join(this.root, "scopes", scope, "snapshot.json");
  }

  async load(identity: CacheIdentity): Promise<CacheSnapshot | undefined> {
    const raw = await readJson<unknown | undefined>(this.filename(identity), undefined);
    if (raw === undefined) return undefined;
    const result = snapshotSchema.safeParse(raw);
    if (!result.success) return undefined;
    return result.data.team_id === identity.team_id
      && result.data.actor_id === identity.actor_id
      && result.data.credential_generation === identity.credential_generation
      ? result.data
      : undefined;
  }

  async save(snapshot: CacheSnapshot): Promise<void> {
    await this.transaction(async () => {
      const parsed = snapshotSchema.parse(snapshot);
      const existing = await this.load(parsed);
      if (existing?.revision === parsed.revision) {
        throw new AxiError({
          code: "CACHE_REVISION_REUSED",
          message: "A published cache snapshot revision cannot be reused for another write.",
        });
      }
      await atomicWriteJson(this.filename(parsed), parsed);
    });
  }

  /**
   * Purges every credential generation and actor scope for the requested
   * teams. An unparseable scope cannot be proven unrelated, so it is removed
   * conservatively rather than retaining potentially private Slack data.
   */
  async purgeTeams(teamIds: string[]): Promise<CachePurgeResult> {
    const requested = [...new Set(teamIds)].sort();
    if (requested.length === 0) return { team_ids: [], removed_scopes: 0, removed_unclassified_scopes: 0, removed_legacy_scopes: 0 };
    if (requested.some((teamId) => !/^[A-Z0-9]+$/.test(teamId))) {
      throw new AxiError({ code: "CACHE_PURGE_INVALID", message: "Cache purge received an invalid Slack team identifier." });
    }
    return this.transaction(async () => {
      const scopes = path.join(this.root, "scopes");
      let scopeRoot;
      try {
        scopeRoot = await lstat(scopes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AxiError({ code: "CACHE_PURGE_FAILED", message: "Could not inspect the local Slack cache root.", cause: error });
        }
      }
      if (scopeRoot && !scopeRoot.isDirectory()) {
        try {
          // Do not follow a substituted symlink at the scopes boundary.
          await rm(scopes, { force: true });
        } catch (error) {
          throw new AxiError({ code: "CACHE_PURGE_FAILED", message: "Could not remove an unsafe local Slack cache scope root.", cause: error });
        }
        scopeRoot = undefined;
      }
      let entries: Dirent[] = [];
      if (scopeRoot) {
        try {
          entries = await readdir(scopes, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new AxiError({ code: "CACHE_PURGE_FAILED", message: "Could not inspect local Slack cache scopes.", cause: error });
          }
        }
      }
      const targets = new Set(requested);
      let removedScopes = 0;
      let removedUnclassifiedScopes = 0;
      let removedLegacyScopes = 0;
      let failedScopes = 0;
      for (const entry of entries) {
        const scope = path.join(scopes, entry.name);
        let classifiedTeam: string | undefined;
        if (entry.isDirectory()) {
          const raw = await readJson<unknown | undefined>(path.join(scope, "snapshot.json"), undefined).catch(() => undefined);
          const parsed = snapshotSchema.safeParse(raw);
          if (parsed.success) classifiedTeam = parsed.data.team_id;
        }
        if (classifiedTeam !== undefined && !targets.has(classifiedTeam)) continue;
        try {
          // rm on a symlink removes only the link; it never traverses the
          // target. Directory entries are resolved below the fixed cache root.
          await rm(scope, { recursive: entry.isDirectory(), force: true });
          removedScopes += 1;
          if (classifiedTeam === undefined) removedUnclassifiedScopes += 1;
        } catch {
          failedScopes += 1;
        }
      }
      // Pre-release team-only cache directories are never read, but remove an
      // exact legacy team path as part of privacy cleanup if one is present.
      for (const teamId of requested) {
        const legacy = path.join(this.root, teamId);
        try {
          const metadata = await lstat(legacy);
          await rm(legacy, { recursive: metadata.isDirectory(), force: true });
          removedLegacyScopes += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failedScopes += 1;
        }
      }
      if (failedScopes) {
        throw new AxiError({
          code: "CACHE_PURGE_FAILED",
          message: "Some local Slack cache scopes could not be removed.",
          details: { team_ids: requested, removed_scopes: removedScopes, failed_scopes: failedScopes },
        });
      }
      return { team_ids: requested, removed_scopes: removedScopes, removed_unclassified_scopes: removedUnclassifiedScopes, removed_legacy_scopes: removedLegacyScopes };
    });
  }
}
