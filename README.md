# Claude Code DeepSeek Delegator

MCP server that lets [Claude Code](https://claude.ai/code) delegate heavy-token tasks to DeepSeek. Claude orchestrates; DeepSeek does the heavy lifting.

**One `deepseek` tool. No spawn. No daemon. Zero dependencies.**

```console
─── claude-code-deepseek-delegator
◆ delegated to DeepSeek (v4-pro)

[... full response ...]

─── claude-code-deepseek-delegator · cost ───
deepseek v4-pro $0.073  │  claude sonnet 4 $0.720
saved $0.647 (90%)  │  144,000 tokens (120,000p + 24,000c)
────────────────────────────────
```

## Why not just spawn a subagent?

The usual pattern for heavy tasks — spawning a Claude subagent via the Agent tool — starts a brand new conversation context. That means re-paying the full context window, losing your current state, and still billing at Claude rates.

This MCP server stays **in your current session**. Claude calls `deepseek(...)` as a regular tool call: no new context, no re-initialization, no spawn overhead. DeepSeek handles the heavy compute at ~$0.44/M tokens instead of ~$3/M.

The server itself also needs no manual launch. Claude Code starts it automatically via `npx` when the tool is first called. You configure it once and forget it.

## What makes `files[]` different

When Claude reads files and pastes them into a prompt, those bytes load into **Claude's** context window first — you pay Claude's rate just to pass content through.

With `files[]`, Claude passes only the paths. The MCP server reads the bytes directly from disk and forwards them to DeepSeek. Large codebases go straight to DeepSeek without ever touching Claude's context.

```jsonc
// Claude calls the tool like this — no Read calls needed first:
deepseek({
  prompt: "Audit these files for security vulnerabilities...",
  files: [
    "/path/to/auth.py",
    "/path/to/middleware.py",
    "/path/to/payments.py"
  ]
})
```

## Install

```bash
npm install -g claude-code-deepseek-delegator
```

Or skip the install entirely — Claude Code will fetch and run it on demand:

```json
{
  "mcpServers": {
    "deepseek": {
      "command": "npx",
      "args": ["claude-code-deepseek-delegator"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

Zero dependencies — Node.js 20+ built-ins only.

Get a free DeepSeek API key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys). They give you credits on signup.

## Configure Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "deepseek": {
      "command": "npx",
      "args": ["claude-code-deepseek-delegator"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

Paste your API key directly into the `env` block. Claude Code does not expand shell variables in `mcp.json` — the value must be the literal key string.

Restart Claude Code. The `deepseek` tool is now available.

## Automatic delegation

For Claude to automatically suggest delegation before heavy tasks, add the rules from [DELEGATION.md](DELEGATION.md) to your `~/.claude/CLAUDE.md`.

Once added, Claude will ask **"Delegate to DeepSeek? (y/n)"** before any operation that exceeds ~300 lines, 3+ files, or 500+ words of output.

For stronger enforcement, add the PreToolUse hook from [DELEGATION.md](DELEGATION.md) to `~/.claude/settings.json` — it fires before every skill invocation and injects a mandatory scope-check directly into the model context.

```
> This task analyzes ~800 lines across 4 files.
> Delegate to DeepSeek? (y/n)
```

## Tools

### `deepseek`

Delegate a task to DeepSeek.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | *required* | The task/instructions for DeepSeek |
| `files` | string[] | — | Absolute file paths to read and include. The MCP server reads them — file contents never pass through Claude's context window. |
| `system` | string | — | Optional system prompt |
| `model` | string | `deepseek-v4-pro` | Model ID |
| `temperature` | number | `0.7` | 0–2, lower = deterministic |
| `maxTokens` | number | model max | Response token cap |

### `deepseek_models`

List available models with capabilities, context windows, and thinking support.

## Models

| Model | Context | Thinking | Best for |
|-------|---------|----------|----------|
| `deepseek-v4-pro` | 1M | Yes | Complex analysis, architecture, code |
| `deepseek-v4-flash` | 1M | Optional | Fast/cheap tasks |
| `deepseek-reasoner` | 64K | Yes | Math, logic, step-by-step |

## Features

- **No spawn** — direct tool call, stays in current session, no subagent overhead
- **Files bypass Claude** — `files[]` routes disk reads through the MCP process, not Claude's context
- **Cost comparison** — every response shows DeepSeek cost vs Claude Sonnet 4 equivalent, with $ saved and percentage
- **Mandatory delegation gate** — Claude can't skip the y/n prompt for heavy tasks
- **Retry with backoff** — auto-retries on 429/5xx with exponential backoff (configurable attempts)
- **Configurable timeout** — default 120s, set via `DEEPSEEK_TIMEOUT`
- **Token tracking** — prompt, completion, and total tokens on every response
- **ANSI colors** — output styled to match Claude Code CLI aesthetic (Tokyo Night palette)
- **Content-Length framing** — MCP spec-compliant JSON-RPC 2.0 over stdio

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | **Required.** Your DeepSeek API key |
| `DEEPSEEK_API_HOST` | `api.deepseek.com` | API hostname |
| `DEEPSEEK_TIMEOUT` | `120000` | Request timeout in ms |
| `DEEPSEEK_MAX_RETRIES` | `2` | Max retry attempts on failure |

## Pricing

| Model | Input (1M tokens) | Output (1M tokens) |
|-------|-------------------|---------------------|
| `deepseek-v4-pro` | $0.435 | $0.87 |
| `deepseek-v4-flash` | $0.14 | $0.28 |
| `deepseek-reasoner` | $0.55 | $2.19 |
| *Claude Sonnet 4 (comparison)* | $3.00 | $15.00 |

You get free credits on signup at [platform.deepseek.com](https://platform.deepseek.com).

## License

MIT
