import { randomUUID } from "node:crypto";
import { AxiError, redact } from "./errors.js";
import { normalizeMessage } from "./domain.js";
import { assertLiveActionIdentity } from "./identity.js";
import { validateSlackMessageText } from "./message-text.js";
import { broadcastMentions, validateBroadcastMentions } from "./policy.js";
import { createMessageRef } from "./refs.js";
import { slackRecord } from "./slack-public.js";
import type { SlackAxiApp, WorkspaceContext } from "./app.js";
import type { ActionPlan } from "./types.js";

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `The verified action payload is missing '${key}'.` });
  return value;
}

function requiredPositiveSafeInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: `The verified action payload has an invalid '${key}'.` });
  }
  return Number(value);
}

function recoveryFor(action: ActionPlan): Record<string, unknown> {
  const payload = action.payload ?? {};
  const existing = slackRecord(action.result?.recovery);
  const compact = (value: Record<string, unknown>): Record<string, unknown> => ({ ...existing, ...Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) });
  switch (action.operation) {
    case "message.send":
    case "message.reply":
      return compact({
        conversation_id: payload.conversation_id,
        user_id: payload.user_id,
        client_msg_id: payload.client_msg_id,
        thread_ts: payload.thread_ts,
      });
    case "reaction.add":
    case "reaction.remove":
      return compact({ conversation_id: payload.conversation_id, ts: payload.ts, name: payload.name, ref: payload.ref });
    case "mark-read":
      return compact({ conversation_id: payload.conversation_id, ts: payload.ts });
    case "later.complete":
    case "later.snooze":
      return compact({ item_id: payload.item_id, ts: payload.ts, remind_at: payload.remind_at });
    case "auth.revoke":
      return compact({ team_id: payload.team_id });
    case "file.upload":
      return compact({ conversation_id: payload.conversation_id, thread_ts: payload.thread_ts, snapshot_hash: payload.snapshot_hash });
    default:
      return existing;
  }
}

function recovery(action: ActionPlan): Record<string, unknown> {
  return slackRecord(action.result?.recovery);
}

function authoritativeRejection(error: AxiError): boolean {
  // An explicit uncertain classification must win over a broad error-code
  // category because transport errors can happen on either side of commit.
  if (error.details?.dispatch_uncertain === true) return false;
  if (error.details?.dispatch_uncertain === false) return true;
  return new Set([
    "AUTH_INVALID",
    "SLACK_PERMISSION_DENIED",
    "RATE_LIMITED",
    "CREDENTIAL_MISSING",
    "INVALID_ARGUMENT",
  ]).has(error.code);
}

function uncertainAfterDispatch(error: AxiError): boolean {
  return error.code === "ACTION_COMMIT_UNKNOWN" || error.details?.dispatch_uncertain === true || new Set([
    "REQUEST_TIMEOUT",
    "SLACK_NETWORK_ERROR",
    "SLACK_HTTP_ERROR",
    "SLACK_RESPONSE_INVALID",
  ]).has(error.code);
}

async function withLeasedActionContext<T>(
  app: SlackAxiApp,
  selector: string,
  operation: (context: WorkspaceContext) => Promise<T>,
): Promise<T> {
  // Keep lightweight test/reference app doubles working while ensuring the
  // production SlackAxiApp holds the credential-generation lease.
  const leased = (app as unknown as {
    withContextLease?: <Value>(selector: string | undefined, operation: (context: WorkspaceContext) => Promise<Value>) => Promise<Value>;
  }).withContextLease;
  return typeof leased === "function"
    ? leased.call(app, selector, operation) as Promise<T>
    : operation(await app.context(selector));
}

interface OperationExecution {
  action: ActionPlan;
  providerAcknowledged: boolean;
  uploadSnapshotDescriptorBound: boolean;
}

interface DirectApplyRequest {
  conversationId: string;
}

interface DirectPolicyAuthorization extends DirectApplyRequest {
  requiresBroadcast: boolean;
}

async function providerAcknowledged<T>(execution: OperationExecution, operation: () => Promise<T>): Promise<T> {
  const result = await operation();
  // From this point onward, no local validation, normalization, or persistence
  // error can prove that Slack did not commit the write.
  execution.providerAcknowledged = true;
  return result;
}

function actionRequiresBroadcast(action: ActionPlan): boolean {
  const payload = action.payload ?? {};
  const text = action.operation === "file.upload" ? payload.initial_comment : payload.text;
  return typeof text === "string" && broadcastMentions(text).length > 0;
}

function actionRequiresUnfurlPolicy(action: ActionPlan): boolean {
  const payload = action.payload ?? {};
  return ["message.send", "message.reply"].includes(action.operation)
    && typeof payload.text === "string"
    && (payload.unfurl_links === true || payload.unfurl_media === true);
}

