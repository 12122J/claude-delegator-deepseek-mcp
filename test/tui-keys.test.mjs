// The paste bug that corrupted API keys, pinned forever: terminals wrap
// pastes in ESC[200~ … ESC[201~, and the tokenizer must never let the
// wrapper digits (or an embedded newline) reach the input value.

import { test } from 'node:test';
import { ok, equal, deepEqual } from 'node:assert/strict';
import { tokenize, cleanPaste } from '../src/setup/tui.mjs';

const feed = (chunks) => {
  let state;
  const events = [];
  for (const c of chunks) {
    const res = tokenize(c, state);
    events.push(...res.events);
    state = res.state;
  }
  return events;
};

test('bracketed paste delivers the exact key — wrapper never leaks', () => {
  const key = 'xai-AbC123dEf456gHi789';
  const events = feed([`\x1b[200~${key}\x1b[201~`]);
  deepEqual(events, [{ paste: key }], 'one paste event, no "00~"/"01~" residue');
});

test('the v3.0.0 regression: wrapper digits used to corrupt the value', () => {
  // The old 3-byte parser turned ESC[200~KEY into "00~KEY…" — assert the
  // exact failure shape can no longer happen.
  const events = feed(['\x1b[200~sk-secret\x1b[201~']);
  const text = events.filter((e) => typeof e === 'string').join('');
  ok(!text.includes('00~') && !text.includes('01~'), 'no marker fragments as chars');
  equal(events.find((e) => typeof e === 'object').paste, 'sk-secret');
});

test('paste split across data events reassembles', () => {
  const events = feed(['\x1b[200~xai-first', 'Half-secondHalf', '-tail\x1b[201~x']);
  deepEqual(events, [{ paste: 'xai-firstHalf-secondHalf-tail' }, 'x']);
});

test('PASTE_OFF marker split across chunks still terminates the paste', () => {
  const events = feed(['\x1b[200~abc\x1b[20', '1~\r']);
  deepEqual(events, [{ paste: 'abc' }, '\r']);
});

test('unbracketed paste burst is one paste event; a lone enter still submits', () => {
  deepEqual(feed(['sk-pasted-key\n']), [{ paste: 'sk-pasted-key\n' }], 'burst = paste');
  deepEqual(feed(['a']), ['a'], 'single char = keypress');
  deepEqual(feed(['\r']), ['\r'], 'lone enter = submit');
});

test('cleanPaste strips the newline a password manager appends', () => {
  equal(cleanPaste('sk-key\n'), 'sk-key');
  equal(cleanPaste('sk\r\n-key\t'), 'sk-key');
});

test('arrow keys and other CSI sequences still tokenize as single keys', () => {
  deepEqual(feed(['\x1b[A\x1b[B']), ['\x1b[A', '\x1b[B']);
  deepEqual(feed(['\x1b[', 'A']), ['\x1b[A'], 'split escape sequence reassembles');
});

test('lone ESC (cancel) is still delivered', () => {
  deepEqual(feed(['\x1b', 'q']), ['\x1b', 'q']);
});
