// Unit tests for src/hook-compose.mjs, the pure module the three tripwire
// installers share byte for byte. Everything here runs for each value of
// SELF, because the sibling repos rely on these results without owning the
// code.
//
// The LEGACY fixtures are the exact hook bodies the old installers wrote
// (trailer-tripwire v0.1.0 and v1.0.0, screenshot-tripwire v0.1.0 and
// copy-tripwire v0.1.0), read from each repo's git history.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TRIPWIRES, buildBlock, composeHook } from "../lib/hook-compose.mjs";

const HEADER = [
  "#!/bin/sh",
  "# Pre-commit hook. Each tripwire gate below is a managed block:",
  "# its installer rewrites only the lines between its own markers.",
  "# Bypass once: git commit --no-verify (say why in the commit message).",
  "set -e",
  "",
  "",
].join("\n");

const DIR = "--dir 'brand/trailers/'";

function block(name, args = "") {
  return `# ${name}:v1\nnpx --no -- ${name} check${args ? " " + args : ""} || exit $?\n# ${name}:v1 end`;
}

function fresh(...blocks) {
  return HEADER + blocks.join("\n\n") + "\n";
}

// The arguments each tool installs with: only trailer-tripwire takes any.
function argsOf(name) {
  return name === "trailer-tripwire" ? DIR : "";
}

function siblingsOf(self) {
  return TRIPWIRES.filter((name) => name !== self);
}

const LEGACY = {
  trailerSolo: (tail = "") => [
    "#!/usr/bin/env bash",
    "# trailer-tripwire:v1",
    "# Auto-installed by: trailer-tripwire install-hooks",
    "# Audits any staged video files for AI-default patterns.",
    "# Bypass with: git commit --no-verify",
    "",
    `npx trailer-tripwire check${tail}`,
    "",
  ].join("\n"),
  screenshotSolo: [
    "#!/bin/sh",
    "# screenshot-tripwire:v1",
    "# Auto-installed by 'npx screenshot-tripwire install-hooks'.",
    "# Audits staged images under brand/goneidle-landing/ for AI-default tells before commit.",
    "# Bypass: git commit --no-verify (document why in the commit message).",
    "",
    "set -e",
    "exec npx screenshot-tripwire check",
    "",
  ].join("\n"),
  // Written by screenshot-tripwire over a trailer-tripwire hook. It drops the
  // trailer marker (and any --dir), so trailer is only visible by its command.
  screenshotOverTrailer: [
    "#!/bin/sh",
    "# screenshot-tripwire:v1",
    "# Composed pre-commit hook: trailer-tripwire + screenshot-tripwire.",
    "set -e",
    "npx screenshot-tripwire check",
    "exec npx trailer-tripwire check",
    "",
  ].join("\n"),
  copySolo: [
    "#!/bin/sh",
    "# copy-tripwire:v1",
    "# Auto-installed by 'npx copy-tripwire install-hooks'.",
    "# Audits staged .md / .html / .txt under brand/goneidle-landing/ for AI-default",
    "# tells (banned phrases, em-dash overdose, fabricated versions, over-bulleting).",
    "# Bypass: git commit --no-verify (document why in the commit message).",
    "",
    "set -e",
    "exec npx copy-tripwire check",
    "",
  ].join("\n"),
  copyComposed: (withTrailer, withScreenshot) => [
    "#!/bin/sh",
    "# copy-tripwire:v1",
    ...(withTrailer ? ["# trailer-tripwire:v1"] : []),
    ...(withScreenshot ? ["# screenshot-tripwire:v1"] : []),
    "# Composed pre-commit hook.",
    "set -e",
    ...(withScreenshot ? ["npx screenshot-tripwire check"] : []),
    ...(withTrailer ? ["npx trailer-tripwire check"] : []),
    "exec npx copy-tripwire check",
    "",
  ].join("\n"),
};

