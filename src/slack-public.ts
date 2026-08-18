import { constants, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { pipeline } from "node:stream/promises";
import { LogLevel, WebClient, type Logger, type WebAPICallResult } from "@slack/web-api";
import { z } from "zod";
import { AxiError } from "./errors.js";
import type { VerifiedUploadSnapshot } from "./types.js";

type SlackRecord = Record<string, unknown>;
type CallKind = "read" | "write" | "file";

export const DEFAULT_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const MAX_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024;

const recordSchema = z.record(z.string(), z.unknown());
const oauthMetadataSchema = z.object({ scopes: z.array(z.string().min(1)).optional() }).passthrough();
// Slack always supplies the pagination metadata object on these endpoints,
// but terminal history/replies pages may omit the empty next_cursor member.
const cursorMetadataSchema = z.object({ next_cursor: z.string().optional() }).passthrough();
const listCursorMetadataSchema = z.object({ next_cursor: z.string() }).passthrough();
const okSchema = z.object({ ok: z.literal(true) }).passthrough();
const authSchema = z.object({
  team_id: z.string(),
  user_id: z.string(),
  team: z.string().optional(),
  user: z.string().optional(),
  url: z.string().url().optional(),
  response_metadata: oauthMetadataSchema.optional(),
}).passthrough();
const itemSchema = z.object({ id: z.string() }).passthrough();
const authRevokeSchema = z.object({ ok: z.literal(true), revoked: z.literal(true) }).passthrough();
const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  deleted: z.boolean(),
  is_bot: z.boolean(),
  profile: z.object({ display_name: z.string(), real_name: z.string() }).passthrough(),
  tz: z.union([z.string(), z.null()]).optional(),
}).passthrough();
const directConversationSchema = z.object({
  id: z.string(),
  is_im: z.literal(true),
  user: z.string(),
  is_ext_shared: z.boolean().optional(),
}).passthrough();
const namedConversationSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_im: z.literal(false),
  is_mpim: z.boolean(),
  is_group: z.boolean(),
  is_private: z.boolean(),
  is_archived: z.boolean(),
  is_ext_shared: z.boolean().optional(),
  topic: z.object({ value: z.string() }).passthrough().optional(),
  purpose: z.object({ value: z.string() }).passthrough().optional(),
}).passthrough();
const conversationSchema = z.union([directConversationSchema, namedConversationSchema]);
const reactionSchema = z.object({
  name: z.string().min(1),
  count: z.number().finite().int().nonnegative(),
  users: z.array(z.string()),
}).passthrough();
export type SlackReaction = z.infer<typeof reactionSchema>;
export type TokenRevocationResult =
  | { status: "revoked" }
  | { status: "already_inactive"; slack_error: string };
const messageSchema = z.object({ ts: z.string(), reactions: z.array(reactionSchema).optional() }).passthrough();
const reactionMessageSchema = z.object({
  reactions: z.array(reactionSchema).optional(),
}).passthrough();
const readStateSchema = z.object({
  id: z.string(),
  last_read: z.string().regex(/^\d+(?:\.\d+)?$/),
}).passthrough();
const searchMessageSchema = z.union([
  z.object({ ts: z.string(), text: z.string(), channel_id: z.string(), reactions: z.array(reactionSchema).optional() }).passthrough(),
  z.object({ ts: z.string(), text: z.string(), channel: z.object({ id: z.string() }).passthrough(), reactions: z.array(reactionSchema).optional() }).passthrough(),
]);
const usergroupSchema = z.object({ id: z.string(), handle: z.string(), name: z.string(), description: z.string() }).passthrough();
const fileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  mimetype: z.string(),
  size: z.number().int().nonnegative().optional(),
}).passthrough().refine((value) => value.name !== undefined || value.title !== undefined, { message: "either file name or title is required" });
const inboxConversationSchema = z.object({
  id: z.string(),
  unread_count_display: z.number().int().nonnegative().optional(),
  unread_count: z.number().int().nonnegative().optional(),
  is_ext_shared: z.boolean().optional(),
}).passthrough().refine(
  (value) => value.unread_count_display !== undefined || value.unread_count !== undefined,
  { message: "either unread_count_display or unread_count is required" },
);
const pagedListSchema = (key: string, item: z.ZodType = recordSchema) => z.object({ [key]: z.array(item), response_metadata: listCursorMetadataSchema }).passthrough();
const uploadCompletionSchema = z.object({ ok: z.literal(true), files: z.array(itemSchema).min(1) }).passthrough();
const uploadResponseSchema = z.union([
  z.object({ ok: z.literal(true), files: z.array(itemSchema).min(1) }).passthrough(),
  z.object({ ok: z.literal(true), files: z.array(uploadCompletionSchema).min(1) }).passthrough(),
  z.object({ ok: z.literal(true), file: itemSchema }).passthrough(),
]);
const searchCollectionSchema = <T extends z.ZodTypeAny>(item: T) => z.object({
  matches: z.array(item),
  total: z.number().int().nonnegative(),
  paging: z.object({ pages: z.number().int().nonnegative() }).passthrough(),
}).passthrough();

