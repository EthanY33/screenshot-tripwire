/* Compose the git pre-commit hook shared by the tripwire family.
 *
 * copy-tripwire, screenshot-tripwire and trailer-tripwire ship this file
 * byte for byte (src/hook-compose.mjs in trailer-tripwire, lib/hook-compose.mjs
 * in the other two). Never edit one copy on its own: the three installers
 * only leave each other's gates alone because they run the same code.
 *
 * Pure functions: no fs, no process, no imports. The installer in each repo
 * resolves the hook path, reads the file, calls composeHook() and writes the
 * text it returns.
 *
 * Each tool owns exactly one managed block in the hook file:
 *
 *     # <name>:v1
 *     npx --no -- <name> check [args] || exit $?
 *     # <name>:v1 end
 *
 *  - `# <name>:v1` is the long-standing public marker and never changes.
 *  - `--no` makes npx fail when the tool is not installed, instead of
 *    downloading whatever the npm registry serves under that name.
 *  - `|| exit $?` fails closed even when the surrounding hook has no `set -e`.
 *  - No `exec`: the blocks below this one must still run.
 *
 * composeHook(existing, self, selfArgs) picks the first case that applies:
 *
 *  1. No file (or an empty one): write a fresh file with the SELF block.
 *  2. A complete SELF block exists: rewrite that block in place and change
 *     nothing else.
 *  3. The file is "generated": apart from blank lines, comments and `set -e`
 *     it holds nothing but tripwire command lines (every hook the old
 *     installers wrote, and every file made of managed blocks). Rewrite it
 *     as a fresh file with one block per tripwire whose command line was
 *     present, plus SELF, in the fixed order of TRIPWIRES. A sibling keeps
 *     the arguments its command line had. (If one sibling has command lines
 *     with different arguments they cannot fold into one block, so the file
 *     is treated as hand-written instead.)
 *  4. Hand-written content that carries a SELF marker or a SELF command
 *     line: remove those lines only, then append the SELF block.
 *  5. Hand-written content with a sibling block, marker or command line but
 *     nothing of SELF: append the SELF block.
 *  6. No tripwire marker or command at all: refuse and leave the file alone.
 *
 * A command line counts as a tripwire command only when it starts at column 0
 * and nothing but plain arguments follows `check` (and an optional
 * `|| exit`, `|| exit $?` or `|| exit <nonzero>`). An indented line (the body
 * of an if, a function or a loop) and a line that chains, pipes or redirects
 * anything is hand-written and is never removed or rewritten.
 */

export const TRIPWIRES = Object.freeze(['screenshot-tripwire', 'trailer-tripwire', 'copy-tripwire']);

const HEADER = [
  '#!/bin/sh',
  '# Pre-commit hook. Each tripwire gate below is a managed block:',
  '# its installer rewrites only the lines between its own markers.',
  '# Bypass once: git commit --no-verify (say why in the commit message).',
  'set -e',
];

const COMMAND_RE = new RegExp(
  '^(?:exec\\s+)?npx\\s+(?:--no(?:-install)?\\s+(?:--\\s+)?)?(' +
    TRIPWIRES.join('|') +
    ')\\s+check(?:\\s+(.*))?$',
);
const EXIT_SUFFIX_RE = /(?:^|\s)\|\|\s*exit(?:\s+(?:\$\?|[1-9][0-9]*))?$/;
const EXEC_RE = /^\s*exec\s/;
const EXIT_RE = /^exit(?:\s|$)/;

function beginMarker(name) {
  return `# ${name}:v1`;
}

function endMarker(name) {
  return `# ${name}:v1 end`;
}

function assertTripwire(name) {
  if (!TRIPWIRES.includes(name)) {
    throw new TypeError(`unknown tripwire: ${name}`);
  }
}

/* True when `s` is a run of ordinary shell words: quotes are balanced and no
 * unquoted character could end the command, start another one, redirect it
 * or comment out the rest of the line. */
function isPlainArgs(s) {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= s.length) return false;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (';&|<>()`#'.includes(c)) return false;
  }
  return quote === '';
}

function normalizeArgs(args) {
  const raw = args == null ? '' : String(args);
  if (/[\r\n\0]/.test(raw)) {
    throw new TypeError('hook arguments may not contain newlines or null bytes');
  }
  const trimmed = raw.trim();
  if (!isPlainArgs(trimmed)) {
    throw new TypeError('hook arguments must be plain, fully quoted shell words');
  }
  return trimmed;
}

/* The managed block of one tripwire: three lines joined by "\n", with no
 * trailing newline. `args` is shell text placed after `check` as is, so the
 * caller quotes it. */
export function buildBlock(name, args) {
  assertTripwire(name);
  const a = normalizeArgs(args);
  return [
    beginMarker(name),
    `npx --no -- ${name} check${a ? ' ' + a : ''} || exit $?`,
    endMarker(name),
  ].join('\n');
}

function freshFile(blocks) {
  return HEADER.join('\n') + '\n\n' + blocks.join('\n\n') + '\n';
}

function parseCommand(trimmed) {
  const m = COMMAND_RE.exec(trimmed);
  if (!m) return null;
  const args = (m[2] || '').replace(EXIT_SUFFIX_RE, '').trim();
  if (!isPlainArgs(args)) return null;
  return { name: m[1], args };
}

