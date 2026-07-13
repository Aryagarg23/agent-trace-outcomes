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

  it("fails cleanly outside a git repo", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(path.join(tmpdir(), "atrace-nogit-"));
    const res = await cli(dir, "record", "--check", "unit:test:pass");
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("rev-parse");
  });
});
