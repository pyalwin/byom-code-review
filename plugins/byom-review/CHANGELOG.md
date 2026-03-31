# Changelog

## 1.2.0

- Add multi-model simultaneous code review via `--models` flag
- Run 2-5 models in parallel with straggler timeout detection
- Comparative synthesis across model results (verdict consensus, finding overlap, severity alignment)
- Improved model compatibility with structured output detection fallback
- Configurable timeouts via `BYOM_STRAGGLER_TIMEOUT_MS` and `BYOM_GLOBAL_TIMEOUT_MS`

## 1.1.0

- Extract render module and add tests for missing fields

## 1.0.0

- Initial version of the Codex plugin for Claude Code
