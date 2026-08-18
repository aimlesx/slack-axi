import { createHash, randomBytes } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { AxiError } from "./errors.js";
import type { AuthProfile } from "./types.js";

export const KEYCHAIN_SERVICE = "dev.slack-axi";
export const ACTION_SIGNING_ACCOUNT = "local:action-signing:v1";

export interface SecretStore {
  set(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string>;
  delete(account: string): Promise<boolean>;
}

export class NativeKeychain implements SecretStore {
  private assertPlatform(): void {
    if (process.platform !== "darwin") {
      throw new AxiError({ code: "KEYCHAIN_UNAVAILABLE", message: "Slack AXI v1 requires the native macOS Keychain." });
    }
  }

  async set(account: string, secret: string): Promise<void> {
    this.assertPlatform();
    try {
      await new AsyncEntry(KEYCHAIN_SERVICE, account).setPassword(secret);
    } catch (cause) {
      throw new AxiError({ code: "KEYCHAIN_WRITE_FAILED", message: "Could not store the Slack credential in macOS Keychain.", cause });
    }
  }

  async get(account: string): Promise<string> {
    this.assertPlatform();
    try {
      const secret = await new AsyncEntry(KEYCHAIN_SERVICE, account).getPassword();
      if (!secret) throw new Error("missing");
      return secret;
    } catch (cause) {
      throw new AxiError({ code: "CREDENTIAL_MISSING", message: "The Slack credential is missing or inaccessible in macOS Keychain.", suggestedCommand: "slack-axi auth doctor", cause });
    }
  }

  async delete(account: string): Promise<boolean> {
    this.assertPlatform();
    try {
      return await new AsyncEntry(KEYCHAIN_SERVICE, account).deleteCredential();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/no entry|not found/i.test(message)) return false;
      throw new AxiError({ code: "KEYCHAIN_DELETE_FAILED", message: "Could not remove the Slack credential from macOS Keychain.", cause });
    }
  }
}

export function newCredentialGeneration(): string {
  return randomBytes(16).toString("base64url");
}

export function credentialAccounts(teamId: string, generation: string): string[];
export function credentialAccounts(teamId: string, kind: "browser" | "user_token", generation: string): string[];
export function credentialAccounts(teamId: string, kindOrGeneration: "browser" | "user_token" | string, generation?: string): string[] {
  const kind = generation === undefined ? "user_token" : kindOrGeneration as "browser" | "user_token";
  const resolvedGeneration = generation ?? kindOrGeneration;
  return kind === "browser"
    ? [`${teamId}:browser:${resolvedGeneration}:xoxc`, `${teamId}:browser:${resolvedGeneration}:xoxd`]
    : [`${teamId}:user:${resolvedGeneration}:xoxp`];
}

/**
 * Returns the cache/credential generation selected by a profile's Keychain
 * account pointer. A malformed pointer receives an isolated deterministic
 * identity so it cannot share cache state with a valid credential generation.
 */
export function credentialGeneration(profile: Pick<AuthProfile, "team_id" | "kind" | "keychain_accounts">): string {
  const expectedNamespace = profile.kind === "browser" ? "browser" : "user";
  const expectedSecretNames = profile.kind === "browser" ? ["xoxc", "xoxd"] : ["xoxp"];
  if (profile.keychain_accounts.length === expectedSecretNames.length) {
    const generations = profile.keychain_accounts.map((account, index) => {
      const prefix = `${profile.team_id}:${expectedNamespace}:`;
      const suffix = `:${expectedSecretNames[index]}`;
      if (!account.startsWith(prefix) || !account.endsWith(suffix)) return undefined;
      const generation = account.slice(prefix.length, -suffix.length);
      return /^[A-Za-z0-9_-]{16,}$/.test(generation) ? generation : undefined;
    });
    if (generations.every((generation) => generation !== undefined && generation === generations[0])) return generations[0]!;
  }
  const legacy = createHash("sha256")
    .update(JSON.stringify([profile.team_id, profile.kind, profile.keychain_accounts]))
    .digest("base64url")
    .slice(0, 22);
  return `legacy-${legacy}`;
}
