import { describe, expect, it } from "vitest";
import {
  checksFromCheckRuns,
  ciContextFromEnv,
  fetchCheckRuns,
  inferCheckKind,
  parseGitHubRepo,
  statusFromConclusion,
  type CheckRun,
} from "../src/github";
import { deriveVerdict } from "../src/verdict";

const run = (over: Partial<CheckRun>): CheckRun => ({
  name: "unit-tests",
  status: "completed",
  conclusion: "success",
  ...over,
});

describe("statusFromConclusion", () => {
  it("maps every documented conclusion value", () => {
    expect(statusFromConclusion(run({ conclusion: "success" }))).toBe("pass");
    expect(statusFromConclusion(run({ conclusion: "failure" }))).toBe("fail");
    expect(statusFromConclusion(run({ conclusion: "timed_out" }))).toBe("fail");
    expect(statusFromConclusion(run({ conclusion: "startup_failure" }))).toBe("fail");
    expect(statusFromConclusion(run({ conclusion: "skipped" }))).toBe("skip");
    expect(statusFromConclusion(run({ conclusion: "neutral" }))).toBe("skip");
    expect(statusFromConclusion(run({ conclusion: "cancelled" }))).toBe("error");
    expect(statusFromConclusion(run({ conclusion: "action_required" }))).toBe("error");
    expect(statusFromConclusion(run({ conclusion: "stale" }))).toBe("error");
  });

  it("treats incomplete runs as errors so verdicts are never prematurely verified", () => {
    const inProgress = run({ status: "in_progress", conclusion: null });
    expect(statusFromConclusion(inProgress)).toBe("error");
    const checks = checksFromCheckRuns([run({}), inProgress]);
    expect(deriveVerdict(checks)).toBe("partial");
  });
});

describe("inferCheckKind", () => {
  it("classifies common CI job names", () => {
    expect(inferCheckKind("unit-tests")).toBe("test");
    expect(inferCheckKind("eslint")).toBe("lint");
    expect(inferCheckKind("typecheck")).toBe("typecheck");
    expect(inferCheckKind("Build & Bundle")).toBe("build");
    expect(inferCheckKind("CodeQL")).toBe("security");
    expect(inferCheckKind("security-audit-tests")).toBe("security");
    expect(inferCheckKind("code-review")).toBe("review");
    expect(inferCheckKind("deploy-preview")).toBe("deploy");
    expect(inferCheckKind("mystery-job")).toBe("other");
  });

  it("does not misclassify unrelated words containing test/lint fragments", () => {
    expect(inferCheckKind("inspect-bundle")).toBe("build");
    expect(inferCheckKind("majestic-report")).toBe("other");
    expect(inferCheckKind("lifestyle-configs")).toBe("other");
    expect(inferCheckKind("respect-conventions")).toBe("other");
  });
});

describe("checksFromCheckRuns", () => {
  it("carries name, detail_url, and truncated summary", () => {
    const checks = checksFromCheckRuns([
      run({
        details_url: "https://ci.example.com/1",
        output: { summary: "x".repeat(600) },
      }),
    ]);
    expect(checks[0]).toMatchObject({ name: "unit-tests", kind: "test", status: "pass" });
    expect(checks[0]!.detail_url).toBe("https://ci.example.com/1");
    expect(checks[0]!.summary!.length).toBe(500);
  });
});

describe("fetchCheckRuns", () => {
  it("paginates and sends the documented headers", async () => {
    const pages = [
      { total_count: 3, check_runs: [run({ name: "a" }), run({ name: "b" })] },
      { total_count: 3, check_runs: [run({ name: "c" })] },
    ];
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      requests.push({ url: String(url), headers: init?.headers ?? {} });
      const body = pages[requests.length - 1] ?? { total_count: 3, check_runs: [] };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const runs = await fetchCheckRuns({
      owner: "octo",
      repo: "hello",
      ref: "a".repeat(40),
      token: "tkn",
      fetchImpl,
    });
    expect(runs.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain("/repos/octo/hello/commits/");
    expect(requests[0]!.url).toContain("per_page=100&page=1");
    expect(requests[0]!.headers.Accept).toBe("application/vnd.github+json");
    expect(requests[0]!.headers.Authorization).toBe("Bearer tkn");
    expect(requests[0]!.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("throws with status and body on API errors", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "Not Found",
    })) as unknown as typeof fetch;
    await expect(
      fetchCheckRuns({ owner: "o", repo: "r", ref: "x", fetchImpl }),
    ).rejects.toThrow("404");
  });
});

describe("ciContextFromEnv", () => {
  it("reads GitHub Actions env vars", () => {
    const ctx = ciContextFromEnv({
      GITHUB_SHA: "a".repeat(40),
      GITHUB_REPOSITORY: "octo/hello",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "42",
      GITHUB_WORKFLOW: "ci",
      GITHUB_JOB: "test",
      GITHUB_API_URL: "https://api.github.com",
    });
    expect(ctx).toEqual({
      revision: "a".repeat(40),
      owner: "octo",
      repo: "hello",
      apiUrl: "https://api.github.com",
      runUrl: "https://github.com/octo/hello/actions/runs/42",
      workflow: "ci",
      job: "test",
    });
  });

  it("returns an empty context outside CI", () => {
    expect(ciContextFromEnv({})).toEqual({});
  });
});

describe("parseGitHubRepo", () => {
  it("parses https, ssh, and git@ remotes", () => {
    expect(parseGitHubRepo("https://github.com/octo/hello.git")).toEqual({
      owner: "octo",
      repo: "hello",
    });
    expect(parseGitHubRepo("https://github.com/octo/hello")).toEqual({
      owner: "octo",
      repo: "hello",
    });
    expect(parseGitHubRepo("git@github.com:octo/hello.git")).toEqual({
      owner: "octo",
      repo: "hello",
    });
    expect(parseGitHubRepo("ssh://git@github.com/octo/hello.git")).toEqual({
      owner: "octo",
      repo: "hello",
    });
    expect(parseGitHubRepo("not a url")).toBeUndefined();
  });
});
