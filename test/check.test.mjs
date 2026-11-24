// Regression tests for `check`: staged-blob audit, -z name handling, large
// staged lists, subdirectory cwd, and CLI signal handling. Each test builds a
// throwaway git repo and runs lib/check.mjs inside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.resolve(HERE, "..", "lib", "check.mjs");
const CLI = path.resolve(HERE, "..", "bin", "cli.mjs");
const DIR = "brand/goneidle-landing";

// Opaque, noisy, multi-hue PNG so only the dimension heuristic can fire.
function noisyPng(width, height, seed = 7) {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = (rand() * 256) | 0;
    png.data[i * 4 + 1] = (rand() * 256) | 0;
    png.data[i * 4 + 2] = (rand() * 256) | 0;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

function git(cwd, args, input) {
  const r = spawnSync("git", args, { cwd, input, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "st-check-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  await mkdir(path.join(repo, DIR), { recursive: true });
  return repo;
}

function runCheck(cwd) {
  const r = spawnSync(process.execPath, [CHECK], { cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

async function withRepo(fn) {
  const repo = await makeRepo();
  try { await fn(repo); } finally { await rm(repo, { recursive: true, force: true }); }
}

test("check audits the staged blob, not a later working-tree edit (bad staged, fixed unstaged)", async () => {
  await withRepo(async (repo) => {
    const rel = `${DIR}/capsule_header.png`;
    await writeFile(path.join(repo, rel), noisyPng(500, 215));
    git(repo, ["add", "--", rel]);
    await writeFile(path.join(repo, rel), noisyPng(460, 215)); // fixed, not re-added
    const r = runCheck(repo);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /STEAM_DIMS/);
  });
});

test("check passes a good staged blob even when the working tree is later broken", async () => {
  await withRepo(async (repo) => {
    const rel = `${DIR}/capsule_header.png`;
    await writeFile(path.join(repo, rel), noisyPng(460, 215));
    git(repo, ["add", "--", rel]);
    await writeFile(path.join(repo, rel), noisyPng(500, 215)); // bad edit, not staged
    const r = runCheck(repo);
    assert.equal(r.status, 0, r.out);
  });
});

test("check audits the blob when the staged file is deleted from the working tree", async () => {
  await withRepo(async (repo) => {
    const rel = `${DIR}/capsule_header.png`;
    await writeFile(path.join(repo, rel), noisyPng(500, 215));
    git(repo, ["add", "--", rel]);
    await rm(path.join(repo, rel));
    const r = runCheck(repo);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /STEAM_DIMS/);
    assert.doesNotMatch(r.out, /AUDIT_FAIL/);
  });
});

test("check audits staged images whose names git would quote (non-ASCII)", async () => {
  await withRepo(async (repo) => {
    const rel = `${DIR}/capsule_h\u00e9ader.png`;
    await writeFile(path.join(repo, rel), Buffer.from("junk"));
    git(repo, ["add", "--", rel]);
    const r = runCheck(repo);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /capsule_h\u00e9ader\.png/);
    assert.match(r.out, /TINY_FILE/);
  });
});

test("check audits a macOS style name with U+202F before AM", async () => {
  await withRepo(async (repo) => {
    const rel = `${DIR}/screenshot_1 at 10.30.15\u202fAM.png`;
    await writeFile(path.join(repo, rel), Buffer.from("junk"));
    git(repo, ["add", "--", rel]);
    const r = runCheck(repo);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /TINY_FILE/);
  });
});

test("check skips cleanly when the staged name list is over 1 MiB and none are under the prefix", async () => {
  await withRepo(async (repo) => {
    const blob = git(repo, ["hash-object", "-w", "--stdin"], "x\n").trim();
    const pad = "x".repeat(100);
    let idx = "";
    for (let i = 0; i < 10000; i++) idx += `100644 ${blob} 0\tvendor/${pad}_${i}.txt\n`;
    git(repo, ["update-index", "--add", "--index-info"], idx);
    const r = runCheck(repo);
    assert.equal(r.status, 0, r.out.slice(0, 400));
    assert.match(r.out, /skipping/);
  });
});

test("check works from a subdirectory of the repo", async () => {
  await withRepo(async (repo) => {
    const rel = `${DIR}/capsule_header.png`;
    await writeFile(path.join(repo, rel), noisyPng(500, 215));
    git(repo, ["add", "--", rel]);
    const r = runCheck(path.join(repo, DIR));
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /STEAM_DIMS/);
  });
});

test("check does not match a sibling directory sharing the prefix text", async () => {
  await withRepo(async (repo) => {
    await mkdir(path.join(repo, "brand/goneidle-landing-raw"), { recursive: true });
    const rel = "brand/goneidle-landing-raw/capsule_header.png";
    await writeFile(path.join(repo, rel), Buffer.from("junk"));
    git(repo, ["add", "--", rel]);
    const r = runCheck(repo);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /skipping/);
  });
});

test("cli maps a child killed by a signal to a nonzero exit (never code ?? 0)", async () => {
  const src = await readFile(CLI, "utf8");
  assert.doesNotMatch(src, /code \?\? 0/);
  assert.match(src, /code \?\? 1/);
  assert.match(src, /child\.on\("error"/);
});
