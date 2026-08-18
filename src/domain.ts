import { AxiError } from "./errors.js";
import { createMessageRef } from "./refs.js";
import { slackArray, slackRecord } from "./slack-public.js";
import type { CacheSnapshot } from "./cache.js";
import type { Conversation, Message, User } from "./types.js";

function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function bool(value: unknown): boolean { return value === true; }
function number(value: unknown): number { return typeof value === "number" ? value : Number(value ?? 0); }

export function normalizeConversation(raw: Record<string, unknown>): Conversation {
  const isIm = bool(raw.is_im);
  const isMpim = bool(raw.is_mpim);
  const isGroup = bool(raw.is_group);
  const type = isIm ? "dm" : isMpim ? "group_dm" : isGroup ? "group" : "channel";
  const topic = text(slackRecord(raw.topic).value);
  const purpose = text(slackRecord(raw.purpose).value);
  return {
    id: text(raw.id),
    name: text(raw.name, isIm ? text(raw.user, text(raw.id)) : text(raw.id)),
    type,
    is_private: bool(raw.is_private) || isIm || isMpim || isGroup,
    is_member: raw.is_member !== false,
    is_archived: bool(raw.is_archived),
    ...(typeof raw.is_ext_shared === "boolean" ? { is_external: raw.is_ext_shared } : {}),
    ...(topic ? { topic } : {}),
    ...(purpose ? { purpose } : {}),
    ...(typeof raw.user === "string" ? { member_ids: [raw.user] } : {}),
  };
}

export function normalizeUser(raw: Record<string, unknown>): User {
  const profile = slackRecord(raw.profile);
  return {
    id: text(raw.id),
    name: text(raw.name),
    display_name: text(profile.display_name, text(raw.name)),
    real_name: text(profile.real_name, text(raw.real_name, text(raw.name))),
    ...(typeof profile.email === "string" ? { email: profile.email } : {}),
    ...(typeof raw.tz === "string" ? { timezone: raw.tz } : {}),
    is_bot: bool(raw.is_bot),
    deleted: bool(raw.deleted),
  };
}

export function truncateText(value: string, full: boolean, maximum = 600): { text: string; text_chars: number; text_truncated: boolean } {
  const chars = Array.from(value);
  return { text: full || chars.length <= maximum ? value : `${chars.slice(0, maximum).join("")}…`, text_chars: chars.length, text_truncated: !full && chars.length > maximum };
}

export function normalizeMessage(raw: Record<string, unknown>, teamId: string, conversationId: string, users: Map<string, User>, full = false, actorId?: string): Message {
  const ts = text(raw.ts);
  if (!ts) throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "Slack returned a message without a timestamp." });
  const authorId = text(raw.user, text(raw.bot_id));
  const messageText = truncateText(text(raw.text), full);
  const replyCount = number(raw.reply_count);
  const replyUsers = Array.isArray(raw.reply_users) ? raw.reply_users.filter((id): id is string => typeof id === "string") : [];
  return {
    ref: createMessageRef(teamId, conversationId, ts),
    conversation_id: conversationId,
    ts,
    time: new Date(Number(ts.split(".")[0]) * 1000).toISOString(),
    ...(authorId ? { author_id: authorId, author: users.get(authorId)?.display_name || users.get(authorId)?.real_name || authorId } : {}),
    ...messageText,
    ...(replyCount > 0 ? { thread: { ref: createMessageRef(teamId, conversationId, text(raw.thread_ts, ts)), replies: replyCount, participant_ids: replyUsers, ...(typeof raw.latest_reply === "string" ? { last_reply: new Date(Number(raw.latest_reply.split(".")[0]) * 1000).toISOString() } : {}) } } : {}),
    ...(Array.isArray(raw.files) ? { files: slackArray(raw.files).map((file) => ({ id: text(file.id), name: text(file.name, text(file.title)), ...(typeof file.mimetype === "string" ? { mimetype: file.mimetype } : {}), ...(typeof file.size === "number" ? { size: file.size } : {}) })) } : {}),
    ...(Array.isArray(raw.reactions) ? { reactions: slackArray(raw.reactions).map((reaction) => ({ name: text(reaction.name), count: number(reaction.count), mine: Boolean(actorId && Array.isArray(reaction.users) && reaction.users.includes(actorId)) })) } : {}),
    ...(typeof raw.permalink === "string" ? { permalink: raw.permalink } : {}),
    ...(typeof raw.client_msg_id === "string" ? { client_msg_id: raw.client_msg_id } : {}),
  };
}

export function entityMaps(snapshot: CacheSnapshot): { conversations: Conversation[]; users: User[]; userMap: Map<string, User> } {
  const users = snapshot.users.map(normalizeUser);
  return { conversations: snapshot.conversations.map(normalizeConversation), users, userMap: new Map(users.map((user) => [user.id, user])) };
}

