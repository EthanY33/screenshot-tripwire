# screenshot-tripwire

Node CLI: pre-commit gate for marketing image assets. Sibling of `trailer-tripwire` and `copy-tripwire`. PNG + JPEG only (no animated formats yet). Deps: pngjs + jpeg-js only; no sharp (pure-JS decode for install-anywhere, keep it that way).

## Commands
```
npx screenshot-tripwire audit <files...>     # exit 2 on CRITICAL
npx screenshot-tripwire audit --json <...>   # machine-readable
npx screenshot-tripwire check                # staged images under brand/goneidle-landing/ ONLY (prefix hard-coded in lib/check.mjs)
npx screenshot-tripwire install-hooks        # idempotent pre-commit hook
npx st audit <file>                          # short alias
npm test                                     # node --test test/audit.test.mjs (also CI: .github/workflows/test.yml)
```

## Heuristic codes
- CRITICAL: `TINY_FILE` (<5 KB), `STEAM_DIMS` (filename matches a slot but dims aren't canonical or @2x), `TRANSPARENT_CORNER` (any corner alpha < 255; Steam silently rejects), `NO_HUE` (grey/black/white only), `TOO_DARK` (mean luminance < 0.04), `TOO_BRIGHT` (> 0.96), `DECODE_FAIL`.
- WARN: `MONOCHROME_FLAT` (1 hue family + flat tonality, the AI mood-board tell), `FLAT_TONALITY` (p05-p95 luminance < 0.05), `OVER_COMPRESSED`, `ODD_ASPECT` (no Steam slot match).
- NOTE: `LOW_HUE_DIVERSITY` (1-2 hue families on an otherwise-cohesive image; informational only).

## Steam slot detector (`lib/audit.mjs`)
- `capsule_header*` / `*_capsule_header`: header 460x215
- `capsule_main*` / `*_capsule_main`: main 616x353
- `capsule_vertical*`: vertical 374x448
- `library_hero*`: 3840x1240
- `library_logo*`: 1280x720
- `screenshot_<n>*` (digit required) / `screen_cap*`: 1920x1080
- `page_bg*` / `page_background*`: any dims

Canonical and `@2x` both pass. If filenames don't match, slot inference is wrong: adapt the patterns, don't relax dim checks.

## Pre-commit hook contract (load-bearing)
Marker `# screenshot-tripwire:v1`. Idempotent re-runs replace own hook only. Composes with `# trailer-tripwire:v1` (the only sibling marker the code recognizes; `copy-tripwire` is not referenced anywhere in this repo). Refuses to overwrite unrelated hooks. Don't break this contract: trailer-tripwire depends on it.

## Pending
README "Roadmap": `--ref <ref-image>` mode (mirror trailer-tripwire), animated GIF/WebP, Lighthouse-style perceptual quality, programmatic Node API docs. No `CHANGELOG.md` yet; `v0.1.1` is tagged and matches package.json.