// Every generated legacy shape, with the tripwires whose command line it
// carries and the arguments those lines have.
const LEGACY_SHAPES = [
  { label: "trailer solo", text: LEGACY.trailerSolo(), has: { "trailer-tripwire": "" } },
  {
    label: "trailer solo, single-quoted --dir (v1.0.0)",
    text: LEGACY.trailerSolo(" --dir 'it'\\''s here/'"),
    has: { "trailer-tripwire": "--dir 'it'\\''s here/'" },
  },
  {
    label: "trailer solo, JSON-quoted --dir (v0.1.0)",
    text: LEGACY.trailerSolo(' --dir "brand/trailers/"'),
    has: { "trailer-tripwire": '--dir "brand/trailers/"' },
  },
  { label: "screenshot solo", text: LEGACY.screenshotSolo, has: { "screenshot-tripwire": "" } },
  {
    label: "screenshot composed over trailer",
    text: LEGACY.screenshotOverTrailer,
    has: { "screenshot-tripwire": "", "trailer-tripwire": "" },
  },
  { label: "copy solo", text: LEGACY.copySolo, has: { "copy-tripwire": "" } },
  { label: "copy re-installed alone", text: LEGACY.copyComposed(false, false), has: { "copy-tripwire": "" } },
  {
    label: "copy composed with trailer",
    text: LEGACY.copyComposed(true, false),
    has: { "copy-tripwire": "", "trailer-tripwire": "" },
  },
  {
    label: "copy composed with screenshot",
    text: LEGACY.copyComposed(false, true),
    has: { "copy-tripwire": "", "screenshot-tripwire": "" },
  },
  {
    label: "copy composed with trailer and screenshot",
    text: LEGACY.copyComposed(true, true),
    has: { "copy-tripwire": "", "trailer-tripwire": "", "screenshot-tripwire": "" },
  },
];

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

// ---------------------------------------------------------------- buildBlock

test("TRIPWIRES lists the family in the fixed block order", () => {
  assert.deepEqual(TRIPWIRES, ["screenshot-tripwire", "trailer-tripwire", "copy-tripwire"]);
});

for (const name of TRIPWIRES) {
  test(`buildBlock(${name}) is marker, command, end marker`, () => {
    assert.equal(
      buildBlock(name),
      `# ${name}:v1\nnpx --no -- ${name} check || exit $?\n# ${name}:v1 end`,
    );
    assert.equal(buildBlock(name, ""), buildBlock(name));
    assert.equal(buildBlock(name, null), buildBlock(name));
    assert.equal(
      buildBlock(name, "  --dir 'a b/' "),
      `# ${name}:v1\nnpx --no -- ${name} check --dir 'a b/' || exit $?\n# ${name}:v1 end`,
    );
  });

  test(`buildBlock(${name}) never falls back to the registry, fails closed, never execs`, () => {
    const command = buildBlock(name, DIR).split("\n")[1];
    assert.ok(command.startsWith(`npx --no -- ${name} check`), "--no stops npx from downloading the package");
    assert.ok(command.endsWith(" || exit $?"), "a failed gate must end the hook without set -e");
    assert.doesNotMatch(command, /\bexec\b/, "exec would stop later blocks from running");
  });
}

test("buildBlock rejects unknown tools and arguments that could break out of the line", () => {
  assert.throws(() => buildBlock("lint-tripwire"), /unknown tripwire/);
  assert.throws(() => buildBlock("trailer-tripwire", "--dir a\nrm -rf /"), /newlines or null bytes/);
  assert.throws(() => buildBlock("trailer-tripwire", "--dir a\r"), /newlines or null bytes/);
  assert.throws(() => buildBlock("trailer-tripwire", "--dir a\0b"), /newlines or null bytes/);
  for (const bad of [
    "--dir a; rm -rf /",
    "--dir a && echo hi",
    "--dir a | tee log",
    "--dir a > log",
    "--dir $(pwd)",
    "--dir `pwd`",
    "--dir a # note",
    "--dir 'unclosed",
    '--dir "unclosed',
    "--dir a\\",
  ]) {
    assert.throws(() => buildBlock("trailer-tripwire", bad), /plain/, `accepted: ${bad}`);
  }
  // The same characters are fine once they are quoted or escaped.
  for (const good of [
    "--dir 'a; b && c | d > e $(f) `g` # h'",
    "--dir 'it'\\''s here/'",
    '--dir "a b/"',
    "--dir a\\ b/",
    "--ext mp4,webm --dir brand/trailers/",
  ]) {
    assert.ok(buildBlock("trailer-tripwire", good).includes(` check ${good} || exit $?`), `rejected: ${good}`);
  }
});

