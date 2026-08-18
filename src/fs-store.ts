import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensurePrivateDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function readJson<T>(filename: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filename, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function atomicWriteJson(filename: string, value: unknown): Promise<void> {
  await ensurePrivateDir(path.dirname(filename));
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function immutableWriteJson(filename: string, value: unknown): Promise<void> {
  await ensurePrivateDir(path.dirname(filename));
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(filename), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function removeIfExists(filename: string): Promise<void> {
  await rm(filename, { force: true });
}
