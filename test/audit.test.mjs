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
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";

import { auditFile } from "../lib/audit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "..", "lib");
const CLI = path.resolve(HERE, "..", "bin", "cli.mjs");

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

// --- PNG decode limits -----------------------------------------------------
//
// These PNGs are built by hand: pngjs cannot write interlaced files, and
// writing a 144 MP image through it would need half a gigabyte.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// Build a PNG from scanline bytes that already carry their filter bytes.
// `pad` adds an ancillary chunk of that many bytes so a small image still
// clears the 5 KB TINY_FILE gate and reaches the decoder.
function rawPng({ width, height, depth, colorType, interlace = 0 }, raw, pad = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const chunks = [PNG_SIG, pngChunk("IHDR", ihdr)];
  if (pad > 0) chunks.push(pngChunk("teSt", Buffer.alloc(pad, 0x41)));
  chunks.push(pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

// Exact size of Adam7 interlaced scanline data: per pass, one filter byte plus
// the packed row, for every row.
function adam7RawSize(width, height, bitsPerPixel) {
  const xs = [0, 4, 0, 2, 0, 1, 0], ys = [0, 0, 4, 0, 2, 0, 1];
  const dx = [8, 8, 4, 4, 2, 2, 1], dy = [8, 8, 8, 4, 4, 2, 2];
  let total = 0;
  for (let p = 0; p < 7; p++) {
    const pw = Math.ceil((width - xs[p]) / dx[p]);
    const ph = Math.ceil((height - ys[p]) / dy[p]);
    if (pw > 0 && ph > 0) total += ph * (1 + Math.ceil((pw * bitsPerPixel) / 8));
  }
  return total;
}

// Audit one file in a fresh process and report that process's peak memory.
function auditInChild(fp) {
  const script = [
    `import { auditFile } from ${JSON.stringify(pathToFileURL(path.join(LIB, "audit.mjs")).href)};`,
    "const report = await auditFile(process.argv[1]);",
    "console.log(JSON.stringify({ report, maxRssMb: process.resourceUsage().maxRSS / 1024 }));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, fp], { encoding: "utf8" });
  assert.equal(r.status, 0, `child audit failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("DECODE_FAIL refuses a PNG over the pixel limit before decoding it", async () => {
  // 12000x12000 (144 MP) 1-bit greyscale, all zero: about 18 KB on disk, but
  // pngjs would allocate width*height*4 = 576 MB to decode it.
  const width = 12000, height = 12000;
  const raw = Buffer.alloc(height * (1 + width / 8));
  const fp = path.join(TMP, "huge_dims.png");
  await writeFile(fp, rawPng({ width, height, depth: 1, colorType: 0 }, raw));
  const { report, maxRssMb } = auditInChild(fp);
  const f = report.findings.find(x => x.code === "DECODE_FAIL");
  assert.ok(f, `expected DECODE_FAIL, got ${JSON.stringify(report.findings)}`);
  assert.match(f.msg, /12000x12000/);
  assert.match(f.msg, /limit/);
  assert.equal(report.width, undefined, "image must not have been decoded");
  assert.ok(maxRssMb < 300, `peak RSS ${maxRssMb.toFixed(0)} MB, expected under 300 MB`);
});

test("DECODE_FAIL refuses an interlaced PNG whose data inflates past its declared size", async () => {
  // Declares 8x8 RGBA (a few hundred bytes of scanlines) but carries 64 MB.
  const fp = path.join(TMP, "interlaced_bomb.png");
  await writeFile(fp, rawPng({ width: 8, height: 8, depth: 8, colorType: 6, interlace: 1 }, Buffer.alloc(64 * 1024 * 1024)));
  const { report, maxRssMb } = auditInChild(fp);
  const f = report.findings.find(x => x.code === "DECODE_FAIL");
  assert.ok(f, `expected DECODE_FAIL, got ${JSON.stringify(report.findings)}`);
  assert.match(f.msg, /interlaced/);
  assert.match(f.msg, /inflates past/);
  assert.ok(maxRssMb < 300, `peak RSS ${maxRssMb.toFixed(0)} MB, expected under 300 MB`);
});

test("valid interlaced PNGs of awkward sizes and bit depths still decode", async () => {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const cases = [
    { width: 1,   height: 1,   depth: 1,  colorType: 0 },
    { width: 3,   height: 5,   depth: 1,  colorType: 0 },
    { width: 9,   height: 9,   depth: 2,  colorType: 0 },
    { width: 33,  height: 17,  depth: 4,  colorType: 0 },
    { width: 13,  height: 3,   depth: 8,  colorType: 2 },
    { width: 7,   height: 13,  depth: 16, colorType: 4 },
    { width: 5,   height: 5,   depth: 16, colorType: 6 },
    { width: 600, height: 600, depth: 8,  colorType: 6 },
  ];
  for (const c of cases) {
    const raw = Buffer.alloc(adam7RawSize(c.width, c.height, c.depth * channels[c.colorType]));
    const label = `${c.width}x${c.height} depth ${c.depth} type ${c.colorType}`;
    const fp = path.join(TMP, `interlaced_${c.width}x${c.height}_${c.depth}_${c.colorType}.png`);
    await writeFile(fp, rawPng({ ...c, interlace: 1 }, raw, 6000));
    const report = await auditFile(fp);
    assert.ok(!findingCodes(report).includes("DECODE_FAIL"), `${label}: unexpected DECODE_FAIL ${JSON.stringify(report.findings)}`);
    assert.equal(report.width, c.width, label);
    assert.equal(report.height, c.height, label);
  }
});

// --- audit argument parsing ------------------------------------------------

function runAudit(cwd, args) {
  return spawnSync(process.execPath, [CLI, "audit", ...args], { cwd, encoding: "utf8" });
}

test("audit treats arguments after -- as files, even when they start with --", async () => {
  await writeFile(path.join(TMP, "--bad.png"), Buffer.from("junk"));
  const r = runAudit(TMP, ["--", "--bad.png"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--bad\.png/);
  assert.match(r.stdout, /TINY_FILE/);
  assert.match(r.stdout, /1 file\(s\) audited/);
});

test("audit rejects an unknown option instead of ignoring it", async () => {
  await writeFile(path.join(TMP, "x.png"), Buffer.from("junk"));
  const r = runAudit(TMP, ["--jsno", "x.png"]);
  assert.equal(r.status, 64, `expected exit 64, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--jsno/);
  assert.doesNotMatch(r.stdout, /audited/);
});

test("audit --json still works before or after the file list", async () => {
  const buf = makePng(600, 600, (x, y, r) => [(r() * 256) | 0, (r() * 256) | 0, (r() * 256) | 0, 255]);
  await writeFile(path.join(TMP, "good.png"), buf);
  for (const args of [["--json", "good.png"], ["good.png", "--json"]]) {
    const r = runAudit(TMP, args);
    assert.equal(r.status, 0, `expected exit 0 for ${args.join(" ")}, got ${r.status}: ${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.reports.length, 1);
    assert.equal(out.totalCritical, 0);
  }
});

// --- direct invocation through a linked path --------------------------------

test("lib/audit.mjs runs when invoked through a symlinked or junctioned directory", async () => {
  // A junction needs no privilege on Windows; elsewhere the type is ignored
  // and a plain directory symlink is made. The link gets its own tmpdir and is
  // unlinked on its own, so nothing ever recurses through it into lib/.
  const dir = await mkdtemp(path.join(tmpdir(), "st-link-"));
  const link = path.join(dir, "lib-link");
  const tiny = path.join(dir, "tiny.png");
  await writeFile(tiny, Buffer.from("not a png"));
  await symlink(LIB, link, "junction");
  let r;
  try {
    r = spawnSync(process.execPath, [path.join(link, "audit.mjs"), tiny], { encoding: "utf8" });
  } finally {
    await unlink(link);
  }
  await rm(dir, { recursive: true, force: true });
  assert.equal(r.status, 2, `expected exit 2 through the link, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /TINY_FILE/);
});

// --- teardown --------------------------------------------------------------

test("cleanup", async () => {
  await rm(TMP, { recursive: true, force: true });
});
