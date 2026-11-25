#!/usr/bin/env node
// screenshot-tripwire: catches AI-default tells in marketing screenshots before they ship.
// Same ethos as trailer-tripwire — pattern checker, not taste checker. Detects measurable mistakes
// (wrong Steam capsule dims, transparent corners, monochrome palette, blank frames).
//
// Exit codes: 0 if no CRITICAL findings, 2 if any CRITICAL.
// Findings: CRITICAL (block), WARN (advisory), NOTE (informational).
//
// Image decode: pngjs for PNG, jpeg-js for JPEG. Both pure-JS, no native bindings.

import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import jpegJs from "jpeg-js";

// Steam canonical capsule dimensions, by filename pattern.
// Source: partner.steamgames.com Asset Guidelines.
// allowAlpha marks a slot whose spec asks for a transparent background. That is
// the library logo only (Steam draws it over the library hero); every other
// slot must be opaque.
const STEAM_DIMS = [
  { name: "header capsule",   match: /capsule[_-]?header|header[_-]?capsule/i,     w: 460,  h: 215  },
  { name: "main capsule",     match: /capsule[_-]?main|main[_-]?capsule/i,         w: 616,  h: 353  },
  { name: "vertical capsule", match: /capsule[_-]?vertical|vertical[_-]?capsule/i, w: 374,  h: 448  },
  { name: "library hero",     match: /library[_-]?hero|hero[_-]?library/i,         w: 3840, h: 1240 },
  { name: "library logo",     match: /library[_-]?logo|logo[_-]?library/i,         w: 1280, h: 720,  allowAlpha: true },
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

// pngjs has no limits of its own: it allocates width*height*4 bytes for whatever
// size the header declares, and inflates interlaced data with no output cap, so
// a file under 1 MB can cost gigabytes. jpeg-js already caps at 100 MP. The
// largest accepted Steam slot (library hero @2x) is 19 MP.
const MAX_PNG_PIXELS = 64_000_000;
// pngjs holds the scanlines twice (inflated, then unfiltered) plus the RGBA
// bitmap, and at 16 bits the bitmap is 8 bytes a pixel plus a 4 byte 8-bit copy.
// This budget is what an 8-bit RGBA image at the pixel cap costs.
const MAX_PNG_DECODE_BYTES = 768 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // by IHDR color type
const PNG_DEPTHS = [1, 2, 4, 8, 16];

// Walk the PNG chunks and throw before decoding when the image is over the
// pixel limit, or when an interlaced image carries more scanline data than its
// header allows. Malformed files are left for pngjs to report.
function checkPngLimits(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return;
  let header = null;
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const start = off + 8;
    const end = Math.min(start + length, buf.length);
    if (type === "IHDR" && end - start >= 13) {
      // pngjs lets a later IHDR replace an earlier one, so check every one.
      header = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        depth: buf[start + 8],
        colorType: buf[start + 9],
        interlace: buf[start + 12],
      };
      const pixels = header.width * header.height;
      if (pixels > MAX_PNG_PIXELS) {
        throw new Error(`PNG is ${header.width}x${header.height} (${Math.round(pixels / 1e6)} MP), over the ${MAX_PNG_PIXELS / 1e6} MP decode limit`);
      }
      const ch = PNG_CHANNELS[header.colorType];
      if (ch && PNG_DEPTHS.includes(header.depth)) {
        const est = 2 * Math.ceil((pixels * ch * header.depth) / 8) + pixels * (header.depth === 16 ? 12 : 4);
        if (est > MAX_PNG_DECODE_BYTES) {
          throw new Error(`PNG is ${header.width}x${header.height} at ${header.depth} bits, estimated ${Math.round(est / 1048576)} MB to decode, over the ${MAX_PNG_DECODE_BYTES / 1048576} MB memory limit`);
        }
      }
    } else if (type === "IDAT") {
      idat.push(buf.subarray(start, end));
    } else if (type === "IEND") {
      break;
    }
    off = start + length + 4;
  }

  // Non-interlaced data is already capped by pngjs at the declared image size.
  // Headers pngjs rejects are never inflated, so they need no check here.
  if (!header || header.interlace !== 1) return;
  const channels = PNG_CHANNELS[header.colorType];
  if (!channels || !PNG_DEPTHS.includes(header.depth)) return;
  // Upper bound on Adam7 scanline bytes: the packed pixels, plus a filter byte
  // and under one byte of padding for each of the fewer than 2*height+5 rows.
  const maxRaw = Math.ceil((header.width * header.height * channels * header.depth) / 8) + 4 * header.height + 16;
  try {
    inflateSync(Buffer.concat(idat), { maxOutputLength: maxRaw });
  } catch (e) {
    if (e.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`interlaced PNG inflates past the ${maxRaw} bytes its ${header.width}x${header.height} header allows`);
    }
    // Any other inflate error: pngjs hits the same one and reports it.
  }
}

