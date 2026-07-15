#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import type { CheckStatus, IntentSourceType, Reviewer, Verdict } from "../schemas";
import {
  CHECK_KINDS,
  CHECK_STATUSES,
  INTENT_SOURCE_TYPES,
  OUTCOME_SPEC_VERSION,
  VERDICTS,
  validateOutcomeRecord,
} from "../schemas";
import {
  checksFromCheckRuns,
  ciContextFromEnv,
  fetchCheckRuns,
  parseGitHubRepo,
  queryLessons,
  queryLog,
  recordOutcome,
  resolveRevision,
  verdictFor,
  type CheckInput,
  type RecordOutcomeOptions,
  type StoreOptions,
} from "./index";
import { defaultExec } from "./store";

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function fail(message: string): never {
  process.stderr.write(`atrace-outcomes: ${message}\n`);
  process.exit(1);
}

function storeOptions(cmdOpts: { repo?: string; backend?: string }): StoreOptions {
  if (cmdOpts.backend && cmdOpts.backend !== "files" && cmdOpts.backend !== "notes") {
    fail(`--backend must be "files" or "notes", got "${cmdOpts.backend}"`);
  }
  return {
    ...(cmdOpts.repo ? { repoPath: cmdOpts.repo } : {}),
    ...(cmdOpts.backend ? { backend: cmdOpts.backend as "files" | "notes" } : {}),
  };
}

function parseCheckSpec(spec: string): CheckInput {
  const parts = spec.split(":");
  if (parts.length === 2) {
    const [name, status] = parts as [string, string];
    if (!CHECK_STATUSES.includes(status as CheckStatus)) {
      fail(`invalid check status "${status}" in "${spec}" (use ${CHECK_STATUSES.join("|")})`);
    }
    return { name, status: status as CheckStatus };
  }
  if (parts.length === 3) {
    const [name, kind, status] = parts as [string, string, string];
    if (!CHECK_KINDS.includes(kind as (typeof CHECK_KINDS)[number])) {
      fail(`invalid check kind "${kind}" in "${spec}" (use ${CHECK_KINDS.join("|")})`);
    }
    if (!CHECK_STATUSES.includes(status as CheckStatus)) {
      fail(`invalid check status "${status}" in "${spec}" (use ${CHECK_STATUSES.join("|")})`);
    }
    return { name, kind: kind as CheckInput["kind"], status: status as CheckStatus };
  }
  fail(`invalid --check "${spec}": use name:status or name:kind:status`);
}

function parseReviewer(spec: string): Reviewer {
  const idx = spec.indexOf(":");
  const type = idx === -1 ? "" : spec.slice(0, idx);
  const id = idx === -1 ? "" : spec.slice(idx + 1);
  if ((type !== "human" && type !== "ai") || !id) {
    fail(`invalid --reviewed-by "${spec}": use human:<login> or ai:<provider/model>`);
  }
  return { type, id };
}

