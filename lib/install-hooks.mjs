#!/usr/bin/env node
// screenshot-tripwire: pre-commit hook installer.
//
// Thin wrapper: resolve the hook path (honours core.hooksPath and linked
// worktrees), read the file, let composeHook() decide, write, report. What
// may be rewritten and what must be left alone is decided in
// hook-compose.mjs, which the sibling tripwires share byte for byte.

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildBlock, composeHook } from "./hook-compose.mjs";

const SELF = "screenshot-tripwire";

function resolveHooksDir(cwd) {
  const r = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return path.resolve(cwd, r.stdout.trim());
}

const DONE = {
  created: (where) => `installed ${where}`,
  updated: (where) => `updated its block in ${where}`,
  unchanged: (where) => `${where} is already up to date`,
  migrated: (where) => `rewrote ${where} as managed blocks, one per tripwire gate`,
  appended: (where) => `appended its block to ${where}`,
};

export function installHooks({ cwd = process.cwd() } = {}) {
  const hooksDir = resolveHooksDir(cwd);
  if (!hooksDir) {
    console.error(`${SELF}: not inside a git repository`);
    return { ok: false };
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  const target = path.join(hooksDir, "pre-commit");
  const where = path.relative(cwd, target) || target;

  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  const { action, text, warnings } = composeHook(existing, SELF, "");

  if (action === "refused") {
    console.error(`${SELF}: ${target} is an unrelated pre-commit hook, so it was not modified.`);
    console.error("  To run the gate from that hook, add these three lines to it by hand:");
    console.error("");
    for (const line of buildBlock(SELF, "").split("\n")) console.error(`    ${line}`);
    console.error("");
    console.error("  From then on install-hooks rewrites only the lines between those markers.");
    return { ok: false, target, action };
  }

  if (action !== "unchanged") fs.writeFileSync(target, text);
  try { fs.chmodSync(target, 0o755); } catch { /* windows */ }

  console.log(`${SELF}: ${DONE[action](where)}`);
  console.log("  Gate runs automatically on git commit. Bypass: git commit --no-verify");
  for (const warning of warnings) console.error(`${SELF}: warning: ${warning}`);
  return { ok: true, target, action };
}

// Node resolves symlinks in the main module's path; compare both spellings.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit(installHooks().ok ? 0 : 1);
}
