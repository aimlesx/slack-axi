import type { Readable } from "node:stream";

export type AuthKind = "browser" | "user_token";
export type CapabilityStatus = "supported" | "degraded" | "unavailable";
export type OutputFormat = "toon" | "json" | "jsonl";
export type SlackTimestamp = `${number}.${number}`;
export type MessageRef = `T${string}/${string}/${SlackTimestamp}`;

export interface WorkspaceIdentity {
  id: string;
  alias: string;
  actor_id: string;
  auth_kind: AuthKind;
}

export interface AuthProfile {
  alias: string;
  team_id: string;
  team_name: string;
  workspace_url?: string;
  actor_id: string;
  actor_name?: string;
  timezone: string;
  kind: AuthKind;
  keychain_accounts: string[];
  capabilities: Record<string, CapabilityStatus>;
  capability_probed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface AppConfig {
  version: 1;
  default_workspace?: string;
  profiles: AuthProfile[];
  pending_credential_cleanup?: string[];
  pending_cache_cleanup?: string[];
  removing_workspaces?: string[];
}

export interface PageInfo {
  shown: number;
  complete: boolean;
  next_cursor?: string;
  omitted?: number;
  total?: number;
  total_kind?: "exact" | "known" | "scanned";
  source_complete?: boolean;
}

export interface CoverageInfo {
  requested: number;
  scanned: number;
  failed: number;
  complete: boolean;
  reason?: string;
  sources?: Record<string, {
    scanned: number;
    complete: boolean;
    next_cursor?: string;
    error?: { code: string; message: string };
  }>;
}

export interface SuccessEnvelope<T> {
  schema: "slack-axi/v1";
  ok: true;
  workspace?: WorkspaceIdentity;
  scope: Record<string, string | number | boolean>;
  data: T;
  page?: PageInfo;
  coverage?: CoverageInfo;
  hints?: Array<{ command: string; reason: string }>;
}

export interface ErrorEnvelope {
  schema: "slack-axi/v1";
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retry_after_seconds?: number;
    candidates?: unknown[];
    suggested_command?: string;
    details?: Record<string, unknown>;
  };
}

export interface Conversation {
  id: string;
  name: string;
  type: "channel" | "group" | "dm" | "group_dm";
  is_private: boolean;
  is_member: boolean;
  is_archived: boolean;
  is_external?: boolean;
  topic?: string;
  purpose?: string;
  member_ids?: string[];
}

export interface User {
  id: string;
  name: string;
  display_name: string;
  real_name: string;
  email?: string;
  timezone?: string;
  is_bot: boolean;
  deleted: boolean;
}

export interface Message {
  ref: MessageRef;
  conversation_id: string;
  ts: string;
  time: string;
  author_id?: string;
  author?: string;
  text: string;
  text_chars: number;
  text_truncated: boolean;
  thread?: {
    ref: MessageRef;
    replies: number;
    participant_ids: string[];
    last_reply?: string;
  };
  files?: Array<{ id: string; name: string; mimetype?: string; size?: number }>;
  reactions?: Array<{ name: string; count: number; mine: boolean }>;
  permalink?: string;
  client_msg_id?: string;
}

export type ActionState =
  | "planned"
  | "applying"
  | "partial"
  | "unknown"
  | "applied"
  | "not_applied"
  | "abandoned"
  | "expired";

export interface ReconciliationProgress {
  cursor?: string | undefined;
  source?: string | undefined;
  source_scanned?: number | undefined;
  window_basis?: "uncertain_boundary_v1" | undefined;
  scanned: number;
  oldest: string;
  latest: string;
  complete_misses: number;
  last_complete_miss_at?: string | undefined;
}

export interface ActionPlan {
  id: string;
  approval: string;
  workspace_id: string;
  actor_id: string;
  operation: string;
  target_ids: string[];
  payload_hash: string;
  preview_hash: string;
  created_at: string;
  expires_at: string;
  preview?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  state: ActionState;
  revision: number;
  result?: Record<string, unknown>;
  last_error?: { code: string; message: string; at: string };
  reconciliation?: ReconciliationProgress;
  content_discarded?: boolean;
  upload_snapshot?: string;
}

/**
 * A staged upload opened and verified by ActionStore. The backing descriptor
 * remains open from the final signed-content check through the raw Slack
 * transfer; transports never receive a pathname that they could reopen.
 */
export interface VerifiedUploadSnapshot {
  readonly size: number;
  readonly expected_sha256: string;
  createReadStream(): Readable;
  assertUnchanged(): Promise<void>;
}

export interface PolicyRule {
  operation: string;
  conversations: string[];
}

export interface Policy {
  version: 1;
  allow_direct_apply: PolicyRule[];
  allow_broadcast_mentions: PolicyRule[];
  allowed_unfurl_domains: string[];
}
