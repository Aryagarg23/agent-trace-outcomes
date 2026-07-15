import { describe, expect, it } from "vitest";
import {
  OUTCOME_RECORD_SCHEMA,
  serializeOutcomeRecord,
  validateOutcomeRecord,
  type OutcomeRecord,
} from "../schemas";

const SHA = "a".repeat(40);

const minimal = (): OutcomeRecord => ({
  version: "0.1.0",
  id: "01234567-89ab-4def-8123-456789abcdef",
  timestamp: "2026-07-13T12:00:00Z",
  vcs: { type: "git", revision: SHA },
  checks: [],
  verdict: "unverified",
});

const full = (): OutcomeRecord => ({
  ...minimal(),
  trace_ids: ["fedcba98-7654-4321-8fed-cba987654321"],
  task_id: "11111111-2222-4333-8444-555555555555",
  derived_from: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  vcs: {
    type: "git",
    revision: SHA,
    workspace_state: "dirty",
    diff: "diff --git a/x b/x\n+hi\n",
  },
  intent: {
    summary: "fix token refresh race",
    source: { type: "issue", url: "https://example.com/issues/1", path: "docs/plan.md" },
  },
  checks: [
    {
      name: "unit-tests",
      kind: "test",
      status: "pass",
      detail_url: "https://ci.example.com/run/1",
      summary: "212 passed",
    },
  ],
  verdict: "verified",
  coverage: { total: 1, by_kind: { test: 1 }, has_review: true },
  reviewed_by: [
    { type: "human", id: "arya" },
    { type: "ai", id: "anthropic/claude-fable-5" },
  ],
  lesson: {
    summary: "The refresh path needs a mutex; concurrent refreshes invalidate each other.",
    tags: ["auth", "race-condition"],
    applies_to: ["src/auth/**"],
  },
  selected: true,
  metadata: { "com.example": { run: 1 } },
});

function expectError(record: unknown, fragment: string): void {
  const result = validateOutcomeRecord(record);
  expect(result.valid).toBe(false);
  expect(result.errors.join("\n")).toContain(fragment);
}