async function githubRepoSlug(
  explicit: string | undefined,
  store: StoreOptions,
): Promise<{ owner: string; repo: string }> {
  const slug = explicit ?? process.env.GITHUB_REPOSITORY;
  if (slug) {
    const [owner, repo] = slug.split("/");
    if (owner && repo) return { owner, repo };
    fail(`invalid repo slug "${slug}": expected owner/repo`);
  }
  const res = await defaultExec("git", ["remote", "get-url", "origin"], {
    cwd: store.repoPath ?? process.cwd(),
  });
  const parsed = res.code === 0 ? parseGitHubRepo(res.stdout) : undefined;
  if (!parsed) {
    fail("cannot determine GitHub repo: pass --github-repo owner/repo or set GITHUB_REPOSITORY");
  }
  return parsed;
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const program = new Command();

program
  .name("atrace-outcomes")
  .description(
    "Outcome Records for Agent Trace: record and query the verified outcomes of code changes.",
  )
  .version(OUTCOME_SPEC_VERSION);

program
  .command("record")
  .description("Write an outcome record for a commit")
  .option("--intent <summary>", "what the change was trying to do")
  .option(
    "--intent-source <type>",
    `intent source type (${INTENT_SOURCE_TYPES.join("|")})`,
  )
  .option("--intent-url <url>", "URL of the intent source")
  .option("--intent-path <path>", "repo-relative path of the intent source")
  .option(
    "-c, --check <spec>",
    "a check as name:status or name:kind:status (repeatable)",
    collect,
    [] as string[],
  )
  .option("--trace-id <uuid>", "Agent Trace record ID this outcome verifies (repeatable)", collect, [] as string[])
  .option("--task-id <uuid>", "stable id shared by every attempt at this task, across revisions")
  .option("--derived-from <uuid>", "id of the parent outcome record this attempt forked from")
  .option("--reviewed-by <spec>", "reviewer as human:<login> or ai:<provider/model> (repeatable)", collect, [] as string[])
  .option("--lesson <summary>", "what this change taught, for future retrieval")
  .option("--tag <tag>", "lesson tag (repeatable)", collect, [] as string[])
  .option("--applies-to <path>", "path/glob the lesson applies to (repeatable)", collect, [] as string[])
  .option("--revision <sha>", "commit to record against (default: HEAD)")
  .option("--dirty", "mark the checks as having run against a dirty worktree on top of revision")
  .option("--diff-file <path>", "unified diff of what was tested, read from a file (or - for stdin)")
  .option("--selected", "mark this explored branch as the one kept")
  .option("--pruned", "mark this explored branch as pruned")
  .option("--verdict <verdict>", `override the derived verdict (${VERDICTS.join("|")})`)
  .option("--from-ci", "populate revision and a check from GitHub Actions env vars")
  .option("--status <status>", "job status for --from-ci (pass|fail|error, or success|failure|cancelled)")
  .option("--from-checks [sha]", "populate checks from the GitHub Checks API for a commit")
  .option("--github-repo <owner/repo>", "GitHub repo for --from-checks (default: origin remote)")
  .option("--token <token>", "GitHub token for --from-checks (default: GITHUB_TOKEN)")
  .option("--backend <backend>", "storage backend: files|notes (default: files)")
  .option("--repo <path>", "repository root (default: cwd)")
  .option("--json", "print the written record as JSON")
  .action(async (opts) => {
    const store = storeOptions(opts);
    const checks: CheckInput[] = (opts.check as string[]).map(parseCheckSpec);
    let revision: string | undefined = opts.revision;
    let detailUrl: string | undefined;

    if (opts.fromCi) {
      const ci = ciContextFromEnv();
      revision ??= ci.revision;
      detailUrl = ci.runUrl;
      const raw = (opts.status ?? process.env.ATRACE_JOB_STATUS ?? "").toLowerCase();
      if (raw) {
        const map: Record<string, CheckStatus> = {
          pass: "pass",
          success: "pass",
          fail: "fail",
          failure: "fail",
          error: "error",
          cancelled: "error",
          skip: "skip",
          skipped: "skip",
        };
        const status = map[raw];
        if (!status) fail(`invalid --status "${raw}"`);
        checks.push({
          name: [ci.workflow, ci.job].filter(Boolean).join("/") || "ci",
          kind: "test",
          status,
          ...(detailUrl ? { detail_url: detailUrl } : {}),
        });
      }
    }

    if (revision !== undefined && !/^[0-9a-f]{40}$/.test(revision)) {
      revision = await resolveRevision(store, revision);
    }

    if (opts.fromChecks !== undefined) {
      const sha =
        typeof opts.fromChecks === "string"
          ? await resolveRevision(store, opts.fromChecks)
          : (revision ?? (await resolveRevision(store)));
      revision ??= sha;
      const { owner, repo } = await githubRepoSlug(opts.githubRepo, store);
      const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      const runs = await fetchCheckRuns({
        owner,
        repo,
        ref: sha,
        token,
        apiUrl: process.env.GITHUB_API_URL,
      });
      checks.push(...checksFromCheckRuns(runs));
    }

    if (opts.verdict && !VERDICTS.includes(opts.verdict as Verdict)) {
      fail(`invalid --verdict "${opts.verdict}" (use ${VERDICTS.join("|")})`);
    }
    if (opts.intentSource && !INTENT_SOURCE_TYPES.includes(opts.intentSource as IntentSourceType)) {
      fail(`invalid --intent-source "${opts.intentSource}" (use ${INTENT_SOURCE_TYPES.join("|")})`);
    }
    if (opts.selected && opts.pruned) {
      fail("--selected and --pruned are mutually exclusive");
    }

    const diff: string | undefined = opts.diffFile
      ? opts.diffFile === "-"
        ? await readStdin()
        : await readFile(opts.diffFile as string, "utf8")
      : undefined;

    const recordOpts: RecordOutcomeOptions = {
      ...store,
      checks,
      ...(revision ? { revision } : {}),
      ...(opts.verdict ? { verdict: opts.verdict as Verdict } : {}),
      ...(opts.intent
        ? {
            intent: {
              summary: opts.intent as string,
              ...(opts.intentSource
                ? {
                    source: {
                      type: opts.intentSource as IntentSourceType,
                      ...(opts.intentUrl ? { url: opts.intentUrl as string } : {}),
                      ...(opts.intentPath ? { path: opts.intentPath as string } : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...((opts.traceId as string[]).length ? { traceIds: opts.traceId as string[] } : {}),
      ...(opts.taskId ? { taskId: opts.taskId as string } : {}),
      ...(opts.derivedFrom ? { derivedFrom: opts.derivedFrom as string } : {}),
      ...((opts.reviewedBy as string[]).length
        ? { reviewedBy: (opts.reviewedBy as string[]).map(parseReviewer) }
        : {}),
      ...(opts.lesson
        ? {
            lesson: {
              summary: opts.lesson as string,
              ...((opts.tag as string[]).length ? { tags: opts.tag as string[] } : {}),
              ...((opts.appliesTo as string[]).length
                ? { applies_to: opts.appliesTo as string[] }
                : {}),
            },
          }
        : {}),
      ...(opts.dirty ? { workspaceState: "dirty" as const } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(opts.selected ? { selected: true } : {}),
      ...(opts.pruned ? { selected: false } : {}),
    };

    const record = await recordOutcome(recordOpts);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      process.stdout.write(
        `recorded ${record.verdict} outcome ${record.id.slice(0, 8)} for ${record.vcs.revision.slice(0, 7)} (${record.checks.length} check${record.checks.length === 1 ? "" : "s"})\n`,
      );
    }
  });

program
  .command("log")
  .description("List outcome records, optionally filtered to a path")
  .argument("[path]", "repo-relative file or directory")
  .option("--limit <n>", "maximum records", (v) => parseInt(v, 10))
  .option("--backend <backend>", "storage backend: files|notes")
  .option("--repo <path>", "repository root (default: cwd)")
  .option("--json", "output JSON instead of a table")
  .action(async (pathArg: string | undefined, opts) => {
    const records = await queryLog({
      ...storeOptions(opts),
      ...(pathArg ? { path: pathArg } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
      return;
    }
    if (records.length === 0) {
      process.stdout.write("no outcome records found\n");
      return;
    }
    process.stdout.write(
      `${"DATE".padEnd(11)}${"SHA".padEnd(9)}${"VERDICT".padEnd(11)}${"INTENT".padEnd(42)}LESSON\n`,
    );
    for (const r of records) {
      process.stdout.write(
        `${r.timestamp.slice(0, 10).padEnd(11)}${r.vcs.revision.slice(0, 7).padEnd(9)}${r.verdict.padEnd(11)}${truncate(r.intent?.summary ?? "-", 40).padEnd(42)}${truncate(r.lesson?.summary ?? "-", 60)}\n`,
      );
    }
  });

program
  .command("verdict")
  .description("Print the verdict and checks for a commit; exit 0 iff verified")
  .argument("<sha>", "commit SHA (short or full)")
  .option("--backend <backend>", "storage backend: files|notes")
  .option("--repo <path>", "repository root (default: cwd)")
  .option("--json", "output JSON")
  .action(async (sha: string, opts) => {
    const report = await verdictFor(sha, storeOptions(opts));
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ verdict: report.verdict, checks: report.checks, record_id: report.record?.id }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${report.verdict}\n`);
      for (const c of report.checks) {
        process.stdout.write(
          `  ${c.status.padEnd(6)} ${c.kind.padEnd(10)} ${c.name}${c.summary ? ` — ${c.summary}` : ""}\n`,
        );
      }
    }
    process.exit(report.verdict === "verified" ? 0 : 1);
  });

program
  .command("lessons")
  .description("Dump lessons from past outcomes, newest first (the agent-facing query)")
  .argument("[path]", "repo-relative file or directory the caller is about to touch")
  .option("--tag <tag>", "filter by lesson tag (repeatable)", collect, [] as string[])
  .option("--limit <n>", "maximum lessons (default 20)", (v) => parseInt(v, 10))
  .option("--backend <backend>", "storage backend: files|notes")
  .option("--repo <path>", "repository root (default: cwd)")
  .option("--json", "output JSON (for agents)")
  .option(
    "--claude-hook [event]",
    "emit a Claude Code hook envelope (hookSpecificOutput.additionalContext); event defaults to SessionStart",
  )
  .action(async (pathArg: string | undefined, opts) => {
    const lessons = await queryLessons({
      ...storeOptions(opts),
      ...(pathArg ? { paths: [pathArg] } : {}),
      ...((opts.tag as string[]).length ? { tags: opts.tag as string[] } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
    if (opts.claudeHook !== undefined) {
      const hookEventName =
        typeof opts.claudeHook === "string" ? opts.claudeHook : "SessionStart";
      const additionalContext = lessons.length
        ? `Lessons from past outcome records in this repo (newest first):\n${lessons
            .map((l) => `- [${l.verdict}] ${l.summary}${l.applies_to.length ? ` (applies to: ${l.applies_to.join(", ")})` : ""}`)
            .join("\n")}`
        : "";
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`,
      );
      return;
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(lessons, null, 2)}\n`);
      return;
    }
    if (lessons.length === 0) {
      process.stdout.write("no lessons found\n");
      return;
    }
    for (const l of lessons) {
      const tags = l.tags.length ? ` [${l.tags.join(", ")}]` : "";
      process.stdout.write(
        `${l.timestamp.slice(0, 10)} ${l.revision.slice(0, 7)} (${l.verdict})${tags}\n  ${l.summary}\n`,
      );
    }
  });

program
  .command("validate")
  .description("Validate a record file against the Outcome Record JSON Schema")
  .argument("<file>", "path to a JSON record")
  .action(async (file: string) => {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const result = validateOutcomeRecord(value);
    for (const w of result.warnings) process.stdout.write(`warning: ${w}\n`);
    if (result.valid) {
      process.stdout.write(`${file}: valid outcome record\n`);
    } else {
      for (const e of result.errors) process.stderr.write(`error: ${e}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
