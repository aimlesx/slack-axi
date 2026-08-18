import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { performance } from "node:perf_hooks";

/**
 * Kernel-visible process birth information. macOS exposes this through ps(1)
 * rather than procfs. Millisecond values are deliberately rounded to seconds
 * because that is the precision returned by `ps -o lstart`.
 *
 * `instanceId` is an additional exact fence for the current Node process. It
 * catches even a same-second PID reuse when a stale record names our PID.
 */
export interface ProcessIdentity {
  startedAtMs: number;
  instanceId?: string;
}

export type ProcessIdentityReader = (pid: number) => Promise<ProcessIdentity | undefined>;
export type ProcessLivenessProbe = (pid: number) => boolean;

export interface ProcessOwnerIdentity {
  pid: number;
  claimed_at: string;
  process_started_at_ms?: number | undefined;
  process_instance_id?: string | undefined;
  process_fence_socket?: string | undefined;
}

const CURRENT_PROCESS_IDENTITY: ProcessIdentity = {
  startedAtMs: Math.floor(performance.timeOrigin / 1_000) * 1_000,
  instanceId: randomUUID().replaceAll("-", ""),
};

const PROCESS_FENCE_PATTERN = /^\/(?:private\/)?tmp\/slack-axi-cli-lock-\d+-[a-f0-9]{32}\.sock$/;
const CURRENT_PROCESS_FENCE = `/tmp/slack-axi-cli-lock-${process.getuid?.() ?? 0}-${CURRENT_PROCESS_IDENTITY.instanceId!}.sock`;
let fenceServer: Server | undefined;
let fencePromise: Promise<string | undefined> | undefined;

export function validProcessFenceSocket(value: unknown): value is string {
  return typeof value === "string" && PROCESS_FENCE_PATTERN.test(value);
}

function currentProcessFence(): Promise<string | undefined> {
  fencePromise ??= new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once("error", () => finish(undefined));
    server.listen({ path: CURRENT_PROCESS_FENCE, backlog: 128 }, () => {
      fenceServer = server;
      server.unref();
      finish(CURRENT_PROCESS_FENCE);
    });
  });
  return fencePromise;
}

process.once("exit", () => {
  if (!fenceServer) return;
  try { unlinkSync(CURRENT_PROCESS_FENCE); } catch { /* best-effort stale socket cleanup */ }
});

async function fenceIsListening(filename: string): Promise<boolean | undefined> {
  if (!validProcessFenceSocket(filename)) return undefined;
  return new Promise<boolean | undefined>((resolve) => {
    const socket = createConnection({ path: filename });
    let settled = false;
    const finish = (value: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 250);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === "ENOENT" || code === "ECONNREFUSED" ? false : undefined);
    });
  });
}

export function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that the PID exists. Other errors (notably ESRCH)
    // cannot establish a live owner and are treated as dead.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function psStartedAt(pid: number): Promise<number | undefined> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
        maxBuffer: 4_096,
        timeout: 1_000,
      },
      (error, value) => error ? reject(error) : resolve(value),
    );
  });
  const parsed = Date.parse(stdout.trim());
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) * 1_000 : undefined;
}

export const defaultProcessIdentity: ProcessIdentityReader = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const startedAtMs = await psStartedAt(pid);
    if (startedAtMs === undefined) return pid === process.pid ? CURRENT_PROCESS_IDENTITY : undefined;
    return {
      startedAtMs,
      ...(pid === process.pid ? { instanceId: CURRENT_PROCESS_IDENTITY.instanceId } : {}),
    };
  } catch {
    // A failed probe must never authorize takeover of an otherwise-live PID.
    return pid === process.pid ? CURRENT_PROCESS_IDENTITY : undefined;
  }
};

export async function currentProcessOwner(
  claimedAt: string,
  readIdentity: ProcessIdentityReader = defaultProcessIdentity,
): Promise<ProcessOwnerIdentity> {
  const identity = await readIdentity(process.pid) ?? CURRENT_PROCESS_IDENTITY;
  const processFence = await currentProcessFence();
  return {
    pid: process.pid,
    claimed_at: claimedAt,
    process_started_at_ms: identity.startedAtMs,
    ...(identity.instanceId ? { process_instance_id: identity.instanceId } : {}),
    ...(processFence ? { process_fence_socket: processFence } : {}),
  };
}

/**
 * A PID alone is not ownership: the kernel may have assigned it to a later
 * process. A valid recorded birth must match the currently-live process.
 * Legacy records have no birth field, so a process demonstrably born after
 * their claim is stale; an unavailable/ambiguous probe fails closed.
 */
export async function processOwnerIsLive(
  owner: ProcessOwnerIdentity,
  isAlive: ProcessLivenessProbe = defaultProcessAlive,
  readIdentity: ProcessIdentityReader = defaultProcessIdentity,
): Promise<boolean> {
  if (!isAlive(owner.pid)) return false;
  if (owner.process_fence_socket !== undefined) {
    const listening = await fenceIsListening(owner.process_fence_socket);
    // A refused or absent instance-specific socket proves that the recorded
    // owner exited even when its PID now belongs to another process. Timeout
    // or an unexpected local error remains conservatively busy.
    if (listening !== undefined) return listening;
    return true;
  }
  const current = await readIdentity(owner.pid);
  if (!current) return true;

  if (owner.process_started_at_ms !== undefined
    && owner.process_started_at_ms !== current.startedAtMs) return false;

  if (owner.pid === process.pid
    && owner.process_instance_id !== undefined
    && current.instanceId !== undefined
    && owner.process_instance_id !== current.instanceId) return false;

  if (owner.process_started_at_ms === undefined) {
    const claimedAtMs = Date.parse(owner.claimed_at);
    // ps reports whole seconds. The extra second makes a same-tick legacy
    // claim conservative while still recovering ordinary PID reuse.
    if (Number.isFinite(claimedAtMs) && current.startedAtMs > claimedAtMs + 1_000) return false;
  }
  return true;
}
