# Claude Code DeepSeek Delegator

**Cut your Claude Code bill by offloading heavy, token-hungry work to DeepSeek — without leaving your session.**

Claude orchestrates, DeepSeek does the grunt work (big file audits, long generations, deep reasoning) at roughly **1/16th the price**. One tool call, no subagent spawn, no daemon, zero dependencies.

**One command installs everything.** `init` wires up *both* the `deepseek` tool (the delegation) *and* the automatic gate (the "Delegate to DeepSeek? (y/n)" nudge before heavy reads and skill loads). No per-project setup, no manual prompting to remember — run it once, restart Claude Code, and delegation and gating just happen.

<p>
  <a href="https://www.npmjs.com/package/claude-code-deepseek-delegator"><img alt="npm" src="https://img.shields.io/npm/v/claude-code-deepseek-delegator?color=cb3837&logo=npm"></a>
  <a href="https://www.npmjs.com/package/claude-code-deepseek-delegator"><img alt="downloads" src="https://img.shields.io/npm/dm/claude-code-deepseek-delegator?color=cb3837"></a>
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white">
  <img alt="license" src="https://img.shields.io/npm/l/claude-code-deepseek-delegator?color=blue">
</p>

> ⭐ **If this saves you money, please [star the repo](https://github.com/12122J/claude-delegator-deepseek-mcp).** It's the single biggest thing that helps other Claude Code users find it.

```console
> This task analyzes ~800 lines across 4 files.
> Delegate to DeepSeek? (y/n)  y

◆ delegated to DeepSeek (v4-pro)
  Claude hands the heavy compute to DeepSeek, then synthesizes the
  answer for you — same conversation, a fraction of the token spend.
```

---

## Install (one command)

```bash
npx claude-code-deepseek-delegator init
```

That's it. `init` wires everything into Claude Code in one shot, and **shows you exactly what it will change and asks before writing anything.** Restart Claude Code and you're done.

Then sanity-check it:

```bash
npx claude-code-deepseek-delegator doctor
```

`doctor` doesn't just check that files exist — it **actually fires the gate hooks** and confirms the delegation prompt is live.

Get a DeepSeek API key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys). Set it once:

```bash
export DEEPSEEK_API_KEY=sk-your-key-here   # add to ~/.zshrc or ~/.bashrc
```

…or just paste it when `init` asks.

### What `init` actually changes (full disclosure)

`init` is explicit and reversible. It will:

1. **Append a clearly-labeled block to `~/.claude/CLAUDE.md`** — the delegation rules. It's fenced with `<!-- >>> ... >>> -->` markers, says who added it and how to remove it, and **never touches anything else in your file.** You see the exact text before it's written.
2. **Add two `PreToolUse` hooks to `~/.claude/settings.json`** — they inject a "Delegate to DeepSeek? (y/n)" nudge before large file reads and skill loads. They **only add context — they never block, delete, or modify your tool calls.** Plain `node`, no `jq` needed.
3. **Register an MCP server** named `deepseek` (`npx -y claude-code-deepseek-delegator`).

Before any of that, it writes a timestamped backup of every file it changes. To undo everything:

```bash
npx claude-code-deepseek-delegator uninstall
```

`uninstall` removes exactly what `init` added — your own content and unrelated config are left untouched.

### Manual setup (if you prefer)

Add to `~/.claude/mcp.json` yourself:

```json
{
  "mcpServers": {
    "deepseek": {
      "command": "npx",
      "args": ["-y", "claude-code-deepseek-delegator"],
      "env": { "DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}" }
    }
  }
}
```

This gives you the `deepseek` tool, but **not** the automatic "Delegate? (y/n)" gate — that comes from the CLAUDE.md rules and hooks that `init` installs. Claude Code expands `${DEEPSEEK_API_KEY}`, so your key stays out of the file.

---

## Why this instead of spawning a subagent?

The usual pattern for heavy work — spawning a Claude subagent — starts a **brand new context window**: you re-pay the full context, lose your current state, and still bill at Claude rates.

