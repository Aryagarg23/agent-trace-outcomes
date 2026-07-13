# Outcome Records for Agent Trace

**Version**: 0.1.0<br>
**Status**: RFC<br>
**Date**: July 2026

An additive extension to the [Agent Trace](https://github.com/cursor/agent-trace) specification.

## Abstract

An Outcome Record describes the verified outcome of a code change: which checks ran against it, what their results were, who reviewed it, and what lesson was learned. Records attach to commits and live in the repository. They require no other tooling to be useful.

Outcome Records are also an additive extension to the [Agent Trace](https://github.com/cursor/agent-trace) specification, which records who or what wrote code. When Agent Trace records are present, an Outcome Record links back to them via `trace_ids`.

## Table of Contents

1. [Motivation](#1-motivation)
2. [Goals](#2-goals)
3. [Non-Goals](#3-non-goals)
4. [Terminology](#4-terminology)
5. [Architecture Overview](#5-architecture-overview)
6. [Core Specification](#6-core-specification)
7. [Extensibility](#7-extensibility)
8. [Reference Implementation](#8-reference-implementation)
9. [Positioning and Prior Art](#9-positioning-and-prior-art)
- [Appendix](#appendix)
- [License](#license)
- [Contributing](#contributing)

## 1. Motivation

Attribution answers where a change came from. The next question is whether it worked. Today that answer is scattered across CI logs that expire, review threads on vendor servers, and memory. Recording it as a repo-resident document keeps it available: for humans doing post-incident analysis, and for coding agents, which otherwise re-attempt approaches that already failed because nothing durable records the failure ([cursor/agent-trace#16](https://github.com/cursor/agent-trace/issues/16) describes the same problem for decisions).

The gap widens with time. Six months after a change lands, answering "which checks ran against this commit, did anyone review it, and had this failure mode been seen before?" means reconstructing state from systems that no longer hold it. A repository that accumulates outcome records answers those questions directly.

The Agent Trace ecosystem has proposals covering the moments before and during generation: plans ([#29](https://github.com/cursor/agent-trace/issues/29)), decisions ([#16](https://github.com/cursor/agent-trace/issues/16)), prompt causation and correlation ([#9](https://github.com/cursor/agent-trace/issues/9)), trust metrics ([#18](https://github.com/cursor/agent-trace/issues/18)), and record integrity ([#31](https://github.com/cursor/agent-trace/issues/31)). None records post-hoc verification facts. When trace records are present, Outcome Records extend the chain:

> plan (#29) → decision (#16) → trace (core spec) → outcome (this specification)

When they are not, an Outcome Record still describes a commit on its own (§9.3).

### 1.1 Relationship to the parent spec's Quality Assessment non-goal

Agent Trace's non-goals state: *"We don't evaluate whether AI contributions are good or bad."* This extension preserves that stance. An Outcome Record records facts about verification events ("the test suite ran and 3 tests failed"), not judgments about quality. The `verdict` field is a mechanical aggregation of check statuses under a fixed rule (§6.6), not a score.

## 2. Goals

1. **Additive:** Existing Agent Trace records remain valid, untouched, and unaware of this extension. Outcome Records are a sibling document type, following the extension pattern established by [#29](https://github.com/cursor/agent-trace/issues/29) and [#16](https://github.com/cursor/agent-trace/issues/16).
2. **Factual:** Every field records an observable event (a check ran, a person approved) or a durable pointer to one — never an evaluation.
3. **Useful at n=1:** A solo developer gets value on day one with no orchestrator, no CI, and no organization: `atrace-outcomes log src/auth/` answers "what has been tried here, and did it work?"
4. **Embeddable:** The reference implementation folds into any host loop at exactly two touchpoints — write at the verification gate, read at context-assembly time — with one line of code each.
5. **Human & agent readable:** Records are plain JSON, readable without special tooling, and shaped for retrieval by coding agents.

## 3. Non-Goals

- **Quality scoring.** No ranking, scoring, or evaluation of contributions — the parent spec's Quality Assessment non-goal extends fully to this document.
- **Orchestration opinions.** No opinions on agents, loops, or workflow. The record is written *by* a host's existing verification step, whatever that is.
- **Storage mandates.** Like the parent spec, this specification is unopinionated about where records live. The reference implementation offers two backends (§7.4); neither is required.
- **Infrastructure.** No server, no accounts, no telemetry. Local-first.
- **Runtime execution tracing.** Recording what an agent did *during* execution is the observability ecosystem's lane (§9.1); this specification records what happened to the resulting change afterward.
- **Competing attribution.** Outcome Records reference Agent Trace records; they never duplicate attribution fields.

## 4. Terminology

- **Outcome Record:** Metadata describing the verified outcome of a change: its checks, verdict, reviewers, and lesson.
- **Check:** A single verification event that was observed for a change — a test run, a lint pass, a build, a review, a deployment.
- **Verdict:** The mechanical aggregation of a record's checks under the derivation rule in §6.6.
- **Intent:** A one-line statement of what the change was trying to do, optionally linked to its source (issue, plan, decision, conversation).
- **Lesson:** A short statement of what the change taught, scoped to paths it applies to.
- **Verification gate:** The moment in a host workflow where a change's checks complete — the natural write point for an Outcome Record.

## 5. Architecture Overview

![Producers (CI, an agent loop, or the CLI) write Outcome Records at the verification gate; records are stored as repo files or git notes; consumers (a merge gate, context assembly, or a log) read them back. Agent Trace records are an optional side input, linked via trace_ids.](./docs/architecture.svg)

An Outcome Record is produced at a host's verification gate — the moment a change's checks complete. The producer can be a CI job (the reference GitHub Action), an agent loop calling the library, or a developer using the CLI. The record is stored in the repository (a file under `.agent-trace/outcomes/`, or a git note) and read back by two kinds of consumers: gates asking whether a revision was verified, and context assemblers asking what has been tried near a set of paths.

Producing and consuming are independent. A repository can write records with no consumer installed, and a consumer can read records it did not produce. Nothing coordinates producers and consumers except the record format itself.

## 6. Core Specification

An Outcome Record is a JSON document. Required fields: `version`, `id`, `timestamp`, `vcs`, `checks`, `verdict`. All other fields are optional.

```json
{
  "version": "0.1.0",
  "id": "e8f9a0b1-c2d3-4e5f-8a9b-0c1d2e3f4a5b",
  "timestamp": "2026-07-12T22:14:07Z",
  "trace_ids": ["6ba7b810-9dad-41d1-80b4-00c04fd430c8"],
  "vcs": { "type": "git", "revision": "c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0" },
  "intent": {
    "summary": "Cache session lookups in Redis to cut auth latency",
    "source": { "type": "plan", "path": "docs/plans/2026-07-session-cache.md" }
  },
  "checks": [
    { "name": "unit-tests", "kind": "test", "status": "pass" },
    {
      "name": "integration-tests",
      "kind": "test",
      "status": "fail",
      "detail_url": "https://github.com/example/api/actions/runs/9911002",
      "summary": "3 failures in session-revocation.spec.ts"
    }
  ],
  "verdict": "failed",
  "reviewed_by": [{ "type": "human", "id": "arya" }],
  "lesson": {
    "summary": "Caching sessions by ID breaks revocation; invalidate on the revocation path or key on a generation counter.",
    "tags": ["auth", "caching"],
    "applies_to": ["src/auth/session.ts", "src/auth/revoke.ts"]
  }
}
```

The full JSON Schema (draft 2020-12) is reproduced in §6.10 and ships as `OUTCOME_RECORD_SCHEMA` in [`schemas.ts`](./schemas.ts).

### 6.1 version, id, timestamp

- `version` — the Outcome Record spec version this record conforms to (semver, pattern `^[0-9]+\.[0-9]+\.[0-9]+$`).
- `id` — a UUID uniquely identifying this record.
- `timestamp` — RFC 3339 date-time of when the outcome was recorded.

These mirror the parent Trace Record's leading fields exactly.

### 6.2 trace_ids

An optional array of UUIDs identifying the Agent Trace record(s) this outcome verifies. The field is optional by design: outcome records are writable even when no Agent Trace producer is installed, so a repository can accumulate verification history before (or without) adopting attribution tooling.

### 6.3 vcs

Identical in shape to the parent spec's `$defs/vcs`: `type` is one of `git | jj | hg | svn`, and `revision` is the revision identifier (git commit SHA, jj change ID, hg changeset). For `git`, the revision is the full 40-character SHA. Unlike the parent (where `vcs` is optional), `vcs` is **required** here: an outcome is meaningless without the change it describes.

### 6.4 intent

What the change was trying to do, as one human/agent-readable line, with an optional pointer to where that intent came from:

- `summary` (required) — one line, e.g. "Cache session lookups in Redis to cut auth latency".
- `source` (optional) — `{ type, url?, path? }` where `type` is one of `issue | plan | decision | conversation | manual`. `path` is a repo-relative path to a committed document; `url` is an external link. Repo-local `path` is preferred where available, for the durability reasons argued in [#16](https://github.com/cursor/agent-trace/issues/16): vendor conversation URLs rot; repo-local records persist. The `plan` and `decision` types are designed to point at Plan Records ([#29](https://github.com/cursor/agent-trace/issues/29)) and decision documents ([#16](https://github.com/cursor/agent-trace/issues/16), [MADR](https://adr.github.io/madr/)) respectively, completing the plan → decision → trace → outcome chain.

### 6.5 checks

An array of verification events. Each check:

- `name` (required) — e.g. `unit-tests`, `CodeQL`, `manual-qa`.
- `kind` (required) — one of `test | lint | typecheck | build | security | review | manual | deploy | other`.
- `status` (required) — one of `pass | fail | skip | error`. `skip` means the check was deliberately not run; `error` means the check was attempted but produced no usable result (crashed, timed out, cancelled, or still incomplete when observed).
- `detail_url` (optional) — link to the CI run or check-run.
- `summary` (optional) — short result summary, e.g. "3 failures in auth.spec.ts".

A check records that something ran and what it reported — a fact, not a judgment. `checks` may be empty; the verdict is then `unverified`.

### 6.6 verdict (derivation rule)

`verdict` is one of `verified | failed | partial | unverified`, derived from `checks`:

1. If no checks are recorded, or every recorded check has status `skip`: **`unverified`**.
2. Otherwise, if any check has status `fail`: **`failed`**.
3. Otherwise, if every non-skipped check has status `pass`: **`verified`**.
4. Otherwise (some check errored, none failed): **`partial`**.

Examples:

| Check statuses | Verdict |
|---|---|
| (none) | `unverified` |
| `skip`, `skip` | `unverified` |
| `pass`, `pass` | `verified` |
| `pass`, `skip` | `verified` |
| `pass`, `fail` | `failed` |
| `fail`, `error` | `failed` |
| `pass`, `error` | `partial` |

This rule is normative: a compliant producer writes the verdict this rule derives. Consumers treat a record whose verdict disagrees with the rule as suspect (the reference validator reports it as a warning). The verdict adds no information beyond the checks — it exists so that consumers (merge gates, `verdictFor` queries, dashboards) can filter without re-deriving.

### 6.7 reviewed_by

An optional array of `{ type, id }` entries recording who reviewed the change. `type` is `human` or `ai`. For humans, `id` is a login or handle. For AI reviewers, `id` follows the models.dev convention (`provider/model-name`, e.g. `anthropic/claude-fable-5`), matching the parent spec's model identifier convention.

### 6.8 lesson

An optional `{ summary, tags?, applies_to? }`:

- `summary` — one paragraph: what this change taught, written for retrieval by future agents (and humans).
- `tags` — free-form labels for filtering.
- `applies_to` — repo-relative paths or globs the lesson is relevant to.

The lesson exists so that accumulated outcome records can serve as memory for coding agents ([#16](https://github.com/cursor/agent-trace/issues/16) describes the cost of its absence for decisions: agents re-solving the same problems every session). A failed record's lesson documents what didn't work; a verified record's lesson documents what did.

### 6.9 metadata

An optional object for vendor extensions, following the parent spec's namespacing convention exactly: keys are reverse-domain vendor namespaces (e.g. `dev.cursor`, `com.github.copilot`) and values are objects. Vendors add custom data without breaking compatibility.

### 6.10 JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/agent-trace-outcomes/spec/outcome-record.schema.json",
  "title": "Agent Trace Outcome Record",
  "description": "A record of the verified outcome of a code change: which checks ran, their results, who reviewed it, and what lesson was learned.",
  "type": "object",
  "required": ["version", "id", "timestamp", "vcs", "checks", "verdict"],
  "additionalProperties": false,
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Outcome Record spec version this record conforms to."
    },
    "id": {
      "type": "string",
      "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      "description": "Unique identifier (UUID) for this outcome record."
    },
    "timestamp": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?([Zz]|[+-]\\d{2}:\\d{2})$",
      "description": "RFC 3339 timestamp of when the outcome was recorded."
    },
    "trace_ids": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
      },
      "description": "IDs of the Agent Trace record(s) this outcome verifies. Optional: outcome records are writable even when no Agent Trace producer is installed."
    },
    "vcs": { "$ref": "#/$defs/vcs" },
    "intent": { "$ref": "#/$defs/intent" },
    "checks": {
      "type": "array",
      "items": { "$ref": "#/$defs/check" },
      "description": "Verification events observed for this change. May be empty (verdict is then 'unverified')."
    },
    "verdict": {
      "type": "string",
      "enum": ["verified", "failed", "partial", "unverified"],
      "description": "Aggregate result derived from checks per the normative rule in SPEC.md §6.6."
    },
    "reviewed_by": {
      "type": "array",
      "items": { "$ref": "#/$defs/reviewer" },
      "description": "Humans or AI systems that reviewed the change."
    },
    "lesson": { "$ref": "#/$defs/lesson" },
    "metadata": {
      "type": "object",
      "propertyNames": { "pattern": "^[a-z0-9-]+(\\.[a-zA-Z0-9-]+)+$" },
      "additionalProperties": { "type": "object" },
      "description": "Vendor extensions under reverse-domain namespaces, per Agent Trace §7.2."
    }
  },
  "$defs": {
    "vcs": {
      "type": "object",
      "required": ["type", "revision"],
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["git", "jj", "hg", "svn"] },
        "revision": { "type": "string", "minLength": 1 }
      },
      "if": { "properties": { "type": { "const": "git" } } },
      "then": { "properties": { "revision": { "pattern": "^[0-9a-f]{40}$" } } },
      "description": "Version control reference for the change, mirroring Agent Trace $defs/vcs."
    },
    "intent": {
      "type": "object",
      "required": ["summary"],
      "additionalProperties": false,
      "properties": {
        "summary": {
          "type": "string",
          "minLength": 1,
          "description": "One-line human/agent-readable statement of what the change was trying to do."
        },
        "source": {
          "type": "object",
          "required": ["type"],
          "additionalProperties": false,
          "properties": {
            "type": {
              "type": "string",
              "enum": ["issue", "plan", "decision", "conversation", "manual"]
            },
            "url": { "type": "string" },
            "path": {
              "type": "string",
              "description": "Repo-relative path to the source document."
            }
          }
        }
      }
    },
    "check": {
      "type": "object",
      "required": ["name", "kind", "status"],
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "kind": {
          "type": "string",
          "enum": ["test", "lint", "typecheck", "build", "security", "review", "manual", "deploy", "other"]
        },
        "status": { "type": "string", "enum": ["pass", "fail", "skip", "error"] },
        "detail_url": {
          "type": "string",
          "description": "Link to the CI run / check-run for this check."
        },
        "summary": {
          "type": "string",
          "description": "Optional short result summary, e.g. '3 failures in auth.spec.ts'."
        }
      }
    },
    "reviewer": {
      "type": "object",
      "required": ["type", "id"],
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["human", "ai"] },
        "id": {
          "type": "string",
          "minLength": 1,
          "description": "Login for humans; provider/model-name (models.dev convention, Agent Trace §6.7) for AI."
        }
      }
    },
    "lesson": {
      "type": "object",
      "required": ["summary"],
      "additionalProperties": false,
      "properties": {
        "summary": {
          "type": "string",
          "minLength": 1,
          "description": "One paragraph: what this change taught, written for retrieval by future agents."
        },
        "tags": { "type": "array", "items": { "type": "string", "minLength": 1 } },
        "applies_to": {
          "type": "array",
          "items": { "type": "string", "minLength": 1 },
          "description": "Repo-relative paths/globs this lesson is relevant to."
        }
      }
    }
  }
}
```

`additionalProperties: false` describes the fields this version defines; per §7.1, readers do not reject records carrying fields from a later minor version (the reference validator reports them as warnings).

## 7. Extensibility

### 7.1 Specification versioning

- Major version: breaking changes to required fields.
- Minor version: additive changes (new optional fields). Records carry the version they conform to; readers do not reject records for fields they do not recognize (the reference validator reports them as warnings).

### 7.2 `outcome` as a related resource type

For linking in the *other* direction — from an Agent Trace record to its outcome — this specification defines a new `related` resource type, `"outcome"`, for the parent's `related[]` array, following the pattern of `"decision"` ([#16](https://github.com/cursor/agent-trace/issues/16)) and `"plan"` ([#29](https://github.com/cursor/agent-trace/issues/29)):

```json
"related": [
  { "type": "outcome", "path": ".agent-trace/outcomes/c9d8e7f-e8f9a0b1.json" }
]
```

This adopts #29's proposed optional `path` field on related entries (with the `oneOf` url-XOR-path constraint), and for the same reason: outcome records are repo-local by default, and repo-local paths persist where vendor URLs rot. Producers that cannot modify trace records lose nothing — the `trace_ids` back-link on the Outcome Record carries the same relationship.

### 7.3 Vendor metadata

As in the parent spec (§6.9 above): reverse-domain namespaces inside `metadata`.

### 7.4 Storage

The specification is storage-unopinionated. The reference implementation provides two backends:

1. **Repo files** (default): `.agent-trace/outcomes/<short-sha>-<id-prefix>.json`. Durable, survives clones, reviewable in pull requests — the durability argument of #16/#29 applied to outcomes.
2. **Git notes**: NDJSON under the ref `refs/notes/agent-trace/outcomes`. History-clean, zero repo clutter. Prior art: [git-ai](https://usegitai.com/docs/cli/how-git-ai-works) stores attribution in `refs/notes/ai`. Note that [git notes](https://git-scm.com/docs/git-notes) are not transferred by default: `git push origin refs/notes/*` / `git fetch origin refs/notes/agent-trace/outcomes:refs/notes/agent-trace/outcomes`.

### 7.5 Cryptographic profiles

[cursor/agent-trace#31](https://github.com/cursor/agent-trace/issues/31) proposes an optional cryptographic digest profile for trace records. Outcome records are designed to remain digestible under any such profile adopted upstream: the reference serializer emits deterministic field ordering (schema declaration order, stable nested ordering), so independent verifiers can reproduce digests byte-for-byte.

## 8. Reference Implementation

This repository ships the reference implementation in TypeScript (Node ≥ 18, dual ESM/CJS, zero runtime dependencies in the core):

- [`schemas.ts`](./schemas.ts) — the JSON Schema, generated types, a zero-dependency validator, and the deterministic serializer.
- [`src/store.ts`](./src/store.ts) — `OutcomeStore` over the two backends (§7.3), with injectable `exec`/`fs` for sandboxing and tests.
- [`src/verdict.ts`](./src/verdict.ts) — the §6.6 derivation rule as a pure function.
- [`src/index.ts`](./src/index.ts) — the library surface: `recordOutcome()`, `queryLessons()`, `queryLog()`, `verdictFor()`, `deriveVerdict()`, `openStore()`.
- [`src/cli.ts`](./src/cli.ts) — the `atrace-outcomes` CLI: `record`, `log`, `verdict`, `lessons`, `validate`.
- [`action.yml`](./action.yml) — a GitHub Action that synthesizes outcome records from merged PRs' check runs.

## 9. Positioning and Prior Art

### 9.1 Adjacent lanes (complementary, not competing)

- **Runtime agent observability** — OpenTelemetry GenAI spans, Braintrust, Comet, Gravitee, UiPath agent traces — records *what an agent did during execution*: tool calls, token counts, latencies. Outcome Records capture *what happened to the resulting change afterward*, as a portable repo-resident record. An observability trace expires with its retention window; an outcome record travels with the clone.
- **Cryptographic receipt tools** (e.g. agentic-trace-cli) prove a record *wasn't tampered with*. This specification defines what the record *says*. §7.5 keeps the two composable.
- **git-ai's open standard** ([v3.0.0](https://raw.githubusercontent.com/git-ai-project/git-ai/main/specs/git_ai_standard_v3.0.0.md)) is attribution-only: its "attestation" is a line-attribution mapping, and the format contains no outcome, verdict, check, or lesson fields. git-ai's outcome-adjacent features (rework rates, incident-to-session linking) live in its closed Teams analytics product; this specification is the open counterpart to that idea, formatted as a sibling of Agent Trace rather than a separate ecosystem.
- **ADR/MADR** ([adr.github.io/madr](https://adr.github.io/madr/)) is the long-standing prior art for repo-resident "why" records, and the precedent [#16](https://github.com/cursor/agent-trace/issues/16) builds on. Outcome Records are the same move applied to "did it work."

### 9.2 Within the Agent Trace ecosystem

As of July 2026, every existing extension proposal on cursor/agent-trace covers the period before or during generation (#9 prompts/correlation, #16 decisions, #18 trust intent, #29 plans, #31 integrity). Outcome Records are the first proposal for the period after: post-hoc verification facts. [RFC-ISSUE.md](./RFC-ISSUE.md) is the upstream proposal.

### 9.3 Use without Agent Trace

Outcome Records do not require Agent Trace records to exist. They attach to commits, and `trace_ids` is optional (§6.2), so a repository can write and query outcomes with no attribution tooling installed. Repositories using a different attribution mechanism (git-ai's notes, `Co-authored-by` trailers) can also write outcome records against their commits; a minor version can add a generalized attribution reference if needed (§7.1).

## Appendix

### A. Minimal valid record

```json
{
  "version": "0.1.0",
  "id": "b3c1a2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "timestamp": "2026-07-13T18:30:00Z",
  "vcs": {
    "type": "git",
    "revision": "8f4e2c1a9b7d6e5f4c3b2a1908f7e6d5c4b3a291"
  },
  "checks": [
    { "name": "unit-tests", "kind": "test", "status": "pass" }
  ],
  "verdict": "verified"
}
```

### B. MIME type

`application/vnd.agent-trace.outcome+json`, following the parent's `application/vnd.agent-trace.record+json` pattern.

### C. FAQ

**Can a commit have more than one outcome record?**
Yes. A common sequence: CI writes a record at merge time, and a manual review adds another later. Consumers that need a single answer take the newest record for the revision (the reference `verdictFor` does this); consumers that need history read all of them.

**Can a record be changed after it is written?**
Write a new record for the same revision instead. Records are small, and the sequence of records for a revision is itself information — a `failed` followed by a `verified` is a fix, confirmed.

**Why not store outcomes in commit messages or trailers?**
Outcomes arrive after the commit exists: CI finishes minutes later, reviews land days later. A separate record can be written at any time without rewriting history.

**What about attempts that never became commits?**
An outcome record describes a revision, so a discarded attempt is only recordable if it was committed somewhere — for example, a per-attempt work branch. Hosts that want failure history for uncommitted attempts commit them first.

**How does this differ from reading the GitHub Checks API directly?**
The Checks API is a source, and the reference implementation can populate `checks[]` from it (`--from-checks`). The record is a durable snapshot: API data sits behind authentication and retention windows; a record travels with every clone.

**Does an Outcome Record require Agent Trace?**
No (§9.3). `trace_ids` links the two when both are present; either is useful alone.

### D. References

- Agent Trace specification: https://github.com/cursor/agent-trace · https://agent-trace.dev/
- Extension-pattern precedents: [#16 (decision related type)](https://github.com/cursor/agent-trace/issues/16), [#29 (Plan Records)](https://github.com/cursor/agent-trace/issues/29), [#9 (prompt_id / correlation_id)](https://github.com/cursor/agent-trace/issues/9), [#31 (cryptographic profile)](https://github.com/cursor/agent-trace/issues/31)
- git-ai and its open standard: https://github.com/git-ai-project/git-ai · https://usegitai.com/docs/cli/how-git-ai-works
- git notes: https://git-scm.com/docs/git-notes
- GitHub Checks API: https://docs.github.com/en/rest/checks/runs
- Model identifiers: https://models.dev
- MADR: https://adr.github.io/madr/
- Cognition's Agent Trace announcement (context-graph framing): https://cognition.com/blog/agent-trace

## License

This specification text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), matching the parent Agent Trace specification. The reference implementation code in this repository is licensed under [MIT](./LICENSE).

## Contributing

Discussion happens on GitHub. The upstream proposal to cursor/agent-trace is [RFC-ISSUE.md](./RFC-ISSUE.md).
