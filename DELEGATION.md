# Claude Code Delegator — Auto-Delegate Rules (manual setup)

> **Prefer `npx claude-code-deepseek-delegator init`.** The wizard installs a
> provider-named version of these rules plus deterministic hooks, and keeps
> them updated. This file is the copy-paste fallback for manual setups.

Copy the rules below into `~/.claude/CLAUDE.md`. Once added, Claude will ask
**"Delegate to <YourProvider>? (y/n)"** before any heavy operation. Replace
`DeepSeek` with the provider you configured.

---

## Delegation (MANDATORY GATE)

**Estimate scope FIRST — before invoking any skill, writing any code, or reading any files.** The gate fires on intent, not on output.

Before ANY of the following operations, you MUST stop and ask: **"Delegate to DeepSeek? (y/n)"**

- Invoking a skill where the resulting work would exceed the thresholds below
- Read/analyze/grep files > 300 lines total
- Write/edit/create > 200 lines of code
- Generate specs, docs, plans, or architecture > 500 words
- Multi-file codebase review (3+ files)
- Web fetch with > 5,000 chars response
- Complex reasoning (math, logic, multi-step deduction)
- Any task where your response would exceed ~4k tokens

### Threshold reference

| Operation | Delegation threshold |
|-----------|---------------------|
| Read/analyze files | > 300 lines total |
| Write/edit code | > 200 lines changed |
| Generate documentation | > 500 words |
| Multi-file review | 3+ files |
| Web content fetch | > 5,000 chars response |

**Format:** Print the scope estimate, then ask. Example:
```
> This task analyzes ~800 lines across 4 files.
> Delegate to DeepSeek? (y/n)
```

**If y/yes:** Call the `delegate` tool. Set `task` so routing picks the right model:
- `task: "read"` — summarize/analyze/extract from large inputs
- `task: "write"` — generate code or docs
- `task: "reason"` — math, logic, architecture decisions

Add `model` only to override routing — a bare id or `provider:model`
(e.g. `moonshot:kimi-k2.5`). Announce `> Delegating to <provider> (<model>)…`

**If the user keeps a shortlist** (`"mode": "ask"` in `~/.claude/delegator.json`):
first present the shortlist with the AskUserQuestion tool (one option per model,
price as the description), then call `delegate` with `model` set to the choice.

**If n/no:** Proceed yourself.

**Never skip the prompt.** Not even for "obvious" cases. The gate is mandatory.

**NEVER read files before delegating.** Pass file paths via `files[]`. The MCP server reads them directly — file bytes never touch Claude's context window.

```
// RIGHT — file bytes never touch Claude's context
delegate(prompt: "Audit for bugs", task: "read", files: ["/abs/path/a.py", "/abs/path/b.py"])

// WRONG — reads files into Claude's context first, then forwards them
<read files> → delegate(prompt: "Audit for bugs\n\n```python\n[file contents]\n```")
```

Synthesize the result, don't echo it verbatim.

**Every `delegate` result ends with a cost receipt.** Surface its savings line
to the user — never silently drop it.

> The v2 tool names `deepseek` / `deepseek_models` still work as aliases.

## PreToolUse hooks (stronger enforcement)

`init` installs zero-dependency `node -e` hooks that nudge the gate before
large file reads and skill loads, plus a `PostToolUse` hook that displays the
cost receipt deterministically. Run it once instead of maintaining hooks by
hand:

```bash
npx claude-code-deepseek-delegator init
npx claude-code-deepseek-delegator doctor   # live-fires the hooks to prove the gate works
```
