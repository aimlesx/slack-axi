import path from "node:path";
import os from "node:os";

export interface AppPaths {
  data: string;
  cache: string;
  config: string;
  policy: string;
  actions: string;
}

export function appPaths(home = os.homedir()): AppPaths {
  const data = path.join(home, "Library", "Application Support", "slack-axi");
  return {
    data,
    cache: path.join(home, "Library", "Caches", "slack-axi"),
    config: path.join(data, "config.json"),
    policy: path.join(data, "policy.json"),
    actions: path.join(data, "actions"),
  };
}