test("composeHook rejects an unknown SELF", () => {
  assert.throws(() => composeHook(null, "lint-tripwire", ""), /unknown tripwire/);
});

// --------------------------------------------------------------- composeHook

for (const self of TRIPWIRES) {
  const selfArgs = argsOf(self);
  const own = block(self, selfArgs);
  const [sibA, sibB] = siblingsOf(self);

  test(`${self}: no file gives the fresh file`, () => {
    for (const existing of [null, undefined, "", "\n\n  \n"]) {
      const r = composeHook(existing, self, selfArgs);
      assert.equal(r.action, "created");
      assert.equal(r.text, fresh(own));
      assert.deepEqual(r.warnings, []);
    }
  });

  test(`${self}: installing twice is byte-identical`, () => {
    const first = composeHook(null, self, selfArgs);
    const second = composeHook(first.text, self, selfArgs);
    assert.equal(second.action, "unchanged");
    assert.equal(second.text, first.text);
    assert.deepEqual(second.warnings, []);
  });

  test(`${self}: new arguments rewrite only its own command line`, () => {
    const before = fresh(block(sibA, argsOf(sibA)), block(self, "--dir 'old/'"), block(sibB, argsOf(sibB)))
      .replace(block(sibA, argsOf(sibA)), block(sibA, argsOf(sibA)) + "\n\nnpm run lint");
    const r = composeHook(before, self, "--dir 'new/'");
    assert.equal(r.action, "updated");
    assert.equal(r.text, before.replace("--dir 'old/'", "--dir 'new/'"));
  });

  test(`${self}: the block is rewritten in place, every other byte is kept`, () => {
    const before = [
      "#!/bin/bash\r",
      "  # copy-tripwire:v1 is mentioned here but is not a marker line\r",
      "npm run lint\r",
      `exec npx ${sibA} check && echo done`,
      "",
      `# ${self}:v1`,
      "echo hand-edited inside the managed block",
      `# ${self}:v1 end`,
      "",
      "",
      `npx ${sibB} check`,
      "npm test",
    ].join("\n"); // no trailing newline on purpose
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "updated");
    assert.equal(
      r.text,
      before.replace(
        `# ${self}:v1\necho hand-edited inside the managed block\n# ${self}:v1 end`,
        own,
      ),
    );
    assert.deepEqual(r.warnings, []);
    assert.equal(composeHook(r.text, self, selfArgs).action, "unchanged");
  });

  test(`${self}: a stray legacy marker above the block does not swallow the lines between`, () => {
    const before = `#!/bin/sh\n# ${self}:v1\nnpm run lint\nnpm test\n\n${block(self, "--dir 'old/'")}\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "updated");
    assert.equal(r.text, `#!/bin/sh\n# ${self}:v1\nnpm run lint\nnpm test\n\n${own}\n`);
  });

  test(`${self}: its marker closed by another tool's end marker is not a block`, () => {
    const before = `#!/bin/sh\n# ${self}:v1\nnpm run lint\n# ${sibA}:v1 end\nnpm test\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, `#!/bin/sh\nnpm run lint\n# ${sibA}:v1 end\nnpm test\n\n${own}\n`);
  });

  test(`${self}: every copy of its block is kept in step`, () => {
    const before = `#!/bin/sh\n${block(self, "--dir 'a/'")}\nnpm test\n${block(self, "--dir 'b/'")}\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "updated");
    assert.equal(r.text, `#!/bin/sh\n${own}\nnpm test\n${own}\n`);
  });

  for (const shape of LEGACY_SHAPES) {
    test(`${self}: legacy hook "${shape.label}" migrates with every gate it had`, () => {
      const r = composeHook(shape.text, self, selfArgs);
      const expected = TRIPWIRES
        .filter((name) => name === self || name in shape.has)
        .map((name) => block(name, name === self ? selfArgs : shape.has[name]));
      assert.equal(r.action, "migrated");
      assert.equal(r.text, fresh(...expected));
      assert.deepEqual(r.warnings, []);

      // Stable from here on, for this tool and for every sibling.
      assert.equal(composeHook(r.text, self, selfArgs).action, "unchanged");
      assert.doesNotMatch(r.text, /^\s*exec\s/m);
      assert.doesNotMatch(r.text, /npx\s+(?!--no -- )/);
    });
  }

  test(`${self}: CRLF line endings do not hide a legacy hook`, () => {
    const r = composeHook(LEGACY.copyComposed(true, true).replace(/\n/g, "\r\n"), self, selfArgs);
    assert.equal(r.action, "migrated");
    assert.equal(
      r.text,
      fresh(...TRIPWIRES.map((name) => block(name, name === self ? selfArgs : ""))),
    );
    assert.doesNotMatch(r.text, /\r/);
  });

  test(`${self}: joins a hook made of sibling blocks, in the fixed order`, () => {
    const one = composeHook(fresh(block(sibA, argsOf(sibA))), self, selfArgs);
    assert.equal(one.action, "migrated");
    assert.equal(
      one.text,
      fresh(...TRIPWIRES.filter((n) => n === self || n === sibA).map((n) => block(n, argsOf(n)))),
    );
    const both = composeHook(fresh(block(sibB, argsOf(sibB)), block(sibA, argsOf(sibA))), self, selfArgs);
    assert.equal(both.action, "migrated");
    assert.equal(both.text, fresh(...TRIPWIRES.map((n) => block(n, argsOf(n)))));
  });

  test(`${self}: hand-merged legacy lines are replaced by the block, nothing else moves`, () => {
    const before = [
      "#!/usr/bin/env bash",
      `# ${self}:v1`,
      "npm run lint",
      "npx lint-staged || exit 1",
      `# ${sibA}:v1`,
      `npx ${sibA} check`,
      `npx ${self} check --dir 'old/'`,
      `npx ${sibB} check || exit 1`,
      "npm test",
      "",
    ].join("\n");
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(
      r.text,
      [
        "#!/usr/bin/env bash",
        "npm run lint",
        "npx lint-staged || exit 1",
        `# ${sibA}:v1`,
        `npx ${sibA} check`,
        `npx ${sibB} check || exit 1`,
        "npm test",
        "",
        own,
        "",
      ].join("\n"),
    );
    assert.deepEqual(r.warnings, []);
    assert.equal(composeHook(r.text, self, selfArgs).action, "unchanged");
  });

  test(`${self}: every spelling of its own legacy command is replaced`, () => {
    for (const legacy of [
      `npx ${self} check`,
      `exec npx ${self} check`,
      `npx --no-install ${self} check`,
      `npx --no -- ${self} check || exit $?`,
      `npx ${self} check --dir "old/" || exit 1`,
    ]) {
      const r = composeHook(`#!/bin/sh\nnpm run lint\n${legacy}\n`, self, selfArgs);
      assert.equal(r.action, "appended", legacy);
      assert.equal(r.text, `#!/bin/sh\nnpm run lint\n\n${own}\n`, legacy);
      assert.deepEqual(r.warnings, [], legacy);
    }
  });

  test(`${self}: a line that does more than run the check is hand-written and kept`, () => {
    for (const hand of [
      `npx ${self} check && npm test`,
      `npx ${self} check || true`,
      `npx ${self} check || exit 0`,
      `npx ${self} check; npm test`,
      `npx ${self} check > /dev/null`,
      `npx ${self} check --dir $(pwd)`,
      `npx ${self} check \\`,
      `npx ${self} checkout`,
      `npx --yes ${self} check`,
      `if ! npx ${self} check; then exit 1; fi`,
      `  npx ${self} check --ext mp4,webm || exit`,
    ]) {
      // With its marker present the file is known to be ours to extend, but
      // the hand-written line itself must survive untouched.
      const before = `#!/bin/sh\n# ${self}:v1\n${hand}\nnpm test\n`;
      const r = composeHook(before, self, selfArgs);
      assert.equal(r.action, "appended", hand);
      assert.equal(r.text, `#!/bin/sh\n${hand}\nnpm test\n\n${own}\n`, hand);

      // Without any marker it is simply an unrelated hook.
      const bare = `#!/bin/sh\n${hand}\nnpm test\n`;
      const refused = composeHook(bare, self, selfArgs);
      assert.equal(refused.action, "refused", hand);
      assert.equal(refused.text, bare, hand);
    }
  });

  test(`${self}: appends below hand-written content that carries a sibling, byte for byte`, () => {
    const hand = "#!/bin/sh\r\nnpm run lint\r\n";
    for (const sibling of [
      `${block(sibA, argsOf(sibA))}\nnpm test\n`,
      `# ${sibA}:v1\nnpm test\n`,
      `npx ${sibB} check --dir 'x y/'\nnpm test\n`,
      `exec npx ${sibB} check\n`,
      `${block(sibA, "--dir 'a/'")}\n${block(sibB, "--dir 'b/'")}\n\n\n`,
    ]) {
      const before = hand + sibling;
      const r = composeHook(before, self, selfArgs);
      assert.equal(r.action, "appended", sibling);
      const blank = before.endsWith("\n\n") ? "" : "\n";
      assert.equal(r.text, before + blank + own + "\n", sibling);
      assert.equal(composeHook(r.text, self, selfArgs).action, "unchanged", sibling);
    }
  });

  test(`${self}: appends after a last line that has no newline`, () => {
    const before = `#!/bin/sh\nnpm run lint\nnpx ${sibA} check`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, `${before}\n\n${own}\n`);
  });

  test(`${self}: a sibling block someone edited by hand is left exactly as it is`, () => {
    const edited = `# ${sibA}:v1\nnpx --no -- ${sibA} check || echo "not blocking"\n# ${sibA}:v1 end`;
    const before = fresh(edited);
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, before + "\n" + own + "\n");
  });

  test(`${self}: nothing inside a sibling block is removed, not even its own command`, () => {
    const before = `#!/bin/sh\nnpm run lint\n# ${sibA}:v1\nnpx ${self} check\n# ${sibA}:v1 end\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, before + "\n" + own + "\n");
  });

  test(`${self}: a sibling gate with two different scopes is not folded into one block`, () => {
    const before = `#!/bin/sh\nset -e\nnpx ${sibA} check --dir 'a/'\nnpx ${sibA} check --dir 'b/'\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, before + "\n" + own + "\n");
  });

  test(`${self}: its own legacy commands with different scopes still become one block`, () => {
    const before = `#!/bin/sh\nset -e\nnpx ${self} check --dir 'a/'\nnpx ${sibA} check\nnpx ${self} check --dir 'b/'\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "migrated");
    assert.equal(
      r.text,
      fresh(...TRIPWIRES.filter((n) => n === self || n === sibA).map((n) => block(n, n === self ? selfArgs : ""))),
    );
  });

  test(`${self}: a marker with no command is not enough to rewrite the file`, () => {
    const before = `#!/bin/sh\n# ${self}:v1\n# notes the user keeps here\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, `#!/bin/sh\n# notes the user keeps here\n\n${own}\n`);
  });

  test(`${self}: an end marker that lost its begin marker is not a legacy line to remove`, () => {
    const before = `#!/bin/sh\nnpm run lint\nnpx ${self} check\n# ${self}:v1 end\nnpm test\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, `#!/bin/sh\nnpm run lint\n# ${self}:v1 end\nnpm test\n\n${own}\n`);
    assert.equal(composeHook(r.text, self, selfArgs).action, "unchanged");
  });

  test(`${self}: an unrelated hook is refused and returned untouched`, () => {
    for (const before of [
      "#!/bin/sh\nnpm run lint\nnpm test\n",
      "#!/bin/sh\n# only comments and settings\nset -e\n",
      `#!/bin/sh\n# see the docs for # ${self}:v1 before editing\nnpm test\n`,
      `#!/bin/sh\necho "# ${self}:v1"\n`,
      "#!/bin/sh\nnpx lint-staged\r\n",
    ]) {
      const r = composeHook(before, self, selfArgs);
      assert.equal(r.action, "refused", before);
      assert.equal(r.text, before, before);
      assert.deepEqual(r.warnings, [], before);
    }
  });

  test(`${self}: warns when the appended block lands below an exec line`, () => {
    const before = `#!/bin/sh\n# ${sibA}:v1\nnpm run lint\nexec npx ${sibA} check\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, before + "\n" + own + "\n");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^line 4 starts with "exec"/);
    assert.match(r.warnings[0], /never run/);
    assert.ok(r.warnings[0].includes(self));
  });

  test(`${self}: warns when the appended block lands below an unconditional exit`, () => {
    const before = `#!/bin/sh\n# ${self}:v1\nnpm run lint || exit 1\nnpx ${self} check || exit 1\nexit 0\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^line 3 is an unconditional "exit"/);
    assert.match(r.warnings[0], /never run/);
  });

  test(`${self}: a conditional exit and an exit inside a sibling block do not warn`, () => {
    const cond = `#!/bin/sh\nif [ -n "$SKIP" ]; then\n  exit 0\nfi\nnpx ${self} check\n`;
    const r = composeHook(cond, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.deepEqual(r.warnings, []);
    const sibling = `# ${sibA}:v1\nexit 0\n# ${sibA}:v1 end`;
    const r2 = composeHook(`#!/bin/sh\nnpm run lint\n${sibling}\n`, self, selfArgs);
    assert.equal(r2.action, "appended");
    assert.deepEqual(r2.warnings, []);
  });

  test(`${self}: an indented own command inside an if is kept and warned about`, () => {
    const body = `if command -v npx >/dev/null; then\n  npx ${self} check\nfi\nnpm test\n`;
    const marked = `#!/bin/sh\n# ${self}:v1\n${body}`;
    const r = composeHook(marked, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, `#!/bin/sh\n${body}\n${own}\n`);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^line 3 runs /);
    const bare = `#!/bin/sh\n${body}`;
    const refused = composeHook(bare, self, selfArgs);
    assert.equal(refused.action, "refused");
    assert.equal(refused.text, bare);
  });

  test(`${self}: its own removed exec line and exec inside a sibling block do not warn`, () => {
    const sibling = `# ${sibA}:v1\nexec npx ${sibA} check\n# ${sibA}:v1 end`;
    const before = `#!/bin/sh\nnpm run lint\n${sibling}\nexec npx ${self} check\n`;
    const r = composeHook(before, self, selfArgs);
    assert.equal(r.action, "appended");
    assert.equal(r.text, `#!/bin/sh\nnpm run lint\n${sibling}\n\n${own}\n`);
    assert.deepEqual(r.warnings, []);
  });
}

