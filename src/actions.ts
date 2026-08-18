import { constants, createReadStream, createWriteStream } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";
import { AxiError } from "./errors.js";
import { atomicWriteJson, ensurePrivateDir, immutableWriteJson, removeIfExists } from "./fs-store.js";
import { ACTION_SIGNING_ACCOUNT, NativeKeychain, type SecretStore } from "./keychain.js";
import { preserveActionOutcome, withOwnedRelease } from "./lease-outcome.js";
import { appPaths } from "./paths.js";
import {
  currentProcessOwner,
  defaultProcessAlive,
  defaultProcessIdentity,
  processOwnerIsLive,
  type ProcessIdentityReader,
  type ProcessLivenessProbe,
} from "./process-identity.js";
import type { ActionPlan, ActionState, VerifiedUploadSnapshot } from "./types.js";

const actionState = z.enum(["planned", "applying", "partial", "unknown", "applied", "not_applied", "abandoned", "expired"]);
const planDataSchema = z.object({
  version: z.literal(2),
  id: z.string().uuid(),
  workspace_id: z.string().min(1),
  actor_id: z.string().min(1),
  operation: z.string().min(1),
  target_ids: z.array(z.string()),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string(),
  expires_at: z.string(),
});
const signedPlanSchema = z.object({ data: planDataSchema, signature: z.string().min(43) });
const stagingWorkspaceDataSchema = z.object({
  version: z.literal(1),
  action_id: z.string().uuid(),
  workspace_id: z.string().min(1),
});
const signedStagingWorkspaceSchema = z.object({ data: stagingWorkspaceDataSchema, signature: z.string().min(43) });
const stateDataSchema = z.object({
  version: z.literal(2),
  action_id: z.string().uuid(),
  state: actionState,
  revision: z.number().int().nonnegative(),
  updated_at: z.string(),
  result: z.record(z.string(), z.unknown()).optional(),
  last_error: z.object({ code: z.string(), message: z.string(), at: z.string() }).optional(),
  reconciliation: z.object({
    cursor: z.string().optional(),
    source: z.string().optional(),
    source_scanned: z.number().int().nonnegative().optional(),
    window_basis: z.literal("uncertain_boundary_v1").optional(),
    scanned: z.number().int().nonnegative(),
    oldest: z.string(),
    latest: z.string(),
    complete_misses: z.number().int().nonnegative(),
    last_complete_miss_at: z.string().optional(),
  }).optional(),
  content_discarded: z.boolean().optional(),
});
const signedStateSchema = z.object({ data: stateDataSchema, signature: z.string().min(43) });
const lockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  claimed_at: z.string().datetime(),
  process_started_at_ms: z.number().int().positive().optional(),
  process_instance_id: z.string().regex(/^[A-Za-z0-9_-]{16,}$/).optional(),
  process_fence_socket: z.string().regex(/^\/(?:private\/)?tmp\/slack-axi-cli-lock-\d+-[a-f0-9]{32}\.sock$/).optional(),
}).strict();

type PlanData = z.infer<typeof planDataSchema>;
type StateData = z.infer<typeof stateDataSchema>;
type LockOwner = z.infer<typeof lockOwnerSchema>;

const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const ACTION_PLAN_LIFETIME_MS = 15 * 60_000;
const ORPHAN_CREATOR_GRACE_MS = INCOMPLETE_LOCK_GRACE_MS;
const ORPHAN_RETENTION_MS = ACTION_PLAN_LIFETIME_MS + ORPHAN_CREATOR_GRACE_MS;
const ACTION_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const CREATION_DIRECTORY_PATTERN = /^\.creating-([0-9a-f-]{36})-(\d+)-([a-f0-9]{32})$/i;
const DELETION_DIRECTORY_PATTERN = /^(?:\.[0-9a-f-]{36}\.deleting-[a-f0-9]{32}|\.orphan-deleting-[a-f0-9]{32})$/i;

export const DEFAULT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const MAX_UPLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export interface WorkspaceActionPurgeResult {
  workspace_id: string;
  scanned: number;
  removed: number;
  skipped: number;
  complete: boolean;
  failed: Array<{ entry: string; code: string; message: string }>;
}

const TERMINAL_STATES = new Set<ActionState>(["applied", "not_applied", "abandoned", "expired"]);
const LEGAL_TRANSITIONS: Record<ActionState, ReadonlySet<ActionState>> = {
  planned: new Set(["applying", "expired"]),
  applying: new Set(["partial", "unknown", "applied", "not_applied"]),
  partial: new Set(["applying", "unknown", "applied", "not_applied"]),
  unknown: new Set(["unknown", "applied", "not_applied", "abandoned"]),
  applied: new Set(),
  not_applied: new Set(),
  abandoned: new Set(),
  expired: new Set(),
};

function hmac(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(canonicalize(value)).digest("base64url");
}

function cursorHmac(key: Buffer, value: unknown): string {
  return createHmac("sha256", key)
    .update("slack-axi/cursor/v1\0")
    .update(canonicalize(value))
    .digest("base64url");
}

