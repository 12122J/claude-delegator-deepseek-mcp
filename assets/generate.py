#!/usr/bin/env python3
"""Generate light macOS-Terminal-style SVG assets for the delegator README."""
from html import escape

# Light-mode palette, tuned for readability on white
C = {
    'plain': '#2d2d2d',
    'dim':   '#9a9a9a',
    'cyan':  '#0e7490',
    'green': '#188038',
    'yellow': '#b26a00',
    'red':   '#d13438',
}
BOLD = {'bold', 'boldcyan', 'boldgreen'}
FILL = {'bold': C['plain'], 'boldcyan': C['cyan'], 'boldgreen': C['green'], **C}

FS = 13          # font size
LH = 19          # line height
X = 26           # left padding
BAR_H = 44       # title bar height
W = 860

def seg(style, text):
    return (style, text)

def vis_len(line):
    return sum(len(t) for _, t in line)

def panel(title_segs, rows, prefix_style='dim'):
    """Replicate tui.panel: rows are lists of segs; returns list of lines."""
    width = max(max(vis_len(r) for r in rows), vis_len(title_segs) + 2)
    out = []
    t_pad = '─' * max(0, width - vis_len(title_segs) - 1)
    out.append([seg('dim', '│  ╭─ ')] + title_segs + [seg('dim', f' {t_pad}╮')])
    for r in rows:
        pad = ' ' * (width - vis_len(r))
        out.append([seg('dim', '│  │ ')] + r + [seg('plain', pad)] + [seg('dim', ' │')])
    out.append([seg('dim', f'│  ╰{"─" * (width + 2)}╯')])
    return out

def render(lines, title, fname):
    n = len(lines)
    H = BAR_H + 18 + n * LH + 22
    parts = []
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
        f'font-family="&quot;SF Mono&quot;, SFMono-Regular, Menlo, Consolas, &quot;Liberation Mono&quot;, monospace" '
        f'font-size="{FS}">')
    parts.append(f'''  <defs>
    <clipPath id="win"><rect x="1" y="1" width="{W-2}" height="{H-2}" rx="10"/></clipPath>
  </defs>
  <!-- window -->
  <rect x="1" y="1" width="{W-2}" height="{H-2}" rx="10" fill="#ffffff" stroke="#d0d0d0"/>
  <g clip-path="url(#win)">
    <rect x="0" y="0" width="{W}" height="{BAR_H}" fill="#f0f0f0"/>
    <line x1="0" y1="{BAR_H}" x2="{W}" y2="{BAR_H}" stroke="#dcdcdc"/>
  </g>
  <circle cx="26" cy="{BAR_H//2}" r="6.5" fill="#ff5f57"/>
  <circle cx="48" cy="{BAR_H//2}" r="6.5" fill="#febc2e"/>
  <circle cx="70" cy="{BAR_H//2}" r="6.5" fill="#28c840"/>
  <text x="{W//2}" y="{BAR_H//2 + 4}" text-anchor="middle" fill="#7a7a7a" font-size="12">{escape(title)}</text>''')
    y = BAR_H + 18 + FS
    for line in lines:
        if not line:
            y += LH
            continue
        tspans = ''.join(
            f'<tspan fill="{FILL[s]}"{" font-weight=\"600\"" if s in BOLD else ""}>{escape(t)}</tspan>'
            for s, t in line)
        parts.append(f'  <text x="{X}" y="{y}" xml:space="preserve">{tspans}</text>')
        y += LH
    parts.append('</svg>')
    open(fname, 'w').write('\n'.join(parts) + '\n')
    print(f'{fname}: {n} lines, {W}x{H}')

D, P, CY, G, YW, B = 'dim', 'plain', 'cyan', 'green', 'yellow', 'bold'

