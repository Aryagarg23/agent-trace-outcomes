# agent-trace-outcomes

> **Status:** v0.1.0, being dogfooded on real repositories before any upstream proposal. Schema and API may still change based on that usage. [RFC-ISSUE.md](./RFC-ISSUE.md) is the proposal this project intends to open against [cursor/agent-trace](https://github.com/cursor/agent-trace) once it has — not yet filed.

**Verification receipts for git commits.** An Outcome Record describes the verified outcome of a code change — which checks ran, what the results were, who reviewed it, and what lesson was learned — as a plain JSON record that lives in the repository. Records attach to commits, so they work on any git repo: human commits, agent commits, repos with no attribution tooling.

When [Agent Trace](https://github.com/cursor/agent-trace) records are present (Agent Trace answers "who or what wrote this code"), outcomes link back to them via `trace_ids`. This project is designed as an additive extension to that specification, but does not depend on it.

The integration contract is two calls:

```ts
await recordOutcome({ intent, checks });     // write point — at your verification gate
await queryLessons({ paths });               // read point — at context-assembly time
```

The intended use: post-incident analysis becomes a query instead of log archaeology, and coding agents stop re-attempting approaches that already failed, because the failure is recorded where they can retrieve it.

> **Not quality assessment.** The parent spec's non-goals state: *"We don't evaluate whether AI contributions are good or bad."* This extension keeps that stance: it records facts about verification events, not judgments — the `verdict` is a mechanical aggregation of check statuses under a fixed rule, never a score. Also non-goals: orchestration opinions, storage mandates, servers, accounts, telemetry, and runtime execution tracing. See [SPEC.md §3](./SPEC.md#3-non-goals).

## Architecture

![Producers (CI, an agent loop, or the CLI) write Outcome Records at the verification gate; records are stored as repo files or git notes; consumers (a merge gate, context assembly, or a log) read them back. Agent Trace records are an optional side input, linked via trace_ids.](./docs/architecture.svg)

## The record

```json
{
  "version": "0.1.0",
  "id": "e8f9a0b1-c2d3-4e5f-8a9b-0c1d2e3f4a5b",
  "timestamp": "2026-07-12T22:14:07Z",
  "trace_ids": ["6ba7b810-9dad-41d1-80b4-00c04fd430c8"],
  "vcs": { "type": "git", "revision": "c9d8e7f6…" },
  "intent": { "summary": "Cache session lookups in Redis to cut auth latency" },
  "checks": [
    { "name": "unit-tests", "kind": "test", "status": "pass" },
    { "name": "integration-tests", "kind": "test", "status": "fail",
      "summary": "3 failures in session-revocation.spec.ts" }
  ],
  "verdict": "failed",
  "reviewed_by": [{ "type": "human", "id": "arya" }],
  "lesson": {
    "summary": "Caching sessions by ID breaks revocation; invalidate on the revocation path.",
    "applies_to": ["src/auth/**"]
  }
}
```

The specification is [SPEC.md](./SPEC.md) (CC BY 4.0, matching the parent spec). This repo is its reference implementation: a zero-dependency TypeScript library, a CLI, and a GitHub Action.

Coding agents: [AGENTS.md](./AGENTS.md) is a compact reference with the full API, CLI, enums, and recipes — read that instead of this file. It ships in the npm package (`node_modules/agent-trace-outcomes/AGENTS.md`).

## Quickstart (2 minutes)

```sh
npm install -g agent-trace-outcomes   # or: npx -y agent-trace-outcomes …

cd your-repo

# after your tests run, record what happened (revision auto-detected from HEAD):
atrace-outcomes record --intent "fix token refresh race" \
  --check unit-tests:test:fail \
  --lesson "Concurrent refreshes invalidate each other; serialize them." --applies-to "src/auth/**"

# what's been tried in this area, and did it work?
atrace-outcomes log src/auth/

# lessons for an agent about to touch these paths (plain JSON):
atrace-outcomes lessons src/auth --json

# gate: exit 0 iff the commit's outcome is verified
atrace-outcomes verdict HEAD || echo "not verified"
```

No CI, orchestrator, or organization required. Records land in `.agent-trace/outcomes/` as reviewable JSON (or in git notes with `--backend notes`).

## Automatic capture: the GitHub Action

On every merged PR this gathers the check runs, derives the verdict, records approvers, and commits the record:

```yaml
# .github/workflows/outcomes.yml
on: { pull_request: { types: [closed] } }
permissions: { contents: write, checks: read, pull-requests: read }
jobs:
  record:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ github.event.pull_request.base.ref }}" }
      - uses: Aryagarg23/agent-trace-outcomes@v0
```

See [reference/ci-gate.md](./reference/ci-gate.md) for the notes backend, merge gates, and the `workflow_run` variant.

## Library API

The primary consumers are agent loops importing the library at two points. Plain async functions, JSON in / JSON out, no framework types, no global state, no init step; every function takes `{ repoPath }` (default `cwd`). Dual ESM/CJS, Node ≥ 18, zero runtime dependencies in the core.

```ts
import {
  recordOutcome, queryLessons, queryLog, verdictFor,
  deriveVerdict, openStore, validateOutcomeRecord,
  type OutcomeRecord, type CheckInput, type LessonEntry,
} from "agent-trace-outcomes";

// Write at the verification gate. Revision defaults to HEAD; verdict is derived.
const record: OutcomeRecord = await recordOutcome({
  intent: "add rate limiting to public endpoints",
  checks: [
    { name: "unit-tests", kind: "test", status: "pass" },
    { name: "load-test", kind: "test", status: "skip", summary: "skipped on PR builds" },
  ],
  traceIds: ["550e8400-e29b-41d4-a716-446655440000"],  // optional Agent Trace links
  lesson: { summary: "Gateway-level limiting was enough.", applies_to: ["src/gateway/**"] },
  repoPath: "/path/to/repo",                            // default: process.cwd()
});

// Read at context assembly. Matches lessons via applies_to globs,
// falling back to the files each change actually touched.
const lessons: LessonEntry[] = await queryLessons({ paths: ["src/gateway/"], limit: 10 });

// History and gating.
const attempts: OutcomeRecord[] = await queryLog({ path: "src/gateway/" });
const { verdict, checks } = await verdictFor("abc1234");   // short SHAs resolved via git

// Pure pieces, usable standalone.
deriveVerdict([{ name: "t", kind: "test", status: "pass" }]);       // "verified"
validateOutcomeRecord(JSON.parse(text));                             // { valid, errors, warnings }
const store = openStore({ backend: "notes" });                       // files | notes
```

Hosts that sandbox or test without a real repo inject `exec`/`fs`: `recordOutcome({ ..., exec: fakeExec, fs: memFs })`. No network calls exist anywhere except the explicitly-invoked GitHub Checks API paths (`--from-checks`, the Action).

## Integration matrix

The write point is any post-completion moment; the read point is any context-assembly moment. Every environment below integrates in ≤ 3 lines per touchpoint — details and working configs in [reference/integration-survey.md](./reference/integration-survey.md):

| Environment | Write point (≤3 lines) | Read point (≤3 lines) |
|---|---|---|
| Claude Code hooks | `Stop` hook: `… && atrace-outcomes record --check unit:test:pass \|\| atrace-outcomes record --check unit:test:fail` | `SessionStart` hook: `atrace-outcomes lessons . --claude-hook` |
| GitHub Actions / CI | `- if: always()`<br>`  run: npx -y agent-trace-outcomes record --from-ci --status "${{ steps.test.outcome }}"` | `- run: npx -y agent-trace-outcomes lessons src/ --json` |
| git hooks / husky | `.husky/post-commit`: test && `record --check …` | `.husky/pre-push`: `atrace-outcomes verdict "$(git rev-parse HEAD)"` |
| LangGraph | `graph.addNode("record", async s => { await recordOutcome({intent: s.task, checks: s.checks}); return s; })` | `graph.addNode("lessons", async s => ({...s, lessons: await queryLessons({paths: s.paths})}))` |
| OpenAI Agents SDK | `agent.on("agent_end", async () => recordOutcome({intent: agent.name, checks}))` | `new Agent({ instructions: async () => render(await queryLessons({paths})) })` |
| CrewAI (via CLI) | `Task(..., callback=lambda o: subprocess.run([...,"record","--check",...]))` | `@before_kickoff`: `inputs["lessons"] = …lessons --json…` |
| Mastra | `createStep({ id: "record", execute: async ({inputData}) => { await recordOutcome(…); return inputData; } })` | `new Agent({ instructions: async () => render(await queryLessons({paths})) })` |
| Vercel AI SDK | `generateText({ ..., onFinish: async () => recordOutcome({intent, checks}) })` | `generateText({ system: render(await queryLessons({paths})), ... })` |
| MCP | (read-only surface by design) | 10-line stdio server exposing a `query_lessons` tool |
| Any orchestrator | `await recordOutcome({ intent: task.brief, checks: gate.results })` | `await queryLessons({ paths: task.paths })` |

The generic multi-agent pattern (orchestrator + subagents + verification queue) is worked through in [reference/orchestrator-integration.md](./reference/orchestrator-integration.md); Claude Code hook configs in [reference/claude-code-hooks.md](./reference/claude-code-hooks.md).

## Positioning and prior art

As of July 2026 (full citations in [SPEC.md §9](./SPEC.md#9-positioning-and-prior-art)):

- **Within Agent Trace:** existing extension proposals cover the period before or during generation — plans ([#29](https://github.com/cursor/agent-trace/issues/29)), decisions ([#16](https://github.com/cursor/agent-trace/issues/16)), prompt correlation ([#9](https://github.com/cursor/agent-trace/issues/9)), trust metrics ([#18](https://github.com/cursor/agent-trace/issues/18)), integrity ([#31](https://github.com/cursor/agent-trace/issues/31)). None records post-hoc verification facts. The extension pattern (sibling record schema + a new `related` type + repo-local `path`) mirrors #29 and #16. Outcome records attach to commits and treat trace linkage as optional, so they work with or without Agent Trace tooling ([SPEC.md §9.3](./SPEC.md#93-use-without-agent-trace)).
- **Runtime agent observability** (OTel GenAI spans, Braintrust, Comet, UiPath…) records what an agent did *during execution*. This records what happened to the resulting change *afterward*, as a portable repo-resident record. Complementary lanes.
- **Cryptographic receipt tools** prove a record wasn't tampered with; this defines what the record *says*. The serializer's deterministic field ordering keeps records digestible under any upstream crypto profile ([#31](https://github.com/cursor/agent-trace/issues/31)).
- **git-ai's open standard** ([v3.0.0](https://raw.githubusercontent.com/git-ai-project/git-ai/main/specs/git_ai_standard_v3.0.0.md)) is attribution-only — no outcome/verdict/check/lesson fields. Its outcome-adjacent analytics live in a closed product; this is the open, Agent-Trace-native counterpart. Its `refs/notes/ai` storage is the prior art for our notes backend.

## CLI reference

```
atrace-outcomes record     [--intent s] [--check name[:kind]:status]… [--lesson s] [--tag t]…
                           [--applies-to p]… [--trace-id uuid]… [--reviewed-by human:x|ai:p/m]…
                           [--revision sha] [--from-ci --status s] [--from-checks [sha]]
                           [--backend files|notes] [--repo path] [--json]
atrace-outcomes log        [path] [--limit n] [--json]
atrace-outcomes verdict    <sha>            # exit 0 iff verified
atrace-outcomes lessons    [path] [--tag t]… [--json | --claude-hook [event]]
atrace-outcomes validate   <file>
```

## Development

```sh
npm install
npm test        # builds (tsup) then runs vitest: 70+ tests incl. CLI e2e on scratch git repos
```

## License

Code: [MIT](./LICENSE). Specification text ([SPEC.md](./SPEC.md)): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), matching the parent spec. Upstream proposal: [RFC-ISSUE.md](./RFC-ISSUE.md).