function signatureMatches(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sha256(value: unknown): string {
  if (value instanceof Uint8Array) return createHash("sha256").update(value).digest("hex");
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export async function sha256File(filename: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function sha256Handle(handle: Awaited<ReturnType<typeof open>>): Promise<{ hash: string; size: number }> {
  const digest = createHash("sha256");
  let size = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    // Positional reads leave the descriptor open and its shared offset
    // untouched so the exact same fd can later back the transfer stream.
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, size);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { hash: digest.digest("hex"), size };
}

type SnapshotMetadata = Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;

function sameSnapshotVersion(left: SnapshotMetadata, right: SnapshotMetadata): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    // Renaming an inode can update ctime without changing its bytes. The open
    // descriptor plus the transfer digest already make path replacement safe;
    // mtime detects ordinary in-place writes and the digest catches any write
    // whose timestamp resolution is too coarse.
    && left.mtimeMs === right.mtimeMs;
}

export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishLockRecord(filename: string, owner: LockOwner): Promise<boolean> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${owner.nonce}.tmp`);
  try {
    await immutableWriteJson(temporary, owner);
    try {
      await link(temporary, filename);
      await syncDirectory(path.dirname(filename));
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw cause;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readLockOwner(filename: string): Promise<{
  owner?: LockOwner;
  pid?: number;
  ageMs: number;
  identity?: string;
}> {
  let raw: unknown;
  let contents = "";
  let modifiedAt = Date.now();
  let device = 0;
  let inode = 0;
  try {
    const [value, metadata] = await Promise.all([readFile(filename, "utf8"), stat(filename)]);
    contents = value;
    modifiedAt = metadata.mtimeMs;
    device = metadata.dev;
    inode = metadata.ino;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ageMs: 0 };
    throw cause;
  }
  const identity = `${device.toString(16)}-${inode.toString(16)}-${createHash("sha256").update(contents).digest("hex").slice(0, 16)}`;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    // A legacy writer could have crashed mid-record. Recover a visible PID
    // conservatively so a live incomplete writer is never fenced out.
    const pidMatch = /"pid"\s*:\s*(\d+)/.exec(contents);
    const pidValue = pidMatch?.[1] === undefined ? undefined : Number(pidMatch[1]);
    const pid = Number.isSafeInteger(pidValue) && pidValue! > 0 ? pidValue : undefined;
    return { ...(pid === undefined ? {} : { pid }), ageMs: Math.max(0, Date.now() - modifiedAt), identity };
  }
  const parsed = lockOwnerSchema.safeParse(raw);
  if (parsed.success) {
    return { owner: parsed.data, pid: parsed.data.pid, ageMs: Math.max(0, Date.now() - modifiedAt), identity };
  }
  const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const pid = Number.isInteger(candidate.pid) && (candidate.pid as number) > 0 ? candidate.pid as number : undefined;
  const claimedAt = typeof candidate.claimed_at === "string" ? Date.parse(candidate.claimed_at) : Number.NaN;
  const ageReference = Number.isFinite(claimedAt) ? Math.min(modifiedAt, claimedAt) : modifiedAt;
  return { ...(pid === undefined ? {} : { pid }), ageMs: Math.max(0, Date.now() - ageReference), identity };
}

async function removeLockRecordIfOwned(filename: string, nonce: string): Promise<boolean> {
  const observed = await readLockOwner(filename);
  if (observed.owner?.nonce !== nonce) return false;
  try {
    await unlink(filename);
    await syncDirectory(path.dirname(filename));
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function safeRecovery(operation: string, payload: Record<string, unknown> | undefined, existing: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = payload ?? {};
  const allowedByOperation: Record<string, string[]> = {
    "message.send": ["conversation_id", "user_id", "client_msg_id", "thread_ts"],
    "message.reply": ["conversation_id", "client_msg_id", "thread_ts"],
    "reaction.add": ["conversation_id", "ts", "name", "ref"],
    "reaction.remove": ["conversation_id", "ts", "name", "ref"],
    "mark-read": ["conversation_id", "ts"],
    "later.complete": ["item_id", "ts"],
    "later.snooze": ["item_id", "ts", "remind_at"],
    "auth.revoke": ["team_id"],
    "file.upload": ["conversation_id", "thread_ts", "snapshot_hash"],
  };
  const selected = Object.fromEntries((allowedByOperation[operation] ?? []).flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
  return { ...(existing ?? {}), ...selected };
}

export class ActionStore {
  private readonly isProcessAlive: ProcessLivenessProbe;
  private readonly processIdentity: ProcessIdentityReader;

  constructor(
    private readonly directory = appPaths().actions,
    private readonly secrets: SecretStore = new NativeKeychain(),
    lockOptions: { isProcessAlive?: ProcessLivenessProbe; processIdentity?: ProcessIdentityReader } = {},
  ) {
    this.isProcessAlive = lockOptions.isProcessAlive ?? defaultProcessAlive;
    this.processIdentity = lockOptions.processIdentity ?? defaultProcessIdentity;
  }

  private actionDirectory(id: string): string {
    if (!ACTION_ID_PATTERN.test(id)) throw new AxiError({ code: "ACTION_ID_INVALID", message: "Action ID must be a UUID.", exitCode: 2 });
    return path.join(this.directory, id);
  }

  private filesAt(root: string): { root: string; workspace: string; plan: string; state: string; preview: string; payload: string; upload: string; lock: string } {
    return {
      root,
      workspace: path.join(root, "workspace.json"),
      plan: path.join(root, "plan.json"),
      state: path.join(root, "state.json"),
      preview: path.join(root, "preview.json"),
      payload: path.join(root, "payload.json"),
      upload: path.join(root, "upload.bin"),
      lock: path.join(root, ".lock"),
    };
  }

  private files(id: string): ReturnType<ActionStore["filesAt"]> {
    return this.filesAt(this.actionDirectory(id));
  }

  private creationDirectory(id: string, nonce: string): string {
    return path.join(this.directory, `.creating-${id}-${process.pid}-${nonce}`);
  }

  private workspaceLifecycleDirectory(workspaceId: string): string {
    const identity = createHash("sha256").update(workspaceId).digest("hex");
    return path.join(this.directory, `.workspace-${identity}.lifecycle-lock`);
  }

  private async acquireWorkspaceLifecycleLock(workspaceId: string): Promise<() => Promise<void>> {
    return this.acquireOwnedLock(this.workspaceLifecycleDirectory(workspaceId), `Slack workspace '${workspaceId}' action lifecycle`);
  }

  private async actionDirectoriesExist(): Promise<boolean> {
    await ensurePrivateDir(this.directory);
    return (await readdir(this.directory, { withFileTypes: true })).some((entry) => entry.isDirectory() && (
      ACTION_ID_PATTERN.test(entry.name)
      || CREATION_DIRECTORY_PATTERN.test(entry.name)
      || DELETION_DIRECTORY_PATTERN.test(entry.name)
    ));
  }

  private async readSigningKey(create: boolean): Promise<Buffer> {
    try {
      const encoded = await this.secrets.get(ACTION_SIGNING_ACCOUNT);
      const key = Buffer.from(encoded, "base64url");
      if (key.length !== 32) throw new Error("invalid signing-key length");
      return key;
    } catch (cause) {
      if (!create || await this.actionDirectoriesExist()) {
        throw new AxiError({
          code: "ACTION_SIGNING_KEY_MISSING",
          message: "The action signing key is missing or invalid while staged actions exist; verification is unavailable.",
          suggestedCommand: "slack-axi action delete <id> --force-unverified",
          cause,
        });
      }
    }

    const release = await this.acquireOwnedLock(path.join(this.directory, ".signing-key.lock"), "Action signing-key initialization");
    try {
      try {
        const existing = Buffer.from(await this.secrets.get(ACTION_SIGNING_ACCOUNT), "base64url");
        if (existing.length === 32) return existing;
      } catch {
        // The lock serializes the only safe key-generation path.
      }
      if (await this.actionDirectoriesExist()) {
        throw new AxiError({ code: "ACTION_SIGNING_KEY_MISSING", message: "Refusing to replace a missing signing key while actions exist." });
      }
      const key = randomBytes(32);
      await this.secrets.set(ACTION_SIGNING_ACCOUNT, key.toString("base64url"));
      return key;
    } finally {
      await release();
    }
  }

  /**
   * Cursor authentication shares the protected local signing key but uses a
   * separate HMAC domain. Callers never receive the key itself.
   */
  async signCursor(value: unknown): Promise<string> {
    return cursorHmac(await this.readSigningKey(true), value);
  }

  async verifyCursor(value: unknown, signature: string): Promise<boolean> {
    return signatureMatches(cursorHmac(await this.readSigningKey(true), value), signature);
  }

  /**
   * Keep one O_NOFOLLOW descriptor open from the final signed-byte check until
   * the upload transport finishes. Path replacement cannot redirect the
   * transfer, while the transport hashes the same descriptor again as Slack
   * consumes it and refuses to complete a changed upload.
   */
  async withVerifiedUploadSnapshot<T>(action: ActionPlan, operation: (snapshot: VerifiedUploadSnapshot) => Promise<T>): Promise<T> {
    if (action.operation !== "file.upload" || !action.payload) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The verified upload action payload is unavailable." });
    }
    const expectedHash = action.payload.snapshot_hash;
    const expectedSize = action.payload.snapshot_size;
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)
      || typeof expectedSize !== "number" || !Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The verified upload snapshot metadata is invalid." });
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.files(action.id).upload, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${action.id}' upload snapshot could not be opened safely.`, cause });
    }

    try {
      let initial: SnapshotMetadata;
      try {
        initial = await handle.stat();
        if (!initial.isFile() || initial.size !== expectedSize) {
          throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${action.id}' upload snapshot failed verification.` });
        }
        const verified = await sha256Handle(handle);
        const afterHash = await handle.stat();
        if (verified.hash !== expectedHash || verified.size !== expectedSize || !sameSnapshotVersion(initial, afterHash)) {
          throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${action.id}' upload snapshot failed verification.` });
        }
        initial = afterHash;
      } catch (cause) {
        if (cause instanceof AxiError) throw cause;
        throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${action.id}' upload snapshot failed verification.`, cause });
      }

      let streamClaimed = false;
      const snapshot: VerifiedUploadSnapshot = Object.freeze({
        size: expectedSize,
        expected_sha256: expectedHash,
        createReadStream: () => {
          if (streamClaimed) throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The verified upload snapshot stream was already consumed." });
          streamClaimed = true;
          return handle.createReadStream({ autoClose: false, start: 0 });
        },
        assertUnchanged: async () => {
          let current: SnapshotMetadata;
          try { current = await handle.stat(); } catch (cause) {
            throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${action.id}' upload snapshot is no longer readable.`, cause });
          }
          if (!current.isFile() || !sameSnapshotVersion(initial, current)) {
            throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${action.id}' upload snapshot changed before completion.` });
          }
        },
      });
      return await operation(snapshot);
    } finally {
      // Once the callback crosses Slack's byte boundary its outcome is more
      // important than a local close error. Closing also releases an inode
      // whose pathname may have been replaced during dispatch.
      await handle.close().catch(() => undefined);
    }
  }

  private async snapshotUpload(source: string, destination: string, maxBytes: number): Promise<{ hash: string; size: number }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_UPLOAD_MAX_BYTES) {
      throw new AxiError({ code: "FILE_UPLOAD_LIMIT_INVALID", message: `The upload byte limit must be between 1 and ${MAX_UPLOAD_MAX_BYTES}.`, exitCode: 2 });
    }
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await sourceHandle.stat();
      if (!metadata.isFile()) throw new AxiError({ code: "FILE_INVALID", message: `'${source}' is not a regular file.`, exitCode: 2 });
      if (metadata.size > maxBytes) {
        throw new AxiError({ code: "FILE_UPLOAD_LIMIT_EXCEEDED", message: "The upload source exceeds the configured byte limit.", exitCode: 2, details: { bytes: metadata.size, maximum_bytes: maxBytes } });
      }
      const digest = createHash("sha256");
      let size = 0;
      const hashingStream = new Transform({
        transform(chunk, _encoding, callback) {
          digest.update(chunk as Buffer);
          size += (chunk as Buffer).byteLength;
          if (!Number.isSafeInteger(size) || size > maxBytes) {
            callback(new AxiError({ code: "FILE_UPLOAD_LIMIT_EXCEEDED", message: "The upload source grew beyond the configured byte limit while it was staged.", exitCode: 2, details: { bytes_read_at_least: size, maximum_bytes: maxBytes } }));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(sourceHandle.createReadStream({ autoClose: false }), hashingStream, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      const snapshotHandle = await open(destination, "r");
      try {
        const snapshotMetadata = await snapshotHandle.stat();
        if (snapshotMetadata.size !== size) throw new AxiError({ code: "FILE_INVALID", message: "The private upload snapshot size changed while it was being staged." });
        await snapshotHandle.sync();
      } finally {
        await snapshotHandle.close();
      }
      return { hash: digest.digest("hex"), size };
    } finally {
      await sourceHandle.close();
    }
  }

  protected async beforeActionPublish(_stagingDirectory: string, _actionDirectory: string): Promise<void> {
    // Test seam for deterministic interruption at the last safe point. At this
    // boundary every signed record and sensitive file is durable, but no
    // public action directory exists yet.
  }

  protected async persistSignedState(filename: string, value: unknown): Promise<void> {
    await atomicWriteJson(filename, value);
  }

  private async expectedStateIsVisible(filename: string, expected: StateData, key: Buffer): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(filename, "utf8")) as unknown;
      const parsed = signedStateSchema.safeParse(raw);
      return parsed.success
        && canonicalize(parsed.data.data) === canonicalize(expected)
        && signatureMatches(hmac(key, expected), parsed.data.signature);
    } catch {
      return false;
    }
  }

  async create(input: {
    workspace_id: string;
    actor_id: string;
    operation: string;
    target_ids: string[];
    preview: Record<string, unknown>;
    payload: Record<string, unknown>;
    upload_path?: string;
    upload_max_bytes?: number;
    assertWorkspaceAvailable?: () => Promise<void>;
  }): Promise<ActionPlan> {
    await ensurePrivateDir(this.directory);
    const release = await this.acquireWorkspaceLifecycleLock(input.workspace_id);
    return withOwnedRelease(async () => {
      const assertWorkspaceAvailable = input.assertWorkspaceAvailable ?? (async () => undefined);
      await assertWorkspaceAvailable();
      const key = await this.readSigningKey(true);
      const id = uuidv7();
      const publishedFiles = this.files(id);
      const stagingRoot = this.creationDirectory(id, randomBytes(16).toString("hex"));
      const files = this.filesAt(stagingRoot);
      // The creator PID is part of the directory name so GC can recognize a
      // live owner from the instant mkdir succeeds.
      await mkdir(stagingRoot, { mode: 0o700 });
      try {
        const workspace = { version: 1 as const, action_id: id, workspace_id: input.workspace_id };
        await immutableWriteJson(files.workspace, { data: workspace, signature: hmac(key, workspace) });
        let payload = input.payload;
        let preview = input.preview;
        if (input.upload_path) {
          const snapshot = await this.snapshotUpload(input.upload_path, files.upload, input.upload_max_bytes ?? DEFAULT_UPLOAD_MAX_BYTES);
          payload = { ...payload, snapshot_hash: snapshot.hash, snapshot_size: snapshot.size };
          // Approval metadata is derived only after the action-owned snapshot
          // is complete. The signed preview describes the bytes that will be
          // uploaded, never an earlier pathname observation.
          preview = { ...preview, size: snapshot.size, sha256: snapshot.hash };
        }
        await immutableWriteJson(files.preview, preview);
        await immutableWriteJson(files.payload, payload);
        const createdAt = new Date();
        const plan: PlanData = {
          version: 2,
          id,
          workspace_id: input.workspace_id,
          actor_id: input.actor_id,
          operation: input.operation,
          target_ids: input.target_ids,
          payload_hash: sha256(payload),
          preview_hash: sha256(preview),
          created_at: createdAt.toISOString(),
          expires_at: new Date(createdAt.getTime() + ACTION_PLAN_LIFETIME_MS).toISOString(),
        };
        const approval = hmac(key, plan);
        await immutableWriteJson(files.plan, { data: plan, signature: approval });
        const state: StateData = { version: 2, action_id: id, state: "planned", revision: 0, updated_at: createdAt.toISOString() };
        await atomicWriteJson(files.state, { data: state, signature: hmac(key, state) });
        await syncDirectory(stagingRoot);
        await this.beforeActionPublish(stagingRoot, publishedFiles.root);
        // Removal may begin while a large upload snapshot is being copied.
        // Recheck under the workspace lifecycle lock at the publication edge.
        await assertWorkspaceAvailable();
        // A same-filesystem directory rename is the publication boundary: list,
        // show, apply, and reconcile can observe either no action or the complete
        // signed action, never a partially populated directory.
        await rename(stagingRoot, publishedFiles.root);
        await syncDirectory(this.directory);
        return { ...plan, approval, preview, payload, state: "planned", revision: 0, ...(input.upload_path ? { upload_snapshot: publishedFiles.upload } : {}) };
      } catch (error) {
        // If publication already won, stagingRoot no longer exists and the
        // complete signed action remains discoverable. Before publication,
        // remove all sensitive staging content.
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    }, release, (value, cause) => preserveActionOutcome(value, cause, "action"));
  }

  private async readContent(filename: string, label: string): Promise<Record<string, unknown>> {
    try {
      const raw = JSON.parse(await readFile(filename, "utf8")) as unknown;
      const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
      if (!parsed.success) throw new Error("not an object");
      return parsed.data;
    } catch (cause) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `The action ${label} is missing or invalid.`, cause });
    }
  }

  private async loadVerified(id: string, options: { skipUploadSnapshotVerification?: boolean; contentRaceRetried?: boolean } = {}): Promise<ActionPlan> {
    const files = this.files(id);
    try { await stat(files.plan); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new AxiError({ code: "ACTION_NOT_FOUND", message: `Action '${id}' was not found.` }); throw cause; }
    const key = await this.readSigningKey(false);
    let rawPlan: unknown;
    let rawState: unknown;
    try {
      [rawPlan, rawState] = await Promise.all([
        readFile(files.plan, "utf8").then(JSON.parse),
        readFile(files.state, "utf8").then(JSON.parse),
      ]);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new AxiError({ code: "ACTION_NOT_FOUND", message: `Action '${id}' was not found.` });
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${id}' cannot be decoded.`, cause });
    }
    const parsedPlan = signedPlanSchema.safeParse(rawPlan);
    const parsedState = signedStateSchema.safeParse(rawState);
    if (!parsedPlan.success || !parsedState.success) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${id}' has an invalid signed record.` });
    }
    const plan = parsedPlan.data.data;
    const state = parsedState.data.data;
    if (plan.id !== id || state.action_id !== id || !signatureMatches(hmac(key, plan), parsedPlan.data.signature) || !signatureMatches(hmac(key, state), parsedState.data.signature)) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${id}' failed signature verification.` });
    }
    let preview: Record<string, unknown> | undefined;
    let payload: Record<string, unknown> | undefined;
    let cleanupFailure: unknown;
    if (!state.content_discarded) {
      try {
        [preview, payload] = await Promise.all([this.readContent(files.preview, "preview"), this.readContent(files.payload, "payload")]);
      } catch (cause) {
        // A terminal transition commits its signed state before removing
        // sensitive content. A concurrent reader can therefore observe the
        // old state immediately before the winner removes preview/payload.
        // Re-read once and accept only a newer, valid, content-discarded
        // state; unchanged state still fails closed as integrity damage.
        if (!options.contentRaceRetried && cause instanceof AxiError && cause.code === "ACTION_INTEGRITY_FAILED") {
          let latestRaw: unknown;
          try { latestRaw = JSON.parse(await readFile(files.state, "utf8")); } catch { throw cause; }
          const latest = signedStateSchema.safeParse(latestRaw);
          if (latest.success
            && latest.data.data.action_id === id
            && latest.data.data.revision >= state.revision
            && latest.data.data.content_discarded === true
            && signatureMatches(hmac(key, latest.data.data), latest.data.signature)) {
            return this.loadVerified(id, { ...options, contentRaceRetried: true });
          }
        }
        throw cause;
      }
      if (sha256(preview) !== plan.preview_hash || sha256(payload) !== plan.payload_hash) {
        throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${id}' content hashes do not match its signed plan.` });
      }
      if (plan.operation === "file.upload" && !options.skipUploadSnapshotVerification) {
        const expectedHash = typeof payload.snapshot_hash === "string" ? payload.snapshot_hash : "";
        const expectedSize = typeof payload.snapshot_size === "number" ? payload.snapshot_size : -1;
        let snapshotSize = -1;
        let snapshotHash = "";
        try {
          snapshotSize = (await stat(files.upload)).size;
          snapshotHash = await sha256File(files.upload);
        } catch {
          // The shared integrity error below avoids leaking filesystem details.
        }
        if (!expectedHash || snapshotHash !== expectedHash || snapshotSize !== expectedSize) {
          throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `Action '${id}' upload snapshot failed verification.` });
        }
      }
    } else {
      try { await this.cleanupContent(id); } catch (cause) { cleanupFailure = cause; }
    }
    const action: ActionPlan = {
      ...plan,
      approval: parsedPlan.data.signature,
      ...(preview ? { preview } : {}),
      ...(payload ? { payload } : {}),
      state: state.state,
      revision: state.revision,
      ...(state.result ? { result: state.result } : {}),
      ...(state.last_error ? { last_error: state.last_error } : {}),
      ...(state.reconciliation ? { reconciliation: state.reconciliation } : {}),
      ...(state.content_discarded ? { content_discarded: true } : {}),
      ...(plan.operation === "file.upload" && !state.content_discarded ? { upload_snapshot: files.upload } : {}),
    };
    return cleanupFailure ? preserveActionOutcome(action, cleanupFailure, "content") : action;
  }

  private async verifiedWorkspaceAt(root: string, expectedActionId: string | undefined, key: Buffer): Promise<string> {
    const files = this.filesAt(root);
    let rawPlan: unknown;
    try {
      rawPlan = JSON.parse(await readFile(files.plan, "utf8")) as unknown;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "An action plan cannot be decoded while workspace data is being removed.", cause });
      }
    }
    if (rawPlan !== undefined) {
      const parsed = signedPlanSchema.safeParse(rawPlan);
      if (!parsed.success
        || (expectedActionId !== undefined && parsed.data.data.id !== expectedActionId)
        || !signatureMatches(hmac(key, parsed.data.data), parsed.data.signature)) {
        throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "An action plan failed verification while workspace data is being removed." });
      }
      return parsed.data.data.workspace_id;
    }

    let rawWorkspace: unknown;
    try {
      rawWorkspace = JSON.parse(await readFile(files.workspace, "utf8")) as unknown;
    } catch (cause) {
      throw new AxiError({ code: "ACTION_WORKSPACE_UNCLASSIFIED", message: "An incomplete action directory cannot be assigned safely to a Slack workspace.", cause });
    }
    const parsed = signedStagingWorkspaceSchema.safeParse(rawWorkspace);
    if (!parsed.success
      || (expectedActionId !== undefined && parsed.data.data.action_id !== expectedActionId)
      || !signatureMatches(hmac(key, parsed.data.data), parsed.data.signature)) {
      throw new AxiError({ code: "ACTION_WORKSPACE_UNCLASSIFIED", message: "An incomplete action directory has an invalid workspace marker." });
    }
    return parsed.data.data.workspace_id;
  }

  async get(id: string): Promise<ActionPlan> {
    const action = await this.loadVerified(id);
    if (action.state === "planned" && Date.parse(action.expires_at) <= Date.now()) {
      return this.transition(action, "expired", {}, true);
    }
    return action;
  }

  protected async beforeStaleOwnerUnlink(_lockDirectory: string, _staleIdentity: string): Promise<void> {
    // Test seam for deterministic timing amplification. Production subclasses
    // should not delay stale-owner fencing.
  }

  private async electStaleTakeover(lockDirectory: string, staleIdentity: string, contender: LockOwner, label: string): Promise<void> {
    let generation = `owner:${staleIdentity}`;
    for (let depth = 0; depth < 64; depth += 1) {
      const markerName = createHash("sha256").update(generation).digest("hex");
      const markerFile = path.join(lockDirectory, `.takeover-${markerName}.json`);
      if (await publishLockRecord(markerFile, contender)) return;

      const elected = await readLockOwner(markerFile);
      const electedIsLive = elected.owner
        ? await processOwnerIsLive(elected.owner, this.isProcessAlive, this.processIdentity)
        : elected.pid !== undefined && this.isProcessAlive(elected.pid);
      if (elected.pid !== undefined && electedIsLive) {
        throw new AxiError({
          code: "ACTION_BUSY",
          message: `${label} stale-lock recovery is owned by another live process.`,
          retryable: true,
          details: { owner_pid: elected.pid },
        });
      }
      if (elected.pid === undefined && elected.ageMs < INCOMPLETE_LOCK_GRACE_MS) {
        throw new AxiError({
          code: "ACTION_BUSY",
          message: `${label} has an incomplete stale-lock election; retry shortly.`,
          retryable: true,
          details: { owner_pid: null },
        });
      }
      if (!elected.identity) {
        throw new AxiError({ code: "ACTION_BUSY", message: `${label} stale-lock election cannot be verified.`, retryable: true });
      }
      // Markers are immutable and never removed or reused. If an elected
      // reclaimer dies, all contenders derive the same child generation and
      // exactly one can publish the next marker.
      generation = `recovery:${markerName}:${elected.identity}`;
    }
    throw new AxiError({ code: "ACTION_BUSY", message: `${label} stale-lock recovery exceeded its bounded election chain.`, retryable: true });
  }

  private async acquireOwnedLock(lockDirectory: string, label: string): Promise<() => Promise<void>> {
    await ensurePrivateDir(lockDirectory);
    const ownerFile = path.join(lockDirectory, "owner.json");
    const processOwner = await currentProcessOwner(new Date().toISOString(), this.processIdentity);
    const owner: LockOwner = { ...processOwner, nonce: randomBytes(16).toString("hex") };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await publishLockRecord(ownerFile, owner)) {
        return async () => { await removeLockRecordIfOwned(ownerFile, owner.nonce); };
      }

      const observed = await readLockOwner(ownerFile);
      if (!observed.identity) continue;
      const observedIsLive = observed.owner
        ? await processOwnerIsLive(observed.owner, this.isProcessAlive, this.processIdentity)
        : observed.pid !== undefined && this.isProcessAlive(observed.pid);
      if (observed.pid !== undefined && observedIsLive) {
        throw new AxiError({ code: "ACTION_BUSY", message: `${label} is owned by another live process.`, retryable: true, details: { owner_pid: observed.pid } });
      }
      if (observed.pid === undefined && observed.ageMs < INCOMPLETE_LOCK_GRACE_MS) {
        throw new AxiError({ code: "ACTION_BUSY", message: `${label} has an incomplete lock claim; retry shortly.`, retryable: true, details: { owner_pid: null } });
      }

      await this.electStaleTakeover(lockDirectory, observed.identity, owner, label);
      await this.beforeStaleOwnerUnlink(lockDirectory, observed.identity);

      // Only the elected live marker owner may reach this point. Revalidate
      // after any delay: a recovered predecessor may already have installed a
      // successor, in which case this contender must never touch owner.json.
      const current = await readLockOwner(ownerFile);
      if (current.identity !== observed.identity) continue;
      try {
        await unlink(ownerFile);
        await syncDirectory(lockDirectory);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    throw new AxiError({ code: "ACTION_BUSY", message: `${label} changed while its stale lock was being recovered; retry shortly.`, retryable: true });
  }

  private async acquireLock(id: string): Promise<() => Promise<void>> {
    const files = this.files(id);
    try {
      await stat(files.plan);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new AxiError({ code: "ACTION_NOT_FOUND", message: `Action '${id}' was not found.` });
      throw cause;
    }
    return this.acquireOwnedLock(files.lock, `Action '${id}'`);
  }

  async withLock<T>(id: string, operation: (action: ActionPlan) => Promise<T>): Promise<T> {
    const release = await this.acquireLock(id);
    return withOwnedRelease(async () => {
      let action = await this.loadVerified(id);
      if (action.state === "applying") {
        action = await this.transitionLocked(action, "unknown", {
          last_error: { code: "PROCESS_INTERRUPTED", message: "The lock owner exited after the remote boundary became possible.", at: new Date().toISOString() },
          result: { ...(action.result ?? {}), recovery: { ...safeRecovery(action.operation, action.payload, action.result?.recovery && typeof action.result.recovery === "object" ? action.result.recovery as Record<string, unknown> : undefined), reason: "dead_apply_owner" } },
        }, true);
      }
      return await operation(action);
    }, release, (value, cause) => preserveActionOutcome(value, cause, "action"));
  }

  async transitionLocked(
    action: ActionPlan,
    state: ActionState,
    changes: Partial<ActionPlan> = {},
    discardContent = TERMINAL_STATES.has(state),
    verification: { uploadSnapshotDescriptorBound?: boolean } = {},
  ): Promise<ActionPlan> {
    const descriptorBound = verification.uploadSnapshotDescriptorBound === true;
    if (descriptorBound && (!discardContent || !["applied", "not_applied", "unknown"].includes(state))) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "A bound upload descriptor can bypass pathname rechecking only while discarding content after a dispatch attempt." });
    }
    const current = await this.loadVerified(action.id, descriptorBound ? { skipUploadSnapshotVerification: true } : {});
    if (descriptorBound && current.operation !== "file.upload") {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "Upload descriptor verification was supplied for a non-upload action." });
    }
    if (current.revision !== action.revision || current.state !== action.state) {
      throw new AxiError({ code: "ACTION_BUSY", message: "The action state changed in another process; reload it before continuing.", retryable: true });
    }
    if (!LEGAL_TRANSITIONS[current.state].has(state)) {
      throw new AxiError({ code: "ACTION_STATE_INVALID", message: `Action cannot transition from '${current.state}' to '${state}'.` });
    }
    const key = await this.readSigningKey(false);
    const next: StateData = {
      version: 2,
      action_id: current.id,
      state,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
      ...(changes.result ? { result: changes.result } : current.result ? { result: current.result } : {}),
      ...(changes.last_error ? { last_error: changes.last_error } : current.last_error ? { last_error: current.last_error } : {}),
      ...(changes.reconciliation ? { reconciliation: changes.reconciliation } : current.reconciliation ? { reconciliation: current.reconciliation } : {}),
      ...(discardContent || current.content_discarded ? { content_discarded: true } : {}),
    };
    const stateFile = this.files(current.id).state;
    try {
      await this.persistSignedState(stateFile, { data: next, signature: hmac(key, next) });
    } catch (cause) {
      // atomicWriteJson can win its rename and then fail the parent-directory
      // fsync. Pre-dispatch `applying` must be proven durable before Slack is
      // called: visibility alone could roll back after a crash and authorize a
      // duplicate. Post-dispatch states re-read the exact signed revision so a
      // visible remote outcome is not obscured by a late local sync error.
      if (state === "applying") throw cause;
      if (!await this.expectedStateIsVisible(stateFile, next, key)) throw cause;
    }
    let cleanupFailure: unknown;
    if (discardContent && !current.content_discarded) {
      try { await this.cleanupContent(current.id); } catch (cause) { cleanupFailure = cause; }
    }
    const updated: ActionPlan = {
      ...current,
      state,
      revision: next.revision,
      ...(next.result ? { result: next.result } : {}),
      ...(next.last_error ? { last_error: next.last_error } : {}),
      ...(next.reconciliation ? { reconciliation: next.reconciliation } : {}),
      ...(next.content_discarded ? { content_discarded: true } : {}),
    };
    if (next.content_discarded) {
      delete updated.preview;
      delete updated.payload;
      delete updated.upload_snapshot;
    }
    return cleanupFailure ? preserveActionOutcome(updated, cleanupFailure, "content") : updated;
  }

  async transition(action: ActionPlan, state: ActionState, changes: Partial<ActionPlan> = {}, discardContent = TERMINAL_STATES.has(state)): Promise<ActionPlan> {
    const release = await this.acquireLock(action.id);
    return withOwnedRelease(async () => {
      const current = await this.loadVerified(action.id);
      if (current.revision !== action.revision) throw new AxiError({ code: "ACTION_BUSY", message: "The action state is stale; reload and retry.", retryable: true });
      return await this.transitionLocked(current, state, changes, discardContent);
    }, release, (value, cause) => preserveActionOutcome(value, cause, "action"));
  }

  async cleanupContent(id: string): Promise<void> {
    const files = this.files(id);
    await Promise.all([removeIfExists(files.preview), removeIfExists(files.payload), removeIfExists(files.upload)]);
    const directory = await open(files.root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async abandon(id: string, approval: string): Promise<ActionPlan> {
    return this.withLock(id, async (action) => {
      this.verifyApproval(action, approval);
      if (action.state === "abandoned") return action;
      if (action.state !== "unknown") throw new AxiError({ code: "ACTION_STATE_INVALID", message: "Only an unknown action can be abandoned.", exitCode: 2 });
      return this.transitionLocked(action, "abandoned", { result: { ...(action.result ?? {}), uncertainty_acknowledged: true } }, true);
    });
  }

  verifyApproval(action: ActionPlan, approval: string): void {
    if (!signatureMatches(action.approval, approval)) {
      throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The approval token does not match the signed action plan.", exitCode: 2 });
    }
  }

  private async hasPublishedRecords(id: string): Promise<boolean> {
    const files = this.files(id);
    try {
      await Promise.all([stat(files.plan), stat(files.state)]);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
  }

  async list(): Promise<ActionPlan[]> {
    await ensurePrivateDir(this.directory);
    const names = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ACTION_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const candidates = await Promise.all(names.map(async (name): Promise<ActionPlan | undefined> => {
      // Pre-atomic-publication versions could leave a UUID directory with a
      // partial plan and no state. It is not an action and must not make an
      // otherwise valid list unusable; GC owns removal of the orphan.
      if (!await this.hasPublishedRecords(name)) return undefined;
      try {
        return await this.get(name);
      } catch (cause) {
        // A concurrent terminal GC may remove the directory after the record
        // probe. Treat that exactly like an entry absent from the snapshot.
        if (cause instanceof AxiError && cause.code === "ACTION_NOT_FOUND") return undefined;
        throw cause;
      }
    }));
    return candidates.filter((action): action is ActionPlan => action !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  private async latestDirectoryMtime(directory: string): Promise<number | undefined> {
    try {
      const [metadata, entries] = await Promise.all([stat(directory), readdir(directory, { withFileTypes: true })]);
      let latest = metadata.mtimeMs;
      for (const entry of entries) {
        try {
          latest = Math.max(latest, (await stat(path.join(directory, entry.name))).mtimeMs);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
      }
      return latest;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  private async quarantineNamedDirectory(name: string, destinationName: string): Promise<string | undefined> {
    const source = path.join(this.directory, name);
    const destination = path.join(this.directory, destinationName);
    try {
      await rename(source, destination);
      await syncDirectory(this.directory);
      return destination;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  private async quarantineActionDirectory(id: string): Promise<string | undefined> {
    this.actionDirectory(id);
    return this.quarantineNamedDirectory(id, `.${id}.deleting-${randomBytes(16).toString("hex")}`);
  }

  private async purgeOrphanDirectory(name: string, cutoff: number): Promise<boolean> {
    const source = path.join(this.directory, name);
    const latest = await this.latestDirectoryMtime(source);
    if (latest === undefined || latest >= cutoff) return false;
    const quarantined = await this.quarantineNamedDirectory(name, `.orphan-deleting-${randomBytes(16).toString("hex")}`);
    if (!quarantined) return false;
    await rm(quarantined, { recursive: true, force: true });
    return true;
  }

  async purgeWorkspace(workspaceId: string): Promise<WorkspaceActionPurgeResult> {
    if (!workspaceId) throw new AxiError({ code: "WORKSPACE_ID_INVALID", message: "A Slack workspace ID is required for action cleanup.", exitCode: 2 });
    await ensurePrivateDir(this.directory);
    const releaseLifecycle = await this.acquireWorkspaceLifecycleLock(workspaceId);
    return withOwnedRelease(async () => {
      const entries = (await readdir(this.directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && (
        ACTION_ID_PATTERN.test(entry.name)
        || CREATION_DIRECTORY_PATTERN.test(entry.name)
        || DELETION_DIRECTORY_PATTERN.test(entry.name)
      ));
      const result: WorkspaceActionPurgeResult = {
        workspace_id: workspaceId,
        scanned: entries.length,
        removed: 0,
        skipped: 0,
        complete: true,
        failed: [],
      };
      if (entries.length === 0) return result;

      let key: Buffer;
      try {
        key = await this.readSigningKey(false);
      } catch (cause) {
        const code = cause instanceof AxiError ? cause.code : "ACTION_SIGNING_KEY_MISSING";
        const message = cause instanceof Error ? cause.message : "The action signing key is unavailable.";
        result.failed = entries.map((entry) => ({ entry: entry.name, code, message }));
        result.complete = false;
        return result;
      }

      for (const entry of entries) {
        const publishedId = ACTION_ID_PATTERN.test(entry.name) ? entry.name : undefined;
        const embeddedId = publishedId ?? /([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(entry.name)?.[1];
        let releaseAction: (() => Promise<void>) | undefined;
        let quarantined: string | undefined;
        try {
          if (publishedId && await this.hasPublishedRecords(publishedId)) {
            releaseAction = await this.acquireLock(publishedId);
          }
          const entryWorkspace = await this.verifiedWorkspaceAt(path.join(this.directory, entry.name), embeddedId, key);
          if (entryWorkspace !== workspaceId) {
            result.skipped += 1;
            continue;
          }
          quarantined = publishedId
            ? await this.quarantineActionDirectory(publishedId)
            : await this.quarantineNamedDirectory(entry.name, `.orphan-deleting-${randomBytes(16).toString("hex")}`);
        } catch (cause) {
          if (cause instanceof AxiError && cause.code === "ACTION_NOT_FOUND") continue;
          result.failed.push({
            entry: entry.name,
            code: cause instanceof AxiError ? cause.code : "ACTION_PURGE_FAILED",
            message: cause instanceof Error ? cause.message : "The action directory could not be removed safely.",
          });
        } finally {
          if (releaseAction) {
            try { await releaseAction(); } catch (cause) {
              result.failed.push({
                entry: entry.name,
                code: cause instanceof AxiError ? cause.code : "ACTION_LOCK_RELEASE_FAILED",
                message: cause instanceof Error ? cause.message : "The action lock could not be released cleanly.",
              });
            }
          }
        }
        if (!quarantined) continue;
        try {
          await rm(quarantined, { recursive: true, force: true });
          await syncDirectory(this.directory);
          result.removed += 1;
        } catch (cause) {
          result.failed.push({
            entry: entry.name,
            code: cause instanceof AxiError ? cause.code : "ACTION_PURGE_FAILED",
            message: cause instanceof Error ? cause.message : "The quarantined action data could not be deleted.",
          });
        }
      }
      result.complete = result.failed.length === 0;
      return result;
    }, releaseLifecycle);
  }

  async deleteUnverified(id: string): Promise<void> {
    const files = this.files(id);
    try {
      await stat(files.root);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }

    let planExists = true;
    try { await stat(files.plan); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") planExists = false; else throw cause; }
    let quarantined: string | undefined;
    if (planExists) {
      const release = await this.acquireLock(id);
      try { quarantined = await this.quarantineActionDirectory(id); } finally { await release(); }
    } else {
      // No mutation path can acquire an action without a plan. Renaming the
      // incomplete directory is therefore the deletion boundary.
      quarantined = await this.quarantineActionDirectory(id);
    }
    if (quarantined) await rm(quarantined, { recursive: true, force: true });
  }

  async gc(retentionDays = 30): Promise<{ removed: number }> {
    await ensurePrivateDir(this.directory);
    const cutoff = Date.now() - retentionDays * 86_400_000;
    // Incomplete creation directories can contain the same message or upload
    // bytes as a planned action, so they follow planned-action expiry rather
    // than the much longer terminal-record retention window. The small grace
    // covers an ownerless legacy mkdir/write interruption. A live PID protects
    // only fresh work: PIDs can be reused after a creator crashes, so liveness
    // alone must never retain sensitive staging bytes forever.
    const orphanCutoff = Date.now() - ORPHAN_RETENTION_MS;
    let removed = 0;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const creating = CREATION_DIRECTORY_PATTERN.exec(entry.name);
      if (creating) {
        const creatorPid = Number(creating[2]);
        const latest = await this.latestDirectoryMtime(path.join(this.directory, entry.name));
        if (latest === undefined) continue;
        // Ongoing snapshot writes refresh file mtimes. Protect a live creator
        // only inside the same bounded freshness window used for all creation
        // orphans; an old directory whose PID was reused is safe to quarantine.
        if (this.isProcessAlive(creatorPid) && latest >= orphanCutoff) continue;
        if (await this.purgeOrphanDirectory(entry.name, orphanCutoff)) removed += 1;
        continue;
      }

      if (DELETION_DIRECTORY_PATTERN.test(entry.name)) {
        const latest = await this.latestDirectoryMtime(path.join(this.directory, entry.name));
        if (latest !== undefined && latest < orphanCutoff) {
          await rm(path.join(this.directory, entry.name), { recursive: true, force: true });
          removed += 1;
        }
        continue;
      }

      if (!ACTION_ID_PATTERN.test(entry.name)) continue;
      if (!await this.hasPublishedRecords(entry.name)) {
        // This can only be residue from a pre-atomic creator (or manual local
        // damage). New creators stay under a PID-owned hidden name until all
        // records are durable.
        if (await this.purgeOrphanDirectory(entry.name, orphanCutoff)) removed += 1;
        continue;
      }
      let quarantined: string | undefined;
      try {
        await this.withLock(entry.name, async (action) => {
          let current = action;
          if (current.state === "planned" && Date.parse(current.expires_at) <= Date.now()) {
            // GC is also a cleanup path. An expired action must not retain a
            // forgotten message body or upload merely because nobody listed
            // or showed it after staging.
            current = await this.transitionLocked(current, "expired", {}, true);
          }
          if (!TERMINAL_STATES.has(current.state)) return;
          if ((await stat(this.files(entry.name).state)).mtimeMs >= cutoff) return;
          quarantined = await this.quarantineActionDirectory(entry.name);
        });
      } catch (cause) {
        if (cause instanceof AxiError && (cause.code === "ACTION_BUSY" || cause.code === "ACTION_NOT_FOUND")) continue;
        throw cause;
      }
      if (!quarantined) continue;
      await rm(quarantined, { recursive: true, force: true });
      removed += 1;
    }
    return { removed };
  }
}
