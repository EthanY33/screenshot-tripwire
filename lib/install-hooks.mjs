#!/usr/bin/env node
// screenshot-tripwire: pre-commit hook installer.
// Marks its own hook with "# screenshot-tripwire:v1" so reinstall is idempotent
// and refuses to overwrite an unrelated pre-commit hook (matches trailer-tripwire pattern).

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import path from "node:path";

const HOOK_MARKER = "# screenshot-tripwire:v1";
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER}
# Auto-installed by 'npx screenshot-tripwire install-hooks'.
# Audits staged images under brand/goneidle-landing/ for AI-default tells before commit.
# Bypass: git commit --no-verify (document why in the commit message).

set -e
exec npx screenshot-tripwire check
`;

function main() {
  const hooksDir = path.join(process.cwd(), ".git", "hooks");
  if (!existsSync(hooksDir)) {
    console.error("screenshot-tripwire: .git/hooks not found. Run from a git repo root.");
    process.exit(1);
  }
  const hookPath = path.join(hooksDir, "pre-commit");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (existing.includes(HOOK_MARKER)) {
      writeFileSync(hookPath, HOOK_BODY);
      try { chmodSync(hookPath, 0o755); } catch {}
      console.log(`screenshot-tripwire: replaced existing v1 hook at ${hookPath}`);
      return;
    }
    if (existing.includes("# trailer-tripwire:v1")) {
      // Compose with trailer-tripwire — both should run.
      const composed = `#!/bin/sh
${HOOK_MARKER}
# Composed pre-commit hook: trailer-tripwire + screenshot-tripwire.
set -e
npx screenshot-tripwire check
exec npx trailer-tripwire check
`;
      writeFileSync(hookPath, composed);
      try { chmodSync(hookPath, 0o755); } catch {}
      console.log(`screenshot-tripwire: composed with existing trailer-tripwire hook at ${hookPath}`);
      return;
    }
    console.error(`screenshot-tripwire: refusing to overwrite unrelated pre-commit hook at ${hookPath}`);
    console.error("  (Hook does not contain '# screenshot-tripwire:v1' or '# trailer-tripwire:v1' marker.)");
    console.error("  Inspect manually and merge by hand if you want both to run.");
    process.exit(1);
  }

  writeFileSync(hookPath, HOOK_BODY);
  try { chmodSync(hookPath, 0o755); } catch {}
  console.log(`screenshot-tripwire: installed v1 hook at ${hookPath}`);
}

main();
