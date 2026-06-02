# deepseek-mcp

MCP server that lets Claude Code delegate heavy token tasks to DeepSeek.

**Philosophy**: Claude orchestrates; DeepSeek does the heavy lifting.

## How it works

Claude Code detects a task that would burn significant context (large file analysis, multi-file reviews, complex reasoning, long outputs). It calls the `deepseek` tool, which sends the prompt to DeepSeek's API. The response comes back with token usage stats appended.

## Quick start

```bash
# 1. Set your API key
export DEEPSEEK_API_KEY="sk-your-key"

# 2. Run the server
node src/index.mjs
```

## Claude Code config

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "deepseek": {
      "command": "node",
      "args": ["/path/to/deepseek-mcp/src/index.mjs"],
      "env": {
        "DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}"
      }
    }
  }
}
```

## Tools

### `deepseek`

Delegate a task to DeepSeek.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | *required* | The full task/prompt |
| `system` | string | — | Optional system prompt |
| `model` | string | `deepseek-v4-pro` | Model ID |
| `temperature` | number | `0.7` | 0-2, lower = deterministic |
| `maxTokens` | number | model max | Response token cap |

### `deepseek_models`

List available models with capabilities.

## Models

| ID | Context | Thinking | Best for |
|----|---------|----------|----------|
| `deepseek-v4-pro` | 256K | Yes | Complex analysis, architecture, code |
| `deepseek-v4-flash` | 256K | No | Fast/cheap tasks |
| `deepseek-reasoner` | 64K | Yes | Math, logic, step-by-step |

## Features

- **Retry with backoff** — auto-retries on 429/5xx with exponential backoff
- **Timeout** — configurable via `DEEPSEEK_TIMEOUT` (default 120s)
- **Token tracking** — prompt/completion/total tokens appended to response
- **Content-Length framing** — MCP spec-compliant JSON-RPC over stdio
- **Zero dependencies** — Node.js 20+ built-ins only

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | **Required.** DeepSeek API key |
| `DEEPSEEK_API_HOST` | `api.deepseek.com` | API hostname |
| `DEEPSEEK_TIMEOUT` | `120000` | Request timeout in ms |
| `DEEPSEEK_MAX_RETRIES` | `2` | Max retry attempts |
