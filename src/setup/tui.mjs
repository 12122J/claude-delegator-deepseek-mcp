// The wizard's visual language. Zero dependencies.
//
// Everything renders as one connected "delegation window" — a step rail in
// the style of modern CLIs (Claude Code, clack, charm):
//
//   ┌  title                     intro()
//   │  subtitle
//   │
//   ◆  Provider                  select() while active (● cursor, ○ rest)
//   │  ● DeepSeek  from $0.14/M
//   │  ○ Moonshot  …
//   │
//   ◇  Provider                  …collapsed once answered
//   │  DeepSeek
//   │
//   └  Done.                     outro()
//
// Every helper restores the terminal on EVERY exit path — raw mode off,
// cursor shown — including ctrl-c / esc / q, which reject with AbortError so
// the caller exits cleanly instead of leaving a broken terminal behind.
// Without a TTY, helpers degrade to plain lines / defaults and never block.

import { color, bold, dim } from '../colors.mjs';

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export function isInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

const CSI = '\x1b[';
const out = (s) => process.stdout.write(s);
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleWidth = (s) => s.replace(ANSI_RE, '').length;

// Clamp a line to the terminal width. Redrawn widgets move the cursor up by
// their line count; a line that soft-wraps occupies TWO physical rows and
// breaks that math, leaving a stale ghost line behind on every repaint. Every
// line a widget repaints must pass through here. ANSI sequences are copied
// for free; a truncation ends with "…" + reset so styles never leak.
function fitWidth(s) {
  const cols = (process.stdout.columns || 80) - 1;
  if (visibleWidth(s) <= cols) return s;
  let visible = 0;
  let res = '';
  for (let i = 0; i < s.length;) {
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m) { res += m[0]; i += m[0].length; continue; }
    if (visible >= cols - 1) break;
    res += s[i]; visible++; i++;
  }
  return res + `…${CSI}0m`;
}

// Rail glyphs
const BAR = dim('│');
const S_ACTIVE = color('cyan', '◆');
const S_DONE = color('green', '◇');
const S_FAIL = color('red', '■');
const R_ON = color('cyan', '●');
const R_OFF = dim('○');

// Cursor-visibility safety net: if anything throws between hide and show,
// the exit handler puts the cursor back.
let cursorHidden = false;
process.on('exit', () => {
  if (cursorHidden) process.stdout.write(`${CSI}?25h`);
});
function hideCursor() { cursorHidden = true; out(`${CSI}?25l`); }
function showCursor() { cursorHidden = false; out(`${CSI}?25h`); }

// ── static rail pieces ─────────────────────────────────────────────────────

export function intro(title, subtitle) {
  out(`${dim('┌')}  ${bold(title)}\n`);
  if (subtitle) out(`${BAR}  ${dim(subtitle)}\n`);
  out(`${BAR}\n`);
}

export function outro(lines) {
  const [first, ...rest] = Array.isArray(lines) ? lines : [lines];
  out(`${dim('└')}  ${first}\n`);
  for (const l of rest) out(`   ${l}\n`);
  out('\n');
}

export function bar(text = '') {
  out(text ? `${BAR}  ${text}\n` : `${BAR}\n`);
}

// A completed step: ◇ title / │ answer / │
export function stepDone(title, answer) {
  out(`${S_DONE}  ${bold(title)}\n`);
  if (answer) out(`${BAR}  ${answer}\n`);
  out(`${BAR}\n`);
}

export function stepFail(title, detail) {
  out(`${S_FAIL}  ${bold(title)}${detail ? '  ' + dim(detail) : ''}\n${BAR}\n`);
}

// A framed panel hanging off the rail.
export function panel(lines, { title = '' } = {}) {
  const width = Math.max(...lines.map(visibleWidth), visibleWidth(title) + 2);
  const top = title
    ? `╭─ ${title} ${'─'.repeat(Math.max(0, width - visibleWidth(title) - 1))}╮`
    : `╭${'─'.repeat(width + 2)}╮`;
  out(`${BAR}  ${dim(top)}\n`);
  for (const l of lines) {
    out(`${BAR}  ${dim('│')} ${l}${' '.repeat(width - visibleWidth(l))} ${dim('│')}\n`);
  }
  out(`${BAR}  ${dim(`╰${'─'.repeat(width + 2)}╯`)}\n`);
}

