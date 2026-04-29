#!/usr/bin/env node
// screenshot-tripwire CLI dispatcher.
//   screenshot-tripwire audit [--json] <file>...
//   screenshot-tripwire check                       # audit currently-staged images under brand/goneidle-landing/
//   screenshot-tripwire install-hooks               # install pre-commit gate
//   screenshot-tripwire help

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const LIB        = path.resolve(__dirname, "..", "lib");

const COMMANDS = {
  audit:           "audit.mjs",
  check:           "check.mjs",
  "install-hooks": "install-hooks.mjs",
};

function help(exit = 0) {
  console.log(`screenshot-tripwire — pattern-checker for marketing image assets

Usage:
  screenshot-tripwire audit [--json] <file>...   Audit one or more images
  screenshot-tripwire check                      Audit staged images under brand/goneidle-landing/
  screenshot-tripwire install-hooks              Install pre-commit gate (composes with trailer-tripwire)
  screenshot-tripwire help                       Show this message

Short alias: \`st\` works the same as \`screenshot-tripwire\`.

Findings levels: CRITICAL (block, exit 2), WARN (advisory), NOTE (informational).
Catches: wrong Steam capsule dims, transparent corners, monochrome flat palette,
blank frames, over-compression. See README for the full heuristic table.
`);
  process.exit(exit);
}

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") help(0);

const script = COMMANDS[cmd];
if (!script) {
  console.error(`screenshot-tripwire: unknown command "${cmd}"\n`);
  help(64);
}

const child = spawn(process.execPath, [path.join(LIB, script), ...rest], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
