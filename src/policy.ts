import { z } from "zod";
import path from "node:path";
import { canonicalize } from "json-canonicalize";
import { AxiError } from "./errors.js";
import { atomicWriteJson, readJson } from "./fs-store.js";
import { preserveActionOutcome, withOwnedRelease } from "./lease-outcome.js";
import { OwnedFileLock, type OwnedLockLease } from "./owned-lock.js";
import { appPaths } from "./paths.js";
import type { Policy } from "./types.js";

export const defaultPolicy: Policy = {
  version: 1,
  allow_direct_apply: [],
  allow_broadcast_mentions: [],
  allowed_unfurl_domains: [],
};

const operationSchema = z.enum(["message.send", "message.reply", "reaction.add", "reaction.remove", "file.upload", "mark-read", "later.complete", "later.snooze"]);
const directRuleSchema = z.object({
  operation: operationSchema,
  conversations: z.array(z.string().regex(/^[CDG][A-Z0-9]+$/)),
});
const broadcastRuleSchema = z.object({
  operation: z.enum(["message.send", "message.reply", "file.upload"]),
  conversations: z.array(z.string().regex(/^[CDG][A-Z0-9]+$/)),
});

const schema = z.object({
  version: z.literal(1),
  allow_direct_apply: z.array(directRuleSchema),
  // Existing pre-release policies remain readable, but omission is always a
  // deny. A broadcast grant never follows implicitly from direct-apply access.
  allow_broadcast_mentions: z.array(broadcastRuleSchema).default([]),
  allowed_unfurl_domains: z.array(z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i)),
});

const commitRecordSchema = z.discriminatedUnion("state", [
  z.object({ version: z.literal(1), state: z.literal("pending"), target: schema }),
  z.object({ version: z.literal(1), state: z.literal("committed"), target: schema.nullable() }),
]);

type PolicyCommitRecord =
  | { version: 1; state: "pending"; target: Policy }
  | { version: 1; state: "committed"; target: Policy | null };

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function samePolicy(left: Policy, right: Policy): boolean {
  return sameJson(left, right);
}

const BROADCAST_MENTION = /<!(?:channel|everyone|here)(?:\|[^>\r\n]*)?>|<!subteam\^[^>\s|]+(?:\|[^>\r\n]*)?>/gi;

export function broadcastMentions(text: string): string[] {
  return [...new Set(text.match(BROADCAST_MENTION) ?? [])];
}

export function validateBroadcastMentions(text: string, explicitlyAllowed: boolean): void {
  const mentions = broadcastMentions(text);
  if (mentions.length > 0 && !explicitlyAllowed) {
    throw new AxiError({
      code: "BROADCAST_MENTION_REQUIRES_OPT_IN",
      message: "Broadcast mentions require the explicit --allow-broadcast safety flag.",
      exitCode: 2,
      details: { mentions },
    });
  }
}

interface LinkInspection {
  hostnames: string[];
  malformed: number;
  found: number;
}

