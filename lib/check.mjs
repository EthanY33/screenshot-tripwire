#!/usr/bin/env node
// screenshot-tripwire: pre-commit check against currently-staged image files
// under brand/goneidle-landing/. Same shape as trailer-tripwire's check.
// Audits the staged blob (index content), not the working tree.
// Exits 0 if no CRITICAL findings, 2 if any. Any internal error exits 1.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { auditBuffer } from "./audit.mjs";

const STAGED_GLOB_PREFIX = "brand/goneidle-landing/";
const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];
const MAX_BUFFER = 64 * 1024 * 1024;

// Run git without a shell, from the repo root, returning stdout as a Buffer.
function git(root, args) {
  return execFileSync("git", args, { cwd: root, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

// Backslashes to "/", no leading "./", exactly one trailing "/".
function normDir(d) {
  return d.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/*$/, "/");
}

function getStagedImages(root) {
  const prefix = normDir(STAGED_GLOB_PREFIX);
  const out = git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--", prefix]).toString("utf8");
  return out.split("\0")
    .filter(Boolean)
    .filter(p => p.startsWith(prefix))
    .filter(p => IMAGE_EXTS.includes(path.extname(p).toLowerCase()));
}

// Read the staged blob, not the working tree. --filters applies smudge filters
// so LFS content is real content; fall back to the raw blob if that fails.
function readStagedBlob(root, p) {
  try {
    return git(root, ["cat-file", "--filters", ":" + p]);
  } catch {
    return git(root, ["cat-file", "blob", ":" + p]);
  }
}

async function main() {
  const root = repoRoot();
  const files = getStagedImages(root);
  if (files.length === 0) {
    console.log("screenshot-tripwire: no staged images under brand/goneidle-landing/ — skipping");
    process.exit(0);
  }
  console.log(`screenshot-tripwire: auditing ${files.length} staged image(s)`);

  let totalCritical = 0;
  for (const f of files) {
    try {
      const r = auditBuffer(f, readStagedBlob(root, f));
      const head = `${r.filepath}${r.width ? ` [${r.width}x${r.height}, ${(r.sizeBytes/1024).toFixed(1)} KB]` : ""}`;
      console.log(head);
      if (r.findings.length === 0) { console.log("  ok"); continue; }
      for (const finding of r.findings) {
        console.log(`  ${finding.level.padEnd(8)} ${finding.code.padEnd(20)} ${finding.msg}`);
        if (finding.level === "CRITICAL") totalCritical++;
      }
    } catch (e) {
      console.log(`${f}\n  CRITICAL AUDIT_FAIL ${e.message}`);
      totalCritical++;
    }
  }

  console.log(`\nscreenshot-tripwire: ${totalCritical} CRITICAL finding(s)`);
  if (totalCritical > 0) {
    console.log("\nFix CRITICALs or commit with --no-verify (and document why in the message).");
  }
  process.exit(totalCritical > 0 ? 2 : 0);
}

main().catch(e => {
  const reason = String(e && e.message ? e.message : e).split("\n")[0];
  console.error(`screenshot-tripwire: check failed: ${reason}`);
  process.exit(1);
});