describe("validateOutcomeRecord", () => {
  it("accepts a minimal valid record", () => {
    const result = validateOutcomeRecord(minimal());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts a fully-populated record", () => {
    const result = validateOutcomeRecord(full());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("rejects non-objects", () => {
    expectError("hi", "expected a JSON object");
    expectError(null, "expected a JSON object");
    expectError([minimal()], "expected a JSON object");
  });

  it("requires version, id, timestamp, vcs, checks, verdict", () => {
    for (const field of ["version", "id", "timestamp", "vcs", "checks", "verdict"]) {
      const record: Record<string, unknown> = { ...minimal() };
      delete record[field];
      expectError(record, `missing required field "${field}"`);
    }
  });

  it("warns on (but accepts) unknown properties, per the §7.1 versioning rule", () => {
    const result = validateOutcomeRecord({ ...minimal(), files: [] });
    expect(result.valid).toBe(true);
    expect(result.warnings.join("\n")).toContain('unknown property "files"');
  });

  it("survives a plausible v0.2 record (unknown attribution field)", () => {
    const v02 = {
      ...minimal(),
      version: "0.2.0",
      attribution: [{ format: "git-ai", ref: "refs/notes/ai" }],
    };
    const result = validateOutcomeRecord(v02);
    expect(result.valid).toBe(true);
    expect(result.warnings.join("\n")).toContain('unknown property "attribution"');
  });

  it("validates version as semver", () => {
    expectError({ ...minimal(), version: "1.0" }, "version");
  });

  it("validates id and trace_ids as UUIDs", () => {
    expectError({ ...minimal(), id: "not-a-uuid" }, "id");
    expectError({ ...minimal(), trace_ids: ["nope"] }, "trace_ids[0]");
  });

  it("validates timestamp as RFC 3339", () => {
    expectError({ ...minimal(), timestamp: "yesterday" }, "timestamp");
    expectError({ ...minimal(), timestamp: "2026-07-13" }, "timestamp");
    const offset = validateOutcomeRecord({ ...minimal(), timestamp: "2026-07-13T12:00:00+05:30" });
    expect(offset.valid).toBe(true);
  });

  it("validates vcs type and git revision shape", () => {
    expectError({ ...minimal(), vcs: { type: "cvs", revision: SHA } }, "vcs.type");
    expectError({ ...minimal(), vcs: { type: "git", revision: "abc123" } }, "40-character");
    const jj = validateOutcomeRecord({
      ...minimal(),
      vcs: { type: "jj", revision: "zxkq" },
    });
    expect(jj.valid).toBe(true);
  });

  it("validates task_id and derived_from as UUIDs", () => {
    expectError({ ...minimal(), task_id: "not-a-uuid" }, "task_id");
    expectError({ ...minimal(), derived_from: "not-a-uuid" }, "derived_from");
    const ok = validateOutcomeRecord({
      ...minimal(),
      task_id: "11111111-2222-4333-8444-555555555555",
      derived_from: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    });
    expect(ok.valid).toBe(true);
  });

  it("validates vcs.workspace_state and vcs.diff", () => {
    expectError(
      { ...minimal(), vcs: { type: "git", revision: SHA, workspace_state: "filthy" } },
      "vcs.workspace_state",
    );
    expectError(
      { ...minimal(), vcs: { type: "git", revision: SHA, diff: "" } },
      "vcs.diff",
    );
    const ok = validateOutcomeRecord({
      ...minimal(),
      vcs: { type: "git", revision: SHA, workspace_state: "dirty", diff: "diff --git a/x b/x\n" },
    });
    expect(ok.valid).toBe(true);
    // workspace_state does not relax the git SHA requirement.
    expectError(
      { ...minimal(), vcs: { type: "git", revision: "abc123", workspace_state: "dirty" } },
      "40-character",
    );
  });

  it("validates selected as a boolean", () => {
    expectError({ ...minimal(), selected: "true" }, "selected: expected boolean");
    const ok = validateOutcomeRecord({ ...minimal(), selected: false });
    expect(ok.valid).toBe(true);
  });

  it("validates coverage shape", () => {
    expectError({ ...minimal(), coverage: {} }, 'coverage: missing required field "total"');
    expectError(
      { ...minimal(), coverage: { total: -1, by_kind: {}, has_review: false } },
      "coverage.total",
    );
    expectError(
      { ...minimal(), coverage: { total: 0, by_kind: { vibes: 1 }, has_review: false } },
      "coverage.by_kind",
    );
    expectError(
      { ...minimal(), coverage: { total: 0, by_kind: { test: 0 }, has_review: false } },
      'coverage.by_kind["test"]',
    );
    expectError(
      { ...minimal(), coverage: { total: 0, by_kind: {}, has_review: "yes" } },
      "coverage.has_review",
    );
  });

  it("warns (not errors) when coverage disagrees with the derivation rule", () => {
    const record = {
      ...minimal(),
      checks: [{ name: "t", kind: "test" as const, status: "pass" as const }],
      verdict: "verified" as const,
      coverage: { total: 99, by_kind: {}, has_review: false },
    };
    const result = validateOutcomeRecord(record);
    expect(result.valid).toBe(true);
    expect(result.warnings.join("\n")).toContain("coverage");
    expect(result.warnings.join("\n")).toContain("derivation rule");
  });

  it("derives has_review from reviewed_by even with no review-kind check", () => {
    const record = {
      ...minimal(),
      checks: [{ name: "t", kind: "test" as const, status: "pass" as const }],
      verdict: "verified" as const,
      reviewed_by: [{ type: "human" as const, id: "arya" }],
      coverage: { total: 1, by_kind: { test: 1 }, has_review: true },
    };
    const result = validateOutcomeRecord(record);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("requires intent.summary and a valid source type", () => {
    expectError({ ...minimal(), intent: {} }, "intent.summary");
    expectError(
      { ...minimal(), intent: { summary: "x", source: { type: "tweet" } } },
      "intent.source.type",
    );
  });

  it("validates checks entries", () => {
    expectError({ ...minimal(), checks: [{ kind: "test", status: "pass" }] }, "checks[0].name");
    expectError(
      { ...minimal(), checks: [{ name: "t", kind: "vibes", status: "pass" }] },
      "checks[0].kind",
    );
    expectError(
      { ...minimal(), checks: [{ name: "t", kind: "test", status: "green" }] },
      "checks[0].status",
    );
    const extra = validateOutcomeRecord({
      ...minimal(),
      checks: [{ name: "t", kind: "test", status: "pass", extra: 1 }],
    });
    expect(extra.valid).toBe(true);
    expect(extra.warnings.join("\n")).toContain('checks[0]: unknown property "extra"');
  });

  it("validates verdict enum", () => {
    expectError({ ...minimal(), verdict: "great" }, "verdict");
  });

  it("validates reviewed_by entries", () => {
    expectError({ ...minimal(), reviewed_by: [{ type: "robot", id: "x" }] }, "reviewed_by[0].type");
    expectError({ ...minimal(), reviewed_by: [{ type: "human", id: "" }] }, "reviewed_by[0].id");
  });

  it("validates lesson shape", () => {
    expectError({ ...minimal(), lesson: {} }, "lesson.summary");
    expectError({ ...minimal(), lesson: { summary: "x", tags: [""] } }, "lesson.tags[0]");
    expectError({ ...minimal(), lesson: { summary: "x", applies_to: [1] } }, "lesson.applies_to[0]");
  });

  it("requires reverse-domain metadata namespaces with object values", () => {
    expectError({ ...minimal(), metadata: { cursor: {} } }, "reverse-domain");
    expectError({ ...minimal(), metadata: { "com.example": "hi" } }, 'metadata["com.example"]');
    const ok = validateOutcomeRecord({ ...minimal(), metadata: { "dev.cursor": { a: 1 } } });
    expect(ok.valid).toBe(true);
  });

  it("warns (not errors) when verdict disagrees with the derivation rule", () => {
    const record = { ...minimal(), verdict: "verified" as const };
    const result = validateOutcomeRecord(record);
    expect(result.valid).toBe(true);
    expect(result.warnings.join("\n")).toContain("derivation rule");
  });
});

describe("serializeOutcomeRecord", () => {
  it("emits fields in canonical schema order regardless of input order", () => {
    const record = full();
    const shuffled = Object.fromEntries(Object.entries(record).reverse()) as unknown as OutcomeRecord;
    const a = serializeOutcomeRecord(record);
    const b = serializeOutcomeRecord(shuffled);
    expect(a).toBe(b);
    const keys = Object.keys(JSON.parse(a) as Record<string, unknown>);
    expect(keys).toEqual([
      "version",
      "id",
      "timestamp",
      "trace_ids",
      "task_id",
      "derived_from",
      "vcs",
      "intent",
      "checks",
      "verdict",
      "coverage",
      "reviewed_by",
      "lesson",
      "selected",
      "metadata",
    ]);
  });

  it("orders nested objects deterministically too", () => {
    const parsed = JSON.parse(serializeOutcomeRecord(full())) as {
      checks: Array<Record<string, unknown>>;
      vcs: Record<string, unknown>;
      coverage: Record<string, unknown>;
    };
    expect(Object.keys(parsed.vcs)).toEqual(["type", "revision", "workspace_state", "diff"]);
    expect(Object.keys(parsed.checks[0]!)).toEqual([
      "name",
      "kind",
      "status",
      "detail_url",
      "summary",
    ]);
    expect(Object.keys(parsed.coverage)).toEqual(["total", "by_kind", "has_review"]);
  });
});

describe("OUTCOME_RECORD_SCHEMA", () => {
  it("is draft 2020-12 and requires the six core fields", () => {
    expect(OUTCOME_RECORD_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(OUTCOME_RECORD_SCHEMA.required).toEqual([
      "version",
      "id",
      "timestamp",
      "vcs",
      "checks",
      "verdict",
    ]);
  });
});
