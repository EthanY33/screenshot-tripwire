# CLAUDE.md — screenshot-tripwire project memory

Node CLI. Pre-commit gate for marketing image assets. Sibling to `trailer-tripwire` and `copy-tripwire`. PNG + JPEG only (no animated formats yet).

## Commands

```
npx screenshot-tripwire audit <files...>     # exit 2 on CRITICAL
npx screenshot-tripwire audit --json <...>   # machine-readable
npx screenshot-tripwire check                # staged images under brand/goneidle-landing/ ONLY (prefix hard-coded in lib/check.mjs)
npx screenshot-tripwire install-hooks        # idempotent pre-commit hook
npx st audit <file>                          # short alias
npm test                                     # node --test test/audit.test.mjs (also run by CI: .github/workflows/test.yml)
```

## Heuristic codes

CRITICAL: `TINY_FILE` (<5 KB), `STEAM_DIMS` (filename matches a slot but dims aren't canonical or @2x), `TRANSPARENT_CORNER` (any corner alpha < 255 — Steam silently rejects), `NO_HUE` (grey/black/white only), `TOO_DARK` (mean luminance < 0.04), `TOO_BRIGHT` (> 0.96), `DECODE_FAIL`.

WARN: `MONOCHROME_FLAT` (1 hue family + flat tonality — the AI mood-board tell), `FLAT_TONALITY` (p05–p95 luminance < 0.05), `OVER_COMPRESSED`, `ODD_ASPECT` (when no Steam slot match).

NOTE: `LOW_HUE_DIVERSITY` (1–2 hue families on otherwise-cohesive image — informational only).

## Steam asset slot detector

Filename patterns recognized in `lib/audit.mjs`:

| Pattern | Slot | Canonical |
|---|---|---|
| `capsule_header*` / `*_capsule_header` | header | 460×215 |
| `capsule_main*` / `*_capsule_main` | main | 616×353 |
| `capsule_vertical*` | vertical | 374×448 |
| `library_hero*` | library hero | 3840×1240 |
| `library_logo*` | library logo | 1280×720 |
| `screenshot_<n>*` (digit required) / `screen_cap*` | screenshot | 1920×1080 |
| `page_bg*` / `page_background*` | page bg | (any) |

Both canonical and `@2x` retina sizes pass. If user filenames don't match, the slot inference will be wrong — adapt the patterns rather than relaxing dim checks.

## Pre-commit hook contract (load-bearing)

Marker: `# screenshot-tripwire:v1`. Idempotent re-runs replace own hook only. **Composes** with `# trailer-tripwire:v1` (the only sibling marker the code recognizes — `copy-tripwire` is not referenced anywhere in this repo). Refuses to overwrite unrelated hooks. **Don't break this contract** — trailer-tripwire depends on it.

## Pending

README "Roadmap": `--ref <ref-image>` mode (mirror trailer-tripwire), animated GIF / WebP support, Lighthouse-style perceptual quality, programmatic Node API docs.

No `CHANGELOG.md` yet. `v0.1.1` is tagged and matches package.json. Deps are pngjs + jpeg-js only (no sharp — pure-JS decode, keep it that way for install-anywhere).