// ── interactive widgets ────────────────────────────────────────────────────

// Attach a raw-mode key listener; returns a detach function. The handler gets
// one key (or escape sequence) at a time even when input arrives batched.
function onKeys(handler) {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  const onData = (buf) => {
    const s = buf.toString('utf8');
    for (let i = 0; i < s.length;) {
      if (s[i] === '\x1b' && s[i + 1] === '[' && s.length > i + 2) {
        handler(s.slice(i, i + 3));
        i += 3;
      } else {
        handler(s[i]);
        i += 1;
      }
    }
  };
  stdin.on('data', onData);
  return () => {
    stdin.off('data', onData);
    if (!wasRaw) stdin.setRawMode(false);
    stdin.pause();
  };
}

/**
 * Arrow-key single select. items: [{ label, hint?, value }].
 * Renders as an active rail step; collapses to a ◇ receipt when answered.
 * Resolves the chosen value; rejects with AbortError on ctrl-c / esc / q.
 * Non-TTY: returns the initial item's value immediately.
 */
export function select(title, items, { initialIndex = 0 } = {}) {
  if (items.length === 0) return Promise.reject(new Error(`select "${title}" got no items`));
  const clamp = (i) => Math.min(Math.max(i, 0), items.length - 1);
  if (!isInteractive()) return Promise.resolve(items[clamp(initialIndex)].value);

  return new Promise((resolve, reject) => {
    let index = clamp(initialIndex);
    let rendered = 0;

    const line = (item, active) => {
      const marker = active ? R_ON : R_OFF;
      const label = active ? bold(item.label) : dim(item.label);
      return `${BAR}  ${marker} ${label}${item.hint ? '  ' + dim(item.hint) : ''}`;
    };

    const render = () => {
      if (rendered) out(`${CSI}${rendered}A`);
      const lines = [
        `${S_ACTIVE}  ${bold(title)}  ${dim('↑↓ · enter')}`,
        ...items.map((it, i) => line(it, i === index)),
      ];
      out(lines.map((l) => `\r${CSI}2K${fitWidth(l)}`).join('\n') + '\n');
      rendered = lines.length;
    };

    const finish = (ok, val) => {
      detach();
      out(`${CSI}${rendered}A\r${CSI}0J`); // collapse the whole widget
      showCursor();
      if (ok) {
        stepDone(title, items[index].label);
        resolve(val);
      } else {
        stepFail(title, 'cancelled');
        reject(new AbortError());
      }
    };

    hideCursor();
    const detach = onKeys((key) => {
      if (key === `${CSI}A` || key === 'k') { index = clamp(index - 1); render(); }
      else if (key === `${CSI}B` || key === 'j') { index = clamp(index + 1); render(); }
      else if (key === '\r' || key === '\n') finish(true, items[index].value);
      else if (key === '\x03' || key === '\x1b' || key === 'q') finish(false);
    });
    render();
  });
}

/**
 * Multi-select on the rail: space toggles, enter confirms (needs ≥1 picked).
 * items: [{ label, hint?, value }]. Resolves the array of chosen values in
 * list order. Non-TTY: resolves initialSelected values (or the first item).
 */
