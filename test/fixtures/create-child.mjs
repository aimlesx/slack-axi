import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ActionStore } from "../../dist/actions.js";

const [root, keyFile, readyFile, releaseFile, operation, sourceFile] = process.argv.slice(2);
const secretText = `crash-sensitive-message-${operation}`;
const secrets = {
  async get() { return (await readFile(keyFile, "utf8")).trim(); },
  async set() { throw new Error("unexpected signing-key write"); },
  async delete() { return false; },
};

class PausedCreatorStore extends ActionStore {
  async beforeActionPublish(stagingDirectory) {
    await writeFile(readyFile, `${stagingDirectory}\n`, { flag: "wx" });
    for (;;) {
      try {
        await access(releaseFile);
        return;
      } catch {
        await delay(5);
      }
    }
  }
}

const actions = new PausedCreatorStore(root, secrets);
const workspaceId = operation === "file.upload" ? "T2" : "T1";
if (operation === "file.upload") {
  await actions.create({
    workspace_id: workspaceId,
    actor_id: "U1",
    operation,
    target_ids: ["C1"],
    preview: { filename: path.basename(sourceFile), comment: secretText },
    payload: { conversation_id: "C1", filename: path.basename(sourceFile), comment: secretText },
    upload_path: sourceFile,
  });
} else {
  await actions.create({
    workspace_id: workspaceId,
    actor_id: "U1",
    operation,
    target_ids: ["C1"],
    preview: { text: secretText },
    payload: { conversation_id: "C1", text: secretText, client_msg_id: "crash-id" },
  });
}
