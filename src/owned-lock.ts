import { randomUUID } from "node:crypto";
import { link, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { AxiError } from "./errors.js";
import { ensurePrivateDir, immutableWriteJson } from "./fs-store.js";
import {
  currentProcessOwner,
  defaultProcessAlive,
  defaultProcessIdentity,
  processOwnerIsLive,
  type ProcessIdentityReader,
  type ProcessLivenessProbe,
} from "./process-identity.js";

interface LockOwner {
  version: 1;
  pid: number;
  nonce: string;
  claimed_at: string;
  process_started_at_ms?: number | undefined;
  process_instance_id?: string | undefined;
  process_fence_socket?: string | undefined;
}

interface ReclaimOwner extends LockOwner {
  target_nonce: string;
}

export interface OwnedLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  now?: () => Date;
  isProcessAlive?: ProcessLivenessProbe;
  processIdentity?: ProcessIdentityReader;
}

export interface OwnedLockLease {
  readonly owner: Readonly<LockOwner>;
  release(): Promise<void>;
}

type ParsedOwner = { kind: "missing" } | { kind: "invalid" } | { kind: "owner"; owner: LockOwner };

function isOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LockOwner>;
  return candidate.version === 1
    && Number.isSafeInteger(candidate.pid)
    && (candidate.pid ?? 0) > 0
    && typeof candidate.nonce === "string"
    && /^[A-Za-z0-9_-]{16,}$/.test(candidate.nonce)
    && typeof candidate.claimed_at === "string"
    && !Number.isNaN(Date.parse(candidate.claimed_at))
    && (candidate.process_started_at_ms === undefined
      || (Number.isSafeInteger(candidate.process_started_at_ms) && candidate.process_started_at_ms > 0))
    && (candidate.process_instance_id === undefined
      || (typeof candidate.process_instance_id === "string" && /^[A-Za-z0-9_-]{16,}$/.test(candidate.process_instance_id)))
    && (candidate.process_fence_socket === undefined
      || (typeof candidate.process_fence_socket === "string"
        && /^\/(?:private\/)?tmp\/slack-axi-cli-lock-\d+-[a-f0-9]{32}\.sock$/.test(candidate.process_fence_socket)));
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.pid === right.pid
    && left.nonce === right.nonce
    && left.claimed_at === right.claimed_at
    && left.process_started_at_ms === right.process_started_at_ms
    && left.process_instance_id === right.process_instance_id
    && left.process_fence_socket === right.process_fence_socket;
}

function errno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * A process-owned filesystem lock.
 *
 * Lock and reclaimer records are fully written before an atomic hard-link
 * publishes them. Reclaimers publish unique marker files and elect one owner;
 * new claimants do not return while any live reclaimer exists. Releases move
 * the exact owned record to a nonce-specific path before deleting it, so a
 * delayed former owner never unlinks a successor's lock.
 */
export class OwnedFileLock {
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processIdentity: ProcessIdentityReader;
  private readonly markerPrefix: string;

  constructor(readonly filename: string, options: OwnedLockOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryMs = options.retryMs ?? 20;
    this.now = options.now ?? (() => new Date());
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.processIdentity = options.processIdentity ?? defaultProcessIdentity;
    this.markerPrefix = `.${path.basename(filename)}.reclaim.`;
  }

  private async readOwner(filename = this.filename): Promise<ParsedOwner> {
    try {
      const value = JSON.parse(await readFile(filename, "utf8")) as unknown;
      return isOwner(value) ? { kind: "owner", owner: value } : { kind: "invalid" };
    } catch (error) {
      if (errno(error, "ENOENT")) return { kind: "missing" };
      if (error instanceof SyntaxError) return { kind: "invalid" };
      throw error;
    }
  }

