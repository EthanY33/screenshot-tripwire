// Synthesize known-bad and known-good PNGs in a tmpdir, run auditFile,
// and assert the heuristics fire (or don't) as expected.
//
// Uses Node's built-in test runner (node:test) — no external deps.
//
// Note on file sizes: solid-color and pure-gradient PNGs compress to <5 KB and
// trip the TINY_FILE gate before reaching the heuristic under test. We use
// makeNoisyPng() to add a deterministic per-pixel jitter that defeats PNG
// compression while staying inside the target heuristic's tolerance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

import { auditFile } from "../lib/audit.mjs";

// --- helpers ---------------------------------------------------------------

// Deterministic LCG so noise is reproducible across runs (auditFile is
// expected to be deterministic; the test must be too).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff; // [0, 1)
  };
}

// Per-pixel callback fn(x,y,rand) -> [r,g,b,a]. `rand` returns deterministic [0,1).
function makePng(width, height, fn, seed = 12345) {
  const rand = lcg(seed);
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      const [r, g, b, a] = fn(x, y, rand);
      png.data[off]     = r;
      png.data[off + 1] = g;
      png.data[off + 2] = b;
      png.data[off + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

function findingCodes(report) {
  return report.findings.map(f => f.code);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let TMP;
test("setup", async () => {
  TMP = await mkdtemp(path.join(tmpdir(), "st-test-"));
});

// --- TINY_FILE -------------------------------------------------------------

test("TINY_FILE fires on sub-5KB image", async () => {
  // A 1x1 PNG is well under 5KB.
  const buf = makePng(1, 1, () => [0, 0, 0, 255]);
  const fp = path.join(TMP, "tiny.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  assert.ok(findingCodes(report).includes("TINY_FILE"), `expected TINY_FILE, got ${JSON.stringify(report.findings)}`);
});

// --- TRANSPARENT_CORNER ----------------------------------------------------

test("TRANSPARENT_CORNER fires when any corner has alpha < 255", async () => {
  // 800x800 noisy color, but TR corner is fully transparent.
  // Noise amplitude defeats compression so file > 5KB.
  const buf = makePng(800, 800, (x, y, r) => {
    if (x === 799 && y === 0) return [0, 0, 0, 0];
    const n = (r() * 60) | 0;
    return [clamp(80 + n, 0, 255), clamp(120 + n, 0, 255), clamp(200 + n, 0, 255), 255];
  });
  const fp = path.join(TMP, "transparent_corner.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  const codes = findingCodes(report);
  assert.ok(codes.includes("TRANSPARENT_CORNER"), `expected TRANSPARENT_CORNER, got ${JSON.stringify(report.findings)}`);
  // Should report exactly 1/4 corners.
  const f = report.findings.find(x => x.code === "TRANSPARENT_CORNER");
  assert.match(f.msg, /1\/4 corner/);
  assert.match(f.msg, /TR@/);
});

test("TRANSPARENT_CORNER reports ALL transparent corners, not just first", async () => {
  // 800x800, three corners transparent (TL, TR, BL), BR opaque.
  const buf = makePng(800, 800, (x, y, r) => {
    const tl = x === 0   && y === 0;
    const tr = x === 799 && y === 0;
    const bl = x === 0   && y === 799;
    if (tl || tr || bl) return [0, 0, 0, 0];
    const n = (r() * 60) | 0;
    return [clamp(80 + n, 0, 255), clamp(120 + n, 0, 255), clamp(200 + n, 0, 255), 255];
  });
  const fp = path.join(TMP, "three_corners.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  const f = report.findings.find(x => x.code === "TRANSPARENT_CORNER");
  assert.ok(f, `expected TRANSPARENT_CORNER, got ${JSON.stringify(report.findings)}`);
  assert.match(f.msg, /3\/4 corner/);
  // All three labels present
  assert.match(f.msg, /TL@/);
  assert.match(f.msg, /TR@/);
  assert.match(f.msg, /BL@/);
});

// --- STEAM_DIMS ------------------------------------------------------------

test("STEAM_DIMS fires when filename matches a slot but dims are wrong", async () => {
  // capsule_header should be 460x215 (or @2x). Make it 500x215 with noise.
  const buf = makePng(500, 215, (x, y, r) => {
    const n = (r() * 60) | 0;
    return [clamp(80 + n, 0, 255), clamp(120 + n, 0, 255), clamp(200 + n, 0, 255), 255];
  });
  const fp = path.join(TMP, "capsule_header.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  const codes = findingCodes(report);
  assert.ok(codes.includes("STEAM_DIMS"), `expected STEAM_DIMS, got ${JSON.stringify(report.findings)}`);
  const f = report.findings.find(x => x.code === "STEAM_DIMS");
  assert.match(f.msg, /460x215/);
});

test("STEAM_DIMS does NOT fire on canonical 460x215 capsule header", async () => {
  const buf = makePng(460, 215, (x, y, r) => {
    const n = (r() * 60) | 0;
    return [clamp(80 + n, 0, 255), clamp(120 + n, 0, 255), clamp(200 + n, 0, 255), 255];
  });
  const fp = path.join(TMP, "capsule_header_good.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  assert.ok(!findingCodes(report).includes("STEAM_DIMS"), `STEAM_DIMS should not fire on canonical dims; got ${JSON.stringify(report.findings)}`);
});

test("STEAM_DIMS does NOT fire on @2x retina dims", async () => {
  const buf = makePng(920, 430, (x, y, r) => {
    const n = (r() * 60) | 0;
    return [clamp(80 + n, 0, 255), clamp(120 + n, 0, 255), clamp(200 + n, 0, 255), 255];
  });
  const fp = path.join(TMP, "capsule_header_2x.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  assert.ok(!findingCodes(report).includes("STEAM_DIMS"), `STEAM_DIMS should not fire on @2x dims; got ${JSON.stringify(report.findings)}`);
});

// --- NO_HUE ----------------------------------------------------------------

test("NO_HUE fires on greyscale-only image", async () => {
  // 600x600 noisy greyscale — no color, but tonally varied.
  const buf = makePng(600, 600, (x, y, r) => {
    const v = clamp(((x + y) * 200 / 1200) + (r() * 40) | 0, 0, 255);
    return [v, v, v, 255];
  });
  const fp = path.join(TMP, "greyscale.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  assert.ok(findingCodes(report).includes("NO_HUE"), `expected NO_HUE, got ${JSON.stringify(report.findings)}`);
});

// --- TOO_DARK / TOO_BRIGHT -------------------------------------------------

test("TOO_DARK fires on near-black image", async () => {
  // 600x600, every pixel in [0,8] — keeps lumMean < 0.04 but defeats compression.
  const buf = makePng(600, 600, (x, y, r) => {
    const v = (r() * 8) | 0;
    return [v, v, v, 255];
  });
  const fp = path.join(TMP, "all_black.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  assert.ok(findingCodes(report).includes("TOO_DARK"), `expected TOO_DARK, got ${JSON.stringify(report.findings)}`);
});

test("TOO_BRIGHT fires on near-white image", async () => {
  // 600x600, every pixel in [248,255] — keeps lumMean > 0.96.
  const buf = makePng(600, 600, (x, y, r) => {
    const v = clamp(248 + ((r() * 8) | 0), 0, 255);
    return [v, v, v, 255];
  });
  const fp = path.join(TMP, "all_white.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  assert.ok(findingCodes(report).includes("TOO_BRIGHT"), `expected TOO_BRIGHT, got ${JSON.stringify(report.findings)}`);
});

// --- MONOCHROME_FLAT vs FLAT_TONALITY dedup --------------------------------

test("MONOCHROME_FLAT fires on single-hue + flat-tonality image", async () => {
  // 600x600 single-hue blue with tiny ±3 noise. lumSpread stays <0.10, single hue.
  const buf = makePng(600, 600, (x, y, r) => {
    const n = ((r() * 7) | 0) - 3;
    return [clamp(40 + n, 0, 255), clamp(60 + n, 0, 255), clamp(200 + n, 0, 255), 255];
  });
  const fp = path.join(TMP, "mono_blue.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  const codes = findingCodes(report);
  assert.ok(codes.includes("MONOCHROME_FLAT"), `expected MONOCHROME_FLAT, got ${JSON.stringify(report.findings)}`);
  // FLAT_TONALITY should be suppressed (dedup) when MONOCHROME_FLAT fires.
  assert.ok(!codes.includes("FLAT_TONALITY"), `FLAT_TONALITY should be suppressed when MONOCHROME_FLAT fires; got ${JSON.stringify(report.findings)}`);
});

// --- Determinism -----------------------------------------------------------

test("auditFile is deterministic for the same input", async () => {
  const buf = makePng(600, 600, (x, y, r) => {
    const n = (r() * 60) | 0;
    return [clamp((x * 200 / 600) + n, 0, 255) | 0, clamp((y * 200 / 600) + n, 0, 255) | 0, clamp(((x + y) % 256) + n, 0, 255) | 0, 255];
  });
  const fp = path.join(TMP, "deterministic.png");
  await writeFile(fp, buf);
  const r1 = await auditFile(fp);
  const r2 = await auditFile(fp);
  assert.deepEqual(findingCodes(r1).sort(), findingCodes(r2).sort(), "audit results must be deterministic across runs");
});

// --- Clean image (smoke) ---------------------------------------------------

test("varied colorful image produces no CRITICAL findings", async () => {
  // 800x600 with full hue sweep + tonal variation + light noise, no transparent corners.
  const buf = makePng(800, 600, (x, y, r) => {
    const h = (x / 800) * 360;
    const s = 0.6 + 0.4 * (y / 600);
    const v = 0.3 + 0.6 * ((x + y) % 200) / 200;
    // HSV → RGB
    const c = v * s, hp = h / 60, xx = c * (1 - Math.abs((hp % 2) - 1));
    let rr=0, gg=0, bb=0;
    if (hp < 1)      [rr, gg, bb] = [c, xx, 0];
    else if (hp < 2) [rr, gg, bb] = [xx, c, 0];
    else if (hp < 3) [rr, gg, bb] = [0, c, xx];
    else if (hp < 4) [rr, gg, bb] = [0, xx, c];
    else if (hp < 5) [rr, gg, bb] = [xx, 0, c];
    else             [rr, gg, bb] = [c, 0, xx];
    const m = v - c;
    const noise = ((r() * 10) | 0) - 5;
    return [
      clamp(((rr + m) * 255) + noise, 0, 255) | 0,
      clamp(((gg + m) * 255) + noise, 0, 255) | 0,
      clamp(((bb + m) * 255) + noise, 0, 255) | 0,
      255,
    ];
  });
  const fp = path.join(TMP, "colorful.png");
  await writeFile(fp, buf);
  const report = await auditFile(fp);
  const criticals = report.findings.filter(f => f.level === "CRITICAL");
  assert.equal(criticals.length, 0, `expected zero CRITICAL findings, got ${JSON.stringify(criticals)}`);
});

// --- teardown --------------------------------------------------------------

test("cleanup", async () => {
  await rm(TMP, { recursive: true, force: true });
});