async function withUnfurlPolicyLease<T>(app: SlackAxiApp, action: ActionPlan, operation: () => Promise<T>): Promise<T> {
  const payload = action.payload ?? {};
  const leased = (app.policy as unknown as {
    withUnfurlApplyLease?: <Value>(text: string, callback: () => Promise<Value>) => Promise<Value>;
  }).withUnfurlApplyLease;
  return typeof leased === "function"
    ? leased.call(app.policy, requiredString(payload, "text"), operation) as Promise<T>
    : operation();
}

async function withDirectPolicyLease<T>(
  app: SlackAxiApp,
  action: ActionPlan,
  authorization: DirectPolicyAuthorization,
  operation: () => Promise<T>,
): Promise<T> {
  const suggestedCommand = applyCommand(action);
  const leased = (app.policy as unknown as {
    withDirectApplyLease?: <Value>(input: {
      operation: string;
      conversationId: string;
      requiresBroadcast: boolean;
      suggestedCommand?: string;
    }, callback: () => Promise<Value>) => Promise<Value>;
  }).withDirectApplyLease;
  if (typeof leased === "function") {
    return leased.call(app.policy, {
      operation: action.operation,
      conversationId: authorization.conversationId,
      requiresBroadcast: authorization.requiresBroadcast,
      suggestedCommand,
    }, operation) as Promise<T>;
  }
  // Lightweight reference/test doubles do not own persistent policy state.
  // Production always uses PolicyStore.withDirectApplyLease above.
  if (!(await app.policy.allows(action.operation, authorization.conversationId, authorization.requiresBroadcast))) {
    throw new AxiError({ code: "POLICY_DENIED", message: "Direct apply is not allowed for this operation and conversation.", suggestedCommand });
  }
  return operation();
}

export async function stageAction(app: SlackAxiApp, context: WorkspaceContext, input: {
  operation: string;
  targetIds: string[];
  preview: Record<string, unknown>;
  payload: Record<string, unknown>;
  uploadPath?: string;
  uploadMaxBytes?: number;
}): Promise<ActionPlan> {
  if (["message.send", "message.reply"].includes(input.operation) && typeof input.payload.text === "string") {
    validateSlackMessageText(input.payload.text);
    validateBroadcastMentions(input.payload.text, input.payload.allow_broadcast_mentions === true);
    await app.policy.validateUnfurls(input.payload.text, input.payload.unfurl_links === true || input.payload.unfurl_media === true);
  }
  if (input.operation === "file.upload" && typeof input.payload.initial_comment === "string") {
    validateSlackMessageText(input.payload.initial_comment, "File comment");
    validateBroadcastMentions(input.payload.initial_comment, input.payload.allow_broadcast_mentions === true);
    await app.policy.validateUploadComment(input.payload.initial_comment);
  }
  const availability = (app.config as unknown as { assertWorkspaceAvailable?: (teamId: string) => Promise<void> } | undefined)?.assertWorkspaceAvailable;
  return app.actions.create({
      workspace_id: context.profile.team_id,
      actor_id: context.profile.actor_id,
      operation: input.operation,
      target_ids: input.targetIds,
      preview: input.preview,
      payload: input.payload,
      ...(input.uploadPath ? { upload_path: input.uploadPath } : {}),
      ...(input.uploadMaxBytes === undefined ? {} : { upload_max_bytes: input.uploadMaxBytes }),
      assertWorkspaceAvailable: typeof availability === "function"
        ? () => availability.call(app.config, context.profile.team_id)
        : async () => undefined,
    });
}

export function applyCommand(action: ActionPlan): string {
  return `slack-axi action apply ${action.id} --approval ${action.approval}`;
}

