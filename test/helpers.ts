import { createHmac } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { CursorIntegrity } from "../src/cache.js";
import { AxiError } from "../src/errors.js";
import type { SecretStore } from "../src/keychain.js";

export class MemoryCursorIntegrity implements CursorIntegrity {
  constructor(private readonly key = Buffer.alloc(32, 0x5a)) {}

  async signCursor(value: unknown): Promise<string> {
    return createHmac("sha256", this.key)
      .update("slack-axi/cursor/v1\0")
      .update(canonicalize(value))
      .digest("base64url");
  }

  async verifyCursor(value: unknown, signature: string): Promise<boolean> {
    return signature === await this.signCursor(value);
  }
}

export class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  readonly failSet = new Set<string>();
  readonly failDelete = new Set<string>();

  async set(account: string, secret: string): Promise<void> {
    if (this.failSet.has(account)) throw new AxiError({ code: "KEYCHAIN_WRITE_FAILED", message: "injected set failure" });
    this.values.set(account, secret);
  }

  async get(account: string): Promise<string> {
    const value = this.values.get(account);
    if (!value) throw new AxiError({ code: "CREDENTIAL_MISSING", message: "missing" });
    return value;
  }

  async delete(account: string): Promise<boolean> {
    if (this.failDelete.has(account)) throw new AxiError({ code: "KEYCHAIN_DELETE_FAILED", message: "injected delete failure" });
    return this.values.delete(account);
  }
}
