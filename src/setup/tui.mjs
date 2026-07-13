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

// Longest list a picker renders before it starts scrolling
const MAX_VISIBLE = 10;

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

// ── key tokenizer ──────────────────────────────────────────────────────────
// Raw-mode input is a byte stream, and pastes are the hard part:
//  - terminals with bracketed paste on (zsh leaves it on) wrap pasted text in
//    ESC[200~ … ESC[201~ — the wrapper must never leak into the value, and a
//    paste may span multiple 'data' events
//  - without bracketing, a paste arrives as one multi-char burst, often with
//    a trailing newline that must NOT submit the field mid-paste
// tokenize() turns chunks into events: single-key strings (chars and full CSI
// sequences) and { paste } objects. Pure, so the paste handling is testable.

const PASTE_ON = '\x1b[200~';
const PASTE_OFF = '\x1b[201~';
const CSI_RE = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

export function tokenize(chunk, state = { carry: '', paste: null }) {
  let s = state.carry + chunk;
  const events = [];
  const next = { carry: '', paste: state.paste };

  while (s.length) {
    if (next.paste !== null) {
      const end = s.indexOf(PASTE_OFF);
      if (end === -1) {
        // keep a tail in carry in case PASTE_OFF is split across chunks
        const keep = Math.max(0, s.length - PASTE_OFF.length + 1);
        next.paste += s.slice(0, keep);
        next.carry = s.slice(keep);
        return { events, state: next };
      }
      events.push({ paste: next.paste + s.slice(0, end) });
      next.paste = null;
      s = s.slice(end + PASTE_OFF.length);
      continue;
    }

    if (s[0] === '\x1b') {
      if (s.startsWith(PASTE_ON)) {
        next.paste = '';
        s = s.slice(PASTE_ON.length);
        continue;
      }
      const m = CSI_RE.exec(s);
      if (m) {
        events.push(m[0]);
        s = s.slice(m[0].length);
        continue;
      }
      if (s.length < PASTE_ON.length && /^\x1b(\[[0-9;?]*)?$/.test(s)) {
        next.carry = s; // incomplete sequence — wait for the next chunk
        return { events, state: next };
      }
      events.push(s[0]);
      s = s.slice(1);
      continue;
    }

    // a run of plain chars: length 1 is a keypress; longer is an unbracketed
    // paste, delivered whole so embedded newlines can't submit mid-paste
    const run = /^[^\x1b]+/.exec(s)[0];
    if (run.length === 1) events.push(run);
    else events.push({ paste: run });
    s = s.slice(run.length);
  }
  return { events, state: next };
}

// Sanitize pasted text for a single-line field: control chars (including the
// newline a password manager appends) never belong in an API key.
export function cleanPaste(text) {
  return text.replace(/[\x00-\x1f\x7f]/g, '');
}

// Attach a raw-mode key listener; returns a detach function. The handler gets
// single keys (chars / full escape sequences) and { paste } objects.
function onKeys(handler) {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  out(`${CSI}?2004h`); // ask the terminal to bracket pastes
  let state = { carry: '', paste: null };
  let escTimer = null;
  const onData = (buf) => {
    clearTimeout(escTimer);
    const res = tokenize(buf.toString('utf8'), state);
    state = res.state;
    for (const ev of res.events) handler(ev);
    if (state.carry) {
      // A lone ESC keypress parks in carry looking like a sequence prefix.
      // If nothing follows within a beat, it WAS just ESC — deliver it.
      escTimer = setTimeout(() => {
        const flushed = state.carry;
        state = { carry: '', paste: state.paste };
        for (const ch of flushed) handler(ch);
      }, 40);
      escTimer.unref?.();
    }
  };
  stdin.on('data', onData);
  return () => {
    clearTimeout(escTimer);
    out(`${CSI}?2004l`);
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
    let offset = 0;
    let rendered = 0;

    const line = (item, active) => {
      const marker = active ? R_ON : R_OFF;
      const label = active ? bold(item.label) : dim(item.label);
      return `${BAR}  ${marker} ${label}${item.hint ? '  ' + dim(item.hint) : ''}`;
    };

    const render = () => {
      if (rendered) out(`${CSI}${rendered}A`);
      // viewport: long mixed-provider lists scroll instead of overflowing the
      // terminal (which would break the repaint cursor math)
      if (index < offset) offset = index;
      if (index >= offset + MAX_VISIBLE) offset = index - MAX_VISIBLE + 1;
      const windowed = items.slice(offset, offset + MAX_VISIBLE);
      const below = items.length - offset - windowed.length;
      const lines = [
        `${S_ACTIVE}  ${bold(title)}  ${dim('↑↓ · enter')}`,
        ...(items.length > MAX_VISIBLE ? [`${BAR}  ${dim(offset ? `↑ ${offset} more` : ' ')}`] : []),
        ...windowed.map((it, j) => line(it, offset + j === index)),
        ...(items.length > MAX_VISIBLE ? [`${BAR}  ${dim(below ? `↓ ${below} more` : ' ')}`] : []),
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
      if (typeof key !== 'string') return; // pastes mean nothing in a select
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
    let offset = 0;
    const picked = new Set(preset);
    let rendered = 0;

    const line = (item, active) => {
      const box = picked.has(item.value) ? color('cyan', '◼') : dim('◻');
      const label = active ? bold(item.label) : (picked.has(item.value) ? item.label : dim(item.label));
      return `${BAR}  ${active ? color('cyan', '❯') : ' '} ${box} ${label}${item.hint ? '  ' + dim(item.hint) : ''}`;
    };

    const render = (warn = '') => {
      if (rendered) out(`${CSI}${rendered}A`);
      if (index < offset) offset = index;
      if (index >= offset + MAX_VISIBLE) offset = index - MAX_VISIBLE + 1;
      const windowed = items.slice(offset, offset + MAX_VISIBLE);
      const below = items.length - offset - windowed.length;
      const lines = [
        `${S_ACTIVE}  ${bold(title)}  ${dim('space toggle · enter confirm')}${warn ? '  ' + color('yellow', warn) : ''}`,
        ...(items.length > MAX_VISIBLE ? [`${BAR}  ${dim(offset ? `↑ ${offset} more` : ' ')}`] : []),
        ...windowed.map((it, j) => line(it, offset + j === index)),
        ...(items.length > MAX_VISIBLE ? [`${BAR}  ${dim(below ? `↓ ${below} more` : ' ')}`] : []),
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
      if (typeof key !== 'string') return; // pastes mean nothing in a multiselect
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
      if (typeof key !== 'string') { value += cleanPaste(key.paste); render(); }
      else if (key === '\r' || key === '\n') finish(true);
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