  private async publish(filename: string, value: LockOwner | ReclaimOwner): Promise<void> {
    const candidate = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.candidate`);
    await immutableWriteJson(candidate, value);
    try {
      await link(candidate, filename);
    } finally {
      await rm(candidate, { force: true });
    }
  }

  private async markers(): Promise<Array<{ filename: string; owner: LockOwner | undefined }>> {
    let entries: string[];
    try {
      entries = await readdir(path.dirname(this.filename));
    } catch (error) {
      if (errno(error, "ENOENT")) return [];
      throw error;
    }
    const result: Array<{ filename: string; owner: LockOwner | undefined }> = [];
    for (const entry of entries.filter((name) => name.startsWith(this.markerPrefix)).sort()) {
      const filename = path.join(path.dirname(this.filename), entry);
      const parsed = await this.readOwner(filename);
      if (parsed.kind === "missing") continue;
      if (parsed.kind === "owner") {
        if (!await processOwnerIsLive(parsed.owner, this.isProcessAlive, this.processIdentity)) {
          await rm(filename, { force: true });
        } else {
          result.push({ filename, owner: parsed.owner });
        }
        continue;
      }
      // Marker names include their creator PID. A malformed marker from a dead
      // process is safe to remove because marker paths are nonce-specific and
      // are never reused.
      const pid = Number(entry.slice(this.markerPrefix.length).split(".", 1)[0]);
      if (Number.isSafeInteger(pid) && pid > 0 && !this.isProcessAlive(pid)) {
        await rm(filename, { force: true });
      } else {
        result.push({ filename, owner: undefined });
      }
    }
    return result;
  }

  private async waitForNoReclaimers(deadline: number): Promise<void> {
    while ((await this.markers()).length > 0) {
      if (Date.now() >= deadline) this.busy();
      await delay(this.retryMs);
    }
  }

  private async waitForReclaimTurn(marker: string, deadline: number): Promise<void> {
    for (;;) {
      const markers = await this.markers();
      if (!markers.some((item) => item.filename < marker)) return;
      if (Date.now() >= deadline) this.busy();
      await delay(this.retryMs);
    }
  }

  private busy(): never {
    throw new AxiError({
      code: "CONFIG_BUSY",
      message: "Another Slack AXI process is updating authentication configuration.",
      retryable: true,
    });
  }

  private invalid(): never {
    throw new AxiError({
      code: "CONFIG_LOCK_INVALID",
      message: "The authentication configuration lock is malformed; refusing an unsafe takeover.",
    });
  }

  private async reclaim(observed: LockOwner, deadline: number): Promise<void> {
    const nonce = randomUUID().replaceAll("-", "");
    const marker = path.join(path.dirname(this.filename), `${this.markerPrefix}${process.pid}.${nonce}`);
    const processOwner = await currentProcessOwner(this.now().toISOString(), this.processIdentity);
    const record: ReclaimOwner = {
      version: 1,
      ...processOwner,
      nonce,
      target_nonce: observed.nonce,
    };
    await this.publish(marker, record);
    try {
      await this.waitForReclaimTurn(marker, deadline);
      const current = await this.readOwner();
      if (current.kind === "missing") return;
      if (current.kind === "invalid") this.invalid();
      if (!sameOwner(current.owner, observed)
        || await processOwnerIsLive(current.owner, this.isProcessAlive, this.processIdentity)) return;
      const quarantine = path.join(path.dirname(this.filename), `.${path.basename(this.filename)}.${observed.nonce}.${nonce}.stale`);
      try {
        await rename(this.filename, quarantine);
      } catch (error) {
        if (errno(error, "ENOENT")) return;
        throw error;
      }
      const moved = await this.readOwner(quarantine);
      if (moved.kind !== "owner" || !sameOwner(moved.owner, observed)) {
        throw new AxiError({ code: "CONFIG_LOCK_LOST", message: "The authentication configuration lock changed during recovery." });
      }
      await rm(quarantine, { force: true });
    } finally {
      await rm(marker, { force: true });
    }
  }

  async acquire(): Promise<OwnedLockLease> {
    await ensurePrivateDir(path.dirname(this.filename));
    const deadline = Date.now() + this.timeoutMs;
    const processOwner = await currentProcessOwner(this.now().toISOString(), this.processIdentity);
    const owner: LockOwner = {
      version: 1,
      ...processOwner,
      nonce: randomUUID().replaceAll("-", ""),
    };
    for (;;) {
      await this.waitForNoReclaimers(deadline);
      let published = false;
      try {
        await this.publish(this.filename, owner);
        published = true;
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
      }
      if (published) {
        await this.waitForNoReclaimers(deadline);
        const current = await this.readOwner();
        if (current.kind === "owner" && sameOwner(current.owner, owner)) {
          let released = false;
          return {
            owner,
            release: async () => {
              if (released) return;
              released = true;
              await this.waitForNoReclaimers(Date.now() + this.timeoutMs);
              const visible = await this.readOwner();
              if (visible.kind !== "owner" || !sameOwner(visible.owner, owner)) {
                throw new AxiError({ code: "CONFIG_LOCK_LOST", message: "The authentication configuration lock is no longer owned by this process." });
              }
              const releasedFile = path.join(path.dirname(this.filename), `.${path.basename(this.filename)}.${owner.nonce}.released`);
              await rename(this.filename, releasedFile);
              const moved = await this.readOwner(releasedFile);
              if (moved.kind !== "owner" || !sameOwner(moved.owner, owner)) {
                throw new AxiError({ code: "CONFIG_LOCK_LOST", message: "The authentication configuration lock changed during release." });
              }
              await rm(releasedFile, { force: true });
            },
          };
        }
        // A reclaimer that was already in flight may have moved this claim.
        // Its marker prevents this process from returning as owner; retry only
        // after the active path is stable again.
        if (Date.now() >= deadline) this.busy();
        await delay(this.retryMs);
        continue;
      }
      const observed = await this.readOwner();
      if (observed.kind === "invalid") this.invalid();
      if (observed.kind === "owner"
        && !await processOwnerIsLive(observed.owner, this.isProcessAlive, this.processIdentity)) {
        await this.reclaim(observed.owner, deadline);
        continue;
      }
      if (Date.now() >= deadline) this.busy();
      await delay(this.retryMs);
    }
  }
}
