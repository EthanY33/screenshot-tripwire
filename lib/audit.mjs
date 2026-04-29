#!/usr/bin/env node
// screenshot-tripwire: catches AI-default tells in marketing screenshots before they ship.
// Same ethos as trailer-tripwire — pattern checker, not taste checker. Detects measurable mistakes
// (wrong Steam capsule dims, transparent corners, monochrome palette, blank frames).
//
// Exit codes: 0 if no CRITICAL findings, 2 if any CRITICAL.
// Findings: CRITICAL (block), WARN (advisory), NOTE (informational).
//
// Image decode: pngjs for PNG, jpeg-js for JPEG. Both pure-JS, no native bindings.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import jpegJs from "jpeg-js";

// Steam canonical capsule dimensions, by filename pattern.
// Source: partner.steamgames.com Asset Guidelines.
const STEAM_DIMS = [
  { name: "header capsule",   match: /capsule[_-]?header|header[_-]?capsule/i,     w: 460,  h: 215  },
  { name: "main capsule",     match: /capsule[_-]?main|main[_-]?capsule/i,         w: 616,  h: 353  },
  { name: "vertical capsule", match: /capsule[_-]?vertical|vertical[_-]?capsule/i, w: 374,  h: 448  },
  { name: "library hero",     match: /library[_-]?hero|hero[_-]?library/i,         w: 3840, h: 1240 },
  { name: "library logo",     match: /library[_-]?logo|logo[_-]?library/i,         w: 1280, h: 720  },
  { name: "page background",  match: /page[_-]?bg|page[_-]?background/i,           w: null, h: null },
  { name: "Steam screenshot", match: /(^|[_-])screenshot[_-]?\d|screen[_-]?cap/i,  w: 1920, h: 1080 },
];

const ACCEPTED_ASPECT_RATIOS = [
  { label: "16:9",  ratio: 16/9, tol: 0.005 },
  { label: "4:3",   ratio: 4/3,  tol: 0.005 },
  { label: "1:1",   ratio: 1,    tol: 0.005 },
  { label: "21:9",  ratio: 21/9, tol: 0.005 },
  { label: "Steam header (460:215)",   ratio: 460/215, tol: 0.005 },
  { label: "Steam main (616:353)",     ratio: 616/353, tol: 0.005 },
  { label: "Steam vertical (374:448)", ratio: 374/448, tol: 0.005 },
];

// Decode an image file to {width, height, data: RGBA buffer}.
async function decode(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const buf = await readFile(filepath);
  if (ext === ".png") {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data, hasAlpha: true };
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    const j = jpegJs.decode(buf, { useTArray: true });
    return { width: j.width, height: j.height, data: j.data, hasAlpha: false };
  }
  throw new Error(`unsupported extension: ${ext} (PNG and JPEG only)`);
}

// Convert RGB to hue family bucket. Returns "red"|"yellow"|"green"|"cyan"|"blue"|"magenta"|"neutral".
function hueBucket(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.15 || max < 0.1) return "neutral";
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = ((h * 60) + 360) % 360;
  if (h < 30 || h >= 330) return "red";
  if (h < 90)  return "yellow";
  if (h < 150) return "green";
  if (h < 210) return "cyan";
  if (h < 270) return "blue";
  return "magenta";
}

// Sample ~targetN pixels via DETERMINISTIC uniform stride. Pre-commit hooks must
// produce identical results every run for the same image — Math.random() makes
// audits flap at boundary thresholds (1 vs 2 hue families, etc.). The stride
// pattern walks a uniform grid hitting roughly targetN samples regardless of dims.
function sampleImage(img, targetN = 4096) {
  const { width, height, data, hasAlpha } = img;
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / targetN));
  const buckets = { red: 0, yellow: 0, green: 0, cyan: 0, blue: 0, magenta: 0, neutral: 0 };
  const lums = [];
  let alphaCount = 0;
  let sampled = 0;
  for (let p = 0; p < total; p += stride) {
    const off = p * 4;
    const r = data[off]     / 255;
    const g = data[off + 1] / 255;
    const b = data[off + 2] / 255;
    const a = (data[off + 3] ?? 255) / 255;
    if (hasAlpha && a < 0.99) alphaCount++;
    buckets[hueBucket(r, g, b)]++;
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    sampled++;
  }
  lums.sort((a, b) => a - b);
  return {
    buckets,
    alphaRatio: sampled > 0 ? alphaCount / sampled : 0,
    lumMean: lums.reduce((s, v) => s + v, 0) / lums.length,
    lumP05: lums[Math.floor(sampled * 0.05)],
    lumP95: lums[Math.floor(sampled * 0.95)],
    sampled,
  };
}

// Read corner pixels directly. Steam rejects any transparent corner on marketing assets.
function checkCorners(img) {
  if (!img.hasAlpha) return null;
  const { width: w, height: h, data } = img;
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  for (const [x, y] of corners) {
    const off = (y * w + x) * 4;
    const a = data[off + 3];
    if (a < 255) return { x, y, alpha: a };
  }
  return null;
}

function expectedDims(filename) {
  const base = path.basename(filename).toLowerCase();
  for (const d of STEAM_DIMS) if (d.match.test(base)) return d;
  return null;
}

function expectedAspect(w, h) {
  const r = w / h;
  for (const a of ACCEPTED_ASPECT_RATIOS) if (Math.abs(r - a.ratio) < a.tol) return a;
  return null;
}

