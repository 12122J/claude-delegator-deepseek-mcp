// ANSI color helpers — Claude Code CLI aesthetic (Tokyo Night palette)
// Respects NO_COLOR / FORCE_COLOR. Does NOT check isTTY — MCP servers run as
// child processes with piped stdio, so isTTY is always false even when the
// parent terminal supports color. Color rendering is the client's responsibility.

const noColor = process.env.NO_COLOR != null || process.env.FORCE_COLOR === '0';

const ansiCodes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const c = {};
for (const [key, code] of Object.entries(ansiCodes)) {
  c[key] = noColor ? '' : code;
}

export const colors = c;

export function color(color, text) {
  if (noColor) return text;
  return `${c[color]}${text}${c.reset}`;
}

export function bold(text) {
  if (noColor) return text;
  return `${c.bold}${text}${c.reset}`;
}

export function dim(text) {
  if (noColor) return text;
  return `${c.dim}${text}${c.reset}`;
}