// Decode an image file to {width, height, data: RGBA buffer}.
// Always emits 4-byte RGBA (jpeg-js v0.4+ returns RGBA when useTArray:true; older
// versions returned RGB and the offset math here would silently read garbage).
function decode(filepath, buf) {
  const ext = path.extname(filepath).toLowerCase();
  let width, height, data, hasAlpha;
  if (ext === ".png") {
    checkPngLimits(buf);
    const png = PNG.sync.read(buf);
    ({ width, height, data } = png);
    hasAlpha = true;
  } else if (ext === ".jpg" || ext === ".jpeg") {
    const j = jpegJs.decode(buf, { useTArray: true });
    ({ width, height, data } = j);
    hasAlpha = false;
  } else {
    throw new Error(`unsupported extension: ${ext} (PNG and JPEG only)`);
  }
  // Sanity check: confirm RGBA layout. Catches old jpeg-js (v0.1/v0.2) returning RGB.
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new Error(`decoder returned ${data.length} bytes for ${width}x${height} (expected ${expected} RGBA bytes) — likely an old jpeg-js version returning RGB`);
  }
  return { width, height, data, hasAlpha };
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

// Sample ~targetN pixels via DETERMINISTIC 2D uniform grid. Pre-commit hooks must
// produce identical results every run for the same image — Math.random() makes
// audits flap at boundary thresholds (1 vs 2 hue families, etc.).
//
// 2D grid (vs linear stride) avoids a pathological aliasing case: a linear stride
// of (total / targetN) on square-ish images can equal width, in which case the
// iterator only ever samples column 0. The 2D grid is uniform regardless.
function sampleImage(img, targetN = 4096) {
  const { width, height, data, hasAlpha } = img;
  const samplesPerAxis = Math.max(1, Math.ceil(Math.sqrt(targetN)));
  const xStride = Math.max(1, Math.floor(width  / samplesPerAxis));
  const yStride = Math.max(1, Math.floor(height / samplesPerAxis));
  const buckets = { red: 0, yellow: 0, green: 0, cyan: 0, blue: 0, magenta: 0, neutral: 0 };
  const lums = [];
  let alphaCount = 0;
  let visibleCount = 0;
  let sampled = 0;
  for (let y = 0; y < height; y += yStride) {
    for (let x = 0; x < width; x += xStride) {
      const off = (y * width + x) * 4;
      const r = data[off]     / 255;
      const g = data[off + 1] / 255;
      const b = data[off + 2] / 255;
      const a = (data[off + 3] ?? 255) / 255;
      if (hasAlpha && a < 0.99) alphaCount++;
      if (a > 0) visibleCount++;
      buckets[hueBucket(r, g, b)]++;
      lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      sampled++;
    }
  }
  lums.sort((a, b) => a - b);
  return {
    buckets,
    alphaRatio: sampled > 0 ? alphaCount / sampled : 0,
    visibleRatio: sampled > 0 ? visibleCount / sampled : 0,
    lumMean: sampled > 0 ? lums.reduce((s, v) => s + v, 0) / sampled : 0,
    lumP05: sampled > 0 ? lums[Math.floor(sampled * 0.05)] : 0,
    lumP95: sampled > 0 ? lums[Math.floor(sampled * 0.95)] : 0,
    sampled,
  };
}

