#!/usr/bin/env node
// screenshot-tripwire: pre-commit check against currently-staged image files
// under brand/goneidle-landing/. Same shape as trailer-tripwire's check.
// Exits 0 if no CRITICAL findings, 2 if any.

import { execSync } from "node:child_process";
import path from "node:path";
import { auditFile } from "./audit.mjs";

const STAGED_GLOB_PREFIX = "brand/goneidle-landing/";
const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];

function getStagedImages() {
  const out = execSync("git diff --cached --name-only --diff-filter=ACMR", { encoding: "utf8" });
  return out.split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(p => p.startsWith(STAGED_GLOB_PREFIX))
    .filter(p => IMAGE_EXTS.includes(path.extname(p).toLowerCase()));
}

async function main() {
  const files = getStagedImages();
  if (files.length === 0) {
    console.log("screenshot-tripwire: no staged images under brand/goneidle-landing/ — skipping");
    process.exit(0);
  }
  console.log(`screenshot-tripwire: auditing ${files.length} staged image(s)`);

  let totalCritical = 0;
  for (const f of files) {
    try {
      const r = await auditFile(f);
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

main().catch(e => { console.error(e); process.exit(1); });