async function applyOperation(app: SlackAxiApp, context: WorkspaceContext, execution: OperationExecution): Promise<{ action: ActionPlan; result: Record<string, unknown> }> {
  const payload = execution.action.payload;
  if (!payload) throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The verified action payload is unavailable." });
  switch (execution.action.operation) {
    case "message.send":
    case "message.reply": {
      const text = requiredString(payload, "text");
      validateSlackMessageText(text);
      validateBroadcastMentions(text, payload.allow_broadcast_mentions === true);
      await app.policy?.validateUnfurls(text, payload.unfurl_links === true || payload.unfurl_media === true);
      let conversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : typeof recovery(execution.action).conversation_id === "string" ? String(recovery(execution.action).conversation_id) : undefined;
      if (!conversationId) {
        const userId = requiredString(payload, "user_id");
        conversationId = await providerAcknowledged(execution, () => context.public.openDm(userId));
        execution.action = await app.actions.transitionLocked(execution.action, "partial", { result: { recovery: { ...recoveryFor(execution.action), conversation_id: conversationId } } });
        execution.action = await app.actions.transitionLocked(execution.action, "applying");
        // Opening a DM is an idempotent prerequisite. Once its conversation ID
        // is durable, an authoritative rejection of the subsequent message send
        // is still a proven not-applied message outcome.
        execution.providerAcknowledged = false;
      }
      const clientMsgId = requiredString(payload, "client_msg_id");
      const response = await providerAcknowledged(execution, () => context.public.postMessage({
        channel: conversationId,
        text,
        ...(typeof payload.thread_ts === "string" ? { threadTs: payload.thread_ts } : {}),
        clientMsgId,
        unfurlLinks: payload.unfurl_links === true,
        unfurlMedia: payload.unfurl_media === true,
      }));
      const ts = typeof response.ts === "string" ? response.ts : String(slackRecord(response.message).ts ?? "");
      if (!ts) throw new AxiError({ code: "ACTION_COMMIT_UNKNOWN", message: "Slack returned success without a message timestamp.", details: { dispatch_uncertain: true } });
      const normalized = normalizeMessage({ ...slackRecord(response.message), ts, client_msg_id: clientMsgId }, context.profile.team_id, conversationId, context.userMap, false, context.profile.actor_id);
      // Terminal state is retained for GC/reconciliation, so it must not become
      // a second copy of the sensitive payload that terminal cleanup deleted.
      // Keep only the durable commit identity and non-content metadata.
      const message: Record<string, unknown> = {
        ref: normalized.ref,
        conversation_id: normalized.conversation_id,
        ts: normalized.ts,
        time: normalized.time,
        ...(normalized.author_id ? { author_id: normalized.author_id } : {}),
        ...(normalized.author ? { author: normalized.author } : {}),
        client_msg_id: clientMsgId,
        text_chars: normalized.text_chars,
      };
      const permalink = await context.public.permalink(conversationId, ts).catch(() => undefined);
      if (permalink) message.permalink = permalink;
      return { action: execution.action, result: { message, noop: false } };
    }
    case "reaction.add": {
      const conversationId = requiredString(payload, "conversation_id");
      const ts = requiredString(payload, "ts");
      const name = requiredString(payload, "name");
      const ref = requiredString(payload, "ref");
      const result = await providerAcknowledged(execution, () => context.public.addReaction(conversationId, ts, name));
      return { action: execution.action, result: { ...result, ref, name } };
    }
    case "reaction.remove": {
      const conversationId = requiredString(payload, "conversation_id");
      const ts = requiredString(payload, "ts");
      const name = requiredString(payload, "name");
      const ref = requiredString(payload, "ref");
      const result = await providerAcknowledged(execution, () => context.public.removeReaction(conversationId, ts, name));
      return { action: execution.action, result: { ...result, ref, name } };
    }
    case "mark-read": {
      const conversationId = requiredString(payload, "conversation_id");
      const ts = requiredString(payload, "ts");
      const result = await providerAcknowledged(execution, () => context.public.markRead(conversationId, ts));
      return { action: execution.action, result: { ...result, conversation_id: conversationId, through: ts } };
    }
    case "file.upload": {
      if (!execution.action.upload_snapshot) throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The verified upload snapshot is unavailable." });
      if (typeof payload.initial_comment === "string") {
        validateSlackMessageText(payload.initial_comment, "File comment");
        validateBroadcastMentions(payload.initial_comment, payload.allow_broadcast_mentions === true);
        await app.policy?.validateUploadComment(payload.initial_comment);
      }
      const filename = requiredString(payload, "filename");
      const conversationId = requiredString(payload, "conversation_id");
      const response = await app.actions.withVerifiedUploadSnapshot(execution.action, (snapshot) => {
        execution.uploadSnapshotDescriptorBound = true;
        return providerAcknowledged(execution, () => context.public.uploadFile({ snapshot, displayFilename: filename, channel: conversationId, ...(typeof payload.thread_ts === "string" ? { threadTs: payload.thread_ts } : {}), ...(typeof payload.initial_comment === "string" ? { initialComment: payload.initial_comment } : {}) }));
      });
      return { action: execution.action, result: { upload: response, conversation_id: conversationId, snapshot_hash: payload.snapshot_hash } };
    }
    case "later.complete": {
      if (context.profile.kind !== "browser" || !context.browser) {
        throw new AxiError({
          code: "BROWSER_CAPABILITY_UNAVAILABLE",
          message: "Later requires browser authentication and is a private, best-effort Slack capability.",
        });
      }
      const itemId = requiredString(payload, "item_id");
      const ts = requiredString(payload, "ts");
      await providerAcknowledged(execution, () => context.browser!.laterComplete(itemId, ts));
      return {
        action: execution.action,
        result: { item_id: itemId, ts, completed: true, capability: "browser_private_best_effort", provider_acknowledged: true },
      };
    }
    case "later.snooze": {
      if (context.profile.kind !== "browser" || !context.browser) {
        throw new AxiError({
          code: "BROWSER_CAPABILITY_UNAVAILABLE",
          message: "Later requires browser authentication and is a private, best-effort Slack capability.",
        });
      }
      const itemId = requiredString(payload, "item_id");
      const ts = requiredString(payload, "ts");
      const remindAt = requiredPositiveSafeInteger(payload, "remind_at");
      await providerAcknowledged(execution, () => context.browser!.laterSnooze(itemId, ts, remindAt));
      return {
        action: execution.action,
        result: { item_id: itemId, ts, remind_at: remindAt, snoozed: true, capability: "browser_private_best_effort", provider_acknowledged: true },
      };
    }
    case "auth.revoke": {
      if (context.profile.kind === "browser") {
        throw new AxiError({
          code: "AUTH_REVOCATION_UNSUPPORTED",
          message: "Slack browser sessions cannot be revoked through a supported API. Terminate the session in Slack, then remove the local profile.",
        });
      }
      const result = await providerAcknowledged(execution, () => context.public.revokeToken());
      return { action: execution.action, result: { ...result, team_id: context.profile.team_id, token_revoked: true } };
    }
    default:
      throw new AxiError({ code: "ACTION_OPERATION_UNSUPPORTED", message: `Unsupported action operation '${execution.action.operation}'.` });
  }
}

