import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ActionStore } from "../../dist/actions.js";
import { applyAction } from "../../dist/mutations.js";

const [root, keyFile, counterFile, id, approval, barrierDirectory] = process.argv.slice(2);
const secrets = {
  async get() { return (await readFile(keyFile, "utf8")).trim(); },
  async set() { throw new Error("unexpected set"); },
  async delete() { return false; },
};
class BarrierActionStore extends ActionStore {
  async beforeStaleOwnerUnlink() {
    if (!barrierDirectory) return;
    await writeFile(path.join(barrierDirectory, "ready"), `${process.pid}\n`, { flag: "wx" });
    for (;;) {
      try {
        await access(path.join(barrierDirectory, "release"));
        return;
      } catch {
        await delay(5);
      }
    }
  }
}
const actions = new BarrierActionStore(root, secrets);
const publicClient = {
  async authTest() { return { team_id: "T1", user_id: "U1" }; },
  async postMessage(options) {
    await appendFile(counterFile, `${options.clientMsgId}\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { ok: true, ts: "1786712345.001200", message: { ts: "1786712345.001200", text: options.text, user: "U1" } };
  },
  async permalink() { return "https://acme.slack.com/archives/C1/p1786712345001200"; },
};
const context = {
  profile: { team_id: "T1", alias: "work", actor_id: "U1", kind: "user_token" },
  public: publicClient,
  snapshot: {},
  conversations: [],
  users: [],
  userMap: new Map(),
};
const app = { actions, async context() { return context; } };
try {
  const action = await actions.get(id);
  await applyAction(app, action, approval);
} catch (error) {
  if (error?.code !== "ACTION_BUSY") throw error;
}
