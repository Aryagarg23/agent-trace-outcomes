# agent-trace-outcomes — agent reference

Compact reference for coding agents using this library. Human docs: [README.md](./README.md), normative spec: [SPEC.md](./SPEC.md).

What it does: reads/writes Outcome Records — JSON records attached to git commits stating which checks ran, their results, reviewers, and a lesson. Two integration points:

- WRITE (after verification): `recordOutcome({ intent, checks })`
- READ (before touching code): `queryLessons({ paths })`

Install: `npm i agent-trace-outcomes` (lib) or `npx -y agent-trace-outcomes` (CLI `atrace-outcomes`). Node ≥ 18. Requires a git repo.

## Library API

All functions async unless noted. All accept `{ repoPath?: string }` (default `process.cwd()`), `{ backend?: "files"|"notes" }` (default `"files"`), and injectable `{ exec?, fs? }`. No init step, no global state.

```ts
import { recordOutcome, queryLessons, queryLog, verdictFor, deriveVerdict, deriveCoverage,
         validateOutcomeRecord, openStore } from "agent-trace-outcomes";

recordOutcome({
  intent?: string | { summary, source?: { type, url?, path? } },
  checks?: { name, status, kind?, detail_url?, summary? }[],  // kind defaults "other"
  lesson?: string | { summary, tags?: string[], applies_to?: string[] },
  traceIds?: string[],          // Agent Trace record UUIDs
  taskId?: string,              // groups every attempt at the same task, across revisions
  derivedFrom?: string,         // id of the parent outcome record this attempt forked from
  reviewedBy?: { type: "human"|"ai", id }[],
  revision?: string,            // default: HEAD, resolved to full SHA
  workspaceState?: "clean"|"dirty",  // checks ran against a dirty worktree on top of revision
  diff?: string,                 // unified diff of exactly what was tested
  selected?: boolean,            // which explored branch was kept (true) or pruned (false)
  verdict?, coverage?, metadata?, id?, timestamp?,  // all optional overrides
}) => Promise<OutcomeRecord>    // throws Error("invalid outcome record: ...") on bad input
// coverage is auto-derived from checks/reviewedBy whenever checks is non-empty

queryLessons({ paths?: string[], tags?: string[], verdict?: Verdict | Verdict[],
               status?: CheckStatus | CheckStatus[], limit? /* =20 */ })
  => Promise<{ summary, tags, applies_to, verdict, revision, timestamp, intent?, record_id }[]>
  // newest first; matches via lesson.applies_to globs, falling back to files the commit touched
  // verdict/status filter on the owning record; all provided filters AND together

queryLog({ path?: string, verdict?: Verdict | Verdict[], status?: CheckStatus | CheckStatus[], limit? })
  => Promise<OutcomeRecord[]>   // newest first; status matches if any check has that status
verdictFor(sha /* short ok */) => Promise<{ verdict, checks, record?, records }>
deriveVerdict(checks) => Verdict                                  // pure, sync
deriveCoverage(checks, reviewedBy?) => Coverage                   // pure, sync
validateOutcomeRecord(value) => { valid, errors: string[], warnings: string[] }  // sync
```

Enums:
- `kind`: `test | lint | typecheck | build | security | review | manual | deploy | other`
- `status`: `pass | fail | skip | error` (`error` = ran but no usable result)
- `verdict`: `verified | failed | partial | unverified`
- `workspace_state` (vcs): `clean | dirty`

Verdict rule (mechanical, derived from checks): no checks or all `skip` → `unverified`; any `fail` → `failed`; all non-skipped `pass` → `verified`; else → `partial`.

Coverage (`{ total, by_kind, has_review }`) is a derived fact like verdict: counts of `checks[]` by kind, and whether any check was a review or `reviewedBy` is non-empty — for fleet triage without re-scanning every check. Never a score.

## CLI

```
atrace-outcomes record  [--intent s] [--check name[:kind]:status]... [--lesson s]
                        [--tag t]... [--applies-to glob]... [--trace-id uuid]...
                        [--task-id uuid] [--derived-from uuid]
                        [--reviewed-by human:login|ai:provider/model]...
                        [--revision sha] [--from-ci --status pass|fail|success|failure|...]
                        [--from-checks [sha]]   # GitHub Checks API; needs GITHUB_TOKEN
                        [--dirty] [--diff-file path|-] [--selected | --pruned]
                        [--record-json path|-]  # read a full/partial record as JSON instead
                                                 # of flags (non-Node integration); still
                                                 # goes through the same validation + write path
                        [--backend files|notes] [--repo path] [--json]
                        # coverage is auto-derived from checks; not a CLI flag
atrace-outcomes log      [path] [--limit n] [--verdict v]... [--status s]... [--json]
atrace-outcomes verdict  <sha>              # exit 0 iff verified — usable as a gate
atrace-outcomes lessons  [path] [--tag t]... [--verdict v]... [--status s]... [--limit n]
                        [--json | --claude-hook [event]]
atrace-outcomes validate <file>             # exit 1 + stderr errors if invalid
```

`log`/`lessons` `--verdict`/`--status` are repeatable and filter with AND semantics alongside path/tag (e.g. `lessons src/auth --status fail` only surfaces lessons from records with a failing check). Also available as `verdict`/`status` on `queryLog`/`queryLessons` in the library API, each accepting a single value or an array.

`lessons --json` emits the LessonEntry array. `lessons --claude-hook` emits a Claude Code hook envelope (`hookSpecificOutput.additionalContext`), event defaults to `SessionStart`.

Non-Node callers: `record --record-json -` accepts a JSON outcome record on stdin (or `--record-json <path>` for a file) instead of `--check`/`--intent`/etc flags — see README.md § "Using it from other languages" for a Python example. Always pass `--repo` explicitly from non-Node callers since storage resolves relative to the CLI process's cwd.

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