# ── init.svg — the v3 wizard, one completed run ─────────────────────────────
init = []
init.append([seg(P, '$ '), seg(B, 'npx claude-code-deepseek-delegator init')])
init.append([])
init.append([seg(D, '┌  '), seg(B, 'claude-code-deepseek-delegator '), seg(D, 'v3.0.0')])
init.append([seg(D, '│  delegate heavy work from Claude Code to a cheaper model · ~1 minute')])
init.append([seg(D, '│')])
init.append([seg(G, '◇  '), seg(B, 'Provider')])
init.append([seg(D, '│  '), seg(P, 'DeepSeek')])
init.append([seg(D, '│')])
init.append([seg(G, '◇  '), seg(B, 'API key')])
init.append([seg(D, '│  '), seg(G, 'DEEPSEEK_API_KEY detected ✓')])
init.append([seg(D, '│')])
init.append([seg(G, '◇  '), seg(B, 'Key verified — DeepSeek answered '), seg(D, '(deepseek-v4-flash)')])
init.append([seg(D, '│')])
init.append([seg(CY, '◆  '), seg(B, 'Which model runs your delegations?'), seg(D, '  ↑↓ · enter')])
init.append([seg(D, '│  '), seg(CY, '● '), seg(B, 'Smart split (recommended)'), seg(D, '  v4-flash digests big files · v4-pro writes code and reasons')])
init.append([seg(D, '│  ○ Ask me each time  choose from a shortlist in Claude Code’s picker')])
init.append([seg(D, '│  ○ Always the best  deepseek-v4-pro for everything')])
init.append([seg(D, '│  ○ Always the cheapest  deepseek-v4-flash for everything')])
init.append([seg(D, '│  ○ Custom…  pick a model for each kind of work')])
init.append([seg(D, '│')])
init.append([seg(G, '◇  '), seg(B, 'Savings baseline — the "vs Claude" line on cost receipts')])
init.append([seg(D, '│  '), seg(P, 'Opus 4.8 (recommended)')])
init.append([seg(D, '│')])
init.extend(panel([seg(B, '4 changes to your Claude Code setup')], [
    [seg(B, 'delegator.json'), seg(P, '   provider, routing, baseline')],
    [seg(B, 'CLAUDE.md'), seg(P, '        delegation rules block '), seg(D, '— your content untouched')],
    [seg(B, 'settings.json'), seg(P, '    2 nudge hooks + the cost receipt '), seg(D, '— never blocks')],
    [seg(B, 'MCP server'), seg(P, '       "deepseek" '), seg(D, '(npx -y claude-code-deepseek-delegator)')],
]))
init.append([seg(D, '│')])
init.append([seg(G, '◇  '), seg(B, 'Apply these changes?')])
init.append([seg(D, '│  '), seg(P, 'Apply')])
init.append([seg(D, '│')])
init.append([seg(D, '│  '), seg(G, '✓ '), seg(B, 'config    '), seg(P, ' wrote provider/routing/baseline')])
init.append([seg(D, '│  '), seg(G, '✓ '), seg(B, 'MCP server'), seg(P, ' registered "deepseek" '), seg(D, '(user scope)')])
init.append([seg(D, '│  '), seg(G, '✓ '), seg(B, 'CLAUDE.md '), seg(P, ' installed the delegation rules')])
init.append([seg(D, '│  '), seg(G, '✓ '), seg(B, 'hooks     '), seg(P, ' installed Read + Skill gates + cost display')])
init.append([seg(D, '│')])
init.extend(panel([seg(G, '✓ '), seg(B, 'delegation is wired')], [
    [seg(B, 'provider'), seg(P, '   DeepSeek '), seg(D, '(deepseek)')],
    [seg(B, 'read'), seg(P, '    '), seg(D, '→'), seg(P, '  deepseek-v4-flash')],
    [seg(B, 'write'), seg(P, '   '), seg(D, '→'), seg(P, '  deepseek-v4-pro')],
    [seg(B, 'reason'), seg(P, '  '), seg(D, '→'), seg(P, '  deepseek-v4-pro')],
    [seg(B, 'baseline'), seg(P, '   opus-4.8')],
]))
init.append([seg(D, '│')])
init.append([seg(D, '└  '), seg(G, 'Done.'), seg(P, ' Restart Claude Code — heavy tasks will prompt '), seg(B, '"Delegate to DeepSeek? (y/n)"')])
init.append([seg(D, '   try:      claude "use delegate to summarize README.md"')])
init.append([seg(D, '   verify:   npx claude-code-deepseek-delegator doctor')])
init.append([])
init.append([seg(YW, '   ★ '), seg(D, 'enjoying it? a star helps others find it → github.com/12122J/claude-delegator-deepseek-mcp')])

render(init, 'javi — deepseek-delegator init — 96×44', 'assets/init.svg')

# ── hero.svg — the delegation loop in one session ───────────────────────────
hero = []
hero.append([seg(CY, '❯ '), seg(P, 'audit src/ for security issues (5 files, ~2,400 lines)')])
hero.append([])
hero.append([seg(P, '> This analyzes ~2,400 lines across 5 files.')])
hero.append([seg(P, '> '), seg(B, 'Delegate to DeepSeek? (y/n)')])
hero.append([])
hero.append([seg(CY, '❯ '), seg(P, 'y')])
hero.append([])
hero.append([seg(G, '  ◆ '), seg(B, 'delegated to '), seg(CY, 'DeepSeek'), seg(D, ' (deepseek-v4-flash · read)')])
hero.append([seg(D, '    files[] → auth.py · middleware.py · payments.py · sessions.py · api.py')])
hero.append([seg(D, '    file bytes go straight to DeepSeek — they never enter Claude’s context')])
hero.append([])
hero.append([seg(D, '  ⎿ delegate deepseek-v4-flash via deepseek · '), seg(G, 'saved $0.194 (94% vs Opus)'), seg(D, ' · spent $0.012 · 38,412 tokens')])
hero.append([])
hero.append([seg(CY, '● '), seg(P, 'Found 3 issues worth fixing, ranked by severity:')])
hero.append([seg(P, '  1. auth.py:142 — JWT signature not verified on the refresh path')])
hero.append([seg(P, '  2. payments.py:88 — amount is taken from the client payload')])
hero.append([seg(P, '  3. sessions.py:31 — session id generated with random.random()')])

render(hero, 'javi — claude — 96×20', 'assets/hero.svg')