export async function applyAction(app: SlackAxiApp, requested: ActionPlan, approval: string, workspace?: string, directAuthorization?: DirectApplyRequest): Promise<ActionPlan> {
  return app.actions.withLock(requested.id, async (action) => {
    app.actions.verifyApproval(action, approval);
    if (action.state === "applied") return { ...action, result: { ...(action.result ?? {}), noop: true, already_applied: true } };
    if (action.state === "unknown") {
      const localCleanupWarnings = Array.isArray(action.result?.local_cleanup_warnings) ? action.result.local_cleanup_warnings : undefined;
      throw new AxiError({
        code: "ACTION_COMMIT_UNKNOWN",
        message: "This action has an uncertain remote outcome; reconcile or abandon it before staging a new write.",
        suggestedCommand: `slack-axi action reconcile ${action.id}`,
        ...(localCleanupWarnings ? { details: { local_cleanup_warnings: localCleanupWarnings } } : {}),
      });
    }
    if (["not_applied", "abandoned", "expired"].includes(action.state)) throw new AxiError({ code: "ACTION_STATE_INVALID", message: `Action '${action.id}' is terminal in state '${action.state}' and cannot be applied.`, exitCode: 2 });
    if (Date.parse(action.expires_at) <= Date.now()) {
      await app.actions.transitionLocked(action, "expired", {}, true);
      throw new AxiError({ code: "ACTION_EXPIRED", message: "The staged action expired and its sensitive content was discarded." });
    }
    if (!action.payload) throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The verified action payload is unavailable." });
    return withLeasedActionContext(app, workspace ?? action.workspace_id, async (context) => {
      if (context.profile.team_id !== action.workspace_id || context.profile.actor_id !== action.actor_id) throw new AxiError({ code: "ACTION_IDENTITY_MISMATCH", message: "The active Slack identity does not match the signed action plan." });
      await assertLiveActionIdentity(context, action);
      // Context construction and live identity verification are reads and can
      // outlast an approval that was valid when this command began. Recheck at
      // the final local boundary so an expired plan never enters `applying`.
      if (Date.parse(action.expires_at) <= Date.now()) {
        await app.actions.transitionLocked(action, "expired", {}, true);
        throw new AxiError({ code: "ACTION_EXPIRED", message: "The staged action expired before dispatch and its sensitive content was discarded." });
      }

      const dispatch = async (): Promise<ActionPlan> => {
        // Direct apply can wait behind a policy lease. The earlier identity-side
        // expiry check is therefore insufficient: recheck after authorization
        // is linearized and immediately before entering the remote boundary.
        if (Date.parse(action.expires_at) <= Date.now()) {
          action = await app.actions.transitionLocked(action, "expired", {}, true);
          throw new AxiError({ code: "ACTION_EXPIRED", message: "The staged action expired while waiting for final dispatch authorization; its sensitive content was discarded." });
        }
        if (action.state === "planned" || action.state === "partial") action = await app.actions.transitionLocked(action, "applying");
        const execution: OperationExecution = { action, providerAcknowledged: false, uploadSnapshotDescriptorBound: false };
        try {
          const applied = await applyOperation(app, context, execution);
          execution.action = applied.action;
          return await app.actions.transitionLocked(execution.action, "applied", { result: applied.result }, true, execution.uploadSnapshotDescriptorBound ? { uploadSnapshotDescriptorBound: true } : {});
        } catch (error) {
          const axi = error instanceof AxiError ? error : new AxiError({ code: "INTERNAL_ERROR", message: "The action failed unexpectedly.", details: { dispatch_uncertain: true }, cause: error });
          const lastError = { code: axi.code, message: redact(axi.message), at: new Date().toISOString() };
          if (execution.providerAcknowledged || (uncertainAfterDispatch(axi) && !authoritativeRejection(axi))) {
            let unknown = execution.action;
            let statePersistenceFailure: unknown;
            try {
              unknown = await app.actions.transitionLocked(execution.action, "unknown", { result: { recovery: recoveryFor(execution.action) }, last_error: lastError }, true, execution.uploadSnapshotDescriptorBound ? { uploadSnapshotDescriptorBound: true } : {});
            } catch (cause) {
              // Reporting the local state-write failure would hide the only
              // safety-relevant fact: Slack may already have committed. The
              // signed `applying` state also prevents replay of this action;
              // the next lock owner will recover it to `unknown`.
              statePersistenceFailure = cause;
            }
            const localCleanupWarnings = Array.isArray(unknown.result?.local_cleanup_warnings) ? unknown.result.local_cleanup_warnings : undefined;
            const statePersistenceCode = statePersistenceFailure instanceof AxiError
              ? statePersistenceFailure.code
              : statePersistenceFailure instanceof Error && "code" in statePersistenceFailure
                ? String(statePersistenceFailure.code)
                : statePersistenceFailure ? "STATE_PERSISTENCE_FAILED" : undefined;
            throw new AxiError({
              code: "ACTION_COMMIT_UNKNOWN",
              message: statePersistenceFailure
                ? "Slack may have committed the action, and the local unknown-state record could not be verified durable; do not replay it."
                : "Slack may have committed the action; automatic retry is disabled and replayable content was discarded.",
              suggestedCommand: ["message.send", "message.reply", "reaction.add", "reaction.remove", "mark-read", "later.complete", "later.snooze"].includes(execution.action.operation)
                ? `slack-axi action reconcile ${unknown.id}`
                : `slack-axi action abandon ${unknown.id} --approval ${unknown.approval}`,
              ...(localCleanupWarnings || statePersistenceCode ? { details: {
                ...(localCleanupWarnings ? { local_cleanup_warnings: localCleanupWarnings } : {}),
                ...(statePersistenceCode ? { local_state_persistence: { code: statePersistenceCode, complete: false } } : {}),
              } } : {}),
              cause: error,
            });
          }
          await app.actions.transitionLocked(execution.action, "not_applied", { last_error: lastError }, true, execution.uploadSnapshotDescriptorBound ? { uploadSnapshotDescriptorBound: true } : {});
          throw error;
        }
      };

      if (!directAuthorization) {
        return actionRequiresUnfurlPolicy(action)
          ? withUnfurlPolicyLease(app, action, dispatch)
          : dispatch();
      }
      if (!action.target_ids.includes(directAuthorization.conversationId)) {
        throw new AxiError({ code: "ACTION_INTEGRITY_FAILED", message: "The direct-apply policy target is not covered by the signed action plan." });
      }
      return withDirectPolicyLease(app, action, {
        conversationId: directAuthorization.conversationId,
        requiresBroadcast: actionRequiresBroadcast(action),
      }, dispatch);
    });
  });
}