// Read all 4 corner pixels. Steam rejects any transparent corner on marketing
// assets. Reports ALL transparent corners, not just the first — saves the user
// from a fix-recheck-find-another cycle on multi-corner failures.
function checkCorners(img) {
  if (!img.hasAlpha) return [];
  const { width: w, height: h, data } = img;
  const corners = [[0, 0, "TL"], [w - 1, 0, "TR"], [0, h - 1, "BL"], [w - 1, h - 1, "BR"]];
  const failures = [];
  for (const [x, y, label] of corners) {
    const off = (y * w + x) * 4;
    const a = data[off + 3];
    if (a < 255) failures.push({ x, y, label, alpha: a });
  }
  return failures;
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
  await stat(filepath);
  const buf = await readFile(filepath);
  return auditBuffer(filepath, buf);
}

// Audit image bytes already in memory. `filepath` is only used for the name
// (extension and Steam slot detection) and for reporting.
export function auditBuffer(filepath, buf) {
  const findings = [];
  const fileStats = { size: buf.length };

  if (fileStats.size < 5_000) {
    findings.push({ level: "CRITICAL", code: "TINY_FILE", msg: `${fileStats.size} bytes — likely empty or corrupted` });
    return { filepath, findings };
  }

  let img;
  try {
    img = decode(filepath, buf);
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

  // Only a slot whose spec requires a transparent background (the library
  // logo) may have transparent corners. Every other asset keeps the check.
  const allowAlpha = Boolean(expected?.allowAlpha);
  const cornerFailures = allowAlpha ? [] : checkCorners(img);
  if (cornerFailures.length > 0) {
    const detail = cornerFailures.map(c => `${c.label}@(${c.x},${c.y}) alpha=${c.alpha}`).join(", ");
    findings.push({
      level: "CRITICAL", code: "TRANSPARENT_CORNER",
      msg: `${cornerFailures.length}/4 corner(s) transparent: ${detail} — Steam rejects RGBA marketing assets with any transparent corner`,
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
  // Art on a transparent background is a logo, not a full frame. White, black
  // and one-color logos are all valid, and the stats also count the RGB hidden
  // under transparent pixels, so the color and luminance checks below do not
  // apply to it. It still has to show something.
  const artOnAlpha = allowAlpha && stats.alphaRatio > 0;
  if (artOnAlpha) {
    if (stats.visibleRatio === 0) {
      findings.push({
        level: "CRITICAL", code: "NO_HUE",
        msg: `no visible pixels in ${stats.sampled} samples: ${expected.name} is fully transparent`,
      });
    }
  } else if (distinctHues === 0) {
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

  if (!artOnAlpha && stats.lumMean < 0.04) {
    findings.push({ level: "CRITICAL", code: "TOO_DARK", msg: `mean luminance ${stats.lumMean.toFixed(3)} — image is effectively black` });
  } else if (!artOnAlpha && stats.lumMean > 0.96) {
    findings.push({ level: "CRITICAL", code: "TOO_BRIGHT", msg: `mean luminance ${stats.lumMean.toFixed(3)} — image is effectively white` });
  }

  // Suppress FLAT_TONALITY when MONOCHROME_FLAT already fired — both describe the
  // same underlying issue (tonally flat) and emitting both adds noise without info.
  const monochromeFlatFired = findings.some(f => f.code === "MONOCHROME_FLAT");
  if (lumSpread < 0.05 && !monochromeFlatFired && !artOnAlpha) {
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
  const usage = "usage: audit.mjs [--json] [--] <file> [<file>...]";
  // --json is the only option. A bare -- ends option parsing, so a file whose
  // name starts with -- can still be audited. Any other --x is an error, never
  // a silently skipped file or a silently ignored typo.
  let jsonMode = false;
  let optionsDone = false;
  const files = [];
  for (const a of process.argv.slice(2)) {
    if (optionsDone || !a.startsWith("--")) files.push(a);
    else if (a === "--") optionsDone = true;
    else if (a === "--json") jsonMode = true;
    else {
      console.error(`audit: unknown option "${a}" (put file names that start with -- after a bare --)\n${usage}`);
      process.exit(64);
    }
  }

  if (files.length === 0) {
    console.error(usage);
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

// Node resolves symlinks and junctions in the main module's path, so
// import.meta.url is the real path while process.argv[1] is the path as typed.
// Compare against both, or a linked install (pnpm, npm link) silently does nothing.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(e => { console.error(e); process.exit(1); });
}
