import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  pathsOverlap,
  queryLessons,
  queryLog,
  recordOutcome,
  verdictFor,
} from "../src/index";
import { commitFiles, makeScratchRepo } from "./helpers";

describe("pathsOverlap", () => {
  it("matches exact paths and directory prefixes both ways", () => {
    expect(pathsOverlap("src/auth/token.ts", "src/auth/token.ts")).toBe(true);
    expect(pathsOverlap("src/auth/token.ts", "src/auth")).toBe(true);
    expect(pathsOverlap("src/auth", "src/auth/token.ts")).toBe(true);
    expect(pathsOverlap("src/auth/", "src/auth/token.ts")).toBe(true);
    expect(pathsOverlap("src/db.ts", "src/auth")).toBe(false);
    expect(pathsOverlap("src/authx", "src/auth")).toBe(false);
  });

  it("matches globs", () => {
    expect(pathsOverlap("src/auth/**", "src/auth/deep/nested.ts")).toBe(true);
    expect(pathsOverlap("src/*.ts", "src/db.ts")).toBe(true);
    expect(pathsOverlap("src/*.ts", "src/auth/token.ts")).toBe(false);
    expect(pathsOverlap("src/auth/**", "src/auth")).toBe(true);
    expect(pathsOverlap("**/*.spec.ts", "test/a.spec.ts")).toBe(true);
  });
});

