# DeepSeek Delegation Rules for Claude Code

Add these rules to your `AGENTS.md` or `CLAUDE.md` to enable automatic
delegation prompts before heavy operations.

---

## Delegation Rule

Before ANY of these operations, ask: **"Delegate this to DeepSeek? (y/n)"**

- **Bash/Shell** that processes or generates files > 300 lines
- **Write/Edit** that creates or modifies > 200 lines of code
- **WebFetch** that fetches pages with > 5,000 characters of content
- **Analysis** of multi-file codebases or large single files
- **Generation** of designs, plans, documentation, or architecture > 500 words
- **Complex reasoning** involving math, logic, or multi-step deduction

If the user answers **y** or **yes**: call the `deepseek` tool with the full
task description as the prompt. Append the result to your response.

If the user answers **n** or **no**: proceed with the task yourself.

**Always print the estimated scope before asking.** Example:

```
> This task will analyze ~1,200 lines across 4 files.
> Delegate to DeepSeek? (y/n)
```

## Threshold reference

| Operation | Delegation threshold |
|-----------|---------------------|
| Read/analyze files | > 300 lines total |
| Write/edit code | > 200 lines changed |
| Generate documentation | > 500 words |
| Multi-file review | 3+ files |
| Web content fetch | > 5,000 chars response |

## Anti-patterns

Do NOT ask for delegation on:
- Single-line edits or typo fixes
- Reading files < 200 lines for context
- Simple shell commands (ls, git status, npm install)
- Questions the user asks you directly
- Tasks the user explicitly says "you do" or "don't delegate"
