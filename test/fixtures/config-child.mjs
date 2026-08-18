import { ConfigStore } from "../../dist/config.js";

const [, , filename, account] = process.argv;
if (!filename || !account) throw new Error("usage: config-child.mjs <config> <account>");

const config = new ConfigStore(filename);
await config.addPendingCleanup([account]);
