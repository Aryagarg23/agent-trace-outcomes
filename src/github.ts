import type { Check, CheckKind, CheckStatus } from "../schemas";

/**
 * GitHub Checks API integration for `--from-checks` and the GitHub Action.
 * The only module that performs network calls, and only when explicitly
 * invoked. Uses the global fetch (Node >= 18); no dependencies.
 */

/** Subset of a GitHub check-run object we consume. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
  app?: { name?: string | null } | null;
}

export interface FetchCheckRunsOptions {
  owner: string;
  repo: string;
  /** Commit SHA (or branch/tag ref) to list check runs for. */
  ref: string;
  token?: string;
  /** Defaults to https://api.github.com (or GITHUB_API_URL in Actions). */
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * List all check runs for a git ref via
 * GET /repos/{owner}/{repo}/commits/{ref}/check-runs (paginated).
 */
export async function fetchCheckRuns(opts: FetchCheckRunsOptions): Promise<CheckRun[]> {
  const apiUrl = (opts.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-trace-outcomes",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const runs: CheckRun[] = [];
  for (let page = 1; ; page++) {
    const url = `${apiUrl}/repos/${opts.owner}/${opts.repo}/commits/${opts.ref}/check-runs?per_page=100&page=${page}`;
    const res = await doFetch(url, { headers });
    if (!res.ok) {
      throw new Error(
        `GitHub Checks API ${res.status} for ${opts.owner}/${opts.repo}@${opts.ref}: ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { total_count: number; check_runs: CheckRun[] };
    runs.push(...body.check_runs);
    if (runs.length >= body.total_count || body.check_runs.length === 0) break;
  }
  return runs;
}

/**
 * Map a check-run conclusion to a check status.
 *
 * success → pass; failure / timed_out / startup_failure → fail;
 * skipped / neutral → skip; cancelled / action_required / stale → error;
 * not yet completed (conclusion null) → error (indeterminate — the verdict
 * becomes "partial", never a premature "verified").
 */
export function statusFromConclusion(run: CheckRun): CheckStatus {
  if (run.status !== "completed" || run.conclusion === null) return "error";
  switch (run.conclusion) {
    case "success":
      return "pass";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "fail";
    case "skipped":
    case "neutral":
      return "skip";
    default:
      // cancelled, action_required, stale, or future values
      return "error";
  }
}

/**
 * Heuristic mapping from a check-run name to a check kind. `spec`, `jest`,
 * `style`, and `format` are word-bounded because, unbounded, they match
 * inside unrelated words ("inspect", "majestic", "lifestyle", "reformat"),
 * misclassifying non-test/lint checks as test/lint.
 */
export function inferCheckKind(name: string): CheckKind {
  const n = name.toLowerCase();
  if (/security|codeql|audit|snyk|trivy|semgrep/.test(n)) return "security";
  if (/\btest|\bspec\b|\bjest\b|vitest|pytest|e2e|integration/.test(n)) return "test";
  if (/lint|eslint|prettier|\bformat\b|\bstyle\b/.test(n)) return "lint";
  if (/typecheck|type-check|\btsc\b|mypy|pyright/.test(n)) return "typecheck";
  if (/build|compile|bundle/.test(n)) return "build";
  if (/deploy|release|publish/.test(n)) return "deploy";
  if (/\breview\b/.test(n)) return "review";
  return "other";
}

/** Convert check runs into outcome-record checks. */
export function checksFromCheckRuns(runs: CheckRun[]): Check[] {
  return runs.map((run) => {
    const status = statusFromConclusion(run);
    const summary =
      run.output?.summary?.trim() ||
      (run.status !== "completed" ? `not completed (status: ${run.status})` : undefined);
    return {
      name: run.name,
      kind: inferCheckKind(run.name),
      status,
      ...(run.details_url ? { detail_url: run.details_url } : {}),
      ...(summary ? { summary: summary.slice(0, 500) } : {}),
    };
  });
}

export interface CiContext {
  revision?: string;
  owner?: string;
  repo?: string;
  apiUrl?: string;
  /** Link to the workflow run, usable as a check detail_url. */
  runUrl?: string;
  workflow?: string;
  job?: string;
}

/** Read GitHub Actions environment variables for `--from-ci`. */
export function ciContextFromEnv(
  env: Record<string, string | undefined> = process.env,
): CiContext {
  const ctx: CiContext = {};
  if (env.GITHUB_SHA) ctx.revision = env.GITHUB_SHA;
  if (env.GITHUB_REPOSITORY) {
    const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
    if (owner && repo) {
      ctx.owner = owner;
      ctx.repo = repo;
    }
  }
  if (env.GITHUB_API_URL) ctx.apiUrl = env.GITHUB_API_URL;
  if (env.GITHUB_WORKFLOW) ctx.workflow = env.GITHUB_WORKFLOW;
  if (env.GITHUB_JOB) ctx.job = env.GITHUB_JOB;
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    ctx.runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return ctx;
}

/** Parse owner/repo out of a GitHub remote URL (https or ssh). */
export function parseGitHubRepo(
  remoteUrl: string,
): { owner: string; repo: string } | undefined {
  const match =
    /^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/git@[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      remoteUrl.trim(),
    );
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}
