import { describe, expect, it } from "vitest";
import { deriveVerdict } from "../src/verdict";
import type { Check, CheckStatus } from "../schemas";

const check = (status: CheckStatus, name = status): Check => ({
  name,
  kind: "test",
  status,
});

describe("deriveVerdict (SPEC.md §6.6)", () => {
  it("returns unverified when no checks are recorded", () => {
    expect(deriveVerdict([])).toBe("unverified");
  });

  it("returns unverified when every check was skipped", () => {
    expect(deriveVerdict([check("skip"), check("skip")])).toBe("unverified");
  });

  it("returns verified when all non-skipped checks pass and at least one ran", () => {
    expect(deriveVerdict([check("pass")])).toBe("verified");
    expect(deriveVerdict([check("pass"), check("pass")])).toBe("verified");
    expect(deriveVerdict([check("pass"), check("skip")])).toBe("verified");
  });

  it("returns failed when any check failed, regardless of other statuses", () => {
    expect(deriveVerdict([check("fail")])).toBe("failed");
    expect(deriveVerdict([check("pass"), check("fail")])).toBe("failed");
    expect(deriveVerdict([check("fail"), check("skip")])).toBe("failed");
    expect(deriveVerdict([check("fail"), check("error")])).toBe("failed");
  });

  it("returns partial for a mix involving errors but no failures", () => {
    expect(deriveVerdict([check("error")])).toBe("partial");
    expect(deriveVerdict([check("pass"), check("error")])).toBe("partial");
    expect(deriveVerdict([check("error"), check("skip")])).toBe("partial");
  });

  it("failed takes precedence over partial", () => {
    expect(deriveVerdict([check("pass"), check("error"), check("fail")])).toBe("failed");
  });
});
