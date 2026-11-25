# screenshot-tripwire

Node CLI: pre-commit gate for marketing image assets. Sibling of `trailer-tripwire` and `copy-tripwire`. PNG + JPEG only (no animated formats yet). Deps: pngjs + jpeg-js only; no sharp (pure-JS decode for install-anywhere, keep it that way).

## Commands
```
npx screenshot-tripwire audit <files...>     # exit 2 on CRITICAL
npx screenshot-tripwire audit --json <...>   # machine-readable
npx screenshot-tripwire check                # staged blobs (index content, not working tree) under brand/goneidle-landing/ ONLY (prefix hard-coded in lib/check.mjs); any internal error exits 1
npx screenshot-tripwire install-hooks        # idempotent pre-commit hook
npx st audit <file>                          # short alias
npm test                                     # node --test over test/*.test.mjs (also CI: .github/workflows/test.yml)
```

## Heuristic codes
- CRITICAL: `TINY_FILE` (<5 KB), `STEAM_DIMS` (filename matches a slot but dims aren't canonical or @2x), `TRANSPARENT_CORNER` (any corner alpha < 255; Steam silently rejects; `library_logo*` exempt), `NO_HUE` (grey/black/white only), `TOO_DARK` (mean luminance < 0.04), `TOO_BRIGHT` (> 0.96), `DECODE_FAIL` (decoder error, or a PNG over the 64 MP decode limit or the decode memory budget, which 16-bit PNGs hit first).
- WARN: `MONOCHROME_FLAT` (1 hue family + flat tonality, the AI mood-board tell), `FLAT_TONALITY` (p05-p95 luminance < 0.05), `OVER_COMPRESSED`, `ODD_ASPECT` (no Steam slot match).
- NOTE: `LOW_HUE_DIVERSITY` (1-2 hue families on an otherwise-cohesive image; informational only).

## Steam slot detector (`lib/audit.mjs`)
- `capsule_header*` / `*_capsule_header`: header 460x215
- `capsule_main*` / `*_capsule_main`: main 616x353
- `capsule_vertical*`: vertical 374x448
- `library_hero*`: 3840x1240
- `library_logo*`: 1280x720. Only slot with `allowAlpha` (spec wants a transparent background): no corner check, and no color/luminance checks when it has transparent pixels; fully transparent is still CRITICAL `NO_HUE`
- `screenshot_<n>*` (digit required) / `screen_cap*`: 1920x1080
- `page_bg*` / `page_background*`: any dims

Canonical and `@2x` both pass. If filenames don't match, slot inference is wrong: adapt the patterns, don't relax dim checks.

## Pre-commit hook contract (load-bearing)
Managed block `# screenshot-tripwire:v1` ... `# screenshot-tripwire:v1 end`, command `npx --no -- screenshot-tripwire check || exit $?`. Hook path from `git rev-parse --git-path hooks`. The install algorithm lives in `lib/hook-compose.mjs`, a byte-identical copy shared with copy-tripwire and trailer-tripwire (the family contract): never edit it here, port changes from trailer-tripwire. `lib/install-hooks.mjs` is a thin wrapper. Re-runs rewrite only the own block; sibling blocks and hand-written lines are never touched; legacy hooks migrate keeping every gate; unrelated hooks are refused with the block to paste. Don't break this contract: the siblings depend on it.

## Pending
README "Roadmap": `--ref <ref-image>` mode (mirror trailer-tripwire), animated GIF/WebP, Lighthouse-style perceptual quality, programmatic Node API docs. No `CHANGELOG.md` yet; `v0.1.1` is tagged and matches package.json.
