import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteJson } from "../src/fs-store.js";
import { defaultPolicy, PolicyStore } from "../src/policy.js";
import type { Policy } from "../src/types.js";

const permitted: Policy = {
  ...defaultPolicy,
  allow_direct_apply: [{ operation: "message.send", conversations: ["C1"] }],
  allowed_unfurl_domains: ["example.com"],
};
const roots: string[] = [];

async function fixture(layout: "slky" | "slack-axi" = "slky") {
  const root = await mkdtemp(path.join(os.tmpdir(), "slky-project-policy-"));
  roots.push(root);
  const global = path.join(root, layout, "policy.json");
  const current = path.join(root, ".slky-policy.json");
  const legacy = path.join(root, ".slack-axi-policy.json");
  await atomicWriteJson(global, permitted);
  return { store: new PolicyStore(global, current), current, legacy };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project policy names", () => {
  it.each(["slky", "slack-axi"] as const)("creates a policy visible to clients sharing the %s layout", async (layout) => {
    const { store, current, legacy } = await fixture(layout);
    const [selected, other] = layout === "slky" ? [current, legacy] : [legacy, current];
    await store.replace(defaultPolicy, "project");
    expect(JSON.parse(await readFile(selected, "utf8"))).toEqual(defaultPolicy);
    expect(JSON.parse(await readFile(`${selected}.commit.json`, "utf8"))).toMatchObject({ state: "committed", target: defaultPolicy });
    await expect(access(other)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a legacy restriction in force and writes its existing pair in place", async () => {
    const { store, current, legacy } = await fixture();
    await atomicWriteJson(legacy, defaultPolicy);
    await expect(store.allows("message.send", "C1")).resolves.toBe(false);
    await expect(store.validateUnfurls("https://example.com", true)).rejects.toMatchObject({ code: "UNFURL_POLICY_DENIED" });
    await store.replace(permitted, "project");
    expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual(permitted);
    await expect(store.allows("message.send", "C1")).resolves.toBe(true);
    await expect(access(current)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("respects and repairs a sidecar-only pending legacy policy at its own path", async () => {
    const { store, current, legacy } = await fixture();
    await atomicWriteJson(`${legacy}.commit.json`, { version: 1, state: "pending", target: defaultPolicy });
    await expect(store.allows("message.send", "C1")).rejects.toMatchObject({ code: "POLICY_COMMIT_UNKNOWN" });
    await store.replace(defaultPolicy, "project");
    await expect(store.allows("message.send", "C1")).resolves.toBe(false);
    expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual(defaultPolicy);
    await expect(access(current)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks authorization and project replacement when both names have commit records only", async () => {
    const { store, current, legacy } = await fixture();
    const record = { version: 1, state: "committed", target: null };
    await Promise.all([current, legacy].map((name) => atomicWriteJson(`${name}.commit.json`, record)));
    const operation = vi.fn(async () => undefined);
    const error = { code: "PROJECT_POLICY_CONFLICT", details: { current_policy: current, legacy_policy: legacy } };
    await expect(store.withDirectApplyLease({ operation: "message.send", conversationId: "C1", requiresBroadcast: false }, operation)).rejects.toMatchObject(error);
    await expect(store.withUnfurlApplyLease("https://example.com", operation)).rejects.toMatchObject(error);
    await expect(store.replace(defaultPolicy, "project")).rejects.toMatchObject(error);
    expect(operation).not.toHaveBeenCalled();
    for (const name of [current, legacy]) {
      await expect(access(name)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(`${name}.commit.json`, "utf8"))).toEqual(record);
    }
  });

  it("refuses a current-only project policy in a legacy layout that older clients share", async () => {
    const { store, current, legacy } = await fixture("slack-axi");
    await atomicWriteJson(current, permitted);
    const error = { code: "PROJECT_POLICY_CONFLICT", message: expect.stringContaining(".slack-axi-policy.json") };
    await expect(store.allows("message.send", "C1")).rejects.toMatchObject(error);
    await expect(store.replace(defaultPolicy, "project")).rejects.toMatchObject(error);
    expect(JSON.parse(await readFile(current, "utf8"))).toEqual(permitted);
    await expect(access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