export async function auditFile(filepath) {
  const findings = [];
  const fileStats = await stat(filepath);

  if (fileStats.size < 5_000) {
    findings.push({ level: "CRITICAL", code: "TINY_FILE", msg: `${fileStats.size} bytes — likely empty or corrupted` });
    return { filepath, findings };
  }

  let img;
  try {
    img = await decode(filepath);
  } catch (e) {
    findings.push({ level: "CRITICAL", code: "DECODE_FAIL", msg: `decode failed: ${e.message}` });
    return { filepath, findings };
  }

  const { width, height } = img;

  const expected = expectedDims(filepath);
  if (expected && expected.w) {
    const exact = (expected.w === width && expected.h === height);
    const at2x  = (expected.w * 2 === width && expected.h * 2 === height); // Steam accepts @2x
    if (!exact && !at2x) {
      findings.push({
        level: "CRITICAL", code: "STEAM_DIMS",
        msg: `${expected.name} expected ${expected.w}x${expected.h} (or ${expected.w*2}x${expected.h*2} @2x), got ${width}x${height}`,
      });
    }
  }

  if (!expected) {
    const aspect = expectedAspect(width, height);
    if (!aspect) {
      findings.push({
        level: "WARN", code: "ODD_ASPECT",
        msg: `aspect ratio ${(width / height).toFixed(3)} (${width}x${height}) is not 16:9 / 4:3 / 1:1 / 21:9`,
      });
    }
  }

  const corner = checkCorners(img);
  if (corner) {
    findings.push({
      level: "CRITICAL", code: "TRANSPARENT_CORNER",
      msg: `corner at (${corner.x}, ${corner.y}) has alpha=${corner.alpha} — Steam rejects RGBA marketing assets with any transparent corner`,
    });
  }

  const stats = sampleImage(img);
  // Hue diversity: a brand can be intentionally cohesive (e.g. deep-blue palette), so a single
  // dominant hue isn't a CRITICAL block — but a TRULY flat single-hue image with no tonal
  // variation IS the AI "single-mood mood-board" tell. We split this:
  //   - CRITICAL: 0 hues above noise (image is grey/black/white only — likely a render failure)
  //   - WARN:     1 hue family AND tonally flat (likely AI mood-board output)
  //   - NOTE:     1-2 hue families on a brand-cohesive image (informational)
  // Threshold is proportional to actual sample count (was hardcoded 100 / 4096 = 2.4%).
  const hueThreshold = Math.max(20, Math.floor(stats.sampled * 0.025));
  const distinctHues = Object.entries(stats.buckets).filter(([k, v]) => k !== "neutral" && v > hueThreshold).length;
  const lumSpread = stats.lumP95 - stats.lumP05;
  if (distinctHues === 0) {
    findings.push({
      level: "CRITICAL", code: "NO_HUE",
      msg: `zero distinct hue families above threshold — image is grey/black/white only. Buckets: ${JSON.stringify(stats.buckets)}`,
    });
  } else if (distinctHues === 1 && lumSpread < 0.10) {
    findings.push({
      level: "WARN", code: "MONOCHROME_FLAT",
      msg: `1 hue family + flat tonality (lum spread ${lumSpread.toFixed(3)}) — common AI mood-board tell`,
    });
  } else if (distinctHues < 3) {
    findings.push({
      level: "NOTE", code: "LOW_HUE_DIVERSITY",
      msg: `${distinctHues} distinct hue families — fine for cohesive brand art, but worth checking the asset isn't one-mood AI output`,
    });
  }

  if (stats.lumMean < 0.04) {
    findings.push({ level: "CRITICAL", code: "TOO_DARK", msg: `mean luminance ${stats.lumMean.toFixed(3)} — image is effectively black` });
  } else if (stats.lumMean > 0.96) {
    findings.push({ level: "CRITICAL", code: "TOO_BRIGHT", msg: `mean luminance ${stats.lumMean.toFixed(3)} — image is effectively white` });
  }

  if (lumSpread < 0.05) {
    findings.push({
      level: "WARN", code: "FLAT_TONALITY",
      msg: `p05-p95 luminance spread ${lumSpread.toFixed(3)} — image is tonally flat (no contrast)`,
    });
  }

  if (fileStats.size < 30_000 && (width * height) > 100_000) {
    findings.push({
      level: "WARN", code: "OVER_COMPRESSED",
      msg: `${fileStats.size} bytes for ${width}x${height} — heavy compression or upscale artifact`,
    });
  }

  return { filepath, width, height, sizeBytes: fileStats.size, findings };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const files = args.filter(a => !a.startsWith("--"));

  if (files.length === 0) {
    console.error("usage: audit.mjs [--json] <file> [<file>...]");
    process.exit(64);
  }

  const reports = [];
  for (const f of files) {
    try { reports.push(await auditFile(f)); }
    catch (e) { reports.push({ filepath: f, findings: [{ level: "CRITICAL", code: "AUDIT_FAIL", msg: e.message }] }); }
  }

  const totalCritical = reports.reduce((n, r) => n + r.findings.filter(f => f.level === "CRITICAL").length, 0);

  if (jsonMode) {
    console.log(JSON.stringify({ reports, totalCritical }, null, 2));
  } else {
    for (const r of reports) {
      const head = `${r.filepath}${r.width ? ` [${r.width}x${r.height}, ${(r.sizeBytes/1024).toFixed(1)} KB]` : ""}`;
      console.log(head);
      if (r.findings.length === 0) { console.log("  ok"); continue; }
      for (const f of r.findings) console.log(`  ${f.level.padEnd(8)} ${f.code.padEnd(20)} ${f.msg}`);
    }
    console.log(`\n${reports.length} file(s) audited — ${totalCritical} CRITICAL finding(s)`);
  }

  process.exit(totalCritical > 0 ? 2 : 0);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(e => { console.error(e); process.exit(1); });
}
