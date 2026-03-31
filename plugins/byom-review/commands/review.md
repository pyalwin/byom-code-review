---
description: Run a code review using any model via OpenRouter
argument-hint: '[--model <id>] [--models <id,id,...>] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a code review through OpenRouter using any model.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- The companion script parses `--wait`, `--model`, `--models`, `--base`, and `--scope`.
- `--model` and `--models` are mutually exclusive. The script enforces this.
- `--models` accepts a comma-separated list of model IDs (2-5 models) for multi-model comparison.
- Supported models: any model ID from OpenRouter (e.g., `anthropic/claude-sonnet-4`, `openai/gpt-4o`, `google/gemini-2.0-flash`).
- It supports working-tree review, branch review, and `--base <ref>`.
- If the user needs custom review instructions or more adversarial framing, they should use `/byom-review:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/byom-companion.mjs" review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/byom-companion.mjs" review $ARGUMENTS`,
  description: "BYOM code review",
  run_in_background: true
})
```
- After launching the command, tell the user: "Code review started in the background."

Multi-model synthesis (when `--models` is present):
- The companion script outputs individual reviews from each model, a failed models section (if any), and aggregate stats.
- After presenting the script output verbatim, synthesize a **Comparative Analysis** section covering:
  - **Verdict consensus:** did models agree or disagree on approve vs needs-attention?
  - **Finding overlap:** which issues were flagged by multiple models (higher confidence) vs. unique to one model?
  - **Severity alignment:** did models rate the same issues at the same severity level?
  - **Notable disagreements:** where models contradicted each other, with your reasoning about which is likely correct based on the code context.
  - **Combined recommendation:** ship or don't ship, based on the weight of evidence across all models.
- The synthesis is your analysis — it is the one exception to "return output verbatim" for this command.
- Do not fix any issues. The synthesis is analytical, not prescriptive.
