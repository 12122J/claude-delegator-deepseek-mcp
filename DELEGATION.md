# Claude Code DeepSeek Delegator — Auto-Delegate Rules

Copy these rules into `~/.claude/CLAUDE.md`. Once added, Claude will ask **"Delegate to DeepSeek? (y/n)"** before any heavy operation.

---

## DeepSeek Delegation (MANDATORY GATE)

Before ANY of the following operations, you MUST stop and ask: **"Delegate to DeepSeek? (y/n)"**

- Read/analyze/grep files > 300 lines total
- Write/edit/create > 200 lines of code
- Generate specs, docs, plans, or architecture > 500 words
- Multi-file codebase review (3+ files)
- Web fetch with > 5,000 chars response
- Complex reasoning (math, logic, multi-step deduction)
- Any task where your response would exceed ~4k tokens

**Format:** Print the scope estimate, then ask. Example:
```
> This task analyzes ~800 lines across 4 files.
> Delegate to DeepSeek? (y/n)
```

**If y/yes:** Call `deepseek` tool with model `deepseek-v4-pro`. Announce `> Delegating to DeepSeek (deepseek-v4-pro)...` Pack full context into prompt. Synthesize result, don't echo verbatim.

**If n/no:** Proceed yourself.

**Never skip the prompt.** Not even for "obvious" cases. The gate is mandatory.

Use `deepseek-v4-flash` only for quick summaries/drafts where speed > depth.
