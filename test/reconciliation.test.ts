import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionStore } from "../src/actions.js";
import { AxiError } from "../src/errors.js";
import { reconcileAction } from "../src/mutations.js";
import type { SlackAxiApp, WorkspaceContext } from "../src/app.js";
import type { ActionPlan } from "../src/types.js";
import { MemorySecrets } from "./helpers.js";

afterEach(() => vi.useRealTimers());

async function unknownMessage(actions: ActionStore): Promise<ActionPlan> {
  const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: { text: "once" }, payload: { conversation_id: "C1", text: "once", client_msg_id: "client-id" } });
  const applying = await actions.transition(plan, "applying");
  return actions.transition(applying, "unknown", { result: { recovery: { conversation_id: "C1", client_msg_id: "client-id" } } }, true);
}

async function unknownReply(actions: ActionStore): Promise<ActionPlan> {
  const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "message.reply", target_ids: ["C1", "1786712000.000001"], preview: { text: "once" }, payload: { conversation_id: "C1", thread_ts: "1786712000.000001", text: "once", client_msg_id: "reply-client-id" } });
  const applying = await actions.transition(plan, "applying");
  return actions.transition(applying, "unknown", { result: { recovery: { conversation_id: "C1", thread_ts: "1786712000.000001", client_msg_id: "reply-client-id" } } }, true);
}

function appWith(actions: ActionStore, publicClient: Record<string, unknown>): SlackAxiApp {
  const context = {
    profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token", timezone: "UTC" },
    public: { async authTest() { return { team_id: "T1", user_id: "U1" }; }, ...publicClient },
    snapshot: {}, conversations: [], users: [], userMap: new Map(),
  } as unknown as WorkspaceContext;
  return { actions, async context() { return context; } } as unknown as SlackAxiApp;
}

async function unknownLater(actions: ActionStore, operation: "later.complete" | "later.snooze", remindAt?: number): Promise<ActionPlan> {
  const payload = {
    item_id: "C1",
    ts: "1786712345.001200",
    ...(remindAt === undefined ? {} : { remind_at: remindAt }),
  };
  const plan = await actions.create({
    workspace_id: "T1",
    actor_id: "U1",
    operation,
    target_ids: ["C1", "1786712345.001200"],
    preview: {},
    payload,
  });
  const applying = await actions.transition(plan, "applying");
  return actions.transition(applying, "unknown", { result: { recovery: payload } }, true);
}

function appWithBrowser(actions: ActionStore, browser: Record<string, unknown>): SlackAxiApp {
  const context = {
    profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "browser", timezone: "UTC" },
    public: { async authTest() { return { team_id: "T1", user_id: "U1" }; } },
    browser,
    snapshot: {}, conversations: [], users: [], userMap: new Map(),
  } as unknown as WorkspaceContext;
  return { actions, async context() { return context; } } as unknown as SlackAxiApp;
}