export async function directOrStage(app: SlackAxiApp, context: WorkspaceContext, input: {
  operation: string;
  targetIds: string[];
  conversationId?: string;
  preview: Record<string, unknown>;
  payload: Record<string, unknown>;
  uploadPath?: string;
  uploadMaxBytes?: number;
  apply: boolean;
}): Promise<ActionPlan> {
  const action = await stageAction(app, context, input);
  if (!input.apply) return action;
  const requiresBroadcast = actionRequiresBroadcast(action);
  if (!input.conversationId) {
    throw new AxiError({ code: "POLICY_DENIED", message: "Direct apply is not allowed without an exact conversation policy target.", suggestedCommand: applyCommand(action) });
  }
  const directAllowed = await app.policy.allows(input.operation, input.conversationId);
  if (!directAllowed) {
    throw new AxiError({ code: "POLICY_DENIED", message: "Direct apply is not allowed for this operation and conversation.", suggestedCommand: applyCommand(action) });
  }
  if (requiresBroadcast && !(await app.policy.allows(input.operation, input.conversationId, true))) {
    throw new AxiError({ code: "BROADCAST_POLICY_DENIED", message: "Direct apply of broadcast mentions requires a separate policy grant for this operation and conversation.", suggestedCommand: applyCommand(action) });
  }
  return applyAction(app, action, action.approval, context.profile.alias, { conversationId: input.conversationId });
}

