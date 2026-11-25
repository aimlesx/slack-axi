import { z } from "zod";
import type { CursorIntegrity } from "./cache.js";
import { SlkyError } from "./errors.js";
import { createMessageRef } from "./refs.js";
import type { SlackRequestBudget } from "./request-budget.js";
import type { PublicSlackClient } from "./slack-public.js";
import { slackTimestampMicros } from "./time.js";
import type { Message } from "./types.js";

const timestamp = z.string().regex(/^\d{10,14}\.\d{6}$/);
const backendCursor = z.string().min(1).max(2048);
const pendingThread = z.object({
  root: timestamp,
  cursor: backendCursor.optional(),
  last_reply: timestamp.optional(),
}).strict();
const failure = z.object({ root: timestamp, code: z.string().max(100) }).strict();
const continuation = z.object({
  v: z.literal(1),
  kind: z.literal("read-with-threads"),
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  history_cursor: backendCursor.optional(),
  history_done: z.boolean(),
  last_parent: timestamp.optional(),
  pending: z.array(pendingThread).max(100),
  emitted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failure_sample: z.array(failure).max(5),
}).strict();
const signedContinuation = continuation.extend({ signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

type State = z.infer<typeof continuation>;
type Thread = { root_ref: string; status: "complete" | "empty" | "failed" | "deferred"; replies: Message[]; code?: string };
type RawMessage = Record<string, unknown>;
type ProviderPage = Awaited<ReturnType<PublicSlackClient["history"]>>;

interface ReadOptions {
  client: PublicSlackClient;
  teamId: string;
  channel: string;
  oldest: string;
  latest: string;
  limit: number;
  budget: SlackRequestBudget;
  token?: string;
  binding: string;
  restart: string;
  integrity: CursorIntegrity;
  normalize: (message: RawMessage) => Message;
}

async function readState(options: ReadOptions): Promise<State> {
  if (!options.token) return {
    v: 1, kind: "read-with-threads", binding: options.binding, history_done: false, pending: [], emitted: 0, failed: 0, failure_sample: [],
  };
  const invalid = (code: string, message: string) => new SlkyError({ code, message, exitCode: 2, suggestedCommand: options.restart });
  let value: z.infer<typeof signedContinuation>;
  try {
    if (options.token.length > 32_768) throw new Error("Cursor exceeds size limit");
    value = signedContinuation.parse(JSON.parse(Buffer.from(options.token, "base64url").toString("utf8")));
  } catch {
    throw invalid("CURSOR_INVALID", "The expanded read cursor is malformed or belongs to another command.");
  }
  const { signature, ...state } = value;
  if (!await options.integrity.verifyCursor(state, signature)) throw invalid("CURSOR_INVALID", "The expanded read cursor failed integrity verification.");
  if (state.binding !== options.binding) throw invalid("CURSOR_STALE", "The expanded read cursor belongs to a different workspace, identity, conversation or window.");
  return state;
}

function compareTimestamps(left: string, right: string): number {
  const a = slackTimestampMicros(left)!;
  const b = slackTimestampMicros(right)!;
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedInWindow(page: ProviderPage, previous: string | undefined, limit: number, options: ReadOptions, direction: 1 | -1) {
  if (page.items.length > limit || (!page.complete && !page.next)
    || (page.next && (page.next === previous || !backendCursor.safeParse(page.next).success))) {
    throw new SlkyError({ code: "SLACK_RESPONSE_INVALID", message: "Slack returned a page that exceeds the requested limit or cannot advance its cursor." });
  }
  const messages = page.items.map((raw) => {
    const ts = timestamp.safeParse(raw.ts);
    if (!ts.success) throw new SlkyError({ code: "SLACK_RESPONSE_INVALID", message: "Slack returned a message with an invalid timestamp." });
    return { raw, ts: ts.data };
  });
  return messages
    .filter(({ ts }) => compareTimestamps(ts, options.oldest) >= 0 && compareTimestamps(ts, options.latest) < 0)
    .sort((a, b) => direction * compareTimestamps(a.ts, b.ts));
}

export async function readWithThreads(options: ReadOptions) {
  const state = await readState(options);
  const parents: Message[] = [];
  const threads = new Map<string, Thread>();
  const rootRef = (ts: string) => createMessageRef(options.teamId, options.channel, ts);
  let shown = 0;
  let historyFailure: string | undefined;
  while (shown < options.limit && options.budget.used < options.budget.limit) {
    const available = options.limit - shown;
    const pending = state.pending[0];
    if (pending) {
      const row = threads.get(pending.root) ?? { root_ref: rootRef(pending.root), status: "deferred", replies: [] };
      threads.set(pending.root, row);
      try {
        const result = await options.client.replies({
          channel: options.channel,
          ts: pending.root,
          limit: available,
          range: { oldest: options.oldest, latest: options.latest },
          ...(pending.cursor ? { cursor: pending.cursor } : {}),
        });
        for (const { raw, ts } of sortedInWindow(result, pending.cursor, available, options, 1)) {
          if (compareTimestamps(ts, pending.last_reply ?? pending.root) <= 0) continue;
          row.replies.push(options.normalize(raw));
          pending.last_reply = ts;
          shown += 1;
        }
        if (result.next) {
          pending.cursor = result.next;
        } else {
          row.status = pending.last_reply ? "complete" : "empty";
          state.pending.shift();
        }
      } catch (error) {
        row.status = "failed";
        row.code = error instanceof SlkyError ? error.code : "SLACK_API_ERROR";
        state.failed += 1;
        if (state.failure_sample.length < 5) state.failure_sample.push({ root: pending.root, code: row.code });
        state.pending.shift();
      }
      continue;
    }
    if (state.history_done) break;
    try {
      const result = await options.client.history({
        channel: options.channel,
        oldest: options.oldest,
        latest: options.latest,
        limit: available,
        ...(state.history_cursor ? { cursor: state.history_cursor } : {}),
      });
      for (const { raw, ts } of sortedInWindow(result, state.history_cursor, available, options, -1)) {
        if (state.last_parent && compareTimestamps(ts, state.last_parent) >= 0) continue;
        if (raw.subtype === "thread_broadcast" || raw.subtype === "reply_broadcast" || (typeof raw.thread_ts === "string" && raw.thread_ts !== ts)) continue;
        parents.push(options.normalize(raw));
        state.last_parent = ts;
        shown += 1;
        const threadKnown = raw.thread_ts === ts || (typeof raw.reply_count === "number" && raw.reply_count > 0);
        if (!threadKnown || raw.reply_count === 0 || raw.subtype === "channel_join" || raw.subtype === "channel_leave") {
          threads.set(ts, { root_ref: rootRef(ts), status: "empty", replies: [] });
        } else {
          state.pending.push({ root: ts });
          threads.set(ts, { root_ref: rootRef(ts), status: "deferred", replies: [] });
        }
      }
      state.history_cursor = result.next;
      state.history_done = result.complete && !result.next;
    } catch (error) {
      if (!shown && !state.emitted) throw error;
      historyFailure = error instanceof SlkyError ? error.code : "SLACK_API_ERROR";
      break;
    }
  }
  state.emitted += shown;
  const more = !state.history_done || state.pending.length > 0;
  const next = more
    ? Buffer.from(JSON.stringify({ ...state, signature: await options.integrity.signCursor(state) })).toString("base64url")
    : undefined;
  return {
    parents,
    threads: [...threads.values()],
    shown,
    emitted: state.emitted,
    historyComplete: state.history_done,
    pendingThreads: state.pending.length,
    failedThreads: state.failed,
    failureSample: state.failure_sample.map(({ root, code }) => ({ root_ref: rootRef(root), code })),
    historyFailure,
    next,
  };
}
