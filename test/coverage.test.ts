import { describe, expect, it } from "vitest";
import { deriveCoverage } from "../schemas";
import type { Check, CheckKind, Reviewer } from "../schemas";

const check = (kind: CheckKind, name: string = kind): Check => ({
  name,
  kind,
  status: "pass",
});

describe("deriveCoverage (SPEC.md §6.12)", () => {
  it("returns zero total and no has_review for no checks and no reviewers", () => {
    expect(deriveCoverage([])).toEqual({ total: 0, by_kind: {}, has_review: false });
  });

  it("counts checks and groups by kind, omitting kinds with zero checks", () => {
    const checks = [check("test"), check("test", "t2"), check("lint")];
    expect(deriveCoverage(checks)).toEqual({
      total: 3,
      by_kind: { test: 2, lint: 1 },
      has_review: false,
    });
  });

  it("sets has_review true when a check has kind review", () => {
    const checks = [check("test"), check("review")];
    expect(deriveCoverage(checks)).toEqual({
      total: 2,
      by_kind: { test: 1, review: 1 },
      has_review: true,
    });
  });

  it("sets has_review true when reviewed_by is non-empty, even with no review-kind check", () => {
    const checks = [check("test")];
    const reviewedBy: Reviewer[] = [{ type: "human", id: "arya" }];
    expect(deriveCoverage(checks, reviewedBy)).toEqual({
      total: 1,
      by_kind: { test: 1 },
      has_review: true,
    });
  });

  it("sets has_review false when reviewed_by is empty and no review-kind check", () => {
    const checks = [check("test")];
    expect(deriveCoverage(checks, [])).toEqual({
      total: 1,
      by_kind: { test: 1 },
      has_review: false,
    });
  });

  it("is a pure function of its inputs (no I/O, no mutation)", () => {
    const checks = [check("build")];
    const before = JSON.stringify(checks);
    deriveCoverage(checks);
    expect(JSON.stringify(checks)).toBe(before);
  });
});