async function reconcileMessage(app: SlackAxiApp, context: WorkspaceContext, action: ActionPlan): Promise<ActionPlan> {
  let current = action;
  let data = recovery(current);
  let conversationId = typeof data.conversation_id === "string" && data.conversation_id
    ? data.conversation_id
    : undefined;
  if (!conversationId) {
    // A DM open is an idempotent prerequisite. If the process died (or local
    // persistence failed) after Slack returned its conversation ID but before
    // the `partial` state became durable, only the signed user ID survives in
    // recovery. Re-open the same DM to recover that identity; never replay the
    // non-idempotent message body.
    if (action.operation !== "message.send") requiredString(data, "conversation_id");
    const userId = requiredString(data, "user_id");
    try {
      conversationId = await context.public.openDm(userId);
    } catch (error) {
      const axi = error instanceof AxiError ? error : new AxiError({ code: "SLACK_API_ERROR", message: "Slack DM recovery failed.", cause: error });
      throw new AxiError({
        code: "RECONCILIATION_INCOMPLETE",
        message: "The DM conversation identity could not be recovered; the action remains unknown.",
        retryable: axi.retryable,
        ...(axi.retryAfterSeconds !== undefined ? { retryAfterSeconds: axi.retryAfterSeconds } : {}),
        suggestedCommand: `slack-axi action reconcile ${action.id}`,
        details: { dependency_error: axi.code, source: "dm_open" },
        cause: error,
      });
    }
    try {
      current = await app.actions.transitionLocked(current, "unknown", {
        result: { ...(current.result ?? {}), recovery: { ...data, conversation_id: conversationId } },
      }, true);
    } catch (error) {
      const axi = error instanceof AxiError ? error : new AxiError({ code: "STATE_PERSISTENCE_FAILED", message: "The recovered DM identity could not be persisted.", cause: error });
      throw new AxiError({
        code: "RECONCILIATION_INCOMPLETE",
        message: "The recovered DM conversation identity could not be verified durable; the action remains unknown.",
        retryable: true,
        suggestedCommand: `slack-axi action reconcile ${action.id}`,
        details: { dependency_error: axi.code, source: "dm_recovery_persistence" },
        cause: error,
      });
    }
    data = recovery(current);
  }
  const clientMsgId = requiredString(data, "client_msg_id");
  const isReply = action.operation === "message.reply";
  const threadTs = isReply ? requiredString(data, "thread_ts") : undefined;
  const source = isReply ? "replies" : "history";
  const created = Date.parse(action.created_at) / 1000;
  // Old reply reconciliation used history cursors and misses. Never carry those
  // into conversations.replies: Slack cursors are endpoint-specific, and a
  // history miss says nothing about whether a threaded reply committed.
  const persisted = action.reconciliation;
  // Old history progress used expiry as a fixed upper bound. Discard those
  // cursors/misses because an apply accepted near expiry could cross that
  // bound before Slack committed it.
  const previous = persisted?.source === source
    && (isReply || persisted.window_basis === "uncertain_boundary_v1")
    ? persisted
    : undefined;
  const uncertainAt = action.last_error?.at ? Date.parse(action.last_error.at) : Number.NaN;
  const safeLatest = String(((Number.isFinite(uncertainAt) ? uncertainAt : Date.now()) + 300_000) / 1000);
  const oldest = isReply ? threadTs! : previous?.oldest ?? String(created - 300);
  const latest = isReply ? threadTs! : previous?.latest ?? safeLatest;
  let cursor = previous?.cursor;
  let scanned = previous?.scanned ?? 0;
  for (let page = 0; page < 3; page += 1) {
    let result: Awaited<ReturnType<typeof context.public.history>>;
    try {
      result = isReply
        ? await context.public.replies({ channel: conversationId, ts: threadTs!, limit: 100, ...(cursor ? { cursor } : {}) })
        : await context.public.history({ channel: conversationId, oldest, latest, limit: 100, ...(cursor ? { cursor } : {}) });
    } catch (error) {
      const axi = error instanceof AxiError ? error : new AxiError({ code: "SLACK_API_ERROR", message: "Slack reconciliation failed.", cause: error });
      current = await app.actions.transitionLocked(current, "unknown", { last_error: { code: axi.code, message: redact(axi.message), at: new Date().toISOString() }, reconciliation: { source, ...(!isReply ? { window_basis: "uncertain_boundary_v1" as const } : {}), scanned, oldest, latest, complete_misses: previous?.complete_misses ?? 0, ...(previous?.last_complete_miss_at ? { last_complete_miss_at: previous.last_complete_miss_at } : {}), ...(cursor ? { cursor } : {}) } }, true);
      throw new AxiError({ code: "RECONCILIATION_INCOMPLETE", message: "Reconciliation could not complete; the action remains unknown.", retryable: axi.retryable, ...(axi.retryAfterSeconds !== undefined ? { retryAfterSeconds: axi.retryAfterSeconds } : {}), suggestedCommand: `slack-axi action reconcile ${action.id}`, cause: error });
    }
    scanned += result.items.length;
    const match = result.items.find((item) => item.client_msg_id === clientMsgId);
    if (match) {
      const ts = requiredString(match, "ts");
      return app.actions.transitionLocked(current, "applied", { result: { message_ref: createMessageRef(context.profile.team_id, conversationId, ts), client_msg_id: clientMsgId, reconciled: true, scanned } }, true);
    }
    cursor = result.next;
    const progress = {
      source,
      ...(!isReply ? { window_basis: "uncertain_boundary_v1" as const } : {}),
      scanned,
      oldest,
      latest,
      complete_misses: previous?.complete_misses ?? 0,
      ...(previous?.last_complete_miss_at ? { last_complete_miss_at: previous.last_complete_miss_at } : {}),
      ...(cursor ? { cursor } : {}),
    };
    current = await app.actions.transitionLocked(current, "unknown", { reconciliation: progress }, true);
    if (!cursor) {
      if (!result.complete) {
        throw new AxiError({ code: "RECONCILIATION_INCOMPLETE", message: `Slack indicated that ${source} reconciliation was incomplete but did not provide a continuation cursor; the action remains unknown.`, retryable: true, suggestedCommand: `slack-axi action reconcile ${action.id}`, details: { scanned, source } });
      }
      const lastMiss = previous?.last_complete_miss_at ? Date.parse(previous.last_complete_miss_at) : undefined;
      if ((previous?.complete_misses ?? 0) >= 1 && lastMiss !== undefined && Date.now() - lastMiss >= 60_000) {
        return app.actions.transitionLocked(current, "not_applied", { result: { reconciled: true, source, complete_scans: (previous?.complete_misses ?? 0) + 1, scanned } }, true);
      }
      const now = new Date().toISOString();
      const firstMissAt = previous?.last_complete_miss_at ?? now;
      return app.actions.transitionLocked(current, "unknown", { reconciliation: { source, ...(!isReply ? { window_basis: "uncertain_boundary_v1" as const } : {}), scanned, oldest, latest, complete_misses: 1, last_complete_miss_at: firstMissAt }, last_error: { code: "RECONCILIATION_NO_MATCH", message: `One complete ${source} scan found no matching message; a second complete scan at least 60 seconds later is required.`, at: now } }, true);
    }
  }
  throw new AxiError({ code: "RECONCILIATION_INCOMPLETE", message: `The bounded reconciliation batch ended before Slack ${source} was exhausted; the cursor was saved.`, retryable: true, suggestedCommand: `slack-axi action reconcile ${action.id}`, details: { scanned, source, next_cursor: cursor } });
}

