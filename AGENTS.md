# agent-trace-outcomes — agent reference

Compact reference for coding agents using this library. Human docs: [README.md](./README.md), normative spec: [SPEC.md](./SPEC.md).

What it does: reads/writes Outcome Records — JSON records attached to git commits stating which checks ran, their results, reviewers, and a lesson. Two integration points:

- WRITE (after verification): `recordOutcome({ intent, checks })`
- READ (before touching code): `queryLessons({ paths })`

Install: `npm i agent-trace-outcomes` (lib) or `npx -y agent-trace-outcomes` (CLI `atrace-outcomes`). Node ≥ 18. Requires a git repo.

## Library API

All functions async unless noted. All accept `{ repoPath?: string }` (default `process.cwd()`), `{ backend?: "files"|"notes" }` (default `"files"`), and injectable `{ exec?, fs? }`. No init step, no global state.

```ts
import { recordOutcome, queryLessons, queryLog, verdictFor, deriveVerdict,
         validateOutcomeRecord, openStore } from "agent-trace-outcomes";

recordOutcome({
  intent?: string | { summary, source?: { type, url?, path? } },
  checks?: { name, status, kind?, detail_url?, summary? }[],  // kind defaults "other"
  lesson?: string | { summary, tags?: string[], applies_to?: string[] },
  traceIds?: string[],          // Agent Trace record UUIDs
  reviewedBy?: { type: "human"|"ai", id }[],
  revision?: string,            // default: HEAD, resolved to full SHA
  verdict?, metadata?, id?, timestamp?,  // all optional overrides
}) => Promise<OutcomeRecord>    // throws Error("invalid outcome record: ...") on bad input

queryLessons({ paths?: string[], tags?: string[], limit? /* =20 */ })
  => Promise<{ summary, tags, applies_to, verdict, revision, timestamp, intent?, record_id }[]>
  // newest first; matches via lesson.applies_to globs, falling back to files the commit touched

queryLog({ path?: string, limit? }) => Promise<OutcomeRecord[]>   // newest first
verdictFor(sha /* short ok */) => Promise<{ verdict, checks, record?, records }>
deriveVerdict(checks) => Verdict                                  // pure, sync
validateOutcomeRecord(value) => { valid, errors: string[], warnings: string[] }  // sync
```

Enums:
- `kind`: `test | lint | typecheck | build | security | review | manual | deploy | other`
- `status`: `pass | fail | skip | error` (`error` = ran but no usable result)
- `verdict`: `verified | failed | partial | unverified`

Verdict rule (mechanical, derived from checks): no checks or all `skip` → `unverified`; any `fail` → `failed`; all non-skipped `pass` → `verified`; else → `partial`.

## CLI

```
atrace-outcomes record  [--intent s] [--check name[:kind]:status]... [--lesson s]
                        [--tag t]... [--applies-to glob]... [--trace-id uuid]...
                        [--reviewed-by human:login|ai:provider/model]...
                        [--revision sha] [--from-ci --status pass|fail|success|failure|...]
                        [--from-checks [sha]]   # GitHub Checks API; needs GITHUB_TOKEN
                        [--backend files|notes] [--repo path] [--json]
atrace-outcomes log      [path] [--limit n] [--json]
atrace-outcomes verdict  <sha>              # exit 0 iff verified — usable as a gate
atrace-outcomes lessons  [path] [--tag t]... [--limit n] [--json | --claude-hook [event]]
atrace-outcomes validate <file>             # exit 1 + stderr errors if invalid
```

`lessons --json` emits the LessonEntry array. `lessons --claude-hook` emits a Claude Code hook envelope (`hookSpecificOutput.additionalContext`), event defaults to `SessionStart`.

## Storage

- files (default): `.agent-trace/outcomes/<sha7>-<id8>.json` — committed, survives clones
- notes: NDJSON under git ref `refs/notes/agent-trace/outcomes` — not pushed by default; `git push origin refs/notes/agent-trace/outcomes`

Records validate against `OUTCOME_RECORD_SCHEMA` (export of `agent-trace-outcomes/schemas`). Unknown fields in records from newer spec versions are warnings, not errors — do not reject them.

## Recipes

Before editing paths (context assembly):
```sh
npx -y agent-trace-outcomes lessons src/auth --json
```
Prepend non-empty results to your working context. A `[failed]` lesson on a path you are about to change is a prior attempt that did not work — read it before repeating it.

After your checks run (verification gate):
```sh
atrace-outcomes record --intent "<what you were doing>" \
  --check unit-tests:test:pass --check typecheck:typecheck:fail \
  --lesson "<what you learned>" --applies-to "src/auth/**"
```
Record failures too; failed records with lessons are the highest-value records.

Claude Code hooks (settings.json): `SessionStart` → `atrace-outcomes lessons . --claude-hook`; `Stop` → run tests then `record --check ...`. Full configs: [reference/claude-code-hooks.md](./reference/claude-code-hooks.md).

CI step (GitHub Actions): `npx -y agent-trace-outcomes record --from-ci --status "${{ steps.test.outcome }}"`.

Merge/deploy gate: `atrace-outcomes verdict "$(git rev-parse HEAD)" || exit 1`.

## Working on this repo itself

`npm install && npm test` (tsup build + typecheck via pretest, then vitest; CLI e2e tests create scratch git repos). Source: `schemas.ts` (schema/validator/serializer), `src/store.ts` (files+notes backends), `src/verdict.ts`, `src/index.ts` (public API), `src/cli.ts`, `src/github.ts` (only networked module). Keep the core zero-dependency; deps allowed only in `src/cli.ts` (commander) and `src/github.ts`. Schema changes: additive only (new optional fields; SPEC.md §7.1).