describe("incremental reconciliation", () => {
  it("persists a cursor after 300 messages and finds a match on a later page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownMessage(actions);
    const pages = new Map<string, { items: Record<string, unknown>[]; next?: string; complete: boolean }>([
      ["", { items: Array.from({ length: 100 }, (_, index) => ({ ts: `1786712${String(index).padStart(3, "0")}.000001` })), next: "p2", complete: false }],
      ["p2", { items: Array.from({ length: 100 }, (_, index) => ({ ts: `1786713${String(index).padStart(3, "0")}.000001` })), next: "p3", complete: false }],
      ["p3", { items: Array.from({ length: 100 }, (_, index) => ({ ts: `1786714${String(index).padStart(3, "0")}.000001` })), next: "p4", complete: false }],
      ["p4", { items: [{ ts: "1786715000.000001", client_msg_id: "client-id" }], complete: true }],
    ]);
    const app = appWith(actions, { async history(options: { cursor?: string }) { return pages.get(options.cursor ?? "")!; } });
    await expect(reconcileAction(app, unknown)).rejects.toMatchObject({ code: "RECONCILIATION_INCOMPLETE", details: { scanned: 300, next_cursor: "p4" } });
    const persisted = await actions.get(unknown.id);
    expect(persisted.reconciliation).toMatchObject({ cursor: "p4", scanned: 300 });
    const applied = await reconcileAction(app, persisted);
    expect(applied.state).toBe("applied");
    expect(applied.result).toMatchObject({ client_msg_id: "client-id", scanned: 301 });
  });

  it("requires two complete misses separated by at least 60 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00Z"));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownMessage(actions);
    const app = appWith(actions, { async history() { return { items: [], complete: true }; } });
    const first = await reconcileAction(app, unknown);
    expect(first.state).toBe("unknown");
    expect(first.reconciliation?.complete_misses).toBe(1);
    vi.advanceTimersByTime(60_001);
    const second = await reconcileAction(app, await actions.get(unknown.id));
    expect(second.state).toBe("not_applied");
  });

  it("covers commits after plan expiry using the signed uncertain-boundary window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00Z"));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "message.send", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", text: "once", client_msg_id: "late-client-id" } });
    const applying = await actions.transition(plan, "applying");
    const uncertainAt = new Date(Date.parse(plan.expires_at) + 20_000).toISOString();
    const committedTs = `${Math.floor((Date.parse(plan.expires_at) + 10_000) / 1000)}.000001`;
    const unknown = await actions.transition(applying, "unknown", {
      result: { recovery: { conversation_id: "C1", client_msg_id: "late-client-id" } },
      last_error: { code: "REQUEST_TIMEOUT", message: "uncertain", at: uncertainAt },
    }, true);
    const history = vi.fn(async (options: { oldest: string; latest: string }) => {
      expect(Number(options.oldest)).toBeLessThan(Number(committedTs));
      expect(Number(options.latest)).toBeGreaterThan(Number(committedTs));
      return { items: [{ ts: committedTs, client_msg_id: "late-client-id" }], complete: true };
    });

    const applied = await reconcileAction(appWith(actions, { history }), unknown);
    expect(applied).toMatchObject({ state: "applied", result: { client_msg_id: "late-client-id" } });
    expect(history).toHaveBeenCalledOnce();
  });

  it("paginates the retained thread with conversations.replies and finds a later-page reply", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownReply(actions);
    const pages = new Map<string, { items: Record<string, unknown>[]; next?: string; complete: boolean }>([
      ["", { items: Array.from({ length: 100 }, (_, index) => ({ ts: `1786712${String(index).padStart(3, "0")}.000001`, thread_ts: "1786712000.000001" })), next: "r2", complete: false }],
      ["r2", { items: Array.from({ length: 100 }, (_, index) => ({ ts: `1786713${String(index).padStart(3, "0")}.000001`, thread_ts: "1786712000.000001" })), next: "r3", complete: false }],
      ["r3", { items: Array.from({ length: 100 }, (_, index) => ({ ts: `1786714${String(index).padStart(3, "0")}.000001`, thread_ts: "1786712000.000001" })), next: "r4", complete: false }],
      ["r4", { items: [{ ts: "1786715000.000001", thread_ts: "1786712000.000001", client_msg_id: "reply-client-id" }], complete: true }],
    ]);
    const history = vi.fn(async () => ({ items: [], complete: true }));
    const replies = vi.fn(async (options: { ts: string; cursor?: string }) => {
      expect(options.ts).toBe("1786712000.000001");
      return pages.get(options.cursor ?? "")!;
    });
    const app = appWith(actions, { history, replies });
    await expect(reconcileAction(app, unknown)).rejects.toMatchObject({ code: "RECONCILIATION_INCOMPLETE", details: { source: "replies", next_cursor: "r4" } });
    const persisted = await actions.get(unknown.id);
    expect(persisted.reconciliation).toMatchObject({ source: "replies", cursor: "r4", oldest: "1786712000.000001", latest: "1786712000.000001", scanned: 300 });
    const applied = await reconcileAction(app, persisted);
    expect(applied).toMatchObject({ state: "applied", result: { client_msg_id: "reply-client-id", scanned: 301 } });
    expect(history).not.toHaveBeenCalled();
  });

  it("requires two complete thread misses before a reply is not_applied and never scans history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00Z"));
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownReply(actions);
    const history = vi.fn(async () => ({ items: [], complete: true }));
    const replies = vi.fn(async (options: { ts: string }) => {
      expect(options.ts).toBe("1786712000.000001");
      return { items: [], complete: true };
    });
    const app = appWith(actions, { history, replies });
    const first = await reconcileAction(app, unknown);
    expect(first).toMatchObject({ state: "unknown", reconciliation: { source: "replies", complete_misses: 1 } });
    vi.advanceTimersByTime(60_001);
    const second = await reconcileAction(app, await actions.get(unknown.id));
    expect(second).toMatchObject({ state: "not_applied", result: { source: "replies", complete_scans: 2 } });
    expect(replies).toHaveBeenCalledTimes(2);
    expect(history).not.toHaveBeenCalled();
  });

  it("keeps the action unknown when reconciliation is rate limited", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownMessage(actions);
    const app = appWith(actions, { async history() { throw new AxiError({ code: "RATE_LIMITED", message: "later", retryAfterSeconds: 9 }); } });
    await expect(reconcileAction(app, unknown)).rejects.toMatchObject({ code: "RECONCILIATION_INCOMPLETE" });
    expect((await actions.get(unknown.id)).state).toBe("unknown");
  });

  it("reconciles a reaction from current remote state without replaying it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation: "reaction.add", target_ids: ["C1"], preview: {}, payload: { conversation_id: "C1", ts: "1786712345.001200", name: "eyes", ref: "T1/C1/1786712345.001200" } });
    const applying = await actions.transition(plan, "applying");
    const unknown = await actions.transition(applying, "unknown", { result: { recovery: { conversation_id: "C1", ts: "1786712345.001200", name: "eyes", ref: "T1/C1/1786712345.001200" } } }, true);
    const app = appWith(actions, { async reactions() { return { reactions: [{ name: "eyes", users: ["U1"] }] }; } });
    expect((await reconcileAction(app, unknown)).state).toBe("applied");
  });

  it.each([
    ["reaction.add", { conversation_id: "C1", ts: "1786712345.001200", name: "eyes", ref: "T1/C1/1786712345.001200" }, "reactions"],
    ["mark-read", { conversation_id: "C1", ts: "1786712345.001200" }, "conversationReadState"],
  ])("keeps %s unknown when authoritative reconciliation fields are unavailable", async (operation, payload, dependency) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const plan = await actions.create({ workspace_id: "T1", actor_id: "U1", operation, target_ids: ["C1"], preview: {}, payload });
    const applying = await actions.transition(plan, "applying");
    const unknown = await actions.transition(applying, "unknown", { result: { recovery: payload } }, true);
    const failure = async () => { throw new AxiError({ code: "SLACK_RESPONSE_INVALID", message: "missing reconciliation evidence" }); };
    const app = appWith(actions, { [dependency]: failure });

    await expect(reconcileAction(app, unknown)).rejects.toMatchObject({ code: "RECONCILIATION_INCOMPLETE", details: { dependency_error: "SLACK_RESPONSE_INVALID" } });
    expect((await actions.get(plan.id)).state).toBe("unknown");
  });

  it("reconciles Later completion across the bounded saved and completed buckets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-later-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownLater(actions, "later.complete");
    const filters: string[] = [];
    const laterList = vi.fn(async (_cursor: string | undefined, limit: number, filter: string) => {
      expect(limit).toBe(50);
      filters.push(filter);
      return {
        items: filter === "completed"
          ? [{ item_id: "C1", ts: "1786712345.001200", state: "completed", date_completed: 1, date_due: 0 }]
          : [],
      };
    });

    const reconciled = await reconcileAction(appWithBrowser(actions, { laterList }), unknown);
    expect(reconciled).toMatchObject({
      state: "applied",
      result: { reconciled: true, satisfied: true, capability: "browser_private_best_effort", scanned: 1 },
    });
    expect(filters).toEqual(["saved", "completed"]);
  });

  it("reconciles a Later snooze from its exact saved-item state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-later-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const remindAt = 1_786_800_000;
    const unknown = await unknownLater(actions, "later.snooze", remindAt);
    const laterList = vi.fn(async () => ({
      items: [{ item_id: "C1", ts: "1786712345.001200", state: "saved", date_completed: 0, date_due: remindAt }],
    }));

    const reconciled = await reconcileAction(appWithBrowser(actions, { laterList }), unknown);
    expect(reconciled).toMatchObject({ state: "applied", result: { reconciled: true, satisfied: true } });
    expect(laterList).toHaveBeenCalledWith(undefined, 50, "saved");
  });

  it.each([
    ["later.complete", undefined],
    ["later.snooze", 1_786_800_000],
  ] as const)("keeps %s unknown when Later counts prove a no-cursor page omitted items", async (operation, remindAt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-later-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownLater(actions, operation, remindAt);
    const laterList = vi.fn(async () => ({
      items: [],
      counts: { uncompleted_count: 1, uncompleted_overdue_count: 0, archived_count: 0, completed_count: 0, total_count: 1 },
    }));

    await expect(reconcileAction(appWithBrowser(actions, { laterList }), unknown)).rejects.toMatchObject({
      code: "RECONCILIATION_INCOMPLETE",
      details: { source: "saved", source_scanned: 0, authoritative_total: 1, omitted: 1 },
    });
    expect(await actions.get(unknown.id)).toMatchObject({
      state: "unknown",
      reconciliation: { source: "saved", source_scanned: 0, scanned: 0 },
    });
    expect(laterList).toHaveBeenCalledOnce();
  });

  it("persists a Later cursor at the three-page bound and resumes without replaying prior pages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "slack-axi-reconcile-later-"));
    const actions = new ActionStore(root, new MemorySecrets());
    const unknown = await unknownLater(actions, "later.complete");
    const laterList = vi.fn(async (cursor: string | undefined, _limit: number, filter: string) => filter === "saved"
      ? {
          items: [{ item_id: `other-${cursor ?? "p1"}`, ts: "1786712000.000001", state: "saved", date_completed: 0, date_due: 0 }],
          next: cursor === undefined ? "p2" : cursor === "p2" ? "p3" : cursor === "p3" ? "p4" : undefined,
        }
      : { items: [] });
    const app = appWithBrowser(actions, { laterList });

    await expect(reconcileAction(app, unknown)).rejects.toMatchObject({
      code: "RECONCILIATION_INCOMPLETE",
      details: { source: "saved", next_cursor: "p4", scanned: 3 },
    });
    const persisted = await actions.get(unknown.id);
    expect(persisted).toMatchObject({ state: "unknown", reconciliation: { source: "saved", cursor: "p4", source_scanned: 3, scanned: 3 } });

    expect((await reconcileAction(app, persisted)).state).toBe("not_applied");
    expect(laterList.mock.calls.map((call) => call[0])).toEqual([undefined, "p2", "p3", "p4", undefined, undefined]);
  });

});