// ------------------------------------------------------------ whole family

test("any install order ends in the same file, and re-installs change nothing", () => {
  const canonical = fresh(...TRIPWIRES.map((name) => block(name, argsOf(name))));
  for (const order of permutations(TRIPWIRES)) {
    let text = null;
    for (const name of order) text = composeHook(text, name, argsOf(name)).text;
    assert.equal(text, canonical, `order: ${order.join(", ")}`);
    for (const name of order) {
      const again = composeHook(text, name, argsOf(name));
      assert.equal(again.action, "unchanged", `re-install of ${name}`);
      assert.equal(again.text, canonical);
    }
  }
});

test("trailer --dir survives sibling installs and re-installs, from every legacy start", () => {
  const dir = "--dir 'it'\\''s here/'";
  const starts = [
    null,
    LEGACY.trailerSolo(` ${dir}`),
    fresh(block("trailer-tripwire", dir)),
    `#!/bin/sh\nnpm run lint\n\n${block("trailer-tripwire", dir)}\nnpm test\n`,
  ];
  for (const start of starts) {
    let text = composeHook(start, "trailer-tripwire", dir).text;
    for (const name of ["copy-tripwire", "screenshot-tripwire", "copy-tripwire", "screenshot-tripwire"]) {
      text = composeHook(text, name, "").text;
      assert.ok(text.includes(block("trailer-tripwire", dir)), `lost after ${name}:\n${text}`);
    }
    for (const name of TRIPWIRES) assert.ok(text.includes(`# ${name}:v1 end`));
  }
});

test("a sibling install never changes another block or a hand-written line", () => {
  const before = [
    "#!/bin/sh",
    "npm run lint",
    "",
    block("trailer-tripwire", "--dir 'brand/trailers/'"),
    "",
    "npx lint-staged || exit 1",
    "",
  ].join("\n");
  let text = before;
  for (const name of ["copy-tripwire", "screenshot-tripwire", "copy-tripwire", "trailer-tripwire"]) {
    const r = composeHook(text, name, name === "trailer-tripwire" ? "--dir 'brand/trailers/'" : "");
    assert.ok(r.text.startsWith(before), `${name} changed existing lines:\n${r.text}`);
    text = r.text;
  }
  assert.equal(text, `${before}\n${block("copy-tripwire")}\n\n${block("screenshot-tripwire")}\n`);
});