function classify(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return { raw, kind: 'blank' };
  for (const name of TRIPWIRES) {
    if (trimmed === beginMarker(name)) return { raw, kind: 'begin', name };
    if (trimmed === endMarker(name)) return { raw, kind: 'end', name };
  }
  if (trimmed.startsWith('#')) return { raw, kind: 'comment' };
  if (trimmed === 'set -e') return { raw, kind: 'set-e' };
  const command = /^\s/.test(raw) ? null : parseCommand(trimmed);
  if (command) return { raw, kind: 'command', name: command.name, args: command.args };
  return { raw, kind: 'other' };
}

/* A managed block runs from a begin marker to the end marker of the same
 * name, with no other tripwire marker in between. A begin marker that is
 * not closed that way is a legacy marker and is not part of any block.
 * Sets `block` (the owner) on every line of a block and `blockStart` on
 * its first line; returns the set of owners found. */
function markBlocks(lines) {
  const owners = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'begin') continue;
    let j = i + 1;
    while (j < lines.length && lines[j].kind !== 'begin' && lines[j].kind !== 'end') j++;
    if (j >= lines.length || lines[j].kind !== 'end' || lines[j].name !== lines[i].name) continue;
    for (let k = i; k <= j; k++) lines[k].block = lines[i].name;
    lines[i].blockStart = true;
    owners.add(lines[i].name);
    i = j;
  }
  return owners;
}

/* Decide what the pre-commit hook should contain after `self` installs
 * itself with `selfArgs`.
 *
 * existing: current hook text, or null when there is no hook file.
 * Returns { action, text, warnings }:
 *   action   'created' | 'updated' | 'unchanged' | 'migrated' | 'appended'
 *            | 'refused'
 *   text     the full hook text to write (the existing text, untouched,
 *            for 'unchanged' and 'refused')
 *   warnings messages the installer should show the user
 */
export function composeHook(existing, self, selfArgs) {
  const ownBlock = buildBlock(self, selfArgs); // throws on an unknown name or unsafe args

  // Case 1: nothing to preserve.
  if (existing == null || String(existing).trim() === '') {
    return { action: 'created', text: freshFile([ownBlock]), warnings: [] };
  }

  const text = String(existing);
  const endsWithNewline = text.endsWith('\n');
  const rawLines = text.split('\n');
  if (endsWithNewline) rawLines.pop();
  const lines = rawLines.map(classify);
  const owners = markBlocks(lines);

  // Case 2: rewrite the SELF block where it stands.
  if (owners.has(self)) {
    const out = [];
    for (const line of lines) {
      if (line.block === self) {
        if (line.blockStart) out.push(ownBlock);
      } else {
        out.push(line.raw);
      }
    }
    const next = out.join('\n') + (endsWithNewline ? '\n' : '');
    return { action: next === text ? 'unchanged' : 'updated', text: next, warnings: [] };
  }

  // Case 3: a generated file is rewritten as blocks in the fixed order.
  const siblingArgs = new Map();
  let generated = lines.every((line) => line.kind !== 'other');
  let commandCount = 0;
  for (const line of lines) {
    if (line.kind !== 'command') continue;
    commandCount++;
    if (line.name === self) continue;
    if (!siblingArgs.has(line.name)) {
      siblingArgs.set(line.name, line.args);
    } else if (siblingArgs.get(line.name) !== line.args) {
      // Two different scopes for one sibling cannot fold into one block.
      generated = false;
    }
  }
  if (generated && commandCount > 0) {
    const blocks = TRIPWIRES
      .filter((name) => name === self || siblingArgs.has(name))
      .map((name) => (name === self ? ownBlock : buildBlock(name, siblingArgs.get(name))));
    return { action: 'migrated', text: freshFile(blocks), warnings: [] };
  }

  // Cases 4 to 6: hand-written content, kept line for line.
  const isSelfLegacy = (line) =>
    !line.block && line.name === self && (line.kind === 'begin' || line.kind === 'command');
  const hasSelf = lines.some(isSelfLegacy);
  const hasSibling = lines.some((line) => line.name !== undefined && line.name !== self);
  if (!hasSelf && !hasSibling) {
    return { action: 'refused', text, warnings: [] };
  }

  const kept = lines.filter((line) => !isSelfLegacy(line));
  const warnings = [];
  kept.forEach((line, index) => {
    if (line.block) return;
    if (EXEC_RE.test(line.raw)) {
      warnings.push(
        `line ${index + 1} starts with "exec": lines after an exec never run, ` +
          `so the ${self} block appended below it will not run. ` +
          'Move the block above that line.',
      );
    }
    if (EXIT_RE.test(line.raw)) {
      warnings.push(
        `line ${index + 1} is an unconditional "exit": lines after it never run, ` +
          `so the ${self} block appended below it will not run. ` +
          'Move the block above that line.',
      );
    }
    if (/^\s/.test(line.raw) && parseCommand(line.raw.trim())?.name === self) {
      warnings.push(
        `line ${index + 1} runs ${self} from inside a hand-written statement, ` +
          'so it was left in place: it still calls npx without --no and the gate now runs twice. ' +
          'Replace or delete it by hand.',
      );
    }
  });
  const out = kept.map((line) => line.raw);
  if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
  out.push(ownBlock);
  return { action: 'appended', text: out.join('\n') + '\n', warnings };
}
