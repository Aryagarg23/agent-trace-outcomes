# Proposal: `outcome` as a related resource type + Outcome Records for verification results

> Ready to paste as an issue on cursor/agent-trace. Structure mirrors #29 (Plan Records).

## Problem

Agent Trace records who or what wrote code. The existing extension proposals cover the period before or during generation:

- #29 — Plan Records
- #16 — `decision` as a related resource type
- #9 — `prompt_id` / conversation timestamps / `correlation_id`
- #18 — trust metrics
- #31 — cryptographic profile

Nothing in the spec or the open proposals records what happens after: which checks ran against the change, what their results were, who reviewed it, and what was learned. Those facts currently live in CI logs (which expire), review threads on vendor servers, and memory. Answering "was this commit ever verified, and had this failure mode been seen before?" gets harder as time passes.

The gap also affects agents. #16 describes agents re-solving decisions every session for lack of persistent memory. The same thing happens one step later in the lifecycle: agents re-attempt approaches that already failed, because nothing durable records the failure. A repo-resident corpus of outcome records makes that queryable.

## Relationship to the Quality Assessment non-goal

The spec's non-goals say: "We don't evaluate whether AI contributions are good or bad." Outcome Records keep that stance. They record facts about verification events ("integration tests ran and 3 failed"), not judgments about quality. The `verdict` field is a mechanical aggregation of check statuses under a fixed rule (below). No field ranks, scores, or evaluates a contribution or a contributor.

## Proposal

Following the additive pattern of #29 and #16, three pieces. All optional and backward-compatible; existing Trace Records remain valid and unaware of this extension.

### 1. A new `related` resource type: `"outcome"`

```json
"related": [
  { "type": "outcome", "path": ".agent-trace/outcomes/c9d8e7f-e8f9a0b1.json" }
]
```

### 2. The optional `path` field on related entries (as proposed in #29)

Same `oneOf` url-XOR-path shape, same rationale as #16: conversation URLs rot; repo-local records persist. Outcome records are repo-local by default, so `path` is their natural pointer. Producers that can't modify trace records lose nothing — the `trace_ids` back-link on the outcome record carries the same relationship.

### 3. A sibling Outcome Record schema

A separate document type (suggested `$id`: `https://agent-trace.dev/schemas/v1/outcome-record.json`, draft 2020-12; suggested MIME type `application/vnd.agent-trace.outcome+json`, following the parent pattern). Summary:

- **Required:** `version` (semver), `id` (uuid), `timestamp` (RFC 3339), `vcs` (identical to `$defs/vcs`), `checks`, `verdict`
- **`trace_ids`** *(optional)* — UUIDs of the Trace Record(s) this outcome verifies. Optional so outcomes can be written when no Agent Trace producer is installed; human-only commits get outcomes too.
- **`checks[]`** — `{ name, kind: test|lint|typecheck|build|security|review|manual|deploy|other, status: pass|fail|skip|error, detail_url?, summary? }`
- **`verdict`** — derived, normatively: `unverified` = no checks (or all skipped); `failed` = any check failed; `verified` = all non-skipped checks passed and at least one ran; `partial` = otherwise (errors, no failures)
- **`intent`** *(optional)* — `{ summary, source?: { type: issue|plan|decision|conversation|manual, url?, path? } }`. The `plan`/`decision` source types point at #29 Plan Records and #16 decision docs.
- **`reviewed_by[]`** *(optional)* — `{ type: human|ai, id }`, AI ids per the models.dev convention
- **`lesson`** *(optional)* — `{ summary, tags?, applies_to? }`: what the change taught, for later retrieval; `applies_to` scopes it to paths/globs
- **`metadata`** — reverse-domain vendor namespaces, per the parent's extensibility rules
- Storage-unopinionated, like the parent. The reference implementation ships repo files (`.agent-trace/outcomes/`) and git notes (`refs/notes/agent-trace/outcomes`; prior art: git-ai's `refs/notes/ai`).
- Deterministic serialization (fixed field order) so records stay digestible under whatever cryptographic profile #31 lands on.

## Reference implementation

Spec + TypeScript library + CLI + GitHub Action (writes outcome records from merged PRs' check runs): https://github.com/Aryagarg23/agent-trace-outcomes — zero-dependency core, dual ESM/CJS, test suite. The write point is one call at a verification gate (`recordOutcome({ intent, checks })`); the read point is one call at context assembly (`queryLessons({ paths })`).

## Questions for maintainers

1. Is `related.type: "outcome"` + the #29 `path` field the preferred linkage, or should outcome linkage wait for a baseline `related.type` vocabulary (per the discussion on #16)?
2. Should sibling record schemas (#29's plan-record, this outcome-record) share a common envelope (`version`/`id`/`timestamp` + `$ref`s into `trace-record.json#/$defs`)? Happy to align this schema with whatever Plan Records settle on.
