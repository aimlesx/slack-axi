#!/usr/bin/env node
import { VERSION } from "./version.js";

const args = process.argv.slice(2);
if (args.length === 1 && ["-v", "-V", "--version"].includes(args[0]!)) {
  process.stdout.write(`${VERSION}\n`);
} else {
  const { run } = await import("./cli.js");
  await run(process.argv);
}
