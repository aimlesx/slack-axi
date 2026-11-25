import { lstatSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SlkyError } from "./errors.js";

export const KEYCHAIN_SERVICE = "dev.slky";

export interface AppPaths {
  data: string;
  cache: string;
  config: string;
  policy: string;
  actions: string;
  keychainService: string;
}

function layout(home: string, name: "slky" | "slack-axi"): AppPaths {
  const data = path.join(home, "Library", "Application Support", name);
  return {
    data,
    cache: path.join(home, "Library", "Caches", name),
    config: path.join(data, "config.json"),
    policy: path.join(data, "policy.json"),
    actions: path.join(data, "actions"),
    keychainService: name === "slky" ? KEYCHAIN_SERVICE : "dev.slack-axi",
  };
}

function hasRoot(paths: AppPaths): boolean {
  // A cache-only installation still owns its layout. lstat also sees a
  // dangling symlink, so an inaccessible root cannot trigger a fresh setup.
  return [paths.data, paths.cache].some((root) => lstatSync(root, { throwIfNoEntry: false }) !== undefined);
}

export function appPaths(home = os.homedir()): AppPaths {
  const current = layout(home, "slky");
  const legacy = layout(home, "slack-axi");
  let hasLegacy: boolean;
  let hasCurrent: boolean;
  try {
    hasLegacy = hasRoot(legacy);
    hasCurrent = hasRoot(current);
  } catch (cause) {
    throw new SlkyError({ code: "STORAGE_LAYOUT_UNAVAILABLE", message: "Could not inspect the slky and slack-axi storage locations.", cause });
  }
  if (hasLegacy && hasCurrent) {
    throw new SlkyError({
      code: "STORAGE_LAYOUT_CONFLICT",
      message: "Both slky and slack-axi storage exist. Back up both layouts and resolve which to keep before retrying.",
      details: { current: { data: current.data, cache: current.cache }, legacy: { data: legacy.data, cache: legacy.cache } },
    });
  }
  return hasLegacy ? legacy : current;
}