function asRecord(value: unknown): SlackRecord {
  return value && typeof value === "object" ? value as SlackRecord : {};
}

function array(value: unknown): SlackRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: `Slack's ${label} response does not match the supported schema.`, details: { issues: parsed.error.issues } });
  return parsed.data;
}

const noOpLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  getLevel() { return LogLevel.ERROR; },
  setName() {},
};

function authoritativeCode(code: string): boolean {
  return new Set([
    "invalid_auth", "not_authed", "account_inactive", "token_revoked",
    "missing_scope", "not_allowed_token_type", "no_permission", "restricted_action",
    "invalid_arguments", "invalid_arg_name", "invalid_array_arg", "invalid_charset",
    "invalid_form_data", "invalid_post_type", "missing_post_type", "channel_not_found",
    "not_in_channel", "is_archived", "msg_too_long", "no_text", "already_reacted", "no_reaction",
  ]).has(code);
}

function translateSlackError(cause: unknown, kind: CallKind): AxiError {
  if (cause instanceof AxiError) return cause;
  const record = asRecord(cause);
  const data = asRecord(record.data);
  const rawCode = typeof data.error === "string" ? data.error : typeof record.code === "string" ? record.code : "slack_api_error";
  const code = rawCode.toLowerCase();
  if (code === "slack_webapi_platform_error" && typeof data.error !== "string") {
    return new AxiError({
      code: "SLACK_RESPONSE_INVALID",
      message: "Slack returned a malformed API response.",
      details: { dispatch_uncertain: kind !== "read" },
      cause,
    });
  }
  const retryAfter = typeof record.retryAfter === "number" ? record.retryAfter : undefined;
  if (retryAfter !== undefined || code.includes("rate_limited")) {
    return new AxiError({ code: "RATE_LIMITED", message: "Slack rate limited the request.", retryable: true, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}), details: { slack_error: rawCode, dispatch_uncertain: false }, cause });
  }
  const authCodes = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked"]);
  const scopeCodes = new Set(["missing_scope", "not_allowed_token_type", "no_permission", "restricted_action"]);
  const requestCode = code.includes("request_error") || code.includes("network") || code.includes("fetch");
  const httpCode = code.includes("http_error") || code.includes("status_code");
  const uncertain = kind !== "read" && !authoritativeCode(code);
  return new AxiError({
    code: authCodes.has(code) ? "AUTH_INVALID" : scopeCodes.has(code) ? "SLACK_PERMISSION_DENIED" : requestCode ? "SLACK_NETWORK_ERROR" : httpCode ? "SLACK_HTTP_ERROR" : rawCode.toUpperCase(),
    message: authCodes.has(code)
      ? "Slack rejected the configured credential."
      : scopeCodes.has(code)
        ? "The configured Slack credential lacks permission for this operation."
        : requestCode
          ? "The Slack request failed at the network boundary."
          : httpCode
            ? "A proxy or HTTP failure interrupted the Slack request."
            : `Slack rejected the request (${rawCode}).`,
    retryable: kind === "read" && (requestCode || httpCode || ["internal_error", "fatal_error", "request_timeout"].includes(code)),
    details: { slack_error: rawCode, dispatch_uncertain: uncertain },
    cause,
  });
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, kind: CallKind): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AxiError({
      code: "REQUEST_TIMEOUT",
      message: `Slack did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
      retryable: kind === "read",
      details: { dispatch_uncertain: kind !== "read", timeout_ms: timeoutMs },
    })), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function allowedSlackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "slack.com" || host.endsWith(".slack.com") || host === "slack-files.com" || host.endsWith(".slack-files.com") || host === "slack-edge.com" || host.endsWith(".slack-edge.com");
}

function allowedSlackCookieHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "slack.com" || host.endsWith(".slack.com");
}

function allowedPermalinkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host.endsWith(".slack.com")) return false;
  const workspaceLabel = host.slice(0, -".slack.com".length);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workspaceLabel)) return false;
  return !/^(?:api|app|edge|files|hooks|downloads?|status)(?:-|$)/.test(workspaceLabel);
}

// conversations.history applies `inclusive` to both oldest and latest. The
// CLI's public range contract is [oldest, latest), so move only the exclusive
// lower provider boundary back by one Slack timestamp microsecond. Slack
// message timestamps have six fractional digits; no real timestamp can fall
// between this adjusted value and the requested oldest value.
function precedingSlackTimestamp(value: string): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new AxiError({ code: "SLACK_TIMESTAMP_INVALID", message: "Slack history boundaries must be nonnegative timestamps with at most six fractional digits." });
  const seconds = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  const microseconds = seconds * 1_000_000n + fraction;
  if (microseconds === 0n) return "0";
  const previous = microseconds - 1n;
  return `${previous / 1_000_000n}.${String(previous % 1_000_000n).padStart(6, "0")}`;
}

export function assertSlackHttpsUrl(input: string, label = "Slack URL"): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new AxiError({ code: "SLACK_URL_INVALID", message: `${label} must be a valid HTTPS Slack URL.` }); }
  if (url.protocol !== "https:" || !allowedSlackHost(url.hostname) || url.username || url.password) {
    throw new AxiError({ code: "SLACK_URL_INVALID", message: `${label} must use HTTPS on a Slack-owned host.` });
  }
  return url;
}

export function slackCookieHeader(cookie: string): string {
  if (!/^xoxd-(?:[A-Za-z0-9._~+/=-]|%[A-Fa-f0-9]{2})+$/.test(cookie)) {
    throw new AxiError({ code: "AUTH_INVALID", message: "Slack browser authentication requires a valid xoxd cookie." });
  }
  return `d=${cookie}`;
}

export function normalizeUploadResponse(value: unknown): SlackRecord {
  const parsed = validate(uploadResponseSchema, value, "files.uploadV2") as SlackRecord;
  const top = Array.isArray(parsed.files) ? parsed.files.map(asRecord) : [asRecord(parsed.file)];
  const files = top.flatMap((entry) => Array.isArray(entry.files) ? entry.files.map(asRecord) : [entry]);
  return { files: files.map((file) => ({ id: file.id, ...(typeof file.name === "string" ? { name: file.name } : {}), ...(typeof file.mimetype === "string" ? { mimetype: file.mimetype } : {}), ...(typeof file.size === "number" ? { size: file.size } : {}), ...(typeof file.permalink === "string" ? { permalink: file.permalink } : {}) })) };
}

export class PublicSlackClient {
  readonly web: WebClient;
  backendCalls = 0;
  private readonly uploadWeb: WebClient;
  private readonly fetchFn: typeof fetch;
  private readonly cookieHeader: string | undefined;

  constructor(
    private readonly token: string,
    options: { apiUrl?: string; fetch?: typeof fetch; cookie?: string } = {},
  ) {
    const apiUrl = options.apiUrl ? assertSlackHttpsUrl(options.apiUrl, "Slack API base URL") : undefined;
    if (options.cookie !== undefined && apiUrl && !allowedSlackCookieHost(apiUrl.hostname)) {
      throw new AxiError({ code: "SLACK_URL_INVALID", message: "Slack browser cookies can be sent only to slack.com or a Slack workspace subdomain." });
    }
    this.cookieHeader = options.cookie === undefined ? undefined : slackCookieHeader(options.cookie);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    const common = {
      ...(options.apiUrl ? { slackApiUrl: options.apiUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch as never } : {}),
      maxRequestConcurrency: 4,
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
      logger: noOpLogger,
      headers: {
        "User-Agent": "slack-axi-cli/0.1",
        ...(this.cookieHeader === undefined ? {} : { Cookie: this.cookieHeader }),
      },
    };
    this.web = new WebClient(token, { ...common, timeout: 15_000 });
    this.uploadWeb = new WebClient(token, { ...common, timeout: 120_000 });
  }

  private async call<T extends WebAPICallResult>(kind: CallKind, operation: () => Promise<T>): Promise<T> {
    const attempts = kind === "read" ? 2 : 1;
    let last: AxiError | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        this.backendCalls += 1;
        return await bounded(operation(), kind === "file" ? 120_000 : kind === "write" ? 15_000 : 10_000, kind);
      } catch (cause) {
        last = translateSlackError(cause, kind);
        if (!last.retryable || last.code === "RATE_LIMITED" || attempt + 1 >= attempts) throw last;
      }
    }
    throw last ?? new AxiError({ code: "SLACK_API_ERROR", message: "Slack request failed." });
  }

  async authTest(): Promise<SlackRecord> {
    return validate(authSchema, await this.call("read", () => this.web.auth.test()), "auth.test");
  }

  async revokeToken(): Promise<TokenRevocationResult> {
    try {
      validate(authRevokeSchema, await this.call("write", () => this.web.auth.revoke()), "auth.revoke");
      return { status: "revoked" };
    } catch (error) {
      if (error instanceof AxiError && error.code === "AUTH_INVALID") {
        const slackError = typeof error.details?.slack_error === "string" ? error.details.slack_error : "invalid_auth";
        if (["invalid_auth", "not_authed", "account_inactive", "token_revoked"].includes(slackError)) {
          return { status: "already_inactive", slack_error: slackError };
        }
      }
      throw error;
    }
  }

  async userInfo(user: string): Promise<SlackRecord> {
    const response = validate(z.object({ user: userSchema }).passthrough(), await this.call("read", () => this.web.users.info({ user })), "users.info");
    return response.user;
  }

  async listUsers(limit = 200, cursor?: string): Promise<{ items: SlackRecord[]; next?: string }> {
    const response = validate(pagedListSchema("members", userSchema), await this.call("read", () => this.web.users.list({ limit: Math.min(limit, 200), ...(cursor ? { cursor } : {}) })), "users.list");
    const next = typeof asRecord(response.response_metadata).next_cursor === "string" ? String(asRecord(response.response_metadata).next_cursor) : undefined;
    return { items: response.members as SlackRecord[], ...(next ? { next } : {}) };
  }

  async listConversations(limit = 200, cursor?: string, types = "public_channel,private_channel,mpim,im"): Promise<{ items: SlackRecord[]; next?: string }> {
    const response = validate(pagedListSchema("channels", conversationSchema), await this.call("read", () => this.web.users.conversations({ limit: Math.min(limit, 200), types, exclude_archived: false, ...(cursor ? { cursor } : {}) })), "users.conversations");
    const next = typeof asRecord(response.response_metadata).next_cursor === "string" ? String(asRecord(response.response_metadata).next_cursor) : undefined;
    return { items: response.channels as SlackRecord[], ...(next ? { next } : {}) };
  }

  async conversationInfo(channel: string): Promise<SlackRecord> {
    const response = validate(z.object({ channel: conversationSchema }).passthrough(), await this.call("read", () => this.web.conversations.info({ channel, include_num_members: true })), "conversations.info");
    return response.channel;
  }

  async conversationInboxInfo(channel: string): Promise<SlackRecord> {
    const response = validate(z.object({ channel: inboxConversationSchema }).passthrough(), await this.call("read", () => this.web.conversations.info({ channel, include_num_members: true })), "conversations.info inbox probe");
    return response.channel;
  }

  async conversationReadState(channel: string): Promise<SlackRecord> {
    const response = validate(z.object({ channel: readStateSchema }).passthrough(), await this.call("read", () => this.web.conversations.info({ channel })), "conversations.info read-state probe");
    return response.channel;
  }

  async conversationMembers(channel: string, limit = 100, cursor?: string): Promise<{ items: string[]; next?: string }> {
    const response = validate(z.object({ members: z.array(z.string()), response_metadata: listCursorMetadataSchema }).passthrough(), await this.call("read", () => this.web.conversations.members({ channel, limit: Math.min(limit, 200), ...(cursor ? { cursor } : {}) })), "conversations.members");
    const next = response.response_metadata?.next_cursor || undefined;
    return { items: response.members, ...(next ? { next } : {}) };
  }

  async listUsergroups(includeUsers = false): Promise<SlackRecord[]> {
    const response = validate(z.object({ usergroups: z.array(usergroupSchema) }).passthrough(), await this.call("read", () => this.web.usergroups.list({ include_users: includeUsers, include_disabled: false })), "usergroups.list");
    return response.usergroups as SlackRecord[];
  }

  async usergroupMembers(usergroup: string): Promise<string[]> {
    const response = validate(z.object({ users: z.array(z.string()) }).passthrough(), await this.call("read", () => this.web.usergroups.users.list({ usergroup })), "usergroups.users.list");
    return response.users;
  }

  async emoji(): Promise<Record<string, string>> {
    const response = validate(z.object({ emoji: z.record(z.string(), z.string()) }).passthrough(), await this.call("read", () => this.web.emoji.list()), "emoji.list");
    return response.emoji;
  }

  async history(options: { channel: string; oldest: string; latest: string; limit: number; cursor?: string }): Promise<{ items: SlackRecord[]; next?: string; complete: boolean }> {
    const response = validate(z.object({ messages: z.array(messageSchema), has_more: z.boolean(), response_metadata: cursorMetadataSchema }).passthrough(), await this.call("read", () => this.web.conversations.history({
      channel: options.channel,
      oldest: precedingSlackTimestamp(options.oldest),
      latest: options.latest,
      inclusive: false,
      limit: Math.min(options.limit, 100),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    })), "conversations.history");
    const next = response.response_metadata?.next_cursor || undefined;
    if (response.has_more && !next) throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack's conversations.history response claims another page without a continuation cursor.", details: { endpoint: "conversations.history", has_more: true } });
    return { items: response.messages, ...(next ? { next } : {}), complete: response.has_more !== true && !next };
  }

  async replies(options: { channel: string; ts: string; limit: number; cursor?: string }): Promise<{ items: SlackRecord[]; next?: string; complete: boolean }> {
    const response = validate(z.object({ messages: z.array(messageSchema), has_more: z.boolean(), response_metadata: cursorMetadataSchema }).passthrough(), await this.call("read", () => this.web.conversations.replies({ channel: options.channel, ts: options.ts, limit: Math.min(options.limit, 100), ...(options.cursor ? { cursor: options.cursor } : {}) })), "conversations.replies");
    const next = response.response_metadata?.next_cursor || undefined;
    if (response.has_more && !next) throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack's conversations.replies response claims another page without a continuation cursor.", details: { endpoint: "conversations.replies", has_more: true } });
    return { items: response.messages, ...(next ? { next } : {}), complete: response.has_more !== true && !next };
  }

  async messageByTs(channel: string, ts: string): Promise<SlackRecord | undefined> {
    const response = validate(z.object({ messages: z.array(messageSchema) }).passthrough(), await this.call("read", () => this.web.apiCall("conversations.history", { channel, oldest: ts, latest: ts, inclusive: true, limit: 1 })), "conversations.history exact lookup");
    const root = response.messages.find((message) => message.ts === ts);
    if (root) return root;
    const thread = validate(
      z.object({ messages: z.array(messageSchema), has_more: z.boolean(), response_metadata: cursorMetadataSchema }).passthrough(),
      await this.call("read", () => this.web.conversations.replies({ channel, ts, oldest: ts, latest: ts, inclusive: true, limit: 1 })),
      "conversations.replies exact lookup",
    );
    const reply = thread.messages.find((message) => message.ts === ts);
    if (reply) return reply;
    const next = thread.response_metadata?.next_cursor || undefined;
    if (thread.has_more || next) {
      throw new AxiError({
        code: "SLACK_RESPONSE_INVALID",
        message: "Slack's exact reply lookup remained paginated without returning the requested timestamp.",
        details: { endpoint: "conversations.replies", has_more: thread.has_more, continuation_present: Boolean(next) },
      });
    }
    return undefined;
  }

  async searchMessages(query: string, limit: number, page = 1, sort: "score" | "timestamp" = "score"): Promise<{ items: SlackRecord[]; total: number; pages: number }> {
    const response = validate(z.object({ messages: searchCollectionSchema(searchMessageSchema) }).passthrough(), await this.call("read", () => this.web.search.messages({ query, count: Math.min(limit, 100), page, sort, sort_dir: "desc" })), "search.messages");
    return { items: response.messages.matches, total: response.messages.total, pages: response.messages.paging.pages };
  }

  async searchFiles(query: string, limit: number, page = 1, sort: "score" | "timestamp" = "score"): Promise<{ items: SlackRecord[]; total: number; pages: number }> {
    const response = validate(z.object({ files: searchCollectionSchema(fileSchema) }).passthrough(), await this.call("read", () => this.web.search.files({ query, count: Math.min(limit, 100), page, sort, sort_dir: "desc" })), "search.files");
    return { items: response.files.matches, total: response.files.total, pages: response.files.paging.pages };
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const response = validate(z.object({ permalink: z.string().url() }).passthrough(), await this.call("read", () => this.web.chat.getPermalink({ channel, message_ts: ts })), "chat.getPermalink");
    const url = assertSlackHttpsUrl(response.permalink, "Slack permalink");
    const expectedPath = `/archives/${channel}/p${ts.replace(".", "")}`;
    if (!allowedPermalinkHost(url.hostname)
      || url.port
      || url.pathname !== expectedPath) {
      throw new AxiError({ code: "SLACK_URL_INVALID", message: "Slack permalink must identify the requested message on a Slack workspace host." });
    }
    return url.toString();
  }

  async reactions(channel: string, timestamp: string): Promise<{ reactions: SlackReaction[] }> {
    const response = validate(z.object({ message: reactionMessageSchema }).passthrough(), await this.call("read", () => this.web.reactions.get({ channel, timestamp, full: true })), "reactions.get");
    return { reactions: response.message.reactions ?? [] };
  }

  async addReaction(channel: string, timestamp: string, name: string): Promise<{ noop: boolean }> {
    try {
      validate(okSchema, await this.call("write", () => this.web.reactions.add({ channel, timestamp, name })), "reactions.add");
      return { noop: false };
    } catch (error) {
      if (error instanceof AxiError && error.details?.slack_error === "already_reacted") return { noop: true };
      throw error;
    }
  }

  async removeReaction(channel: string, timestamp: string, name: string): Promise<{ noop: boolean }> {
    try {
      validate(okSchema, await this.call("write", () => this.web.reactions.remove({ channel, timestamp, name })), "reactions.remove");
      return { noop: false };
    } catch (error) {
      if (error instanceof AxiError && error.details?.slack_error === "no_reaction") return { noop: true };
      throw error;
    }
  }

  async markRead(channel: string, ts: string): Promise<{ noop: boolean }> {
    validate(okSchema, await this.call("write", () => this.web.conversations.mark({ channel, ts })), "conversations.mark");
    return { noop: false };
  }

  async openDm(user: string): Promise<string> {
    const response = validate(z.object({ ok: z.literal(true), channel: itemSchema }).passthrough(), await this.call("write", () => this.web.conversations.open({ users: user })), "conversations.open");
    return response.channel.id;
  }

  async postMessage(options: { channel: string; text: string; threadTs?: string; clientMsgId: string; unfurlLinks: boolean; unfurlMedia: boolean }): Promise<SlackRecord> {
    const response = await this.call("write", () => this.web.apiCall("chat.postMessage", {
      channel: options.channel,
      text: options.text,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      client_msg_id: options.clientMsgId,
      unfurl_links: options.unfurlLinks,
      unfurl_media: options.unfurlMedia,
    }));
    return validate(z.object({ ok: z.literal(true) }).passthrough(), response, "chat.postMessage");
  }

  async uploadFile(options: { snapshot: VerifiedUploadSnapshot; displayFilename: string; channel: string; threadTs?: string; initialComment?: string }): Promise<SlackRecord> {
    let uploadStream: Readable | undefined;
    let hashingStream: Transform | undefined;
    try {
      await options.snapshot.assertUnchanged();
      const size = options.snapshot.size;
      const displayFilename = options.displayFilename;
      const allocation = validate(
        z.object({ ok: z.literal(true), upload_url: z.string().url(), file_id: z.string().min(1) }).passthrough(),
        await this.call("file", () => this.uploadWeb.files.getUploadURLExternal({ filename: displayFilename, length: size })),
        "files.getUploadURLExternal",
      );
      const uploadUrl = assertSlackHttpsUrl(allocation.upload_url, "Slack external upload URL");

      let uploadResponse: Response;
      try {
        // Slack's signed external URL needs the file bytes, not the API token.
        // ActionStore keeps the already-verified O_NOFOLLOW descriptor open;
        // hash that exact stream again while Slack consumes it. Completion is
        // forbidden unless the transferred bytes still match the signed plan.
        await options.snapshot.assertUnchanged();
        const digest = createHash("sha256");
        let transferred = 0;
        hashingStream = new Transform({
          transform(chunk, _encoding, callback) {
            digest.update(chunk as Buffer);
            transferred += (chunk as Buffer).byteLength;
            callback(null, chunk);
          },
        });
        uploadStream = options.snapshot.createReadStream();
        const body = uploadStream.pipe(hashingStream);
        const bodyFinished = finished(hashingStream);
        // A failed HTTP request can abandon the request body before consuming
        // it. Attach a handler immediately so stream teardown cannot surface
        // as an unrelated unhandled rejection; the success path still awaits
        // this original promise and translates its failure as uncertain.
        void bodyFinished.catch(() => undefined);
        this.backendCalls += 1;
        uploadResponse = await bounded(this.fetchFn(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
          },
          body: body as never,
          duplex: "half",
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        } as RequestInit), 120_000, "file");
        if (uploadResponse.status === 200) {
          await bounded(bodyFinished, 120_000, "file");
          await options.snapshot.assertUnchanged();
          if (transferred !== size || digest.digest("hex") !== options.snapshot.expected_sha256) {
            throw new AxiError({
              code: "ACTION_INTEGRITY_FAILED",
              message: "The transferred upload bytes no longer match the signed action snapshot.",
            });
          }
        }
      } catch (cause) {
        const translated = translateSlackError(cause, "file");
        throw new AxiError({
          code: translated.code,
          message: translated.message,
          retryable: false,
          ...(translated.retryAfterSeconds !== undefined ? { retryAfterSeconds: translated.retryAfterSeconds } : {}),
          details: { ...(translated.details ?? {}), dispatch_uncertain: true, upload_phase: "external_bytes" },
          cause,
        });
      }
      if (uploadResponse.status !== 200) {
        throw new AxiError({
          code: "FILE_UPLOAD_FAILED",
          message: `Slack's external upload endpoint returned HTTP ${uploadResponse.status}.`,
          details: { dispatch_uncertain: true, upload_phase: "external_bytes", http_status: uploadResponse.status },
        });
      }

      try {
        const completion = await this.call("file", () => this.uploadWeb.files.completeUploadExternal({
          files: [{ id: allocation.file_id, title: displayFilename }],
          channel_id: options.channel,
          ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
          ...(options.initialComment ? { initial_comment: options.initialComment } : {}),
        }));
        return normalizeUploadResponse(completion);
      } catch (cause) {
        const translated = translateSlackError(cause, "file");
        throw new AxiError({
          code: translated.code,
          message: translated.message,
          retryable: false,
          ...(translated.retryAfterSeconds !== undefined ? { retryAfterSeconds: translated.retryAfterSeconds } : {}),
          details: { ...(translated.details ?? {}), dispatch_uncertain: true, upload_phase: "completion" },
          cause,
        });
      }
    } finally {
      hashingStream?.destroy();
      uploadStream?.destroy();
    }
  }

  async fileInfo(file: string): Promise<SlackRecord> {
    const response = validate(z.object({ file: fileSchema }).passthrough(), await this.call("read", () => this.web.files.info({ file })), "files.info");
    return response.file;
  }

  async download(url: string, output: string, expectedSize?: number, maxBytes = DEFAULT_DOWNLOAD_MAX_BYTES): Promise<{ path: string; bytes: number; redirects: number }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_DOWNLOAD_MAX_BYTES) {
      throw new AxiError({ code: "FILE_DOWNLOAD_LIMIT_INVALID", message: `The download byte limit must be between 1 and ${MAX_DOWNLOAD_MAX_BYTES}.`, exitCode: 2 });
    }
    if (expectedSize !== undefined) {
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new AxiError({ code: "FILE_SIZE_MISMATCH", message: "Slack file metadata contains an invalid size." });
      if (expectedSize > maxBytes) {
        throw new AxiError({
          code: "FILE_DOWNLOAD_LIMIT_EXCEEDED",
          message: "Slack file metadata exceeds the configured download limit.",
          details: { expected: expectedSize, maximum_bytes: maxBytes },
        });
      }
    }
    let current = assertSlackHttpsUrl(url, "Slack file URL");
    let redirects = 0;
    let response: Response;
    for (;;) {
      try {
        response = await this.fetchFn(current, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(this.cookieHeader === undefined || !allowedSlackCookieHost(current.hostname) ? {} : { Cookie: this.cookieHeader }),
          },
          redirect: "manual",
          signal: AbortSignal.timeout(120_000),
        });
      } catch (cause) {
        throw new AxiError({ code: cause instanceof DOMException && cause.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "FILE_DOWNLOAD_FAILED", message: "The Slack file download failed before completion.", retryable: true, cause });
      }
      if (response.status < 300 || response.status >= 400) break;
      if (redirects >= 5) throw new AxiError({ code: "FILE_REDIRECT_LIMIT", message: "Slack file download exceeded five redirects." });
      const location = response.headers.get("location");
      if (!location) throw new AxiError({ code: "FILE_DOWNLOAD_FAILED", message: "Slack returned a redirect without a destination." });
      current = assertSlackHttpsUrl(new URL(location, current).toString(), "Slack file redirect");
      redirects += 1;
    }
    if (!response.ok || !response.body) throw new AxiError({ code: "FILE_DOWNLOAD_FAILED", message: `Slack file download failed with HTTP ${response.status}.`, retryable: response.status >= 500 });
    const rawContentLength = response.headers.get("content-length");
    const contentLength = rawContentLength === null ? -1 : Number(rawContentLength);
    if (rawContentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
      throw new AxiError({ code: "FILE_DOWNLOAD_FAILED", message: "Slack returned an invalid Content-Length for the file download." });
    }
    if (expectedSize !== undefined && contentLength >= 0 && contentLength !== expectedSize) throw new AxiError({ code: "FILE_SIZE_MISMATCH", message: "Slack's download size does not match file metadata." });
    if (contentLength > maxBytes) {
      throw new AxiError({ code: "FILE_DOWNLOAD_LIMIT_EXCEEDED", message: "Slack's download exceeds the configured byte limit.", details: { content_length: contentLength, maximum_bytes: maxBytes } });
    }
    const byteLimit = expectedSize ?? maxBytes;
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer | Uint8Array | string, encoding, callback) {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding as BufferEncoding) : chunk.byteLength;
        const next = received + bytes;
        if (!Number.isSafeInteger(next) || next > byteLimit) {
          callback(new AxiError({
            code: expectedSize === undefined ? "FILE_DOWNLOAD_LIMIT_EXCEEDED" : "FILE_SIZE_MISMATCH",
            message: expectedSize === undefined ? "The Slack file download exceeded the configured byte limit." : "The Slack file download exceeded the size declared in Slack metadata.",
            details: { received_at_least: next, maximum_bytes: byteLimit, ...(expectedSize === undefined ? {} : { expected: expectedSize }) },
          }));
          return;
        }
        received = next;
        callback(null, chunk);
      },
    });
    await mkdir(path.dirname(output), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(output, { flags: "wx", mode: 0o600 }));
    const bytes = (await stat(output)).size;
    if (bytes !== received) throw new AxiError({ code: "FILE_DOWNLOAD_FAILED", message: "The completed download byte count does not match the streamed byte count." });
    if (expectedSize !== undefined && bytes !== expectedSize) throw new AxiError({ code: "FILE_SIZE_MISMATCH", message: "The completed download size does not match Slack file metadata.", details: { expected: expectedSize, received: bytes } });
    return { path: output, bytes, redirects };
  }
}

export function slackRecord(value: unknown): SlackRecord {
  return asRecord(value);
}

export function slackGrantedScopes(value: unknown): string[] | undefined {
  const metadata = asRecord(asRecord(value).response_metadata);
  if (metadata.scopes === undefined) return undefined;
  const parsed = z.array(z.string().min(1)).safeParse(metadata.scopes);
  if (!parsed.success) {
    throw new AxiError({
      code: "SLACK_RESPONSE_INVALID",
      message: "Slack's OAuth scope metadata does not match the supported schema.",
      details: { issues: parsed.error.issues },
    });
  }
  return [...new Set(parsed.data)].sort();
}

export function slackArray(value: unknown): SlackRecord[] {
  return array(value);
}