async function reconcileStateful(app: SlackAxiApp, context: WorkspaceContext, action: ActionPlan): Promise<ActionPlan> {
  const data = recovery(action);
  switch (action.operation) {
    case "reaction.add":
    case "reaction.remove": {
      const message = await context.public.reactions(requiredString(data, "conversation_id"), requiredString(data, "ts"));
      const item = Array.isArray(message.reactions) ? message.reactions.map(slackRecord).find((reaction) => reaction.name === data.name) : undefined;
      const mine = Boolean(item && Array.isArray(item.users) && item.users.includes(context.profile.actor_id));
      const satisfied = action.operation === "reaction.add" ? mine : !mine;
      return app.actions.transitionLocked(action, satisfied ? "applied" : "not_applied", { result: { reconciled: true, satisfied, ref: data.ref, name: data.name } }, true);
    }
    case "mark-read": {
      const conversation = await context.public.conversationReadState(requiredString(data, "conversation_id"));
      const lastRead = requiredString(conversation, "last_read");
      const satisfied = Number(lastRead) >= Number(requiredString(data, "ts"));
      return app.actions.transitionLocked(action, satisfied ? "applied" : "not_applied", { result: { reconciled: true, satisfied, last_read: lastRead } }, true);
    }
    case "later.complete":
    case "later.snooze": {
      if (context.profile.kind !== "browser" || !context.browser) {
        throw new AxiError({
          code: "BROWSER_CAPABILITY_UNAVAILABLE",
          message: "Later reconciliation requires browser authentication and uses a private, best-effort Slack capability.",
        });
      }
      const filters = ["saved", "completed", "archived"] as const;
      const persistedSource = action.reconciliation?.source;
      const persistedIndex = persistedSource === undefined
        ? 0
        : filters.findIndex((filter) => filter === persistedSource);
      let filterIndex = persistedIndex >= 0 ? persistedIndex : 0;
      let current = action;
      let cursor = persistedIndex >= 0 ? action.reconciliation?.cursor : undefined;
      let scanned = persistedIndex >= 0 ? action.reconciliation?.scanned ?? 0 : 0;
      let sourceScanned = cursor ? action.reconciliation?.source_scanned ?? 0 : 0;
      const itemId = requiredString(data, "item_id");
      const ts = requiredString(data, "ts");
      const remindAt = action.operation === "later.snooze"
        ? requiredPositiveSafeInteger(data, "remind_at")
        : undefined;

      for (let page = 0; page < 3 && filterIndex < filters.length; page += 1) {
        const filter = filters[filterIndex]!;
        const list = await context.browser.laterList(cursor, 50, filter);
        scanned += list.items.length;
        sourceScanned += list.items.length;
        const item = list.items.find((candidate) => candidate.item_id === itemId && candidate.ts === ts);
        if (item) {
          const satisfied = action.operation === "later.complete"
            ? item.state === "completed" || item.date_completed > 0
            : item.state === "saved" && item.date_due === remindAt;
          return app.actions.transitionLocked(current, satisfied ? "applied" : "not_applied", {
            result: { reconciled: true, satisfied, item_id: itemId, ts, scanned, capability: "browser_private_best_effort" },
          }, true);
        }

        cursor = list.next;
        if (!cursor) {
          const authoritativeTotal = filter === "saved"
            ? list.counts?.uncompleted_count
            : filter === "completed"
              ? list.counts?.completed_count
              : list.counts?.archived_count;
          if (authoritativeTotal !== undefined && sourceScanned < authoritativeTotal) {
            current = await app.actions.transitionLocked(current, "unknown", {
              reconciliation: { source: filter, source_scanned: sourceScanned, scanned, oldest: ts, latest: "later", complete_misses: 0 },
            }, true);
            throw new AxiError({
              code: "RECONCILIATION_INCOMPLETE",
              message: `Slack reported omitted ${filter} Later items without a continuation cursor; the action remains unknown.`,
              retryable: true,
              suggestedCommand: `slack-axi action reconcile ${action.id}`,
              details: { scanned, source: filter, source_scanned: sourceScanned, authoritative_total: authoritativeTotal, omitted: authoritativeTotal - sourceScanned },
            });
          }
          filterIndex += 1;
          sourceScanned = 0;
          if (filterIndex >= filters.length) {
            return app.actions.transitionLocked(current, "not_applied", {
              result: { reconciled: true, satisfied: false, item_id: itemId, ts, scanned, capability: "browser_private_best_effort" },
            }, true);
          }
        }
        current = await app.actions.transitionLocked(current, "unknown", {
          reconciliation: {
            ...(cursor ? { cursor } : {}),
            source: filters[filterIndex]!,
            source_scanned: sourceScanned,
            scanned,
            oldest: ts,
            latest: "later",
            complete_misses: 0,
          },
        }, true);
      }
      throw new AxiError({
        code: "RECONCILIATION_INCOMPLETE",
        message: "Later reconciliation exceeded its three-page bound; the source and cursor were saved and the action remains unknown.",
        retryable: true,
        suggestedCommand: `slack-axi action reconcile ${action.id}`,
        details: { scanned, source: filters[filterIndex], ...(cursor ? { next_cursor: cursor } : {}) },
      });
    }
    default:
      throw new AxiError({ code: "ACTION_NOT_RECONCILABLE", message: "This action has no reliable remote reconciliation identity.", suggestedCommand: `slack-axi action abandon ${action.id} --approval ${action.approval}` });
  }
}

