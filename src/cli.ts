import { constants } from "node:fs";
import { lstat, link, open, readFile, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { Command, CommanderError, Option } from "commander";
import { z } from "zod";
import { AxiError, redact, toErrorEnvelope } from "./errors.js";
import { SlackAxiApp, type WorkspaceContext } from "./app.js";
import { cacheIdentity, createCacheCursor, filterHash, parseCacheCursor, type CursorIntegrity, type SourceCoverage } from "./cache.js";
import { applyAction, applyCommand, directOrStage, newClientMessageId, reconcileAction, stageAction } from "./mutations.js";
import { SLACK_MESSAGE_MAX_CHARACTERS, SLACK_MESSAGE_MAX_UTF8_BYTES, validateSlackMessageText } from "./message-text.js";
import { normalizeConversation, normalizeFile, normalizeMessage, normalizeUser, normalizeUsergroup, resolveConversation, resolveUser } from "./domain.js";
import { parseMessageRef } from "./refs.js";
import { resolveTimeRange } from "./time.js";
import { serialize } from "./output.js";
import { validateBroadcastMentions } from "./policy.js";
import { DEFAULT_DOWNLOAD_MAX_BYTES, MAX_DOWNLOAD_MAX_BYTES, slackArray, slackRecord } from "./slack-public.js";
import { COMMAND_METADATA, commandKey, decorateHelp } from "./metadata.js";
import { DEFAULT_UPLOAD_MAX_BYTES, MAX_UPLOAD_MAX_BYTES, sha256File } from "./actions.js";
import { VERSION } from "./version.js";
import type { ActionPlan, Conversation, CoverageInfo, OutputFormat, PageInfo, SuccessEnvelope, User } from "./types.js";

interface GlobalOptions {
  workspace?: string;
  output?: OutputFormat;
  fields?: string;
  limit?: number;
  cursor?: string;
  full?: boolean;
  verbose?: boolean;
}

type MessageFileOpen = (filename: string, flags: number) => Promise<FileHandle>;

interface CliDependencies {
  openMessageFile?: MessageFileOpen;
}

interface OriginCommanderError extends CommanderError {
  axiCommandKey?: string;
}

const AUTH_INPUT_MAX_UTF8_BYTES = 16 * 1024;
const HOME_DESCRIPTION = "Read and safely act on Slack from coding agents.";
type LiveCursorKind = "conversation.members" | "usergroup.list" | "usergroup.members" | "read" | "thread" | "later.list";
const liveCursorSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["conversation.members", "usergroup.list", "usergroup.members", "read", "thread", "later.list"]),
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  backend_cursor: z.string().min(1),
  scanned: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  authoritative_total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function expandsFields(command: Command): boolean {
  return Boolean(globals(command).fields?.split(",").some((field) => field.trim()));
}

function workspaceEnvelope<T>(context: WorkspaceContext, command: string, data: T, extra: Partial<SuccessEnvelope<T>> = {}): SuccessEnvelope<T> {
  const backendCalls = Number(context.public?.backendCalls ?? 0) + Number(context.browser?.backendCalls ?? 0);
  return { schema: "slack-axi/v1", ok: true, workspace: { id: context.profile.team_id, alias: context.profile.alias, actor_id: context.profile.actor_id, auth_kind: context.profile.kind }, scope: { command, backend_calls: backendCalls }, data, ...extra };
}

function emit(command: Command, value: unknown): void {
  const options = globals(command);
  const fields = options.fields?.split(",").map((field) => field.trim()).filter(Boolean);
  process.stdout.write(serialize(value, options.output ?? "toon", fields, COMMAND_METADATA[commandKey(command)]?.fields));
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new AxiError({ code: "VALUE_INVALID", message: `Expected a positive safe integer, received '${value}'.`, exitCode: 2 });
  return parsed;
}

function validateAuthAlias(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(value)) {
    throw new AxiError({ code: "ALIAS_INVALID", message: "Workspace alias must contain only letters, numbers, underscores, and hyphens.", exitCode: 2 });
  }
}

function downloadByteLimit(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > MAX_DOWNLOAD_MAX_BYTES) {
    throw new AxiError({
      code: "VALUE_INVALID",
      message: `--max-bytes cannot exceed ${MAX_DOWNLOAD_MAX_BYTES}.`,
      exitCode: 2,
      details: { maximum_bytes: MAX_DOWNLOAD_MAX_BYTES },
    });
  }
  return parsed;
}

function uploadByteLimit(value: string): number {
  const parsed = positiveInteger(value);
  if (parsed > MAX_UPLOAD_MAX_BYTES) {
    throw new AxiError({
      code: "VALUE_INVALID",
      message: `--max-bytes cannot exceed ${MAX_UPLOAD_MAX_BYTES}.`,
      exitCode: 2,
      details: { maximum_bytes: MAX_UPLOAD_MAX_BYTES },
    });
  }
  return parsed;
}

function approvalToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "--approval must be a base64url HMAC token.", exitCode: 2 });
  return value;
}

function ensureLimit(value: number, maximum = 1000): number {
  if (value > maximum) throw new AxiError({ code: "LIMIT_TOO_LARGE", message: `Limit cannot exceed ${maximum}.`, exitCode: 2 });
  return value;
}

async function stdinText(limit?: { maxBytes: number; code: string; message: string; details?: Record<string, unknown> }): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    bytes += chunkBytes;
    if (limit && bytes > limit.maxBytes) {
      throw new AxiError({
        code: limit.code,
        message: limit.message,
        exitCode: 2,
        details: { bytes_read: bytes, maximum_utf8_bytes: limit.maxBytes, ...limit.details },
      });
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function authInput(options: { browser?: boolean; userToken?: boolean; fromStdin?: boolean }): Promise<{ kind: "browser"; token: string; cookie: string } | { kind: "user_token"; token: string }> {
  if (options.browser && options.userToken) throw new AxiError({ code: "AUTH_KIND_CONFLICT", message: "Use only one of --browser or --user-token.", exitCode: 2 });
  if (!options.fromStdin) throw new AxiError({ code: "STDIN_REQUIRED", message: "auth add requires --from-stdin with one JSON object; interactive prompts are not supported.", exitCode: 2 });
  const input = await stdinText({
    maxBytes: AUTH_INPUT_MAX_UTF8_BYTES,
    code: "AUTH_INPUT_TOO_LARGE",
    message: `Authentication input exceeds ${AUTH_INPUT_MAX_UTF8_BYTES} UTF-8 bytes.`,
  });
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new AxiError({ code: "STDIN_JSON_INVALID", message: "--from-stdin expects exactly one JSON object.", exitCode: 2 }); }
  if (options.userToken) {
    const result = z.object({ xoxp: z.string().startsWith("xoxp-") }).strict().safeParse(value);
    if (!result.success) throw new AxiError({ code: "STDIN_JSON_INVALID", message: "User-token input must contain only a valid string field 'xoxp'.", exitCode: 2 });
    return { kind: "user_token", token: result.data.xoxp };
  }
  const result = z.object({
    xoxc: z.string().startsWith("xoxc-").refine((token) => !/[\r\n]/.test(token)),
    xoxd: z.string().startsWith("xoxd-").refine((cookie) => !/[\r\n]/.test(cookie)),
  }).strict().safeParse(value);
  if (!result.success) throw new AxiError({ code: "STDIN_JSON_INVALID", message: "Browser input must contain only valid string fields 'xoxc' and 'xoxd'.", exitCode: 2 });
  return { kind: "browser", token: result.data.xoxc, cookie: result.data.xoxd };
}

function syncHint(context: WorkspaceContext): { command: string; reason: string } {
  return { command: `slack-axi sync --all --max-pages 100 --workspace ${shellArgument(context.profile.alias)}`, reason: "Complete the source cache before relying on exhaustive resolution or totals." };
}

function sourcePage(source: SourceCoverage, shown: number, localTotal: number, nextCursor?: string): PageInfo {
  return {
    shown,
    complete: !nextCursor && source.complete,
    source_complete: source.complete,
    total: localTotal,
    total_kind: source.complete ? "exact" : "known",
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    ...(localTotal > shown ? { omitted: localTotal - shown } : {}),
  };
}

function actionOutput(action: ActionPlan): Record<string, unknown> {
  const { payload: _payload, upload_snapshot: _snapshot, ...safeAction } = action;
  return {
    action: safeAction,
    ...(action.state === "planned" ? { apply_command: applyCommand(action) } : {}),
    ...(action.state === "unknown" ? { reconcile_command: `slack-axi action reconcile ${action.id}`, abandon_command: `slack-axi action abandon ${action.id} --approval ${action.approval}` } : {}),
  };
}

function preflightTimeFlags(options: { since?: string; from?: string; to?: string; on?: string }): void {
  if ([options.since, options.from, options.on].filter(Boolean).length > 1) throw new AxiError({ code: "TIME_CONFLICT", message: "Use only one of --since, --from, or --on.", exitCode: 2 });
  if (options.on && options.to) throw new AxiError({ code: "TIME_CONFLICT", message: "--on cannot be combined with --to.", exitCode: 2 });
  if (options.since) {
    const match = /^([1-9]\d*)(m|h|d|w)$/.exec(options.since);
    const amount = Number(match?.[1]);
    const multiplier = match ? ({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const)[match[2] as "m" | "h" | "d" | "w"] : undefined;
    const milliseconds = multiplier === undefined ? Number.NaN : amount * multiplier;
    if (!match || !Number.isSafeInteger(amount) || !Number.isSafeInteger(milliseconds) || milliseconds > 8_000_000_000_000_000) {
      throw new AxiError({ code: "TIME_INVALID", message: "--since must use a positive duration such as 30m, 24h, 7d, or 2w.", exitCode: 2 });
    }
  }
  for (const [name, value] of [["--from", options.from], ["--to", options.to], ["--on", options.on]] as const) {
    if (!value) continue;
    try {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) Temporal.PlainDate.from(value, { overflow: "reject" });
      else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}(?::\d{2})?(?::\d{2})?$/.test(value)) Temporal.PlainDateTime.from(value.replace(" ", "T"), { overflow: "reject" });
      else Temporal.Instant.from(value);
    } catch (cause) {
      throw new AxiError({ code: "TIME_INVALID", message: `${name} must be a valid ISO-8601 date or timestamp.`, exitCode: 2, cause });
    }
  }
}

function validateSearchOptions(options: Record<string, unknown>, command: Command): number {
  if (options.all && !options.maxResults) throw new AxiError({ code: "MAX_RESULTS_REQUIRED", message: "--all requires --max-results.", exitCode: 2 });
  if (options.maxResults && !options.all) throw new AxiError({ code: "SEARCH_OPTION_CONFLICT", message: "--max-results is valid only with --all.", exitCode: 2 });
  if (options.all && globals(command).limit !== undefined) throw new AxiError({ code: "SEARCH_OPTION_CONFLICT", message: "--limit cannot be combined with --all; use --max-results as the explicit bound.", exitCode: 2 });
  for (const name of ["after", "before"] as const) {
    if (typeof options[name] === "string") {
      try { Temporal.PlainDate.from(options[name] as string, { overflow: "reject" }); } catch (cause) { throw new AxiError({ code: "TIME_INVALID", message: `--${name} must be a valid YYYY-MM-DD date.`, exitCode: 2, cause }); }
    }
  }
  if (typeof options.after === "string" && typeof options.before === "string" && options.after >= options.before) {
    throw new AxiError({ code: "TIME_RANGE_INVALID", message: "--after must be earlier than --before.", exitCode: 2 });
  }
  return ensureLimit(Number(options.all ? options.maxResults : globals(command).limit ?? 20));
}