describe("recordOutcome", () => {
  it("auto-detects HEAD, derives the verdict, and persists", async () => {
    const repo = await makeScratchRepo();
    const record = await recordOutcome({
      repoPath: repo,
      intent: "initial verification",
      checks: [{ name: "unit", status: "pass", kind: "test" }],
    });
    expect(record.vcs.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(record.verdict).toBe("verified");
    expect(record.intent).toEqual({ summary: "initial verification" });

    const report = await verdictFor(record.vcs.revision, { repoPath: repo });
    expect(report.verdict).toBe("verified");
    expect(report.record!.id).toBe(record.id);
  });

  it("defaults check kind to other and accepts string lessons", async () => {
    const repo = await makeScratchRepo();
    const record = await recordOutcome({
      repoPath: repo,
      checks: [{ name: "eyeballed it", status: "pass" }],
      lesson: "looks fine",
    });
    expect(record.checks[0]!.kind).toBe("other");
    expect(record.lesson).toEqual({ summary: "looks fine" });
  });

  it("rejects invalid input with validation errors", async () => {
    const repo = await makeScratchRepo();
    await expect(
      recordOutcome({ repoPath: repo, traceIds: ["not-a-uuid"] }),
    ).rejects.toThrow("invalid outcome record");
  });

  it("writes unverified records when no checks are given", async () => {
    const repo = await makeScratchRepo();
    const record = await recordOutcome({ repoPath: repo });
    expect(record.verdict).toBe("unverified");
  });

  it("threads task_id, derived_from, selected, workspace state and diff", async () => {
    const repo = await makeScratchRepo();
    const record = await recordOutcome({
      repoPath: repo,
      checks: [{ name: "unit", status: "pass", kind: "test" }],
      taskId: "11111111-2222-4333-8444-555555555555",
      derivedFrom: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      selected: false,
      workspaceState: "dirty",
      diff: "diff --git a/x b/x\n+hi\n",
    });
    expect(record.task_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(record.derived_from).toBe("66666666-7777-4888-8999-aaaaaaaaaaaa");
    expect(record.selected).toBe(false);
    expect(record.vcs.workspace_state).toBe("dirty");
    expect(record.vcs.diff).toBe("diff --git a/x b/x\n+hi\n");
  });

  it("auto-derives coverage from checks and reviewedBy when checks is non-empty", async () => {
    const repo = await makeScratchRepo();
    const record = await recordOutcome({
      repoPath: repo,
      checks: [
        { name: "unit", status: "pass", kind: "test" },
        { name: "lint", status: "pass", kind: "lint" },
      ],
      reviewedBy: [{ type: "human", id: "arya" }],
    });
    expect(record.coverage).toEqual({
      total: 2,
      by_kind: { test: 1, lint: 1 },
      has_review: true,
    });
  });

  it("omits coverage when checks is empty, and honors an explicit override", async () => {
    const repo = await makeScratchRepo();
    const bare = await recordOutcome({ repoPath: repo });
    expect(bare.coverage).toBeUndefined();

    const overridden = await recordOutcome({
      repoPath: repo,
      checks: [{ name: "unit", status: "pass", kind: "test" }],
      coverage: { total: 5, by_kind: { test: 5 }, has_review: true },
    });
    expect(overridden.coverage).toEqual({ total: 5, by_kind: { test: 5 }, has_review: true });
  });
});

describe("verdictFor", () => {
  it("returns unverified for commits with no records", async () => {
    const repo = await makeScratchRepo();
    const report = await verdictFor("HEAD", { repoPath: repo });
    expect(report.verdict).toBe("unverified");
    expect(report.records).toEqual([]);
  });

  it("uses the newest record for the revision", async () => {
    const repo = await makeScratchRepo();
    await recordOutcome({
      repoPath: repo,
      checks: [{ name: "unit", status: "fail", kind: "test" }],
      timestamp: "2026-01-01T00:00:00Z",
    });
    await recordOutcome({
      repoPath: repo,
      checks: [{ name: "unit", status: "pass", kind: "test" }],
      timestamp: "2026-01-02T00:00:00Z",
    });
    const report = await verdictFor("HEAD", { repoPath: repo });
    expect(report.verdict).toBe("verified");
    expect(report.records).toHaveLength(2);
  });
});

describe("queryLog", () => {
  it("filters records by the files their commits touched", async () => {
    const repo = await makeScratchRepo();
    const authSha = await commitFiles(repo, { "src/auth/token.ts": "1\n" }, "auth work");
    await recordOutcome({
      repoPath: repo,
      revision: authSha,
      intent: "auth change",
      checks: [{ name: "unit", status: "pass", kind: "test" }],
    });
    const dbSha = await commitFiles(repo, { "src/db.ts": "1\n" }, "db work");
    await recordOutcome({
      repoPath: repo,
      revision: dbSha,
      intent: "db change",
      checks: [{ name: "unit", status: "fail", kind: "test" }],
    });

    const all = await queryLog({ repoPath: repo });
    expect(all).toHaveLength(2);

    const auth = await queryLog({ repoPath: repo, path: "src/auth" });
    expect(auth).toHaveLength(1);
    expect(auth[0]!.intent!.summary).toBe("auth change");
  });

  it("joins against Agent Trace records' files when trace_ids resolve", async () => {
    const repo = await makeScratchRepo();
    const traceId = "12345678-1234-4123-8123-123456789012";
    await mkdir(path.join(repo, ".agent-trace"), { recursive: true });
    await writeFile(
      path.join(repo, ".agent-trace", "traces.jsonl"),
      `${JSON.stringify({
        version: "1.0.0",
        id: traceId,
        timestamp: "2026-07-13T00:00:00Z",
        files: [{ path: "src/payments/charge.ts", conversations: [] }],
      })}\n`,
    );
    // The commit itself touches nothing under src/payments — only the trace does.
    await recordOutcome({
      repoPath: repo,
      traceIds: [traceId],
      intent: "payments fix",
      checks: [{ name: "unit", status: "pass", kind: "test" }],
    });

    const hits = await queryLog({ repoPath: repo, path: "src/payments" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.intent!.summary).toBe("payments fix");
  });

  it("resolves attribution through the injectable resolveAttribution seam", async () => {
    const repo = await makeScratchRepo();
    // The commit touches nothing under src/custom; only the injected resolver does.
    await recordOutcome({
      repoPath: repo,
      intent: "custom attribution",
      checks: [{ name: "unit", status: "pass", kind: "test" }],
    });

    const hits = await queryLog({
      repoPath: repo,
      path: "src/custom",
      resolveAttribution: async () => ["src/custom/x.ts"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.intent!.summary).toBe("custom attribution");

    const misses = await queryLog({
      repoPath: repo,
      path: "src/custom",
      resolveAttribution: async () => ["src/elsewhere/y.ts"],
    });
    expect(misses).toHaveLength(0);
  });

  it("sorts newest first and honors limit", async () => {
    const repo = await makeScratchRepo();
    await recordOutcome({ repoPath: repo, intent: "old", timestamp: "2026-01-01T00:00:00Z" });
    await recordOutcome({ repoPath: repo, intent: "new", timestamp: "2026-06-01T00:00:00Z" });
    const records = await queryLog({ repoPath: repo, limit: 1 });
    expect(records).toHaveLength(1);
    expect(records[0]!.intent!.summary).toBe("new");
  });

  describe("verdict/status filtering", () => {
    async function seedMixed(repo: string): Promise<void> {
      await recordOutcome({
        repoPath: repo,
        intent: "passed",
        checks: [{ name: "unit", status: "pass", kind: "test" }],
        timestamp: "2026-01-01T00:00:00Z",
      });
      await recordOutcome({
        repoPath: repo,
        intent: "failed",
        checks: [{ name: "unit", status: "fail", kind: "test" }],
        timestamp: "2026-01-02T00:00:00Z",
      });
      await recordOutcome({
        repoPath: repo,
        intent: "partial",
        checks: [
          { name: "unit", status: "pass", kind: "test" },
          { name: "lint", status: "error", kind: "lint" },
        ],
        timestamp: "2026-01-03T00:00:00Z",
      });
      await recordOutcome({
        repoPath: repo,
        intent: "unverified",
        timestamp: "2026-01-04T00:00:00Z",
      });
    }

    it("filters by a single verdict", async () => {
      const repo = await makeScratchRepo();
      await seedMixed(repo);
      const records = await queryLog({ repoPath: repo, verdict: "failed" });
      expect(records).toHaveLength(1);
      expect(records[0]!.intent!.summary).toBe("failed");
    });

    it("filters by an array of verdicts", async () => {
      const repo = await makeScratchRepo();
      await seedMixed(repo);
      const records = await queryLog({ repoPath: repo, verdict: ["failed", "partial"] });
      expect(records.map((r) => r.intent!.summary).sort()).toEqual(["failed", "partial"]);
    });

    it("filters by a single check status", async () => {
      const repo = await makeScratchRepo();
      await seedMixed(repo);
      const records = await queryLog({ repoPath: repo, status: "error" });
      expect(records).toHaveLength(1);
      expect(records[0]!.intent!.summary).toBe("partial");
    });

    it("filters by an array of check statuses", async () => {
      const repo = await makeScratchRepo();
      await seedMixed(repo);
      const records = await queryLog({ repoPath: repo, status: ["fail", "error"] });
      expect(records.map((r) => r.intent!.summary).sort()).toEqual(["failed", "partial"]);
    });

    it("combines verdict and status with path filters (AND semantics)", async () => {
      const repo = await makeScratchRepo();
      const authSha = await commitFiles(repo, { "src/auth/token.ts": "1\n" }, "auth work");
      await recordOutcome({
        repoPath: repo,
        revision: authSha,
        intent: "auth failure",
        checks: [{ name: "unit", status: "fail", kind: "test" }],
      });
      const dbSha = await commitFiles(repo, { "src/db.ts": "1\n" }, "db work");
      await recordOutcome({
        repoPath: repo,
        revision: dbSha,
        intent: "db failure",
        checks: [{ name: "unit", status: "fail", kind: "test" }],
      });

      const authOnly = await queryLog({ repoPath: repo, path: "src/auth", verdict: "failed" });
      expect(authOnly).toHaveLength(1);
      expect(authOnly[0]!.intent!.summary).toBe("auth failure");

      const noneVerified = await queryLog({ repoPath: repo, path: "src/auth", verdict: "verified" });
      expect(noneVerified).toHaveLength(0);
    });

    it("filters before applying limit", async () => {
      const repo = await makeScratchRepo();
      await seedMixed(repo);
      const records = await queryLog({ repoPath: repo, verdict: ["failed", "partial"], limit: 1 });
      expect(records).toHaveLength(1);
      expect(records[0]!.intent!.summary).toBe("partial"); // newest of the two
    });
  });
});

describe("queryLessons", () => {
  async function seed(repo: string): Promise<void> {
    const authSha = await commitFiles(repo, { "src/auth/token.ts": "1\n" });
    await recordOutcome({
      repoPath: repo,
      revision: authSha,
      intent: "fix token refresh",
      checks: [{ name: "unit", status: "fail", kind: "test" }],
      lesson: {
        summary: "Refreshing concurrently invalidates both tokens; serialize refreshes.",
        tags: ["auth", "race"],
        applies_to: ["src/auth/**"],
      },
      timestamp: "2026-02-01T00:00:00Z",
    });
    const dbSha = await commitFiles(repo, { "src/db.ts": "1\n" });
    await recordOutcome({
      repoPath: repo,
      revision: dbSha,
      intent: "pool tuning",
      checks: [{ name: "unit", status: "pass", kind: "test" }],
      // No applies_to: path matching falls back to the commit diff.
      lesson: { summary: "Pool size above 20 exhausts postgres connections.", tags: ["db"] },
      timestamp: "2026-03-01T00:00:00Z",
    });
  }

  it("returns lessons newest first with record context", async () => {
    const repo = await makeScratchRepo();
    await seed(repo);
    const lessons = await queryLessons({ repoPath: repo });
    expect(lessons.map((l) => l.tags[0])).toEqual(["db", "auth"]);
    expect(lessons[1]).toMatchObject({
      verdict: "failed",
      intent: "fix token refresh",
      applies_to: ["src/auth/**"],
    });
  });

  it("filters by paths using applies_to globs", async () => {
    const repo = await makeScratchRepo();
    await seed(repo);
    const lessons = await queryLessons({ repoPath: repo, paths: ["src/auth/session.ts"] });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.tags).toContain("auth");
  });

  it("falls back to commit diff when a lesson has no applies_to", async () => {
    const repo = await makeScratchRepo();
    await seed(repo);
    const lessons = await queryLessons({ repoPath: repo, paths: ["src/db.ts"] });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.summary).toContain("Pool size");
  });

  it("filters by tag and honors limit", async () => {
    const repo = await makeScratchRepo();
    await seed(repo);
    expect(await queryLessons({ repoPath: repo, tags: ["race"] })).toHaveLength(1);
    expect(await queryLessons({ repoPath: repo, limit: 1 })).toHaveLength(1);
  });

  it("skips records without lessons", async () => {
    const repo = await makeScratchRepo();
    await recordOutcome({ repoPath: repo, checks: [{ name: "unit", status: "pass" }] });
    expect(await queryLessons({ repoPath: repo })).toEqual([]);
  });

  describe("verdict/status filtering", () => {
    it("filters by a single verdict", async () => {
      const repo = await makeScratchRepo();
      await seed(repo);
      const lessons = await queryLessons({ repoPath: repo, verdict: "failed" });
      expect(lessons).toHaveLength(1);
      expect(lessons[0]!.intent).toBe("fix token refresh");
    });

    it("filters by an array of verdicts", async () => {
      const repo = await makeScratchRepo();
      await seed(repo);
      // Both seeded records carry a lesson: one "failed", one "verified".
      const both = await queryLessons({ repoPath: repo, verdict: ["failed", "verified"] });
      expect(both).toHaveLength(2);
      const failedOnly = await queryLessons({ repoPath: repo, verdict: ["failed"] });
      expect(failedOnly).toHaveLength(1);
      expect(failedOnly[0]!.intent).toBe("fix token refresh");
    });

    it("filters by check status", async () => {
      const repo = await makeScratchRepo();
      await seed(repo);
      const lessons = await queryLessons({ repoPath: repo, status: "fail" });
      expect(lessons).toHaveLength(1);
      expect(lessons[0]!.intent).toBe("fix token refresh");

      const passing = await queryLessons({ repoPath: repo, status: ["pass"] });
      expect(passing).toHaveLength(1);
      expect(passing[0]!.intent).toBe("pool tuning");
    });

    it("combines verdict/status with tags and paths (AND semantics)", async () => {
      const repo = await makeScratchRepo();
      await seed(repo);
      const hits = await queryLessons({
        repoPath: repo,
        paths: ["src/auth/session.ts"],
        tags: ["auth"],
        verdict: "failed",
        status: "fail",
      });
      expect(hits).toHaveLength(1);

      const misses = await queryLessons({
        repoPath: repo,
        paths: ["src/auth/session.ts"],
        tags: ["auth"],
        verdict: "verified",
      });
      expect(misses).toHaveLength(0);
    });
  });
});

describe("notes backend end-to-end", () => {
  it("supports the full record → query flow", async () => {
    const repo = await makeScratchRepo();
    const opts = { repoPath: repo, backend: "notes" as const };
    await recordOutcome({
      ...opts,
      intent: "notes flow",
      checks: [{ name: "unit", status: "pass", kind: "test" }],
      lesson: { summary: "notes work", applies_to: ["README.md"] },
    });
    expect((await queryLog(opts))[0]!.intent!.summary).toBe("notes flow");
    expect((await queryLessons({ ...opts, paths: ["README.md"] }))[0]!.summary).toBe("notes work");
    expect((await verdictFor("HEAD", opts)).verdict).toBe("verified");
  });
});