// Slack accepts both ordinary links and mrkdwn links such as
// `<https://example.com|label>`. The pipe is a Slack delimiter, not part of
// the URL. Encoded schemes are treated as URL-like too so encoding cannot turn
// a parsing failure into an allowlist bypass.
const URL_TOKEN = /\b(?=((?:https?:|https?%3a|www(?:\.|%2e))[^\s<>{}\[\]"'|)]*))/gi;
const ENCODED_URL_TOKEN = /(?=((?:%[0-9a-f]{2}){4,}[^\s<>{}\[\]"'|)]*))/gi;

function markupIsMalformed(text: string, start: number, raw: string): boolean {
  const open = text.lastIndexOf("<", start);
  const closedBefore = text.lastIndexOf(">", start);
  if (open <= closedBefore) return false;
  const close = text.indexOf(">", start);
  if (close < 0) return true;
  const pipe = text.indexOf("|", start);
  const destinationEnd = pipe >= 0 && pipe < close ? pipe : close;
  return open + 1 !== start
    || text.slice(start, destinationEnd) !== raw
    || (pipe >= 0 && pipe < close && pipe + 1 === close);
}

function normalizedCandidate(raw: string, encoded: boolean, inMarkup: boolean): string | undefined {
  const candidate = inMarkup ? raw : raw.replace(/[.,!?;:]+$/g, "");
  if (!candidate) return undefined;
  try {
    const decoded = encoded || /^(?:https?%3a|www%2e)/i.test(candidate)
      ? decodeURIComponent(candidate)
      : candidate;
    return /^www\./i.test(decoded) ? `http://${decoded}` : decoded;
  } catch {
    return undefined;
  }
}

function inspectLinks(text: string): LinkInspection {
  const candidates = [
    ...text.matchAll(URL_TOKEN),
    ...text.matchAll(ENCODED_URL_TOKEN),
  ].map((match) => ({ start: match.index ?? 0, raw: match[1] ?? "" }))
    .sort((left, right) => left.start - right.start);
  const seen = new Set<string>();
  const hostnames: string[] = [];
  let malformed = 0;
  let found = 0;

  for (const { start, raw } of candidates) {
    const key = `${start}:${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const encoded = raw.startsWith("%") || /^(?:https?%3a|www%2e)/i.test(raw);
    let decodedPrefix = raw;
    if (encoded) {
      try { decodedPrefix = decodeURIComponent(raw); } catch { decodedPrefix = ""; }
      // Ignore unrelated percent-encoded prose. Once decoding resembles a URL,
      // however, every failure below is security-relevant and must fail closed.
      if (!/^(?:https?:\/\/|www\.)/i.test(decodedPrefix)) continue;
    }

    found += 1;
    const open = text.lastIndexOf("<", start);
    const inMarkup = open > text.lastIndexOf(">", start);
    if (markupIsMalformed(text, start, raw)) malformed += 1;
    const normalized = normalizedCandidate(raw, encoded, inMarkup);
    if (!normalized) {
      malformed += 1;
      continue;
    }
    try {
      const parsed = new URL(normalized);
      if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname) {
        malformed += 1;
        continue;
      }
      hostnames.push(parsed.hostname.toLowerCase().replace(/\.$/, ""));
    } catch {
      malformed += 1;
    }
  }
  return { hostnames, malformed, found };
}

export class PolicyStore {
  private readonly lock: OwnedFileLock;

  constructor(private readonly filename = appPaths().policy, private readonly projectFilename = path.resolve(".slack-axi-policy.json")) {
    this.lock = new OwnedFileLock(`${filename}.lock`);
  }

  private async acquireLease(): Promise<OwnedLockLease> {
    try {
      return await this.lock.acquire();
    } catch (cause) {
      if (cause instanceof AxiError && cause.code.startsWith("CONFIG_")) {
        throw new AxiError({
          code: cause.code === "CONFIG_BUSY" ? "POLICY_BUSY" : "POLICY_LOCK_INVALID",
          message: cause.code === "CONFIG_BUSY"
            ? "Another Slack AXI process is updating or using direct-apply policy."
            : "The direct-apply policy lock is invalid; refusing an unsafe authorization.",
          retryable: cause.retryable,
          cause,
        });
      }
      throw cause;
    }
  }

  /** Test seam for failures after the atomic rename but before its caller returns. */
  protected async persistPolicyFile(filename: string, value: unknown): Promise<void> {
    await atomicWriteJson(filename, value);
  }

  private commitFilename(filename: string): string {
    return `${filename}.commit.json`;
  }

  private commitUnknown(scope: "global" | "project", cause?: unknown): AxiError {
    return new AxiError({
      code: "POLICY_COMMIT_UNKNOWN",
      message: "The policy replacement could not be verified; direct authorization is blocked until an explicit policy apply repairs it.",
      suggestedCommand: `slack-axi policy apply <file>${scope === "project" ? " --project" : ""}`,
      details: { policy_scope: scope, direct_authorization_blocked: true },
      cause,
    });
  }

  private async persistCommitRecord(filename: string, record: PolicyCommitRecord, scope: "global" | "project"): Promise<void> {
    try {
      await this.persistPolicyFile(this.commitFilename(filename), record);
    } catch (cause) {
      // A commit-record rename can become visible before its parent-directory
      // fsync reports failure. An exact committed record is safe: the earlier
      // durable pending record means a crash can only retain the committed
      // record or fall back to a fail-closed pending record.
      let visible: unknown;
      try {
        visible = await readJson<unknown | undefined>(this.commitFilename(filename), undefined);
      } catch (verificationError) {
        throw this.commitUnknown(scope, verificationError);
      }
      if (sameJson(visible, record)) return;
      throw this.commitUnknown(scope, cause);
    }
  }

  private async readGuarded(filename: string, scope: "global" | "project"): Promise<Policy | undefined> {
    const [raw, rawRecord] = await Promise.all([
      readJson<unknown | undefined>(filename, undefined),
      readJson<unknown | undefined>(this.commitFilename(filename), undefined),
    ]);
    if (rawRecord === undefined) {
      if (raw === undefined) return undefined;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new AxiError({ code: "POLICY_INVALID", message: "Slack AXI policy is invalid.", details: { issues: parsed.error.issues } });
      return parsed.data;
    }

    const record = commitRecordSchema.safeParse(rawRecord);
    if (!record.success || record.data.state === "pending") throw this.commitUnknown(scope);
    if (record.data.target === null) {
      if (raw === undefined) return undefined;
      throw this.commitUnknown(scope);
    }
    if (raw === undefined) throw this.commitUnknown(scope);
    const parsed = schema.safeParse(raw);
    if (!parsed.success || !samePolicy(parsed.data, record.data.target)) throw this.commitUnknown(scope);
    return parsed.data;
  }

  private previousCommittedTarget(raw: unknown | undefined): Policy | null | undefined {
    if (raw === undefined) return null;
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private async replaceLocked(parsed: Policy, filename: string, scope: "global" | "project", previous: unknown | undefined): Promise<Policy> {
    // The durable pending record is a write-ahead safety fence. If the policy
    // replacement later has an indeterminate result, all readers fail closed
    // until policy apply writes a matching committed record.
    await this.persistPolicyFile(this.commitFilename(filename), { version: 1, state: "pending", target: parsed } satisfies PolicyCommitRecord);
    try {
      await this.persistPolicyFile(filename, parsed);
    } catch (cause) {
      let visible: unknown | undefined;
      try {
        visible = await readJson<unknown | undefined>(filename, undefined);
      } catch (verificationError) {
        throw this.commitUnknown(scope, verificationError);
      }
      const visiblePolicy = visible === undefined ? undefined : schema.safeParse(visible);
      if (visiblePolicy?.success && samePolicy(visiblePolicy.data, parsed)) {
        await this.persistCommitRecord(filename, { version: 1, state: "committed", target: parsed }, scope);
        return parsed;
      }
      if (sameJson(visible, previous)) {
        const priorTarget = this.previousCommittedTarget(previous);
        if (priorTarget !== undefined) {
          await this.persistCommitRecord(filename, { version: 1, state: "committed", target: priorTarget }, scope);
          throw cause;
        }
      }
      throw this.commitUnknown(scope, cause);
    }
    await this.persistCommitRecord(filename, { version: 1, state: "committed", target: parsed }, scope);
    return parsed;
  }

  private async loadEffective(): Promise<{ global: Policy; local?: Policy }> {
    const global = await this.load();
    const local = await this.readGuarded(this.projectFilename, "project");
    return local === undefined ? { global } : { global, local };
  }

  private static ruleAllows(policy: Policy, field: "allow_direct_apply" | "allow_broadcast_mentions", operation: string, conversationId: string): boolean {
    return policy[field].some((rule) => rule.operation === operation && rule.conversations.includes(conversationId));
  }

  private async authorization(operation: string, conversationId: string, requiresBroadcast: boolean): Promise<{ direct: boolean; broadcast: boolean }> {
    const { global, local } = await this.loadEffective();
    const direct = PolicyStore.ruleAllows(global, "allow_direct_apply", operation, conversationId)
      && (!local || PolicyStore.ruleAllows(local, "allow_direct_apply", operation, conversationId));
    const broadcast = !requiresBroadcast || (
      PolicyStore.ruleAllows(global, "allow_broadcast_mentions", operation, conversationId)
      && (!local || PolicyStore.ruleAllows(local, "allow_broadcast_mentions", operation, conversationId))
    );
    return { direct, broadcast };
  }

  async load(): Promise<Policy> {
    return await this.readGuarded(this.filename, "global") ?? defaultPolicy;
  }

  async init(): Promise<Policy> {
    const lease = await this.acquireLease();
    return withOwnedRelease(async () => {
      const existing = await readJson<unknown | undefined>(this.filename, undefined);
      if (existing !== undefined) throw new AxiError({ code: "POLICY_EXISTS", message: "A Slack AXI policy already exists.", suggestedCommand: "slack-axi policy show" });
      return this.replaceLocked(defaultPolicy, this.filename, "global", existing);
    }, () => lease.release(), (value) => value);
  }

  validate(value: unknown): Policy {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AxiError({ code: "POLICY_INVALID", message: "Slack AXI policy is invalid.", exitCode: 2, details: { issues: parsed.error.issues } });
    return parsed.data;
  }

  /** Replace a policy through the same lock used by direct dispatch leases. */
  async replace(value: unknown, scope: "global" | "project" = "global"): Promise<Policy> {
    const parsed = this.validate(value);
    const lease = await this.acquireLease();
    return withOwnedRelease(async () => {
      const filename = scope === "global" ? this.filename : this.projectFilename;
      const previous = await readJson<unknown | undefined>(filename, undefined);
      return this.replaceLocked(parsed, filename, scope, previous);
    }, () => lease.release(), (value) => value);
  }

  async allows(operation: string, conversationId: string, requiresBroadcast = false): Promise<boolean> {
    const result = await this.authorization(operation, conversationId, requiresBroadcast);
    return result.direct && result.broadcast;
  }

  /**
   * Linearize a direct-apply authorization with policy replacement. The lease
   * stays live through remote dispatch and durable action-state persistence, so
   * a revocation either finishes first (and denies) or waits for that outcome.
   */
  async withDirectApplyLease<T>(input: {
    operation: string;
    conversationId: string;
    requiresBroadcast: boolean;
    suggestedCommand?: string;
  }, operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireLease();
    return withOwnedRelease(async () => {
      const authorization = await this.authorization(input.operation, input.conversationId, input.requiresBroadcast);
      if (!authorization.direct) {
        throw new AxiError({
          code: "POLICY_DENIED",
          message: "Direct apply is not allowed for this operation and conversation.",
          ...(input.suggestedCommand ? { suggestedCommand: input.suggestedCommand } : {}),
        });
      }
      if (!authorization.broadcast) {
        throw new AxiError({
          code: "BROADCAST_POLICY_DENIED",
          message: "Direct apply of broadcast mentions requires a separate policy grant for this operation and conversation.",
          ...(input.suggestedCommand ? { suggestedCommand: input.suggestedCommand } : {}),
        });
      }
      return await operation();
    }, () => lease.release(), (value, cause) => preserveActionOutcome(value, cause, "policy"));
  }

  /**
   * Linearize the apply-time unfurl check with policy replacement even for a
   * manually approved signed action. A revocation must either be observed
   * before dispatch or wait until the action outcome is durable.
   */
  async withUnfurlApplyLease<T>(text: string, operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireLease();
    return withOwnedRelease(async () => {
      await this.validateUnfurls(text, true);
      return await operation();
    }, () => lease.release(), (value, cause) => preserveActionOutcome(value, cause, "policy"));
  }

  async validateUnfurls(text: string, enabled: boolean): Promise<void> {
    if (!enabled) return;
    const global = await this.load();
    let domains = new Set(global.allowed_unfurl_domains.map((domain) => domain.toLowerCase()));
    const local = await this.readGuarded(this.projectFilename, "project");
    if (local !== undefined) {
      const narrowed = local;
      const localDomains = new Set(narrowed.allowed_unfurl_domains.map((domain) => domain.toLowerCase()));
      domains = new Set([...domains].filter((domain) => localDomains.has(domain)));
    }
    const links = inspectLinks(text);
    const denied = links.hostnames.filter((hostname) => ![...domains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)));
    if (denied.length > 0 || links.malformed > 0) {
      throw new AxiError({
        code: "UNFURL_POLICY_DENIED",
        message: "Message unfurls require every URL-like construct to be valid and allowlisted by policy.",
        details: { denied_domains: [...new Set(denied)], malformed_links: links.malformed, links_found: links.found },
      });
    }
  }

  async validateUploadComment(text: string): Promise<void> {
    const links = inspectLinks(text);
    if (links.found > 0 || links.malformed > 0) {
      throw new AxiError({
        code: "UNFURL_POLICY_DENIED",
        message: "File-upload comments cannot contain URL-like constructs because Slack's upload API cannot explicitly disable unfurls.",
        details: { detected_domains: [...new Set(links.hostnames)], malformed_links: links.malformed, links_found: links.found },
      });
    }
  }
}