This MCP server stays **in your current session**. Claude calls `deepseek(...)` like any tool — no new context, no re-init, no spawn overhead — and DeepSeek does the heavy compute at ~$0.44/M instead of ~$5/M.

## The `files[]` trick (this is the real win)

When Claude reads files and pastes them into a prompt, those bytes land in **Claude's** context first — you pay Claude's rate just to pass content through.

With `files[]`, Claude passes only the **paths**. The MCP server reads the bytes off disk and forwards them straight to DeepSeek. Large codebases never touch Claude's context.

```jsonc
// Claude calls the tool like this — no Read calls first:
deepseek({
  prompt: "Audit these files for security vulnerabilities and rank by severity.",
  files: ["/abs/path/auth.py", "/abs/path/middleware.py", "/abs/path/payments.py"]
})
```

Claude then **synthesizes** DeepSeek's answer for you instead of pasting it verbatim — so you get the conclusion, cheaply, in the same conversation.

---

## How the gate works

After `init`, heavy operations trigger a prompt:

```
> This task analyzes ~800 lines across 4 files.
> Delegate to DeepSeek? (y/n)
```

- **y** → Claude calls `deepseek` (model `deepseek-v4-pro`), passing file paths via `files[]`, then synthesizes the result.
- **n** → Claude does it itself.

Two layers make this reliable: the **CLAUDE.md rules** (Claude offers the gate) and the **PreToolUse hooks** (a deterministic nudge injected at the moment a big read or skill load happens). Run `doctor` to confirm both are live.

---

## Tools

### `deepseek`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | *required* | The task for DeepSeek. Be specific. |
| `files` | string[] | — | Absolute paths. The server reads them — bytes never enter Claude's context. |
| `system` | string | — | Optional system prompt. |
| `temperature` | number | `0.3` | 0–2, lower = more deterministic. |
| `stream` | boolean | `false` | Stream chunks instead of buffering. Good for very large outputs. |

Every call runs on `deepseek-v4-pro` with the full 384K output budget — there's no model or token-cap knob to get wrong.

### `deepseek_models`

Shows the model in use with its context window and output limit.

## Model

`deepseek-v4-pro` is the one and only model — it handles everything. 1M token context window, 384K max output, and every request gets the full output budget.

## Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| `deepseek-v4-pro` | $0.435 | $0.87 |
| *Claude Opus 4.8 (for comparison)* | $5.00 | $25.00 |

That gap — roughly an order of magnitude cheaper, before the `files[]` context savings — is the whole point of delegating heavy work.

---

## CLI reference

```
npx claude-code-deepseek-delegator <command>

  (no command)   Run the MCP server (how Claude Code launches it)
  init           Wire into Claude Code: MCP + CLAUDE.md rules + hooks (asks first)
  doctor         Verify the install and live-fire the gate hooks
  uninstall      Cleanly remove everything init added
  help           Show help
  --version      Print version

  init flags:  --dry-run (preview, write nothing) · --no-hooks · --yes (non-interactive)
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | **Required.** Your DeepSeek API key. |
| `DEEPSEEK_API_HOST` | `api.deepseek.com` | API hostname. |
| `DEEPSEEK_TIMEOUT` | `120000` | Request timeout (ms). |
| `DEEPSEEK_MAX_RETRIES` | `2` | Retry attempts on 429/5xx. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Honored by `init`/`doctor`/`uninstall` if you've relocated Claude's config. |

---

## FAQ

**Does `npm install` alone enable the gate?** No. Installing only provides the binary. Run `init` (or do the manual MCP setup) to wire it in. The automatic "Delegate? (y/n)" gate needs the CLAUDE.md rules + hooks that `init` adds.

**Will it overwrite my CLAUDE.md?** Never. It appends one fenced block and shows you the exact text first. Everything else is left byte-for-byte.

**How do I remove it?** `npx claude-code-deepseek-delegator uninstall`. Clean and complete.

**Is my key safe?** Use `${DEEPSEEK_API_KEY}` and it's never written to disk. Or paste the literal key if you prefer.

## License

MIT
