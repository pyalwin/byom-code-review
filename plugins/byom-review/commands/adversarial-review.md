---
description: Run an adversarial review that challenges implementation approach and design choices
argument-hint: '[--model <id>] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial code review through OpenRouter using any model.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Multi-model guard:
- If the raw arguments contain `--models`, stop immediately and tell the user:
  `"--models is not supported for adversarial reviews yet. Use /byom-review:review --models instead."`
- Do not proceed with the review.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- Supported models: any model ID from OpenRouter (e.g., `anthropic/claude-sonnet-4`, `openai/gpt-4o`, `google/gemini-2.0-flash`).
- It supports working-tree review, branch review, and `--base <ref>`.
- Unlike `/byom-review:review`, it can take extra focus text after the flags.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/byom-companion.mjs" adversarial-review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/byom-companion.mjs" adversarial-review $ARGUMENTS`,
  description: "BYOM adversarial review",
  run_in_background: true
})
```
- After launching the command, tell the user: "Adversarial review started in the background."
