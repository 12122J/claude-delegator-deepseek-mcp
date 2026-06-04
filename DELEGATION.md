# Claude Code DeepSeek Delegator — Auto-Delegate Rules

Copy these rules into `~/.claude/CLAUDE.md`. Once added, Claude will ask **"Delegate to DeepSeek? (y/n)"** before any heavy operation.

---

## DeepSeek Delegation (MANDATORY GATE)

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

**If y/yes:** Call `deepseek` tool with model `deepseek-v4-pro`. Announce `> Delegating to DeepSeek (deepseek-v4-pro)...`

**If n/no:** Proceed yourself.

**Never skip the prompt.** Not even for "obvious" cases. The gate is mandatory.

**NEVER read files before delegating.** Pass file paths via `files[]`. The MCP server reads them directly — file bytes never touch Claude's context window.

```
// RIGHT — file bytes never touch Claude's context
deepseek(prompt: "Audit for bugs", files: ["/abs/path/a.py", "/abs/path/b.py"])

// WRONG — reads files into Claude's context first, then forwards to DeepSeek
<read files> → deepseek(prompt: "Audit for bugs\n\n```python\n[file contents]\n```")
```

Synthesize result, don't echo verbatim.

Use `deepseek-v4-flash` only for quick summaries/drafts where speed > depth.

## PreToolUse Hooks (stronger enforcement)

### Block large file reads

Add this hook to block `Read` calls on files over 300 lines, forcing delegation instead:

```json
{
  "matcher": "Read",
  "hooks": [
    {
      "type": "command",
      "command": "jq -r '.tool_input.file_path // empty' | { read -r f; if [ -z \"$f\" ]; then exit 0; fi; lines=$(wc -l < \"$f\" 2>/dev/null | tr -d ' '); if [ \"$lines\" -gt 300 ]; then jq -n --argjson l \"$lines\" --arg p \"$f\" '{hookSpecificOutput:{hookEventName:\"PreToolUse\",additionalContext:(\"READ BLOCKED: \"+$p+\" is \"+($l|tostring)+\" lines. Do NOT read this file into context. Estimate scope and ask the user: Delegate to DeepSeek? (y/n). If yes, pass the path via files[] to deepseek() — never load large files into Claude context first.\")}}'; fi; }"
    }
  ]
}
```

### Block large skill invocations

Add this to `~/.claude/settings.json` so the gate fires automatically before every Skill invocation:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "jq '{hookSpecificOutput: {hookEventName: \"PreToolUse\", additionalContext: (\"DEEPSEEK GATE — skill: \" + (.tool_input.skill // \"?\") + \". Estimate total token cost BEFORE loading this skill. If the resulting work involves >200 lines of code, >3 files, >4k tokens output, or analysis of large content — STOP and ask the user: Delegate to DeepSeek? (y/n). This is mandatory. No exceptions. No rationalising.\")}}'"
          }
        ]
      }
    ]
  }
}
```

This injects a reminder into the model context before every skill load — the gate cannot be rationalized away.
