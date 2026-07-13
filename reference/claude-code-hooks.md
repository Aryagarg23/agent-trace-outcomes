# Claude Code integration

Two touchpoints, both pure `settings.json` config calling the CLI — no code changes to anything.

## Write point: record an outcome when a task ends

A `Stop` hook fires when Claude Code finishes a turn. This one runs the test suite and records the result against HEAD (put it in `.claude/settings.json` at the repo root):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npm test --silent && npx -y agent-trace-outcomes record --check unit:test:pass || npx -y agent-trace-outcomes record --check unit:test:fail"
          }
        ]
      }
    ]
  }
}
```

Richer variant — a small script as the hook command, so the record carries intent and a lesson prompt. Claude Code passes hook input as JSON on stdin (including `transcript_path` and `cwd`):

```bash
#!/usr/bin/env bash
# .claude/hooks/record-outcome.sh — Stop hook
set -euo pipefail
if npm test --silent; then STATUS=pass; else STATUS=fail; fi
npx -y agent-trace-outcomes record \
  --check "unit-tests:test:$STATUS" \
  --intent "$(git log -1 --format=%s)" \
  --reviewed-by "ai:anthropic/claude-fable-5"
```

If you use an explicit verification step instead (a `/verify` skill, a subagent gate), call the same command from there — the library has no opinion about *when* your gate runs, only that the gate calls `record` when it finishes.

## Read point: inject lessons at session start

`SessionStart` hooks can inject context via `hookSpecificOutput.additionalContext`. The CLI emits that envelope natively:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y agent-trace-outcomes lessons . --claude-hook"
          }
        ]
      }
    ]
  }
}
```

Claude now starts every session knowing what has been tried in this repo and how it went. To scope per-prompt instead, use a `UserPromptSubmit` hook with `--claude-hook UserPromptSubmit`.

For agent-driven (rather than injected) retrieval, expose `queryLessons` as an MCP tool — see the 10-line server in [integration-survey.md §9](./integration-survey.md).

## Pre-task pattern for orchestrated subagents

When a Claude Code session is itself the orchestrator (spawning subagents for tasks), fetch lessons for the paths a subagent is about to touch and prepend them to its prompt:

```bash
LESSONS=$(npx -y agent-trace-outcomes lessons src/auth --json)
# …include $LESSONS in the subagent's task brief
```

This replaces the ad-hoc "check the wiki first" step with a spec-shaped query.
