import { z } from "zod";
import { AxiError } from "./errors.js";
import { slackCookieHeader } from "./slack-public.js";

type BrowserCallKind = "read" | "write";
type BrowserMethod = "client.counts" | "users.prefs.get" | "saved.list" | "saved.update";
type BrowserBody = Record<string, string | number | boolean | undefined>;

export interface BrowserSlackClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

const safeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const epochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const slackTimestampSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const messageTimestampSchema = z.string().regex(/^\d{10,}\.\d{6}$/);

const snapshotSchema = z.object({
  id: z.string().min(1),
  last_read: slackTimestampSchema.optional(),
  latest: slackTimestampSchema.optional(),
  mention_count: safeCountSchema,
  has_unreads: z.boolean(),
}).passthrough();

export type BrowserConversationSnapshot = z.infer<typeof snapshotSchema>;

const countsSchema = z.object({
  ok: z.literal(true),
  channels: z.array(snapshotSchema),
  mpims: z.array(snapshotSchema),
  ims: z.array(snapshotSchema),
}).passthrough();

const notificationPrefsSchema = z.object({
  channels: z.record(z.string(), z.object({ muted: z.boolean().optional() }).passthrough()),
}).passthrough();

const prefsSchema = z.object({
  ok: z.literal(true),
  prefs: z.record(z.string(), z.unknown()),
}).passthrough();

const laterItemSchema = z.object({
  item_id: z.string().regex(/^[CDG][A-Z0-9]+$/),
  item_type: z.literal("message"),
  ts: messageTimestampSchema,
  state: z.enum(["saved", "completed"]),
  date_created: epochSchema.optional(),
  date_due: epochSchema,
  date_completed: epochSchema,
  date_updated: epochSchema.optional(),
  is_archived: z.boolean(),
  date_snoozed_until: epochSchema.optional(),
}).passthrough();

const laterCountsSchema = z.object({
  uncompleted_count: safeCountSchema,
  uncompleted_overdue_count: safeCountSchema,
  archived_count: safeCountSchema,
  completed_count: safeCountSchema,
  total_count: safeCountSchema,
}).passthrough();

const laterSchema = z.object({
  ok: z.literal(true),
  saved_items: z.array(laterItemSchema).max(100),
  counts: laterCountsSchema.optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).passthrough().optional(),
}).passthrough();

const authoritativeErrors = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "missing_scope",
  "not_allowed_token_type",
  "no_permission",
  "restricted_action",
  "invalid_arguments",
  "invalid_arg_name",
  "invalid_array_arg",
  "invalid_charset",
  "invalid_form_data",
  "invalid_post_type",
  "missing_post_type",
  "channel_not_found",
  "message_not_found",
  "item_not_found",
]);

const authenticationErrors = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
]);

function assertBrowserToken(token: string): void {
  if (!/^xoxc-(?:[A-Za-z0-9._~+/=-]|%[A-Fa-f0-9]{2})+$/.test(token)) {
    throw new AxiError({ code: "AUTH_INVALID", message: "Slack browser authentication requires an xoxc token." });
  }
}

function browserApiBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AxiError({ code: "SLACK_URL_INVALID", message: "Browser API base URL must be a valid Slack HTTPS API URL." });
  }
  const hostname = url.hostname.toLowerCase();
  const workspaceLabels = hostname.endsWith(".slack.com")
    ? hostname.slice(0, -".slack.com".length).split(".")
    : [];
  const workspaceHost = workspaceLabels.length > 0
    && workspaceLabels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && !/^(?:api|app|edge|files|hooks|downloads?|status)(?:-|$)/.test(workspaceLabels[0]!);
  const path = url.pathname.replace(/\/$/, "");
  if (url.protocol !== "https:"
    || (hostname !== "slack.com" && !workspaceHost)
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || path !== "/api") {
    throw new AxiError({ code: "SLACK_URL_INVALID", message: "Browser API base URL must be an HTTPS /api URL on slack.com or a Slack workspace host." });
  }
  return `${url.origin}/api`;
}

function isTimeout(cause: unknown): boolean {
  return cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function schemaChanged(label: string, value: unknown, kind: BrowserCallKind): never {
  const details: Record<string, unknown> = {
    capability: label,
    ...(kind === "write" ? { dispatch_uncertain: true } : {}),
  };
  if (value instanceof z.ZodError) details.issues = value.issues;
  throw new AxiError({
    code: "BROWSER_CAPABILITY_CHANGED",
    message: `Slack's private ${label} response no longer matches the supported schema.`,
    details,
  });
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, label: string, kind: BrowserCallKind): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) schemaChanged(label, parsed.error, kind);
  return parsed.data;
}

