# agent-trace-outcomes

> **Status:** v0.1.0, being dogfooded on real repositories before any upstream proposal. Schema and API may still change based on that usage. [RFC-ISSUE.md](./RFC-ISSUE.md) is the proposal this project intends to open against [cursor/agent-trace](https://github.com/cursor/agent-trace) once it has — not yet filed.

A small JSON record of whether a code change actually worked: which checks ran, what happened, who reviewed it, and what was learned. It's saved right in your repo, attached to the commit.

It pairs with [Agent Trace](https://github.com/cursor/agent-trace), which records *who or what wrote* a piece of code. This project answers the next question — *did it work?* The two link together when both are present, but this one works fine on its own too; it doesn't need Agent Trace installed.

## Why bother

Six months after a change lands, "did this ever get tested, and had this failure been seen before?" usually means digging through expired CI logs and half-remembered Slack threads. Recording the answer at the time — as a small file, next to the code — turns that into something you can just look up.

It's also useful while a coding agent is working: before it touches a file, it can check what's already been tried nearby, including things that already failed, instead of quietly repeating the same mistake.

> **Not a quality score.** This doesn't rate or rank a change — it records plain facts ("the test suite ran, 3 tests failed"), never a judgment. See [SPEC.md §3](./SPEC.md#3-non-goals) for the full list of things this deliberately doesn't do.

## Try it in two minutes

```sh
npm install -g agent-trace-outcomes
cd your-repo

# after your tests run, record what happened
atrace-outcomes record --intent "fix token refresh race" \
  --check unit-tests:test:fail \
  --lesson "Concurrent refreshes invalidate each other; serialize them." --applies-to "src/auth/**"

# what's been tried in this area, and did it work?
atrace-outcomes log src/auth/

# gate: exit 0 only if the commit was verified
atrace-outcomes verdict HEAD || echo "not verified"
```

No CI, no account, nothing to configure. Records land in `.agent-trace/outcomes/` as plain, reviewable JSON files (or in git notes, if you'd rather keep them out of the file tree — see [reference/ci-gate.md](./reference/ci-gate.md)).

## How it fits together

![Producers (CI, an agent loop, or the CLI) write Outcome Records at the verification gate; records are stored as repo files or git notes; consumers (a merge gate, context assembly, or a log) read them back. Agent Trace records are an optional side input, linked via trace_ids.](./docs/architecture.svg)

## What a record looks like

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

`trace_ids` is the only tie to Agent Trace, and it's optional — everything else here stands on its own.

## Capturing this automatically from GitHub

Add one workflow file, and every merged PR gets a record — no one has to remember to run anything:

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

It pulls check results and approvers straight from GitHub. Details, the notes-backend option, and using this as a merge gate: [reference/ci-gate.md](./reference/ci-gate.md).

## Using it from code

If you're wiring this into an agent loop or a script rather than the CLI, there are really only two calls that matter:

```ts
await recordOutcome({ intent, checks });   // after your checks finish
await queryLessons({ paths });             // before an agent starts working on a path
```

Everything else — the full function signatures, CLI flags, storage details, and copy-paste snippets for LangGraph, CrewAI, Mastra, Claude Code hooks, and plain CI — is written up for exactly that kind of skimming, not for a person:

- [AGENTS.md](./AGENTS.md) — compact reference (also ships inside the npm package, so it's on disk wherever the library is installed)
- [reference/integration-survey.md](./reference/integration-survey.md) — one snippet per framework
- `atrace-outcomes --help` — the CLI's own flag reference

## Where this sits, and what it's not

Every existing proposal for extending [Agent Trace](https://github.com/cursor/agent-trace) — plans, decisions, prompt correlation, trust metrics, integrity — covers the moment *before or during* a change being written. Nothing covers what happens after: whether it was checked, and what came of it. That's the gap this fills. [SPEC.md §9](./SPEC.md#9-positioning-and-prior-art) has the full citations, including how this differs from runtime agent-observability tools (which record what an agent did *during* a session, not what happened to the code afterward) and from git-ai (whose outcome-style features are closed-source; this is meant as the open counterpart).

## Development

```sh
npm install
npm test        # builds, then runs the test suite (unit + CLI end-to-end on scratch git repos)
```

## License

Code: [MIT](./LICENSE). The specification text ([SPEC.md](./SPEC.md)) is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), matching the parent spec. The proposal this project intends to open upstream is [RFC-ISSUE.md](./RFC-ISSUE.md).
