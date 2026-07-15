import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultExec } from "../src/store";
import { commitFiles, makeScratchRepo } from "./helpers";

const CLI = path.resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "cli.js");

async function cli(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return defaultExec(process.execPath, [CLI, ...args], { cwd });
}

async function cliWithStdin(
  cwd: string,
  input: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return defaultExec(process.execPath, [CLI, ...args], { cwd, input });
}

describe("atrace-outcomes CLI (end-to-end on a scratch repo)", () => {
  it("record → log → verdict → lessons round-trip", async () => {
    const repo = await makeScratchRepo();
    await commitFiles(repo, { "src/auth/token.ts": "export {}\n" }, "auth change");

    const rec = await cli(
      repo,
      "record",
      "--intent",
      "fix token refresh race",
      "--check",
      "unit-tests:test:fail",
      "--check",
      "lint:lint:pass",
      "--lesson",
      "Concurrent refreshes invalidate each other; serialize them.",
      "--tag",
      "auth",
      "--applies-to",
      "src/auth/**",
    );
    expect(rec.stderr).toBe("");
    expect(rec.code).toBe(0);
    expect(rec.stdout).toContain("recorded failed outcome");

    const log = await cli(repo, "log", "src/auth");
    expect(log.code).toBe(0);
    expect(log.stdout).toContain("failed");
    expect(log.stdout).toContain("fix token refresh race");

    const verdict = await cli(repo, "verdict", "HEAD");
    expect(verdict.code).toBe(1); // failed ⇒ non-zero, composes as a CI gate
    expect(verdict.stdout).toContain("failed");
    expect(verdict.stdout).toContain("unit-tests");

    const lessons = await cli(repo, "lessons", "src/auth", "--json");
    expect(lessons.code).toBe(0);
    const parsed = JSON.parse(lessons.stdout) as Array<{ summary: string; tags: string[] }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.summary).toContain("serialize them");
    expect(parsed[0]!.tags).toEqual(["auth"]);
  });

  it("verdict exits 0 for verified commits", async () => {
    const repo = await makeScratchRepo();
    await cli(repo, "record", "--check", "unit:test:pass");
    const verdict = await cli(repo, "verdict", "HEAD");
    expect(verdict.code).toBe(0);
    expect(verdict.stdout).toContain("verified");
  });

  it("supports the notes backend end-to-end", async () => {
    const repo = await makeScratchRepo();
    const rec = await cli(repo, "record", "--backend", "notes", "--check", "unit:pass");
    expect(rec.code).toBe(0);
    const verdict = await cli(repo, "verdict", "HEAD", "--backend", "notes");
    expect(verdict.code).toBe(0);
  });

  it("record --json emits the record; validate accepts it", async () => {
    const repo = await makeScratchRepo();
    const rec = await cli(repo, "record", "--check", "unit:test:pass", "--json");
    expect(rec.code).toBe(0);
    const record = JSON.parse(rec.stdout) as { verdict: string };
    expect(record.verdict).toBe("verified");

    const file = path.join(repo, "record.json");
    await writeFile(file, rec.stdout);
    const valid = await cli(repo, "validate", "record.json");
    expect(valid.code).toBe(0);
    expect(valid.stdout).toContain("valid outcome record");
  });

  it("validate rejects invalid records with exit 1 and errors on stderr", async () => {
    const repo = await makeScratchRepo();
    await writeFile(path.join(repo, "bad.json"), JSON.stringify({ version: "0.1.0" }));
    const res = await cli(repo, "validate", "bad.json");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("missing required field");
  });

  it("lessons --claude-hook emits a Claude Code hook envelope", async () => {
    const repo = await makeScratchRepo();
    await cli(
      repo,
      "record",
      "--check",
      "unit:test:pass",
      "--lesson",
      "envelope test lesson",
    );
    const res = await cli(repo, "lessons", "--claude-hook");
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("envelope test lesson");
  });

  it("threads --task-id and --derived-from into the record", async () => {
    const repo = await makeScratchRepo();
    const rec = await cli(
      repo,
      "record",
      "--check",
      "unit:test:pass",
      "--task-id",
      "11111111-2222-4333-8444-555555555555",
      "--derived-from",
      "66666666-7777-4888-8999-aaaaaaaaaaaa",
      "--json",
    );
    expect(rec.code).toBe(0);
    const record = JSON.parse(rec.stdout) as { task_id: string; derived_from: string };
    expect(record.task_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(record.derived_from).toBe("66666666-7777-4888-8999-aaaaaaaaaaaa");
  });

  it("--selected and --pruned set selected true/false, and are mutually exclusive", async () => {
    const repo = await makeScratchRepo();
    const selected = await cli(repo, "record", "--check", "unit:test:pass", "--selected", "--json");
    expect(selected.code).toBe(0);
    expect((JSON.parse(selected.stdout) as { selected: boolean }).selected).toBe(true);

    const pruned = await cli(repo, "record", "--check", "unit:test:pass", "--pruned", "--json");
    expect(pruned.code).toBe(0);
    expect((JSON.parse(pruned.stdout) as { selected: boolean }).selected).toBe(false);

    const both = await cli(repo, "record", "--check", "unit:test:pass", "--selected", "--pruned");
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("mutually exclusive");
  });

  it("--dirty marks vcs.workspace_state as dirty", async () => {
    const repo = await makeScratchRepo();
    const rec = await cli(repo, "record", "--check", "unit:test:pass", "--dirty", "--json");
    expect(rec.code).toBe(0);
    const record = JSON.parse(rec.stdout) as { vcs: { workspace_state: string } };
    expect(record.vcs.workspace_state).toBe("dirty");
  });

  it("--diff-file reads a file into vcs.diff", async () => {
    const repo = await makeScratchRepo();
    const diffText = "diff --git a/x b/x\n+hi\n";
    await writeFile(path.join(repo, "change.diff"), diffText);
    const rec = await cli(
      repo,
      "record",
      "--check",
      "unit:test:pass",
      "--diff-file",
      "change.diff",
      "--json",
    );
    expect(rec.code).toBe(0);
    const record = JSON.parse(rec.stdout) as { vcs: { diff: string } };
    expect(record.vcs.diff).toBe(diffText);
  });

  it("--diff-file - reads the diff from stdin", async () => {
    const repo = await makeScratchRepo();
    const diffText = "diff --git a/y b/y\n+stdin diff\n";
    const rec = await cliWithStdin(repo, diffText, [
      "record",
      "--check",
      "unit:test:pass",
      "--diff-file",
      "-",
      "--json",
    ]);
    expect(rec.code).toBe(0);
    const record = JSON.parse(rec.stdout) as { vcs: { diff: string } };
    expect(record.vcs.diff).toBe(diffText);
  });

  it("auto-computes coverage from checks in the recorded output", async () => {
    const repo = await makeScratchRepo();
    const rec = await cli(
      repo,
      "record",
      "--check",
      "unit:test:pass",
      "--check",
      "lint:lint:pass",
      "--json",
    );
    expect(rec.code).toBe(0);
    const record = JSON.parse(rec.stdout) as {
      coverage: { total: number; by_kind: Record<string, number>; has_review: boolean };
    };
    expect(record.coverage).toEqual({ total: 2, by_kind: { test: 1, lint: 1 }, has_review: false });
  });

  it("fails cleanly outside a git repo", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "atrace-nogit-"));
    const res = await cli(dir, "record", "--check", "unit:test:pass");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("rev-parse");
  });
});