export class BrowserSlackClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly cookieHeader: string;
  backendCalls = 0;

  constructor(
    private readonly token: string,
    cookie: string,
    options: BrowserSlackClientOptions = {},
  ) {
    assertBrowserToken(token);
    this.cookieHeader = slackCookieHeader(cookie);
    this.baseUrl = browserApiBaseUrl(options.baseUrl ?? "https://slack.com/api");
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private async call(method: BrowserMethod, body: BrowserBody, reason: string, kind: BrowserCallKind = "read"): Promise<Record<string, unknown>> {
    const form: BrowserBody = {
      token: this.token,
      _x_reason: reason,
      _x_mode: "online",
      _x_sonic: true,
      _x_app_name: "client",
      ...body,
    };
    let response: Response;
    try {
      this.backendCalls += 1;
      response = await this.fetchFn(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          Cookie: this.cookieHeader,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "slack-axi-cli/0.1",
        },
        body: new URLSearchParams(
          Object.entries(form)
            .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
            .map(([key, value]) => [key, String(value)]),
        ),
        redirect: "error",
        signal: AbortSignal.timeout(kind === "write" ? 15_000 : 10_000),
      });
    } catch (cause) {
      throw new AxiError({
        code: isTimeout(cause) ? "REQUEST_TIMEOUT" : "BROWSER_NETWORK_ERROR",
        message: isTimeout(cause)
          ? "The Slack browser capability request timed out."
          : "The Slack browser capability request failed at the network boundary.",
        retryable: kind === "read",
        details: { dispatch_uncertain: kind === "write" },
        cause,
      });
    }

    if (response.status === 429) {
      const seconds = retryAfter(response);
      throw new AxiError({
        code: "RATE_LIMITED",
        message: "Slack rate limited the browser capability request.",
        retryable: true,
        ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
        details: { dispatch_uncertain: false },
      });
    }

    if (!response.ok) {
      const ambiguous = kind === "write" && (response.status === 408 || response.status === 425 || response.status >= 500);
      throw new AxiError({
        code: "BROWSER_CAPABILITY_UNAVAILABLE",
        message: `Slack's browser capability returned HTTP ${response.status}.`,
        retryable: kind === "read" && (response.status === 408 || response.status === 425 || response.status >= 500),
        details: { http_status: response.status, dispatch_uncertain: ambiguous },
      });
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (cause) {
      schemaChanged(method, cause, kind);
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) schemaChanged(method, value, kind);
    const record = value as Record<string, unknown>;
    if (record.ok === true) {
      if (Object.hasOwn(record, "error")) schemaChanged(method, record, kind);
      return record;
    }
    if (record.ok === false) {
      if (typeof record.error !== "string" || !/^[a-z0-9_]{1,128}$/.test(record.error)) schemaChanged(method, record, kind);
      const slackError = record.error;
      const authoritative = authoritativeErrors.has(slackError);
      throw new AxiError({
        code: authenticationErrors.has(slackError) ? "AUTH_INVALID" : "BROWSER_CAPABILITY_UNAVAILABLE",
        message: authenticationErrors.has(slackError)
          ? "Slack rejected the configured browser credential."
          : `Slack rejected the browser capability request (${slackError}).`,
        retryable: kind === "read" && ["internal_error", "fatal_error", "request_timeout"].includes(slackError),
        details: { slack_error: slackError, dispatch_uncertain: kind === "write" && !authoritative },
      });
    }
    return schemaChanged(method, record, kind);
  }

  async counts(): Promise<{ channels: BrowserConversationSnapshot[]; mpims: BrowserConversationSnapshot[]; ims: BrowserConversationSnapshot[] }> {
    const response = parseSchema(
      countsSchema,
      await this.call("client.counts", { thread_counts_by_channel: true, org_wide_aware: true, include_file_channels: true }, "client-counts-api/fetchClientCounts"),
      "client.counts",
      "read",
    );
    return { channels: response.channels, mpims: response.mpims, ims: response.ims };
  }

  async mutedChannels(): Promise<string[]> {
    const response = parseSchema(
      prefsSchema,
      await this.call("users.prefs.get", {}, "prefs"),
      "users.prefs.get",
      "read",
    );
    const encoded = response.prefs.all_notifications_prefs;
    if (typeof encoded !== "string") schemaChanged("users.prefs.get", encoded, "read");
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch (cause) {
      schemaChanged("users.prefs.get", cause, "read");
    }
    const parsed = parseSchema(notificationPrefsSchema, decoded, "users.prefs.get", "read");
    return Object.entries(parsed.channels)
      .filter(([, preference]) => preference.muted === true)
      .map(([channel]) => channel)
      .sort();
  }

  async laterList(cursor?: string, limit = 20, filter = "saved"): Promise<{ items: Array<z.infer<typeof laterItemSchema>>; counts?: z.infer<typeof laterCountsSchema>; next?: string }> {
    const response = parseSchema(
      laterSchema,
      await this.call("saved.list", {
        limit: Math.min(Math.max(limit, 1), 100),
        filter,
        include_tombstones: true,
        ...(cursor ? { cursor } : {}),
      }, "saved-api/savedList"),
      "saved.list",
      "read",
    );
    const next = response.response_metadata?.next_cursor || undefined;
    return {
      items: response.saved_items,
      ...(response.counts === undefined ? {} : { counts: response.counts }),
      ...(next ? { next } : {}),
    };
  }

  async laterComplete(itemId: string, ts: string): Promise<Record<string, unknown>> {
    return this.call("saved.update", {
      item_type: "message",
      item_id: itemId,
      ts,
      mark: "completed",
    }, "saved-api/updateSavedMessage", "write");
  }

  async laterSnooze(itemId: string, ts: string, dateDue: number): Promise<Record<string, unknown>> {
    return this.call("saved.update", {
      item_type: "message",
      item_id: itemId,
      ts,
      date_due: dateDue,
    }, "saved-api/updateSavedMessage", "write");
  }
}
