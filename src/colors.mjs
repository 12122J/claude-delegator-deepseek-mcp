// ANSI color helpers — Claude Code CLI aesthetic (Tokyo Night palette)

const noColor = process.env.NO_COLOR || !process.stdout.isTTY;

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