export function resolveUser(selector: string, users: User[], sourceComplete = true, syncCommand = "slack-axi sync --all --max-pages 100"): User {
  const needle = selector.replace(/^@/, "").toLowerCase();
  // Slack IDs and handles are stable/unique selectors. Human-facing names and
  // email are not safe to treat as unique until the user source is complete.
  const stableExact = users.filter((user) => [user.id, user.name].some((value) => value.toLowerCase() === needle));
  if (stableExact.length === 1) return stableExact[0]!;
  if (stableExact.length > 1) throw new AxiError({ code: "USER_AMBIGUOUS", message: `User '${selector}' is ambiguous.`, exitCode: 2, candidates: stableExact.slice(0, 10).map(({ id, name, display_name, real_name }) => ({ id, name, display_name, real_name })) });
  const humanExact = users.filter((user) => [user.display_name, user.real_name, user.email].filter(Boolean).some((value) => String(value).toLowerCase() === needle));
  if (!sourceComplete) throw new AxiError({ code: "RESOLUTION_INCOMPLETE", message: `User '${selector}' cannot be resolved conclusively from the incomplete user cache.`, suggestedCommand: syncCommand });
  if (humanExact.length === 1) return humanExact[0]!;
  if (humanExact.length > 1) throw new AxiError({ code: "USER_AMBIGUOUS", message: `User '${selector}' is ambiguous.`, exitCode: 2, candidates: humanExact.slice(0, 10).map(({ id, name, display_name, real_name }) => ({ id, name, display_name, real_name })) });
  const partial = users.filter((user) => [user.name, user.display_name, user.real_name, user.email].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
  const matches = partial;
  if (matches.length !== 1) throw new AxiError({ code: matches.length ? "USER_AMBIGUOUS" : "USER_NOT_FOUND", message: matches.length ? `User '${selector}' is ambiguous.` : `User '${selector}' was not found.`, exitCode: 2, candidates: matches.slice(0, 10).map(({ id, name, display_name, real_name }) => ({ id, name, display_name, real_name })) });
  return matches[0]!;
}

export function resolveConversation(selector: string, conversations: Conversation[], users: User[], sourceComplete = true, usersComplete = true, syncCommand = "slack-axi sync --all --max-pages 100"): Conversation {
  if (selector.startsWith("@")) {
    const user = resolveUser(selector, users, usersComplete, syncCommand);
    const matches = conversations.filter((conversation) => conversation.type === "dm" && conversation.member_ids?.includes(user.id));
    if (matches.length === 1) return matches[0]!;
    if (!sourceComplete) throw new AxiError({ code: "RESOLUTION_INCOMPLETE", message: `A DM for ${selector} cannot be ruled out because the conversation cache is incomplete.`, suggestedCommand: syncCommand });
    throw new AxiError({ code: "DM_NOT_FOUND", message: `No existing DM conversation was found for ${selector}.`, details: { user_id: user.id } });
  }
  const needle = selector.replace(/^#/, "").toLowerCase();
  const matches = conversations.filter((conversation) => conversation.id === selector || conversation.name.toLowerCase() === needle);
  if (matches.length === 0 && !sourceComplete) throw new AxiError({ code: "RESOLUTION_INCOMPLETE", message: `Conversation '${selector}' cannot be resolved conclusively from the incomplete conversation cache.`, suggestedCommand: syncCommand });
  if (matches.length !== 1) throw new AxiError({ code: matches.length ? "CONVERSATION_AMBIGUOUS" : "CONVERSATION_NOT_FOUND", message: matches.length ? `Conversation '${selector}' is ambiguous.` : `Conversation '${selector}' was not found.`, exitCode: 2, candidates: matches.map(({ id, name, type }) => ({ id, name, type })) });
  return matches[0]!;
}

export function normalizeFile(raw: Record<string, unknown>, full = false): Record<string, unknown> {
  const description = truncateText(text(raw.description, text(raw.title)), full);
  return {
    id: text(raw.id),
    name: text(raw.name, text(raw.title)),
    ...(typeof raw.mimetype === "string" ? { mimetype: raw.mimetype } : {}),
    ...(typeof raw.size === "number" ? { size: raw.size } : {}),
    ...(typeof raw.timestamp === "number" ? { timestamp: new Date(raw.timestamp * 1000).toISOString() } : {}),
    ...(typeof raw.user === "string" ? { user_id: raw.user } : {}),
    ...(typeof raw.permalink === "string" ? { permalink: raw.permalink } : {}),
    ...(description.text ? { description: description.text, description_chars: description.text_chars, description_truncated: description.text_truncated } : {}),
    ...(typeof raw.url_private_download === "string" ? { url_private_download: raw.url_private_download } : {}),
  };
}

export function normalizeUsergroup(raw: Record<string, unknown>, full = false): Record<string, unknown> {
  const description = truncateText(text(raw.description), full);
  return {
    id: text(raw.id),
    handle: text(raw.handle),
    name: text(raw.name),
    ...(description.text ? { description: description.text, description_chars: description.text_chars, description_truncated: description.text_truncated } : {}),
    ...(typeof raw.date_update === "number" ? { date_update: new Date(raw.date_update * 1000).toISOString() } : {}),
  };
}