export async function reconcileAction(app: SlackAxiApp, requested: ActionPlan, workspace?: string): Promise<ActionPlan> {
  return app.actions.withLock(requested.id, async (action) => {
    if (action.state !== "unknown") throw new AxiError({ code: "ACTION_NOT_RECONCILABLE", message: "Only an action with unknown commit state requires reconciliation.", exitCode: 2 });
    return withLeasedActionContext(app, workspace ?? action.workspace_id, async (context) => {
    if (context.profile.team_id !== action.workspace_id || context.profile.actor_id !== action.actor_id) throw new AxiError({ code: "ACTION_IDENTITY_MISMATCH", message: "The active Slack identity does not match the signed action plan." });
    await assertLiveActionIdentity(context, action);
    if (["message.send", "message.reply"].includes(action.operation)) return reconcileMessage(app, context, action);
    try {
      return await reconcileStateful(app, context, action);
    } catch (error) {
      if (error instanceof AxiError && ["ACTION_NOT_RECONCILABLE", "ACTION_INTEGRITY_FAILED", "RECONCILIATION_INCOMPLETE"].includes(error.code)) throw error;
      const axi = error instanceof AxiError ? error : new AxiError({ code: "SLACK_API_ERROR", message: "Slack reconciliation failed.", cause: error });
      throw new AxiError({
        code: "RECONCILIATION_INCOMPLETE",
        message: "Remote state could not be proven; the action remains unknown.",
        retryable: axi.retryable,
        ...(axi.retryAfterSeconds !== undefined ? { retryAfterSeconds: axi.retryAfterSeconds } : {}),
        suggestedCommand: `slack-axi action reconcile ${action.id}`,
        details: { dependency_error: axi.code },
        cause: error,
      });
    }
    });
  });
}

export function newClientMessageId(): string { return randomUUID(); }