function parseFutureInstant(value: string): number {
  try {
    const instant = Temporal.Instant.from(value);
    if (instant.epochMilliseconds <= Date.now()) throw new Error("past");
    return Number(instant.epochMilliseconds);
  } catch (cause) {
    throw new AxiError({ code: "TIME_INVALID", message: "--until must be a future ISO-8601 timestamp with an explicit offset.", exitCode: 2, cause });
  }
}

async function readBoundedMessageFile(filename: string, openFile: MessageFileOpen): Promise<string> {
  const handle = await openFile(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    if (metadata.size > SLACK_MESSAGE_MAX_UTF8_BYTES) {
      throw new AxiError({
        code: "MESSAGE_TOO_LONG",
        message: `Message file exceeds the ${SLACK_MESSAGE_MAX_CHARACTERS}-character Slack limit.`,
        exitCode: 2,
        details: { bytes: metadata.size, maximum_utf8_bytes: SLACK_MESSAGE_MAX_UTF8_BYTES, maximum_characters: SLACK_MESSAGE_MAX_CHARACTERS },
      });
    }

    // The file can grow after fstat, so cap the read itself as well. Supplying
    // an explicit offset keeps every byte tied to this one already-open handle.
    const bytes = Buffer.allocUnsafe(SLACK_MESSAGE_MAX_UTF8_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > SLACK_MESSAGE_MAX_UTF8_BYTES) {
      throw new AxiError({
        code: "MESSAGE_TOO_LONG",
        message: `Message file exceeds the ${SLACK_MESSAGE_MAX_CHARACTERS}-character Slack limit.`,
        exitCode: 2,
        details: { bytes_at_least: offset, maximum_utf8_bytes: SLACK_MESSAGE_MAX_UTF8_BYTES, maximum_characters: SLACK_MESSAGE_MAX_CHARACTERS },
      });
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function messageTextInput(options: { text?: string; textFile?: string }, openFile: MessageFileOpen): Promise<string> {
  if (Boolean(options.text) === Boolean(options.textFile)) throw new AxiError({ code: "MESSAGE_TEXT_REQUIRED", message: "Choose exactly one of --text or --text-file.", exitCode: 2 });
  if (options.text !== undefined) return validateSlackMessageText(options.text);
  if (options.textFile === "-") return validateSlackMessageText(await stdinText({
    maxBytes: SLACK_MESSAGE_MAX_UTF8_BYTES,
    code: "MESSAGE_TOO_LONG",
    message: `Message input exceeds the ${SLACK_MESSAGE_MAX_CHARACTERS}-character Slack limit.`,
    details: { maximum_characters: SLACK_MESSAGE_MAX_CHARACTERS },
  }));
  try {
    return validateSlackMessageText(await readBoundedMessageFile(options.textFile!, openFile));
  } catch (cause) {
    if (cause instanceof AxiError) throw cause;
    throw new AxiError({ code: "FILE_INVALID", message: `--text-file '${options.textFile}' must be a readable regular file.`, exitCode: 2, cause });
  }
}

async function context(app: SlackAxiApp, command: Command, refresh = false): Promise<WorkspaceContext> {
  return app.context(globals(command).workspace, refresh);
}

async function resolveConversationFor(selector: string, ctx: WorkspaceContext): Promise<Conversation> {
  const cached = ctx.conversations.find((item) => item.id === selector);
  if (/^[CDG][A-Z0-9]+$/.test(selector) && !cached) return normalizeConversation(await ctx.public.conversationInfo(selector));
  return resolveConversation(selector, ctx.conversations, ctx.users, ctx.snapshot.coverage.conversations.complete, ctx.snapshot.coverage.users.complete, syncHint(ctx).command);
}

async function resolveUserFor(selector: string, ctx: WorkspaceContext): Promise<User> {
  const cached = ctx.users.find((item) => item.id === selector);
  if (/^[UW][A-Z0-9]+$/.test(selector) && !cached) return normalizeUser(await ctx.public.userInfo(selector));
  return resolveUser(selector, ctx.users, ctx.snapshot.coverage.users.complete, syncHint(ctx).command);
}

async function buildSearchQuery(query: string[], options: Record<string, unknown>, ctx: WorkspaceContext): Promise<string> {
  const parts = [...query];
  if (typeof options.in === "string") parts.push(`in:${(await resolveConversationFor(options.in, ctx)).name}`);
  if (typeof options.fromUser === "string") parts.push(`from:${(await resolveUserFor(options.fromUser, ctx)).name}`);
  if (typeof options.withUser === "string") parts.push(`with:${(await resolveUserFor(options.withUser, ctx)).name}`);
  if (typeof options.after === "string") parts.push(`after:${options.after}`);
  if (typeof options.before === "string") parts.push(`before:${options.before}`);
  if (typeof options.has === "string") parts.push(`has:${options.has}`);
  return parts.join(" ");
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function markdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/[\r\n]+/g, " ");
}

function liveCursorBinding(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function collectionFingerprint(values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function createLiveCursor(kind: LiveCursorKind, binding: string, backendCursor: string, scanned: number, integrity: CursorIntegrity, authoritativeTotal?: number): Promise<string> {
  const value = { v: 1 as const, kind, binding, backend_cursor: backendCursor, scanned, ...(authoritativeTotal === undefined ? {} : { authoritative_total: authoritativeTotal }) };
  return Buffer.from(JSON.stringify({ ...value, signature: await integrity.signCursor(value) })).toString("base64url");
}

async function parseLiveCursor(token: string | undefined, kind: LiveCursorKind, binding: string, restartCommand: string, integrity: CursorIntegrity): Promise<{ backendCursor?: string; scanned: number; authoritativeTotal?: number }> {
  if (!token) return { scanned: 0 };
  let value: z.infer<typeof liveCursorSchema>;
  try {
    value = liveCursorSchema.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
  } catch (cause) {
    throw new AxiError({ code: "CURSOR_INVALID", message: "The continuation cursor is malformed or is not a supported Slack AXI cursor.", exitCode: 2, suggestedCommand: restartCommand, cause });
  }
  const { signature, ...unsigned } = value;
  if (!await integrity.verifyCursor(unsigned, signature)) {
    throw new AxiError({ code: "CURSOR_INVALID", message: "The continuation cursor failed its integrity check.", exitCode: 2, suggestedCommand: restartCommand });
  }
  if (value.kind !== kind || value.binding !== binding) {
    throw new AxiError({ code: "CURSOR_STALE", message: "The continuation cursor belongs to a different command or scope.", exitCode: 2, suggestedCommand: restartCommand });
  }
  return { backendCursor: value.backend_cursor, scanned: value.scanned, ...(value.authoritative_total === undefined ? {} : { authoritativeTotal: value.authoritative_total }) };
}

async function localLiveSlice<T>(
  command: Command,
  kind: "usergroup.list" | "usergroup.members",
  binding: string,
  restartCommand: string,
  items: T[],
  integrity: CursorIntegrity,
  defaultLimit = 20,
): Promise<{ items: T[]; page: PageInfo; next?: string }> {
  const limit = ensureLimit(globals(command).limit ?? defaultLimit, 1000);
  const continuation = await parseLiveCursor(globals(command).cursor, kind, binding, restartCommand, integrity);
  let offset = 0;
  if (continuation.backendCursor !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(continuation.backendCursor)) {
      throw new AxiError({ code: "CURSOR_INVALID", message: "The local collection cursor contains an invalid offset.", exitCode: 2, suggestedCommand: restartCommand });
    }
    offset = Number(continuation.backendCursor);
    if (!Number.isSafeInteger(offset) || offset !== continuation.scanned || offset > items.length || continuation.authoritativeTotal !== items.length) {
      throw new AxiError({ code: "CURSOR_STALE", message: "The local collection changed since this cursor was created.", exitCode: 2, suggestedCommand: restartCommand });
    }
  }
  const shown = items.slice(offset, offset + limit);
  const scanned = offset + shown.length;
  const next = scanned < items.length ? await createLiveCursor(kind, binding, String(scanned), scanned, integrity, items.length) : undefined;
  return {
    items: shown,
    page: {
      shown: shown.length,
      complete: next === undefined,
      source_complete: true,
      total: items.length,
      total_kind: "exact",
      ...(next ? { next_cursor: next, omitted: items.length - scanned } : {}),
    },
    ...(next ? { next } : {}),
  };
}

function searchReplayCommand(kind: "messages" | "files", slackQuery: string, sort: string, workspace: string, bound: number, all: boolean, full = false): string {
  return `slack-axi search ${kind} ${shellArgument(slackQuery)} ${all ? `--all --max-results ${bound}` : `--limit ${bound}`} --sort ${sort}${full ? " --full" : ""} --workspace ${shellArgument(workspace)}`;
}

function cacheRestartOptions(ctx: WorkspaceContext, command: Command): string {
  const options = globals(command);
  return [
    options.limit === undefined ? undefined : `--limit ${options.limit}`,
    options.fields ? `--fields ${shellArgument(options.fields)}` : undefined,
    `--workspace ${shellArgument(ctx.profile.alias)}`,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function liveRestartOptions(ctx: WorkspaceContext, command: Command, includeFull = false): string {
  const options = globals(command);
  return [
    options.limit === undefined ? undefined : `--limit ${options.limit}`,
    options.fields ? `--fields ${shellArgument(options.fields)}` : undefined,
    includeFull && options.full ? "--full" : undefined,
    `--workspace ${shellArgument(ctx.profile.alias)}`,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

async function cacheSlice<T>(ctx: WorkspaceContext, command: Command, key: string, filters: unknown, items: T[], source: SourceCoverage, restartCommand: string, integrity: CursorIntegrity): Promise<{ items: T[]; page: PageInfo }> {
  const limit = ensureLimit(globals(command).limit ?? 20);
  const queryHash = filterHash({ key, filters });
  const offset = await parseCacheCursor(globals(command).cursor, ctx.snapshot, queryHash, restartCommand, integrity);
  const shown = items.slice(offset, offset + limit);
  const next = offset + shown.length < items.length ? await createCacheCursor(ctx.snapshot, queryHash, offset + shown.length, integrity) : undefined;
  return { items: shown, page: sourcePage(source, shown.length, items.length, next) };
}

async function inBatches<T>(items: T[], width: number, operation: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += width) await Promise.all(items.slice(index, index + width).map(operation));
}

function validateFields(command: Command): void {
  const requested = globals(command).fields?.split(",").map((field) => field.trim()).filter(Boolean);
  if (!requested?.length) return;
  const valid = COMMAND_METADATA[commandKey(command)]?.fields ?? [];
  const unknown = requested.filter((field) => !valid.includes(field));
  if (unknown.length) throw new AxiError({ code: "FIELDS_INVALID", message: `Unknown --fields value(s): ${unknown.join(", ")}. Valid fields for '${commandKey(command)}': ${valid.length ? valid.join(", ") : "none"}.`, exitCode: 2, details: { unknown_fields: unknown, valid_fields: valid } });
}

function validatePreflight(command: Command): void {
  validateFields(command);
  const key = commandKey(command);
  const limit = globals(command).limit;
  const limitMaximum = COMMAND_METADATA[key]?.limitMaximum;
  if (limit !== undefined) {
    if (limitMaximum === undefined) {
      const limitCommands = Object.entries(COMMAND_METADATA).filter(([, metadata]) => metadata.limitMaximum !== undefined).map(([name]) => name);
      throw new AxiError({
        code: "LIMIT_UNSUPPORTED",
        message: `--limit is not supported by '${key}'. Limit-capable commands: ${limitCommands.join(", ")}.`,
        exitCode: 2,
        details: { command: key, limit_commands: limitCommands },
      });
    }
    ensureLimit(limit, limitMaximum);
  }
  const cursorCommands = Object.entries(COMMAND_METADATA).filter(([, metadata]) => metadata.cursor).map(([name]) => name);
  if (globals(command).cursor && !COMMAND_METADATA[key]?.cursor) {
    throw new AxiError({
      code: "CURSOR_UNSUPPORTED",
      message: `--cursor is not supported by '${key}'. Cursor-capable commands: ${cursorCommands.join(", ")}.`,
      exitCode: 2,
      details: { command: key, cursor_commands: cursorCommands },
    });
  }
}

function installExitOverrides(program: Command): void {
  const visit = (command: Command): void => {
    command.exitOverride((error) => {
      (error as OriginCommanderError).axiCommandKey = commandKey(command);
      throw error;
    });
    for (const child of command.commands) visit(child);
  };
  visit(program);
}

export function createProgram(app = new SlackAxiApp(), dependencies: CliDependencies = {}): Command {
  const openMessageFile = dependencies.openMessageFile ?? open;
  const program = new Command();
  program
    .name("slack-axi")
    .description(HOME_DESCRIPTION)
    .version(VERSION, "-V, --version", "print the bare version")
    .option("--workspace <alias|team-id>", "Slack workspace selector")
    .addOption(new Option("--output <format>", "stdout format (default: toon)").choices(["toon", "json", "jsonl"]).default("toon"))
    .option("--fields <csv>", "project result fields; unknown names are rejected")
    .option("--limit <n>", "collection limit", positiveInteger)
    .option("--cursor <token>", "continuation cursor")
    .option("--full", "return full long-text fields")
    .option("--verbose", "write redacted diagnostics to stderr")
    .showSuggestionAfterError(true)
    .showHelpAfterError(false)
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .configureOutput({ writeErr: () => undefined })
    .configureHelp({ showGlobalOptions: true })
    .exitOverride()
    .hook("preAction", (_root, actionCommand) => validatePreflight(actionCommand));

  program.action(async (_options, command) => {
    const config = await app.config.load();
    const executable = process.argv[1]?.startsWith(os.homedir()) ? `~${process.argv[1].slice(os.homedir().length)}` : process.argv[1];
    if (config.profiles.length === 0) {
      emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "home", source: "cache" }, data: { status: "setup_required", executable, description: HOME_DESCRIPTION }, hints: [{ command: "slack-axi auth add <alias> --from-stdin", reason: "Pipe one bounded browser-session JSON object on stdin to configure a workspace." }] });
      return;
    }
    const profile = await app.config.resolve(globals(command).workspace);
    const snapshot = await app.cache.load(cacheIdentity(profile));
    const capabilityAge = profile.capability_probed_at ? Math.max(0, Math.floor((Date.now() - Date.parse(profile.capability_probed_at)) / 1000)) : undefined;
    const cacheAge = snapshot ? Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.synced_at)) / 1000)) : undefined;
    emit(command, { schema: "slack-axi/v1", ok: true, workspace: app.identity(profile), scope: { command: "home", source: "cache" }, data: { executable, description: HOME_DESCRIPTION, workspace_name: profile.team_name, actor: profile.actor_name ?? profile.actor_id, capabilities: { values: profile.capabilities, probed_at: profile.capability_probed_at ?? null, age_seconds: capabilityAge ?? null, stale: capabilityAge === undefined || capabilityAge > 604_800 }, cache: snapshot ? { synced_at: snapshot.synced_at, age_seconds: cacheAge, complete: Object.fromEntries(Object.entries(snapshot.coverage).filter(([key]) => key !== "backend_calls").map(([key, value]) => [key, typeof value === "object" && value !== null && "complete" in value ? value.complete : false])) } : { status: "not_synced" }, inbox: snapshot?.inbox ?? { status: "not_synced" } }, hints: snapshot ? [{ command: `slack-axi inbox --workspace ${shellArgument(profile.alias)}`, reason: "Inspect unread Slack activity." }] : [{ command: `slack-axi sync --workspace ${shellArgument(profile.alias)}`, reason: "Build the bounded local cache." }] });
  });

  const auth = program.command("auth");
  auth.command("add <alias>")
    .option("--browser", "import xoxc and xoxd fields (default)")
    .option("--user-token", "import an xoxp field instead")
    .requiredOption("--from-stdin", "read exactly one JSON object from stdin")
    .action(async (alias, options, command) => {
      validateAuthAlias(alias);
      const input = await authInput(options);
      const profile = await app.auth.add({ alias, ...input });
      const { keychain_accounts: _accounts, ...safeProfile } = profile;
      const hints = [
        ...(profile.kind === "browser" ? [{ command: `slack-axi auth doctor --workspace ${shellArgument(profile.alias)}`, reason: "Probe each browser-private capability before relying on it." }] : []),
        { command: `slack-axi sync --workspace ${shellArgument(profile.alias)}`, reason: "Populate entity and inbox caches." },
      ];
      emit(command, { schema: "slack-axi/v1", ok: true, workspace: app.identity(profile), scope: { command: "auth.add" }, data: { profile: safeProfile }, hints });
    });
  auth.command("list").action(async (_options, command) => {
    const config = await app.config.load();
    emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "auth.list" }, data: { count: config.profiles.length, pending_credential_cleanup: config.pending_credential_cleanup?.length ?? 0, pending_cache_cleanup: config.pending_cache_cleanup?.length ?? 0, profiles: config.profiles.map(({ keychain_accounts: _accounts, ...profile }) => ({ ...profile, default: profile.alias === config.default_workspace })) }, page: { shown: config.profiles.length, complete: true, source_complete: true, total: config.profiles.length, total_kind: "exact" } });
  });
  auth.command("use <workspace>").action(async (selector, _options, command) => { const config = await app.config.use(selector); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "auth.use" }, data: { default_workspace: config.default_workspace } }); });
  auth.command("revoke <workspace>").action(async (selector, _options, command) => {
    const globalWorkspace = globals(command).workspace;
    const profile = await app.config.resolve(selector);
    if (globalWorkspace && globalWorkspace !== profile.alias && globalWorkspace !== profile.team_id) {
      throw new AxiError({ code: "WORKSPACE_CONFLICT", message: "The positional workspace and --workspace select different profiles.", exitCode: 2 });
    }
    if (profile.kind === "browser") {
      throw new AxiError({
        code: "AUTH_REVOCATION_UNSUPPORTED",
        message: "Slack AXI cannot revoke a browser session through a supported Slack API. Terminate the session in Slack, then remove its local profile.",
        suggestedCommand: `slack-axi auth remove ${shellArgument(profile.alias)}`,
      });
    }
    const ctx = await app.context(selector);
    if (ctx.profile.kind === "browser") {
      throw new AxiError({
        code: "AUTH_REVOCATION_UNSUPPORTED",
        message: "Slack AXI cannot revoke a browser session through a supported Slack API. Terminate the session in Slack, then remove its local profile.",
        suggestedCommand: `slack-axi auth remove ${shellArgument(ctx.profile.alias)}`,
      });
    }
    const action = await stageAction(app, ctx, {
      operation: "auth.revoke",
      targetIds: [ctx.profile.team_id],
      preview: {
        team_id: ctx.profile.team_id,
        alias: ctx.profile.alias,
        actor_id: ctx.profile.actor_id,
        effect: "revoke_imported_user_token",
        app_uninstall_required_separately: true,
      },
      payload: { team_id: ctx.profile.team_id },
    });
    emit(command, workspaceEnvelope(ctx, "auth.revoke", actionOutput(action)));
  });
  auth.command("remove <workspace>").action(async (selector, _options, command) => {
    const result = await app.auth.remove(selector);
    emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "auth.remove" }, data: { removed: { alias: result.profile.alias, team_id: result.profile.team_id }, credentials_removed: result.credentials_removed, cache_scopes_removed: result.cache_scopes_removed, action_records_removed: result.action_records_removed } });
  });
  auth.command("doctor").action(async (_options, command) => { const result = await app.auth.doctor(globals(command).workspace); emit(command, { schema: "slack-axi/v1", ok: true, workspace: app.identity(result.profile), scope: { command: "auth.doctor", backend_calls: result.backend_calls }, data: { status: result.status, capabilities: result.capabilities, scopes: { granted: result.granted_scopes, metadata_available: result.scope_metadata_available }, probed_at: result.probed_at } }); });

  program.command("sync").option("--all", "continue each paged source to the explicit page bound").option("--max-pages <1..100>", "required with --all", positiveInteger).action(async (options, command) => {
    if (options.all && !options.maxPages) throw new AxiError({ code: "MAX_PAGES_REQUIRED", message: "--all requires --max-pages <1..100>.", exitCode: 2 });
    if (options.maxPages && !options.all) throw new AxiError({ code: "SYNC_OPTION_CONFLICT", message: "--max-pages is valid only with --all.", exitCode: 2 });
    const maxPages = options.all ? ensureLimit(options.maxPages, 100) : 2;
    const { clients, snapshot } = await app.sync(globals(command).workspace, { maxPages });
    const sources = { conversations: snapshot.coverage.conversations, users: snapshot.coverage.users, emoji: snapshot.coverage.emoji, inbox: snapshot.coverage.inbox };
    const failed = Object.values(sources).filter((source) => !source.complete).length;
    emit(command, { schema: "slack-axi/v1", ok: true, workspace: app.identity(clients.profile), scope: { command: "sync", max_pages_per_entity: maxPages, backend_calls: snapshot.coverage.backend_calls }, data: { synced_at: snapshot.synced_at, revision: snapshot.revision, known_counts: { conversations: snapshot.conversations.length, users: snapshot.users.length, emoji: Object.keys(snapshot.emoji).length }, inbox: snapshot.inbox ?? { status: "unavailable" }, sources }, coverage: { requested: 4, scanned: 4 - failed, failed, complete: failed === 0, sources, ...(failed ? { reason: "One or more sources failed or retained a continuation cursor." } : {}) } });
  });

  const conversation = program.command("conversation");
  conversation.command("list").addOption(new Option("--type <type>").choices(["channel", "group", "dm", "group_dm"])).option("--query <text>").option("--include-archived").action(async (options, command) => {
    const ctx = await context(app, command);
    let items = ctx.conversations.filter((item) => options.includeArchived || !item.is_archived);
    if (options.type) items = items.filter((item) => item.type === options.type);
    if (options.query) items = items.filter((item) => `${item.name} ${item.topic ?? ""} ${item.purpose ?? ""}`.toLowerCase().includes(String(options.query).toLowerCase()));
    items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const filters = { type: options.type ?? null, query: options.query ?? null, archived: Boolean(options.includeArchived) };
    const restart = [
      "slack-axi conversation list",
      options.type ? `--type ${options.type}` : undefined,
      options.query ? `--query ${shellArgument(String(options.query))}` : undefined,
      options.includeArchived ? "--include-archived" : undefined,
      cacheRestartOptions(ctx, command),
    ].filter((value): value is string => Boolean(value)).join(" ");
    const page = await cacheSlice(ctx, command, "conversation list", filters, items, ctx.snapshot.coverage.conversations, restart, app.actions);
    const hints = !ctx.snapshot.coverage.conversations.complete ? [syncHint(ctx)] : undefined;
    const rows = expandsFields(command) ? page.items : page.items.map(({ id, name, type }) => ({ id, name, type }));
    emit(command, workspaceEnvelope(ctx, "conversation.list", { known_count: items.length, conversations: rows }, { page: page.page, ...(hints ? { hints } : {}) }));
  });
  conversation.command("get <selector>").action(async (selector, _options, command) => { const ctx = await context(app, command); const item = await resolveConversationFor(selector, ctx); emit(command, workspaceEnvelope(ctx, "conversation.get", { conversation: normalizeConversation(await ctx.public.conversationInfo(item.id)) })); });
  conversation.command("resolve <selector>").action(async (selector, _options, command) => { const ctx = await context(app, command); emit(command, workspaceEnvelope(ctx, "conversation.resolve", { conversation: await resolveConversationFor(selector, ctx) })); });
  conversation.command("members <selector>").action(async (selector, _options, command) => {
    const ctx = await context(app, command);
    const item = await resolveConversationFor(selector, ctx);
    const restart = `slack-axi conversation members ${item.id} ${liveRestartOptions(ctx, command)}`;
    const binding = liveCursorBinding([ctx.profile.team_id, ctx.profile.actor_id, ctx.snapshot.credential_generation, item.id]);
    const continuation = await parseLiveCursor(globals(command).cursor, "conversation.members", binding, restart, app.actions);
    const result = await ctx.public.conversationMembers(item.id, ensureLimit(globals(command).limit ?? 100, 200), continuation.backendCursor);
    const scanned = continuation.scanned + result.items.length;
    const next = result.next ? await createLiveCursor("conversation.members", binding, result.next, scanned, app.actions) : undefined;
    const hints = next ? [{ command: `${restart} --cursor ${next}`, reason: "Continue the same member scan." }] : undefined;
    const members = result.items.map((id) => {
      const user = ctx.userMap.get(id);
      return expandsFields(command) ? user ?? { id } : user ? { id: user.id, name: user.name, display_name: user.display_name } : { id };
    });
    emit(command, workspaceEnvelope(ctx, "conversation.members", { conversation_id: item.id, members }, { page: { shown: result.items.length, complete: !next, source_complete: !next, total: scanned, total_kind: next ? "scanned" : "exact", ...(next ? { next_cursor: next } : {}) }, ...(hints ? { hints } : {}) }));
  });

  const user = program.command("user");
  user.command("search <query>").action(async (query, _options, command) => { const ctx = await context(app, command); const needle = String(query).toLowerCase(); const matched = ctx.users.filter((item) => [item.id, item.name, item.display_name, item.real_name, item.email].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle))).sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id)); const restart = `slack-axi user search ${shellArgument(String(query))} ${cacheRestartOptions(ctx, command)}`; const page = await cacheSlice(ctx, command, "user search", { query: needle }, matched, ctx.snapshot.coverage.users, restart, app.actions); const hints = !ctx.snapshot.coverage.users.complete ? [syncHint(ctx)] : undefined; const rows = expandsFields(command) ? page.items : page.items.map(({ id, display_name, name }) => ({ id, display_name, name })); emit(command, workspaceEnvelope(ctx, "user.search", { known_count: matched.length, users: rows }, { page: page.page, ...(hints ? { hints } : {}) })); });
  user.command("get <selector>").action(async (selector, _options, command) => { const ctx = await context(app, command); const found = await resolveUserFor(selector, ctx); emit(command, workspaceEnvelope(ctx, "user.get", { user: normalizeUser(await ctx.public.userInfo(found.id)) })); });

  const usergroup = program.command("usergroup");
  usergroup.command("list").action(async (_options, command) => {
    const ctx = await context(app, command);
    const items = (await ctx.public.listUsergroups(false))
      .map((item) => normalizeUsergroup(item, globals(command).full))
      .sort((a, b) => String(a.handle).localeCompare(String(b.handle)) || String(a.id).localeCompare(String(b.id)));
    const restart = `slack-axi usergroup list ${liveRestartOptions(ctx, command, true)}`;
    const revision = collectionFingerprint(items.map((item) => JSON.stringify(item)));
    const binding = liveCursorBinding([ctx.profile.team_id, ctx.profile.actor_id, ctx.snapshot.credential_generation, revision]);
    const page = await localLiveSlice(command, "usergroup.list", binding, restart, items, app.actions);
    const rows = expandsFields(command) ? page.items : page.items.map(({ id, handle, name }) => ({ id, handle, name }));
    const hints = page.next ? [{ command: `${restart} --cursor ${page.next}`, reason: "Continue the same user-group snapshot." }] : undefined;
    emit(command, workspaceEnvelope(ctx, "usergroup.list", { count: items.length, usergroups: rows }, { page: page.page, ...(hints ? { hints } : {}) }));
  });
  usergroup.command("members <id>").action(async (id, _options, command) => {
    const ctx = await context(app, command);
    const ids = (await ctx.public.usergroupMembers(id)).sort((a, b) => a.localeCompare(b));
    const restart = `slack-axi usergroup members ${shellArgument(id)} ${liveRestartOptions(ctx, command)}`;
    const revision = collectionFingerprint(ids);
    const binding = liveCursorBinding([ctx.profile.team_id, ctx.profile.actor_id, ctx.snapshot.credential_generation, String(ctx.snapshot.revision ?? ""), id, revision]);
    const page = await localLiveSlice(command, "usergroup.members", binding, restart, ids, app.actions);
    const hints = page.next ? [{ command: `${restart} --cursor ${page.next}`, reason: "Continue the same user-group member snapshot." }] : undefined;
    const members = page.items.map((member) => {
      const user = ctx.userMap.get(member);
      return expandsFields(command) ? user ?? { id: member } : user ? { id: user.id, name: user.name, display_name: user.display_name } : { id: member };
    });
    emit(command, workspaceEnvelope(ctx, "usergroup.members", { usergroup_id: id, count: ids.length, members }, { page: page.page, ...(hints ? { hints } : {}) }));
  });

  const emoji = program.command("emoji");
  emoji.command("search <query>").action(async (query, _options, command) => { const ctx = await context(app, command); const needle = String(query).toLowerCase(); const matched = Object.entries(ctx.snapshot.emoji).filter(([name]) => name.toLowerCase().includes(needle)).sort(([a], [b]) => a.localeCompare(b)).map(([name, url]) => ({ name, url })); const restart = `slack-axi emoji search ${shellArgument(String(query))} ${cacheRestartOptions(ctx, command)}`; const page = await cacheSlice(ctx, command, "emoji search", { query: needle }, matched, ctx.snapshot.coverage.emoji, restart, app.actions); const hints = !ctx.snapshot.coverage.emoji.complete ? [syncHint(ctx)] : undefined; emit(command, workspaceEnvelope(ctx, "emoji.search", { known_count: matched.length, emoji: page.items }, { page: page.page, ...(hints ? { hints } : {}) })); });

  program.command("read <conversation>").option("--since <duration>").option("--from <timestamp>").option("--to <timestamp>").option("--on <date>").action(async (selector, options, command) => {
    preflightTimeFlags(options);
    const ctx = await context(app, command);
    const item = await resolveConversationFor(selector, ctx);
    const range = resolveTimeRange({ ...options, timezone: ctx.profile.timezone });
    const limit = ensureLimit(globals(command).limit ?? 50, 100);
    const restart = `slack-axi read ${item.id} --from ${range.from.toISOString()} --to ${range.to.toISOString()} ${liveRestartOptions(ctx, command, true)}`;
    const binding = liveCursorBinding([ctx.profile.team_id, ctx.profile.actor_id, ctx.snapshot.credential_generation, item.id, range.from.toISOString(), range.to.toISOString()]);
    const continuation = await parseLiveCursor(globals(command).cursor, "read", binding, restart, app.actions);
    const result = await ctx.public.history({ channel: item.id, oldest: String(range.from.getTime() / 1000), latest: String(range.to.getTime() / 1000), limit, ...(continuation.backendCursor ? { cursor: continuation.backendCursor } : {}) });
    const messages = result.items.map((raw) => normalizeMessage(raw, ctx.profile.team_id, item.id, ctx.userMap, globals(command).full, ctx.profile.actor_id));
    const scanned = continuation.scanned + messages.length;
    const next = result.next ? await createLiveCursor("read", binding, result.next, scanned, app.actions) : undefined;
    const hints = [
      ...(messages.some((entry) => entry.text_truncated) ? [{ command: `${restart} --full`, reason: "Expand truncated message text while preserving the exact range." }] : []),
      ...(next ? [{ command: `${restart} --cursor ${next}`, reason: "Continue the same bounded timeline." }] : []),
    ];
    emit(command, workspaceEnvelope(ctx, "read", { conversation: { id: item.id, name: item.name }, range: { from: range.from.toISOString(), to: range.to.toISOString(), interval: "[from,to)", timezone: range.timezone, year: range.year }, count: messages.length, messages }, { page: { shown: messages.length, complete: result.complete, source_complete: result.complete, total: scanned, total_kind: result.complete ? "exact" : "scanned", ...(next ? { next_cursor: next } : {}) }, ...(hints.length ? { hints } : {}) }));
  });
  program.command("thread <ref>").action(async (input, _options, command) => {
    parseMessageRef(input);
    const ctx = await context(app, command);
    const ref = parseMessageRef(input, ctx.profile.team_id);
    const limit = ensureLimit(globals(command).limit ?? 50, 100);
    const canonicalRef = `${ctx.profile.team_id}/${ref.conversationId}/${ref.ts}`;
    const restart = `slack-axi thread ${canonicalRef} ${liveRestartOptions(ctx, command, true)}`;
    const binding = liveCursorBinding([ctx.profile.team_id, ctx.profile.actor_id, ctx.snapshot.credential_generation, ref.conversationId, ref.ts]);
    const continuation = await parseLiveCursor(globals(command).cursor, "thread", binding, restart, app.actions);
    const result = await ctx.public.replies({ channel: ref.conversationId, ts: ref.ts, limit, ...(continuation.backendCursor ? { cursor: continuation.backendCursor } : {}) });
    const messages = result.items.map((raw) => normalizeMessage(raw, ctx.profile.team_id, ref.conversationId, ctx.userMap, globals(command).full, ctx.profile.actor_id));
    const scanned = continuation.scanned + messages.length;
    const next = result.next ? await createLiveCursor("thread", binding, result.next, scanned, app.actions) : undefined;
    const hints = [
      ...(messages.some((entry) => entry.text_truncated) ? [{ command: `${restart} --full`, reason: "Expand truncated thread text for the same thread." }] : []),
      ...(next ? [{ command: `${restart} --cursor ${next}`, reason: "Continue the same thread scan." }] : []),
    ];
    emit(command, workspaceEnvelope(ctx, "thread", { root_ref: canonicalRef, count: messages.length, messages }, { page: { shown: messages.length, complete: result.complete, source_complete: result.complete, total: scanned, total_kind: result.complete ? "exact" : "scanned", ...(next ? { next_cursor: next } : {}) }, ...(hints.length ? { hints } : {}) }));
  });

  const search = program.command("search");
  const addSearchOptions = (command: Command): Command => command.option("--in <conversation>").option("--from-user <user>").option("--with-user <user>").option("--after <YYYY-MM-DD>").option("--before <YYYY-MM-DD>").addOption(new Option("--has <kind>").choices(["link", "reaction", "pin", "star", "file"])).addOption(new Option("--sort <sort>").choices(["score", "timestamp"]).default("score")).option("--all", "fetch multiple result pages").option("--max-results <n>", "required bound for --all", positiveInteger);
  addSearchOptions(search.command("messages <query...>")).action(async (query, options, command) => {
    const bound = validateSearchOptions(options, command);
    const pageSize = Math.min(100, bound);
    const requestCap = options.all ? Math.ceil(bound / pageSize) : 1;
    const ctx = await context(app, command);
    const slackQuery = await buildSearchQuery(query, options, ctx);
    const raw: Record<string, unknown>[] = [];
    let total = 0;
    let pages = 1;
    for (let page = 1; page <= pages && page <= requestCap && raw.length < bound; page += 1) {
      const result = await ctx.public.searchMessages(slackQuery, pageSize, page, options.sort);
      raw.push(...result.items);
      total = result.total;
      if (result.items.length === 0 && raw.length < Math.min(total, bound)) {
        throw new AxiError({
          code: "SLACK_RESPONSE_INVALID",
          message: "Slack search pagination returned an empty page before its declared result boundary.",
          details: { page, declared_pages: result.pages, declared_total: total, collected: raw.length },
        });
      }
      pages = options.all ? Math.min(result.pages, requestCap) : 1;
    }
    const items = raw.slice(0, bound).map((entry) => {
      const channel = slackRecord(entry.channel);
      const channelId = String(entry.channel_id ?? channel.id ?? "");
      return normalizeMessage(entry, ctx.profile.team_id, channelId, ctx.userMap, globals(command).full, ctx.profile.actor_id);
    });
    const hints: Array<{ command: string; reason: string }> = [];
    if (items.some((entry) => entry.text_truncated)) hints.push({ command: searchReplayCommand("messages", slackQuery, options.sort, ctx.profile.alias, bound, Boolean(options.all), true), reason: "Expand truncated result text while preserving the exact Slack query and bound." });
    if (items.length < total && bound < 1000) hints.push({ command: searchReplayCommand("messages", slackQuery, options.sort, ctx.profile.alias, Math.min(total, 1000), true), reason: "Retrieve more results for the same exact Slack query." });
    emit(command, workspaceEnvelope(ctx, "search.messages", { query: slackQuery, total, messages: items }, { page: { shown: items.length, complete: items.length >= total, source_complete: true, total, total_kind: "exact", ...(items.length < total ? { omitted: total - items.length } : {}) }, ...(hints.length ? { hints } : {}) }));
  });
  addSearchOptions(search.command("files <query...>")).action(async (query, options, command) => {
    const bound = validateSearchOptions(options, command);
    const pageSize = Math.min(100, bound);
    const requestCap = options.all ? Math.ceil(bound / pageSize) : 1;
    const ctx = await context(app, command);
    const slackQuery = await buildSearchQuery(query, options, ctx);
    const raw: Record<string, unknown>[] = [];
    let total = 0;
    let pages = 1;
    for (let page = 1; page <= pages && page <= requestCap && raw.length < bound; page += 1) {
      const result = await ctx.public.searchFiles(slackQuery, pageSize, page, options.sort);
      raw.push(...result.items);
      total = result.total;
      if (result.items.length === 0 && raw.length < Math.min(total, bound)) {
        throw new AxiError({
          code: "SLACK_RESPONSE_INVALID",
          message: "Slack search pagination returned an empty page before its declared result boundary.",
          details: { page, declared_pages: result.pages, declared_total: total, collected: raw.length },
        });
      }
      pages = options.all ? Math.min(result.pages, requestCap) : 1;
    }
    const items = raw.slice(0, bound).map((item) => normalizeFile(item, globals(command).full));
    const rows = expandsFields(command) ? items : items.map(({ id, name, mimetype }) => ({ id, name, mimetype }));
    const hints = items.length < total && bound < 1000
      ? [{ command: searchReplayCommand("files", slackQuery, options.sort, ctx.profile.alias, Math.min(total, 1000), true), reason: "Retrieve more results for the same exact Slack query." }]
      : undefined;
    emit(command, workspaceEnvelope(ctx, "search.files", { query: slackQuery, total, files: rows }, { page: { shown: items.length, complete: items.length >= total, source_complete: true, total, total_kind: "exact", ...(items.length < total ? { omitted: total - items.length } : {}) }, ...(hints ? { hints } : {}) }));
  });

  program.command("inbox").option("--mentions-only").option("--include-muted").addOption(new Option("--type <type>").choices(["channel", "group_dm", "dm"])).option("--dm-only").option("--partner-only").option("--internal-only").action(async (options, command) => {
    if ([options.partnerOnly, options.internalOnly].filter(Boolean).length > 1) throw new AxiError({ code: "INBOX_FILTER_CONFLICT", message: "Use only one of --partner-only or --internal-only.", exitCode: 2 });
    if (options.dmOnly && options.type && !["dm", "group_dm"].includes(options.type)) throw new AxiError({ code: "INBOX_FILTER_CONFLICT", message: "--dm-only is incompatible with a non-DM --type.", exitCode: 2 });
    const ctx = await context(app, command);
    const limit = ensureLimit(globals(command).limit ?? 20);
    let rows: Record<string, unknown>[] = [];
    let coverage: CoverageInfo;
    const hints: Array<{ command: string; reason: string }> = [];
    if (ctx.browser) {
      const byId = new Map(ctx.conversations.map((item) => [item.id, item]));
      const counts = await ctx.browser.counts();
      const muted = options.includeMuted ? undefined : new Set(await ctx.browser.mutedChannels());
      const entries = [
        ...counts.channels.map((value) => ({ value, type: "channel" })),
        ...counts.mpims.map((value) => ({ value, type: "group_dm" })),
        ...counts.ims.map((value) => ({ value, type: "dm" })),
      ];
      let unclassified = 0;
      rows = entries.map(({ value, type }) => {
        const metadata = byId.get(value.id);
        const classification = metadata?.is_external === true ? "partner" : metadata?.is_external === false ? "internal" : "unclassified";
        if (classification === "unclassified") unclassified += 1;
        return {
          conversation_id: value.id,
          type,
          unread: value.has_unreads,
          mentions: value.mention_count,
          muted: muted ? muted.has(value.id) : null,
          classification,
          last_read: value.last_read ?? null,
          latest: value.latest ?? null,
        };
      }).filter((row) => row.unread
        && (!options.mentionsOnly || Number(row.mentions) > 0)
        && (!options.type || row.type === options.type)
        && (!options.dmOnly || row.type === "dm" || row.type === "group_dm")
        && (!options.partnerOnly || row.classification === "partner")
        && (!options.internalOnly || row.classification === "internal")
        && (options.includeMuted || row.muted === false));
      coverage = {
        requested: entries.length,
        scanned: entries.length,
        failed: unclassified,
        complete: ctx.snapshot.coverage.conversations.complete && unclassified === 0,
        ...(unclassified ? { reason: "Some unread conversations lacked authoritative external-sharing metadata and were classified as unclassified." } : {}),
      };
    } else {
      const active = ctx.conversations.filter((item) => !item.is_archived).sort((a, b) => a.id.localeCompare(b.id));
      const candidates = active.slice(0, 50);
      const skipped = Math.max(0, active.length - candidates.length);
      const failed: Record<string, unknown>[] = [];
      let unclassified = 0;
      await inBatches(candidates, 4, async (item) => {
        try {
          const info = await ctx.public.conversationInboxInfo(item.id);
          const unread = Number(info.unread_count_display ?? info.unread_count);
          const classification = typeof info.is_ext_shared === "boolean" ? (info.is_ext_shared ? "partner" : "internal") : "unclassified";
          if (classification === "unclassified") unclassified += 1;
          if (unread > 0 && !options.mentionsOnly) rows.push({ conversation_id: item.id, type: item.type, unread_count: unread, mentions: null, muted: null, classification });
        } catch (error) {
          failed.push({ conversation_id: item.id, code: error instanceof AxiError ? error.code : "SLACK_API_ERROR" });
        }
      });
      rows = rows.filter((row) => (!options.type || row.type === options.type)
        && (!options.dmOnly || row.type === "dm" || row.type === "group_dm")
        && (!options.partnerOnly || row.classification === "partner")
        && (!options.internalOnly || row.classification === "internal"));
      const reasons = [
        options.mentionsOnly ? "User-token mode cannot determine mention counts." : undefined,
        skipped ? "Additional conversations were skipped by the 50-conversation fallback bound." : undefined,
        failed.length ? "Some conversations.info probes failed or lacked unread semantics." : undefined,
        unclassified ? "Some conversations lacked authoritative external-sharing metadata and were classified as unclassified." : undefined,
        !options.includeMuted ? "User-token mode cannot determine mute state, so excluding muted conversations is unprovable." : undefined,
      ].filter((value): value is string => Boolean(value));
      coverage = {
        requested: active.length,
        scanned: candidates.length,
        failed: failed.length + unclassified,
        complete: ctx.snapshot.coverage.conversations.complete && skipped === 0 && failed.length === 0 && unclassified === 0 && !options.mentionsOnly && Boolean(options.includeMuted),
        ...(reasons.length ? { reason: reasons.join(" ") } : {}),
      };
      hints.push({ command: `slack-axi auth add ${shellArgument(ctx.profile.alias)} --from-stdin`, reason: "Replace this fallback profile with browser-session credentials for exact mention and mute state." });
      if (!options.includeMuted) {
        const replay = [
          "slack-axi inbox",
          options.mentionsOnly ? "--mentions-only" : undefined,
          options.type ? `--type ${options.type}` : undefined,
          options.dmOnly ? "--dm-only" : undefined,
          options.partnerOnly ? "--partner-only" : undefined,
          options.internalOnly ? "--internal-only" : undefined,
          "--include-muted",
          cacheRestartOptions(ctx, command),
        ].filter((value): value is string => Boolean(value)).join(" ");
        hints.push({ command: replay, reason: "Include muted conversations so user-token mode does not need unavailable mute state." });
      }
    }
    const priority = (row: Record<string, unknown>): number => row.type === "dm" ? 0 : row.type === "group_dm" ? 1 : row.classification === "partner" ? 2 : row.classification === "internal" ? 3 : 4;
    rows.sort((a, b) => priority(a) - priority(b)
      || Number(b.mentions ?? 0) - Number(a.mentions ?? 0)
      || String(b.latest ?? "").localeCompare(String(a.latest ?? ""))
      || String(a.conversation_id).localeCompare(String(b.conversation_id)));
    const shown = rows.slice(0, limit);
    const totals = rows.reduce<Record<string, number>>((result, row) => {
      const key = String(row.type);
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {});
    if (!coverage.complete && !ctx.snapshot.coverage.conversations.complete) hints.push(syncHint(ctx));
    emit(command, workspaceEnvelope(ctx, "inbox", { known_count: rows.length, totals_by_type: totals, conversations: shown }, {
      page: { shown: shown.length, complete: shown.length === rows.length && coverage.complete, source_complete: coverage.complete, total: rows.length, total_kind: coverage.complete ? "exact" : "known", ...(shown.length < rows.length ? { omitted: rows.length - shown.length } : {}) },
      coverage,
      ...(hints.length ? { hints } : {}),
    }));
  });

  program.command("catchup").option("--since <duration>", "lookback duration (default: 24h)", "24h").option("--max-conversations <n>", "conversation bound (default: 20)", positiveInteger, 20).option("--per-conversation <n>", "preview bound (default: 5)", positiveInteger, 5).addOption(new Option("--type <type>").choices(["channel", "group", "dm", "group_dm"])).action(async (options, command) => {
    preflightTimeFlags({ since: options.since });
    ensureLimit(options.maxConversations, 50);
    ensureLimit(options.perConversation, 20);
    const ctx = await context(app, command);
    const range = resolveTimeRange({ since: options.since, timezone: ctx.profile.timezone });
    const eligible = ctx.conversations
      .filter((item) => !item.is_archived && (!options.type || item.type === options.type))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const candidates = eligible.slice(0, options.maxConversations);
    const skippedCount = Math.max(0, eligible.length - candidates.length);
    const skippedSample = eligible.slice(candidates.length, candidates.length + 5).map((item) => ({ conversation_id: item.id, reason: "max_conversations_bound" }));
    const summaries: Record<string, unknown>[] = [];
    const failed: Record<string, unknown>[] = [];
    const incomplete: Record<string, unknown>[] = [];
    await inBatches(candidates, 4, async (item) => {
      try {
        const result = await ctx.public.history({ channel: item.id, oldest: String(range.from.getTime() / 1000), latest: String(range.to.getTime() / 1000), limit: options.perConversation });
        if (!result.complete && !result.next) throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack returned an incomplete history page without a continuation cursor." });
        const restartCommand = `slack-axi read ${item.id} --from ${range.from.toISOString()} --to ${range.to.toISOString()} --limit ${options.perConversation} --workspace ${shellArgument(ctx.profile.alias)}`;
        const readBinding = liveCursorBinding([ctx.profile.team_id, ctx.profile.actor_id, ctx.snapshot.credential_generation, item.id, range.from.toISOString(), range.to.toISOString()]);
        const continuationCursor = result.next ? await createLiveCursor("read", readBinding, result.next, result.items.length, app.actions) : undefined;
        const continuationCommand = continuationCursor ? `${restartCommand} --cursor ${continuationCursor}` : undefined;
        summaries.push({ conversation: { id: item.id, name: item.name, type: item.type }, message_count_shown: result.items.length, messages: result.items.map((raw) => normalizeMessage(raw, ctx.profile.team_id, item.id, ctx.userMap, false, ctx.profile.actor_id)), complete: result.complete, ...(continuationCommand ? { continuation_command: continuationCommand } : {}) });
        if (continuationCommand) incomplete.push({ conversation_id: item.id, reason: "history_page_truncated", continuation_command: continuationCommand });
      } catch (error) {
        failed.push({ conversation_id: item.id, code: error instanceof AxiError ? error.code : "UNKNOWN" });
      }
    });
    summaries.sort((a, b) => String(slackRecord(a.conversation).name).localeCompare(String(slackRecord(b.conversation).name)) || String(slackRecord(a.conversation).id).localeCompare(String(slackRecord(b.conversation).id)));
    incomplete.sort((a, b) => String(a.conversation_id).localeCompare(String(b.conversation_id)));
    failed.sort((a, b) => String(a.conversation_id).localeCompare(String(b.conversation_id)));
    const reasons = [
      !ctx.snapshot.coverage.conversations.complete ? "The conversation source cache is incomplete." : undefined,
      skippedCount ? "Additional conversations were skipped by the explicit aggregation bound." : undefined,
      failed.length ? "Some conversation history requests failed." : undefined,
      incomplete.length ? "Some conversation histories have additional pages beyond the per-conversation preview bound." : undefined,
    ].filter((value): value is string => Boolean(value));
    const complete = reasons.length === 0;
    const hints: Array<{ command: string; reason: string }> = [];
    const firstIncomplete = incomplete[0];
    if (typeof firstIncomplete?.continuation_command === "string") hints.push({ command: firstIncomplete.continuation_command, reason: `Continue the exact bounded range for ${firstIncomplete.conversation_id}.` });
    if (!ctx.snapshot.coverage.conversations.complete) hints.push(syncHint(ctx));
    emit(command, workspaceEnvelope(ctx, "catchup", {
      range: { from: range.from.toISOString(), to: range.to.toISOString(), timezone: range.timezone },
      totals: { eligible: eligible.length, scanned: candidates.length, returned: summaries.length, incomplete: incomplete.length, failed: failed.length, skipped: skippedCount },
      conversations: summaries,
      incomplete,
      failed,
      skipped_count: skippedCount,
      skipped_sample: skippedSample,
    }, {
      coverage: { requested: eligible.length, scanned: candidates.length, failed: failed.length, complete, ...(reasons.length ? { reason: reasons.join(" ") } : {}) },
      ...(hints.length ? { hints } : {}),
    }));
  });

  const message = program.command("message");
  message.command("get <ref>").action(async (input, _options, command) => {
    parseMessageRef(input);
    const ctx = await context(app, command);
    const ref = parseMessageRef(input, ctx.profile.team_id);
    const raw = await ctx.public.messageByTs(ref.conversationId, ref.ts);
    if (!raw) throw new AxiError({ code: "MESSAGE_NOT_FOUND", message: `Message '${input}' was not found.` });
    const item = normalizeMessage(raw, ctx.profile.team_id, ref.conversationId, ctx.userMap, globals(command).full, ctx.profile.actor_id);
    const permalink = await ctx.public.permalink(ref.conversationId, ref.ts).catch(() => undefined);
    if (permalink) item.permalink = permalink;
    const hints = item.text_truncated
      ? [{ command: `slack-axi message get ${item.ref} --full --workspace ${shellArgument(ctx.profile.alias)}`, reason: "Expand the truncated message text." }]
      : undefined;
    emit(command, workspaceEnvelope(ctx, "message.get", { message: item }, { ...(hints ? { hints } : {}) }));
  });
  message.command("cite <refs...>").action(async (inputs: string[], _options, command) => {
    if (inputs.length > 50) throw new AxiError({ code: "LIMIT_TOO_LARGE", message: "message cite accepts at most 50 references.", exitCode: 2 });
    const parsed = inputs.map((input) => ({ input, ref: parseMessageRef(input) }));
    const ctx = await context(app, command);
    const full = Boolean(globals(command).full);
    const citations: Record<string, unknown>[] = [];
    const failed: Record<string, unknown>[] = [];
    await inBatches(parsed, 4, async ({ input }) => {
      try {
        const ref = parseMessageRef(input, ctx.profile.team_id);
        const raw = await ctx.public.messageByTs(ref.conversationId, ref.ts);
        if (!raw) throw new AxiError({ code: "MESSAGE_NOT_FOUND", message: `Message '${input}' was not found.` });
        const item = normalizeMessage(raw, ctx.profile.team_id, ref.conversationId, ctx.userMap, full, ctx.profile.actor_id);
        const permalink = await ctx.public.permalink(ref.conversationId, ref.ts);
        const label = markdownLabel(`${item.author ?? "Slack"} in ${ref.conversationId} at ${item.time}`);
        citations.push({ ref: item.ref, author: item.author, conversation_id: ref.conversationId, time: item.time, permalink, text: item.text, text_chars: item.text_chars, text_truncated: item.text_truncated, markdown: `[${label}](<${permalink}>)` });
      } catch (error) {
        failed.push({ ref: input, code: error instanceof AxiError ? error.code : "SLACK_API_ERROR", message: error instanceof Error ? error.message : String(error) });
      }
    });
    citations.sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
    const hints = !full && citations.some((citation) => citation.text_truncated === true)
      ? [{ command: `slack-axi message cite ${inputs.map(shellArgument).join(" ")} --full --workspace ${shellArgument(ctx.profile.alias)}`, reason: "Expand truncated citation text for the same references." }]
      : undefined;
    emit(command, workspaceEnvelope(ctx, "message.cite", { count: citations.length, citations, failed }, { page: { shown: citations.length, complete: failed.length === 0, source_complete: failed.length === 0, total: inputs.length, total_kind: "exact" }, coverage: { requested: inputs.length, scanned: inputs.length, failed: failed.length, complete: failed.length === 0 }, ...(hints ? { hints } : {}) }));
  });
  const addMessageWriteOptions = (cmd: Command): Command => cmd.requiredOption("--to <conversation|user>").option("--text <text>").option("--text-file <path|->").option("--unfurl", "enable link and media unfurls").option("--unfurl-links").option("--unfurl-media").option("--allow-broadcast", "allow <!channel>, <!everyone>, <!here>, and <!subteam^…> mentions").option("--apply");
  addMessageWriteOptions(message.command("send")).action(async (options, command) => { const body = await messageTextInput(options, openMessageFile); const allowBroadcast = Boolean(options.allowBroadcast); validateBroadcastMentions(body, allowBroadcast); const ctx = await context(app, command); const unfurlLinks = Boolean(options.unfurl || options.unfurlLinks); const unfurlMedia = Boolean(options.unfurl || options.unfurlMedia); await app.policy.validateUnfurls(body, unfurlLinks || unfurlMedia); let conversationId: string | undefined; let userId: string | undefined; let opensDm = false; if (String(options.to).startsWith("@")) { const target = await resolveUserFor(options.to, ctx); userId = target.id; const dm = ctx.conversations.find((item) => item.type === "dm" && item.member_ids?.includes(target.id)); conversationId = dm?.id; opensDm = !dm; } else conversationId = (await resolveConversationFor(options.to, ctx)).id; const action = await directOrStage(app, ctx, { operation: "message.send", targetIds: conversationId ? [conversationId] : [userId!], ...(conversationId ? { conversationId } : {}), preview: { to: options.to, conversation_id: conversationId ?? null, user_id: userId ?? null, opens_dm: opensDm, text: body, unfurl_links: unfurlLinks, unfurl_media: unfurlMedia, allow_broadcast_mentions: allowBroadcast }, payload: { ...(conversationId ? { conversation_id: conversationId } : { user_id: userId }), text: body, client_msg_id: newClientMessageId(), unfurl_links: unfurlLinks, unfurl_media: unfurlMedia, allow_broadcast_mentions: allowBroadcast }, apply: Boolean(options.apply) }); emit(command, workspaceEnvelope(ctx, "message.send", actionOutput(action))); });
  addMessageWriteOptions(message.command("reply").requiredOption("--thread <ref>")).action(async (options, command) => { const threadInput = parseMessageRef(options.thread); const body = await messageTextInput(options, openMessageFile); const allowBroadcast = Boolean(options.allowBroadcast); validateBroadcastMentions(body, allowBroadcast); const ctx = await context(app, command); const thread = parseMessageRef(options.thread, ctx.profile.team_id); const to = await resolveConversationFor(options.to, ctx); if (to.id !== thread.conversationId || threadInput.conversationId !== to.id) throw new AxiError({ code: "THREAD_TARGET_MISMATCH", message: "--to and --thread refer to different conversations.", exitCode: 2 }); const unfurlLinks = Boolean(options.unfurl || options.unfurlLinks); const unfurlMedia = Boolean(options.unfurl || options.unfurlMedia); await app.policy.validateUnfurls(body, unfurlLinks || unfurlMedia); const action = await directOrStage(app, ctx, { operation: "message.reply", targetIds: [to.id, thread.ts], conversationId: to.id, preview: { conversation_id: to.id, thread_ref: options.thread, text: body, unfurl_links: unfurlLinks, unfurl_media: unfurlMedia, allow_broadcast_mentions: allowBroadcast }, payload: { conversation_id: to.id, thread_ts: thread.ts, text: body, client_msg_id: newClientMessageId(), unfurl_links: unfurlLinks, unfurl_media: unfurlMedia, allow_broadcast_mentions: allowBroadcast }, apply: Boolean(options.apply) }); emit(command, workspaceEnvelope(ctx, "message.reply", actionOutput(action))); });

  const reaction = program.command("reaction");
  reaction.command("list <ref>").action(async (input, _options, command) => { parseMessageRef(input); const ctx = await context(app, command); const ref = parseMessageRef(input, ctx.profile.team_id); const raw = await ctx.public.reactions(ref.conversationId, ref.ts); const reactions = raw.reactions.map((item) => ({ name: item.name, count: item.count, mine: item.users.includes(ctx.profile.actor_id) })); emit(command, workspaceEnvelope(ctx, "reaction.list", { ref: input, count: reactions.length, reactions })); });
  for (const verb of ["add", "remove"] as const) reaction.command(`${verb} <ref> <emoji>`).option("--apply").action(async (input, emojiName, options, command) => { const parsed = parseMessageRef(input); const name = String(emojiName).replace(/^:|:$/g, ""); if (!name) throw new AxiError({ code: "EMOJI_INVALID", message: "Emoji name cannot be empty.", exitCode: 2 }); const ctx = await context(app, command); const ref = parseMessageRef(input, ctx.profile.team_id); if (parsed.conversationId !== ref.conversationId) throw new AxiError({ code: "MESSAGE_REF_INVALID", message: "Message reference changed during parsing.", exitCode: 2 }); const operation = `reaction.${verb}`; const action = await directOrStage(app, ctx, { operation, targetIds: [ref.conversationId, ref.ts], conversationId: ref.conversationId, preview: { ref: input, name }, payload: { ref: input, conversation_id: ref.conversationId, ts: ref.ts, name }, apply: Boolean(options.apply) }); emit(command, workspaceEnvelope(ctx, operation, actionOutput(action))); });

  const file = program.command("file");
  file.command("info <id>").action(async (id, _options, command) => {
    const ctx = await context(app, command);
    const item = normalizeFile(await ctx.public.fileInfo(id), globals(command).full);
    const hints = item.description_truncated === true
      ? [{ command: `slack-axi file info ${shellArgument(id)} --full --workspace ${shellArgument(ctx.profile.alias)}`, reason: "Expand the truncated file description." }]
      : undefined;
    emit(command, workspaceEnvelope(ctx, "file.info", { file: item }, { ...(hints ? { hints } : {}) }));
  });
  file.command("get <id>")
    .requiredOption("--out <path>")
    .option("--overwrite")
    .option("--max-bytes <n>", "maximum accepted download size", downloadByteLimit, DEFAULT_DOWNLOAD_MAX_BYTES)
    .action(async (id, options, command) => {
      const output = path.resolve(options.out);
      if (output === path.parse(output).root) throw new AxiError({ code: "FILE_INVALID", message: "--out must name a file, not a filesystem root.", exitCode: 2 });
      const ctx = await context(app, command);
      const info = await ctx.public.fileInfo(id);
      const url = String(info.url_private_download ?? info.url_private ?? "");
      if (!url) throw new AxiError({ code: "FILE_URL_MISSING", message: "Slack did not return a downloadable private URL." });
      const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${randomUUID()}.tmp`);
      try {
        const expected = typeof info.size === "number" ? info.size : undefined;
        const result = await ctx.public.download(url, temporary, expected, options.maxBytes);
        const hash = await sha256File(temporary);
        if (options.overwrite) await rename(temporary, output);
        else {
          try { await link(temporary, output); } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new AxiError({ code: "FILE_EXISTS", message: `Output '${output}' already exists; pass --overwrite to replace it.`, exitCode: 2 });
            throw cause;
          }
          await unlink(temporary);
        }
        emit(command, workspaceEnvelope(ctx, "file.get", { file_id: id, path: output, bytes: result.bytes, redirects: result.redirects, mimetype: info.mimetype ?? null, sha256: hash }));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
  file.command("upload <path>").requiredOption("--to <conversation>").option("--thread <ref>").option("--comment <text>").option("--max-bytes <n>", "maximum staged upload size", uploadByteLimit, DEFAULT_UPLOAD_MAX_BYTES).option("--allow-broadcast", "allow broadcast mentions in the initial comment").option("--apply").action(async (filename, options, command) => { const allowBroadcast = Boolean(options.allowBroadcast); if (options.comment !== undefined) { validateSlackMessageText(options.comment, "File comment"); validateBroadcastMentions(options.comment, allowBroadcast); } const absolute = path.resolve(filename); let metadata; try { metadata = await lstat(absolute); } catch (cause) { throw new AxiError({ code: "FILE_INVALID", message: `'${absolute}' is not readable.`, exitCode: 2, cause }); } if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AxiError({ code: "FILE_INVALID", message: `'${absolute}' must be a regular non-symlink file.`, exitCode: 2 }); if (metadata.size > options.maxBytes) throw new AxiError({ code: "FILE_UPLOAD_LIMIT_EXCEEDED", message: "The upload source exceeds the configured byte limit.", exitCode: 2, details: { bytes: metadata.size, maximum_bytes: options.maxBytes } }); const threadInput = options.thread ? parseMessageRef(options.thread) : undefined; const ctx = await context(app, command); const target = await resolveConversationFor(options.to, ctx); let threadTs: string | undefined; if (options.thread) { const ref = parseMessageRef(options.thread, ctx.profile.team_id); if (ref.conversationId !== target.id || threadInput?.conversationId !== target.id) throw new AxiError({ code: "THREAD_TARGET_MISMATCH", message: "--to and --thread refer to different conversations.", exitCode: 2 }); threadTs = ref.ts; } const action = await directOrStage(app, ctx, { operation: "file.upload", targetIds: [target.id], conversationId: target.id, preview: { conversation_id: target.id, filename: path.basename(absolute), thread_ref: options.thread ?? null, initial_comment: options.comment ?? null, maximum_bytes: options.maxBytes, allow_broadcast_mentions: allowBroadcast }, payload: { conversation_id: target.id, filename: path.basename(absolute), ...(threadTs ? { thread_ts: threadTs } : {}), ...(options.comment ? { initial_comment: options.comment } : {}), allow_broadcast_mentions: allowBroadcast }, uploadPath: absolute, uploadMaxBytes: options.maxBytes, apply: Boolean(options.apply) }); emit(command, workspaceEnvelope(ctx, "file.upload", actionOutput(action))); });

  program.command("mark-read <conversation>").option("--through <ref|timestamp>", "default: latest message").option("--apply").action(async (selector, options, command) => { let parsedThrough: ReturnType<typeof parseMessageRef> | undefined; if (options.through && !/^\d+\.\d{6}$/.test(options.through)) parsedThrough = parseMessageRef(options.through); const ctx = await context(app, command); const target = await resolveConversationFor(selector, ctx); let ts: string; if (options.through) { if (parsedThrough) { const ref = parseMessageRef(options.through, ctx.profile.team_id); if (ref.conversationId !== target.id) throw new AxiError({ code: "MARK_TARGET_MISMATCH", message: "--through and conversation differ.", exitCode: 2 }); ts = ref.ts; } else ts = options.through; } else { const latest = await ctx.public.history({ channel: target.id, oldest: "0", latest: String(Date.now() / 1000), limit: 1 }); ts = String(latest.items[0]?.ts ?? ""); if (!ts) throw new AxiError({ code: "EMPTY_CONVERSATION", message: "The conversation has no message to mark as read." }); } const action = await directOrStage(app, ctx, { operation: "mark-read", targetIds: [target.id], conversationId: target.id, preview: { conversation_id: target.id, through: ts }, payload: { conversation_id: target.id, ts }, apply: Boolean(options.apply) }); emit(command, workspaceEnvelope(ctx, "mark-read", actionOutput(action))); });

  const later = program.command("later");
  later.command("list").action(async (_options, command) => {
    const limit = ensureLimit(globals(command).limit ?? 20, 50);
    const selectedProfile = await app.config.resolve(globals(command).workspace);
    if (selectedProfile.kind !== "browser") {
      throw new AxiError({
        code: "BROWSER_CAPABILITY_UNAVAILABLE",
        message: "Later requires browser-session authentication.",
        suggestedCommand: `slack-axi auth add ${shellArgument(selectedProfile.alias)} --from-stdin`,
      });
    }
    const ctx = await context(app, command);
    if (!ctx.browser) {
      throw new AxiError({
        code: "BROWSER_CAPABILITY_UNAVAILABLE",
        message: "Later requires browser-session authentication.",
        suggestedCommand: `slack-axi auth add ${shellArgument(ctx.profile.alias)} --from-stdin`,
      });
    }
    const filter = "saved";
    const restart = `slack-axi later list ${liveRestartOptions(ctx, command)}`;
    const binding = liveCursorBinding([ctx.profile.team_id, ctx.profile.actor_id, ctx.snapshot.credential_generation, filter]);
    const continuation = await parseLiveCursor(globals(command).cursor, "later.list", binding, restart, app.actions);
    const result = await ctx.browser.laterList(continuation.backendCursor, limit, filter);
    const items = result.items.map((item) => ({
      item_id: item.item_id,
      item_type: item.item_type,
      ts: item.ts,
      state: item.state,
      date_due: item.date_due,
      date_completed: item.date_completed,
      is_archived: item.is_archived,
      ref: `${ctx.profile.team_id}/${item.item_id}/${item.ts}`,
    }));
    const scanned = continuation.scanned + items.length;
    const observedTotal = result.counts?.uncompleted_count;
    const authoritativeTotal = continuation.authoritativeTotal ?? observedTotal;
    const countDrift = (continuation.authoritativeTotal !== undefined && observedTotal !== undefined && observedTotal !== continuation.authoritativeTotal)
      || (observedTotal !== undefined && observedTotal < scanned)
      || (authoritativeTotal !== undefined && authoritativeTotal < scanned);
    const next = result.next && !countDrift
      ? await createLiveCursor("later.list", binding, result.next, scanned, app.actions, authoritativeTotal)
      : undefined;
    const total = authoritativeTotal ?? scanned;
    const providerOmitted = !countDrift && !next && authoritativeTotal !== undefined && scanned < authoritativeTotal;
    const retryLimit = providerOmitted ? Math.min(50, authoritativeTotal) : limit;
    const retry = providerOmitted && retryLimit > limit
      ? `slack-axi later list --limit ${retryLimit}${globals(command).fields ? ` --fields ${shellArgument(globals(command).fields!)}` : ""} --workspace ${shellArgument(ctx.profile.alias)}`
      : undefined;
    const hints = countDrift
      ? [{ command: restart, reason: "Restart this Later scan because Slack's total changed during pagination." }]
      : next
        ? [{ command: `${restart} --cursor ${next}`, reason: "Continue the same Later scan." }]
        : retry
          ? [{ command: retry, reason: "Retry the same Later scan with a larger bound because Slack reported omitted items without a continuation cursor." }]
          : undefined;
    const complete = !countDrift && !next && !providerOmitted;
    emit(command, workspaceEnvelope(ctx, "later.list", {
      capability: "browser_private_best_effort",
      count: items.length,
      counts: result.counts,
      ...(countDrift ? { pagination_count_drift: { initial_total: continuation.authoritativeTotal ?? null, observed_total: observedTotal ?? null, cumulative_scanned: scanned } } : {}),
      items,
    }, {
      page: { shown: items.length, complete, source_complete: complete, total: countDrift ? scanned : total, total_kind: countDrift ? "scanned" : authoritativeTotal === undefined && next ? "scanned" : "exact", ...(next ? { next_cursor: next } : {}), ...(providerOmitted ? { omitted: total - scanned } : {}) },
      ...(countDrift ? { coverage: { requested: continuation.authoritativeTotal ?? observedTotal ?? scanned, scanned, failed: 0, complete: false, reason: "Slack's Later total changed during pagination; the current continuation can no longer prove complete coverage." } } : {}),
      ...(!countDrift && providerOmitted ? { coverage: { requested: total, scanned, failed: 0, complete: false, reason: "Slack reported more Later items than it returned and supplied no continuation cursor." } } : {}),
      ...(hints ? { hints } : {}),
    }));
  });
  later.command("complete <ref>").option("--apply").action(async (input, options, command) => {
    parseMessageRef(input);
    const selectedProfile = await app.config.resolve(globals(command).workspace);
    if (selectedProfile.kind !== "browser") throw new AxiError({ code: "BROWSER_CAPABILITY_UNAVAILABLE", message: "Later requires browser-session authentication.", suggestedCommand: `slack-axi auth add ${shellArgument(selectedProfile.alias)} --from-stdin` });
    const ctx = await context(app, command);
    if (!ctx.browser) throw new AxiError({ code: "BROWSER_CAPABILITY_UNAVAILABLE", message: "Later requires browser-session authentication.", suggestedCommand: `slack-axi auth add ${shellArgument(ctx.profile.alias)} --from-stdin` });
    const ref = parseMessageRef(input, ctx.profile.team_id);
    const action = await directOrStage(app, ctx, { operation: "later.complete", targetIds: [ref.conversationId, ref.ts], conversationId: ref.conversationId, preview: { ref: `${ctx.profile.team_id}/${ref.conversationId}/${ref.ts}`, item_id: ref.conversationId, ts: ref.ts, capability: "browser_private_best_effort" }, payload: { item_id: ref.conversationId, ts: ref.ts }, apply: Boolean(options.apply) });
    emit(command, workspaceEnvelope(ctx, "later.complete", actionOutput(action)));
  });
  later.command("snooze <ref>").requiredOption("--until <timestamp>").option("--apply").action(async (input, options, command) => {
    parseMessageRef(input);
    const remindAt = parseFutureInstant(options.until);
    const selectedProfile = await app.config.resolve(globals(command).workspace);
    if (selectedProfile.kind !== "browser") throw new AxiError({ code: "BROWSER_CAPABILITY_UNAVAILABLE", message: "Later requires browser-session authentication.", suggestedCommand: `slack-axi auth add ${shellArgument(selectedProfile.alias)} --from-stdin` });
    const ctx = await context(app, command);
    if (!ctx.browser) throw new AxiError({ code: "BROWSER_CAPABILITY_UNAVAILABLE", message: "Later requires browser-session authentication.", suggestedCommand: `slack-axi auth add ${shellArgument(ctx.profile.alias)} --from-stdin` });
    const ref = parseMessageRef(input, ctx.profile.team_id);
    const action = await directOrStage(app, ctx, { operation: "later.snooze", targetIds: [ref.conversationId, ref.ts], conversationId: ref.conversationId, preview: { ref: `${ctx.profile.team_id}/${ref.conversationId}/${ref.ts}`, item_id: ref.conversationId, ts: ref.ts, remind_at: new Date(remindAt).toISOString(), capability: "browser_private_best_effort" }, payload: { item_id: ref.conversationId, ts: ref.ts, remind_at: Math.floor(remindAt / 1000) }, apply: Boolean(options.apply) });
    emit(command, workspaceEnvelope(ctx, "later.snooze", actionOutput(action)));
  });

  const policy = program.command("policy");
  policy.command("init").action(async (_options, command) => { const value = await app.policy.init(); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "policy.init" }, data: { policy: value } }); });
  policy.command("show").action(async (_options, command) => { const value = await app.policy.load(); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "policy.show" }, data: { policy: value } }); });
  policy.command("validate [file]").action(async (filename, _options, command) => { let value: unknown; try { value = filename ? JSON.parse(await readFile(filename, "utf8")) : await app.policy.load(); } catch (cause) { throw new AxiError({ code: "POLICY_INVALID", message: "The policy file is not valid readable JSON.", exitCode: 2, cause }); } const parsed = app.policy.validate(value); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "policy.validate" }, data: { valid: true, policy: parsed } }); });
  policy.command("apply <file>").option("--project", "replace the current-directory narrowing policy").action(async (filename, options, command) => { let value: unknown; try { value = JSON.parse(await readFile(filename, "utf8")); } catch (cause) { throw new AxiError({ code: "POLICY_INVALID", message: "The policy file is not valid readable JSON.", exitCode: 2, cause }); } const scope = options.project ? "project" : "global"; const parsed = await app.policy.replace(value, scope); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "policy.apply", policy_scope: scope }, data: { applied: true, policy: parsed } }); });

  const action = program.command("action");
  action.command("list").action(async (_options, command) => { const items = await app.actions.list(); const limit = ensureLimit(globals(command).limit ?? 20); const totals = items.reduce<Record<string, number>>((result, item) => { result[item.state] = (result[item.state] ?? 0) + 1; return result; }, {}); const selected = items.slice(0, limit); const rows = expandsFields(command) ? selected.map(({ payload: _payload, preview: _preview, upload_snapshot: _snapshot, approval: _approval, ...item }) => item) : selected.map(({ id, operation, state, created_at, expires_at }) => ({ id, operation, state, created_at, expires_at })); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "action.list" }, data: { count: items.length, totals_by_state: totals, actions: rows }, page: { shown: selected.length, complete: items.length <= limit, source_complete: true, total: items.length, total_kind: "exact", ...(items.length > limit ? { omitted: items.length - limit } : {}) } }); });
  action.command("show <id>").action(async (id, _options, command) => { const value = await app.actions.get(id); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "action.show" }, data: actionOutput(value) }); });
  action.command("apply <id>").requiredOption("--approval <base64url-hmac>", "signed plan approval", approvalToken).action(async (id, options, command) => { const value = await app.actions.get(id); const result = await applyAction(app, value, options.approval, globals(command).workspace); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "action.apply" }, data: actionOutput(result) }); });
  action.command("reconcile <id>").action(async (id, _options, command) => { const value = await app.actions.get(id); const result = await reconcileAction(app, value, globals(command).workspace); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "action.reconcile" }, data: actionOutput(result) }); });
  action.command("abandon <id>").requiredOption("--approval <base64url-hmac>", "signed plan approval", approvalToken).action(async (id, options, command) => { const result = await app.actions.abandon(id, options.approval); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "action.abandon" }, data: actionOutput(result) }); });
  action.command("delete <id>").requiredOption("--force-unverified", "delete without signature verification").action(async (id, _options, command) => { await app.actions.deleteUnverified(id); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "action.delete" }, data: { deleted: id, verification_bypassed: true } }); });
  action.command("gc").option("--retention-days <n>", "terminal action retention (default: 30)", positiveInteger, 30).action(async (options, command) => { const result = await app.actions.gc(options.retentionDays); emit(command, { schema: "slack-axi/v1", ok: true, scope: { command: "action.gc", retention_days: options.retentionDays }, data: result }); });

  decorateHelp(program);
  installExitOverrides(program);
  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version"].includes(error.code)) return;
    const key = error instanceof CommanderError ? (error as OriginCommanderError).axiCommandKey ?? "" : "";
    const normalized = error instanceof CommanderError
      ? new AxiError({
        code: "USAGE_ERROR",
        message: error.code === "commander.help" || error.message === "(outputHelp)"
          ? `Subcommand required for '${key || "slack-axi"}'.`
          : error.message.replace(/^error:\s*/i, ""),
        exitCode: 2,
        suggestedCommand: `slack-axi${key ? ` ${key}` : ""} --help`,
      })
      : error;
    const { envelope, exitCode } = toErrorEnvelope(normalized);
    const rawFormat = argv.find((value, index) => argv[index - 1] === "--output");
    const format: OutputFormat = rawFormat === "json" || rawFormat === "jsonl" ? rawFormat : "toon";
    process.stdout.write(serialize(envelope, format));
    if (argv.includes("--verbose")) process.stderr.write(`${redact(error instanceof Error ? error.stack ?? error.message : String(error))}\n`);
    process.exitCode = exitCode;
  }
}