export function multiselect(title, items, { initialSelected = [] } = {}) {
  const preset = items.filter((it) => initialSelected.includes(it.value)).map((it) => it.value);
  if (!isInteractive()) return Promise.resolve(preset.length ? preset : [items[0].value]);

  return new Promise((resolve, reject) => {
    let index = 0;
    const picked = new Set(preset);
    let rendered = 0;

    const line = (item, active) => {
      const box = picked.has(item.value) ? color('cyan', '◼') : dim('◻');
      const label = active ? bold(item.label) : (picked.has(item.value) ? item.label : dim(item.label));
      return `${BAR}  ${active ? color('cyan', '❯') : ' '} ${box} ${label}${item.hint ? '  ' + dim(item.hint) : ''}`;
    };

    const render = (warn = '') => {
      if (rendered) out(`${CSI}${rendered}A`);
      const lines = [
        `${S_ACTIVE}  ${bold(title)}  ${dim('space toggle · enter confirm')}${warn ? '  ' + color('yellow', warn) : ''}`,
        ...items.map((it, i) => line(it, i === index)),
      ];
      out(lines.map((l) => `\r${CSI}2K${fitWidth(l)}`).join('\n') + '\n');
      rendered = lines.length;
    };

    const finish = (ok) => {
      detach();
      out(`${CSI}${rendered}A\r${CSI}0J`);
      showCursor();
      if (ok) {
        const chosen = items.filter((it) => picked.has(it.value));
        stepDone(title, chosen.map((c) => c.label).join(dim(' · ')));
        resolve(chosen.map((c) => c.value));
      } else {
        stepFail(title, 'cancelled');
        reject(new AbortError());
      }
    };

    hideCursor();
    const detach = onKeys((key) => {
      if (key === `${CSI}A` || key === 'k') { index = Math.max(0, index - 1); render(); }
      else if (key === `${CSI}B` || key === 'j') { index = Math.min(items.length - 1, index + 1); render(); }
      else if (key === ' ') {
        const v = items[index].value;
        picked.has(v) ? picked.delete(v) : picked.add(v);
        render();
      }
      else if (key === '\r' || key === '\n') {
        if (picked.size === 0) render('pick at least one');
        else finish(true);
      }
      else if (key === '\x03' || key === '\x1b' || key === 'q') finish(false);
    });
    render();
  });
}

/**
 * Line input on the rail. Masked (•) when { mask: true } — for pasting API
 * keys so the secret never lands in terminal scrollback. Resolves the trimmed
 * string (may be empty). Non-TTY: resolves the fallback immediately.
 */
export function input(title, { mask = false, placeholder = '', fallback = '' } = {}) {
  if (!isInteractive()) return Promise.resolve(fallback);

  return new Promise((resolve, reject) => {
    let value = '';
    const render = () => {
      const shown = value
        ? (mask ? '•'.repeat(Math.min(value.length, 40)) : value)
        : dim(placeholder);
      out(`${CSI}1A\r${CSI}2K${fitWidth(`${S_ACTIVE}  ${bold(title)}`)}\n\r${CSI}2K${fitWidth(`${BAR}  ${shown}${color('cyan', '▌')}`)}`);
    };

    const finish = (ok) => {
      detach();
      out(`${CSI}1A\r${CSI}0J`);
      showCursor();
      const v = value.trim();
      if (ok) {
        stepDone(title, v ? (mask ? '••••••••' : v) : dim('(skipped)'));
        resolve(v);
      } else {
        stepFail(title, 'cancelled');
        reject(new AbortError());
      }
    };

    hideCursor();
    out('\n'); // room for the two-line widget; render() climbs back up
    const detach = onKeys((key) => {
      if (key === '\r' || key === '\n') finish(true);
      else if (key === '\x03' || key === '\x1b') finish(false);
      else if (key === '\x7f' || key === '\b') { value = value.slice(0, -1); render(); }
      else if (key.length === 1 && key >= ' ') { value += key; render(); }
    });
    render();
  });
}

/**
 * Spinner on the rail: const s = spinner('checking…'); s.stop(true, 'ok').
 * Ends as a ◇/■ step so the rail stays connected.
 */
export function spinner(text) {
  if (!isInteractive()) {
    out(`${text}…\n`);
    return { stop(ok, finalText) { out(`${ok ? '✓' : '✗'} ${finalText}\n`); } };
  }
  const frames = ['◐', '◓', '◑', '◒'];
  let i = 0;
  hideCursor();
  const timer = setInterval(() => {
    out(fitWidth(`\r${CSI}2K${color('cyan', frames[i++ % frames.length])}  ${text}`));
  }, 90);
  timer.unref?.();
  return {
    stop(ok, finalText) {
      clearInterval(timer);
      out(`\r${CSI}2K`);
      showCursor();
      if (ok) stepDone(finalText.split('\n')[0]);
      else stepFail(finalText.split('\n')[0]);
    },
  };
}
