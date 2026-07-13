import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { OUTCOME_NOTES_REF, openStore, resolveRevision, changedFiles } from "../src/store";
import type { OutcomeRecord } from "../schemas";
import { commitFiles, git, makeScratchRepo } from "./helpers";

function record(revision: string, id: string): OutcomeRecord {
  return {
    version: "0.1.0",
    id,
    timestamp: new Date().toISOString(),
    vcs: { type: "git", revision },
    checks: [{ name: "unit", kind: "test", status: "pass" }],
    verdict: "verified",
  };
}

const ID_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ID_B = "bbbbbbbb-2222-4222-8222-222222222222";

describe("files backend", () => {
  it("round-trips records via .agent-trace/outcomes/", async () => {
    const repo = await makeScratchRepo();
    const sha = await resolveRevision({ repoPath: repo });
    const store = openStore({ repoPath: repo });

    const location = await store.write(record(sha, ID_A));
    expect(location).toBe(`.agent-trace/outcomes/${sha.slice(0, 7)}-aaaaaaaa.json`);

    const files = await readdir(path.join(repo, ".agent-trace", "outcomes"));
    expect(files).toHaveLength(1);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(ID_A);

    const byRev = await store.forRevision(sha);
    expect(byRev).toHaveLength(1);
    expect(await store.forRevision("f".repeat(40))).toHaveLength(0);
  });

  it("serializes with canonical field order on disk", async () => {
    const repo = await makeScratchRepo();
    const sha = await resolveRevision({ repoPath: repo });
    const store = openStore({ repoPath: repo });
    await store.write(record(sha, ID_A));
    const files = await readdir(path.join(repo, ".agent-trace", "outcomes"));
    const text = await readFile(path.join(repo, ".agent-trace", "outcomes", files[0]!), "utf8");
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"id"'));
    expect(text.endsWith("\n")).toBe(true);
  });

  it("returns [] when the outcomes directory does not exist", async () => {
    const repo = await makeScratchRepo();
    expect(await openStore({ repoPath: repo }).list()).toEqual([]);
  });

  it("skips malformed files instead of failing the query", async () => {
    const repo = await makeScratchRepo();
    const sha = await resolveRevision({ repoPath: repo });
    const store = openStore({ repoPath: repo });
    await store.write(record(sha, ID_A));
    const dir = path.join(repo, ".agent-trace", "outcomes");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "garbage.json"), "{not json");
    expect(await store.list()).toHaveLength(1);
  });
});

describe("notes backend", () => {
  it("round-trips records via git notes and supports multiple records per commit", async () => {
    const repo = await makeScratchRepo();
    const sha = await resolveRevision({ repoPath: repo });
    const store = openStore({ repoPath: repo, backend: "notes" });

    const location = await store.write(record(sha, ID_A));
    expect(location).toBe(`${OUTCOME_NOTES_REF}:${sha}`);
    await store.write(record(sha, ID_B));

    const note = await git(repo, "notes", `--ref=${OUTCOME_NOTES_REF}`, "show", sha);
    expect(note.trim().split("\n")).toHaveLength(2);

    const listed = await store.list();
    expect(listed.map((r) => r.id).sort()).toEqual([ID_A, ID_B]);

    const byRev = await store.forRevision(sha);
    expect(byRev).toHaveLength(2);
  });

  it("returns [] when no notes exist", async () => {
    const repo = await makeScratchRepo();
    const store = openStore({ repoPath: repo, backend: "notes" });
    expect(await store.list()).toEqual([]);
    expect(await store.forRevision("f".repeat(40))).toEqual([]);
  });

  it("keeps records attached to their commit, not the working tree", async () => {
    const repo = await makeScratchRepo();
    const first = await resolveRevision({ repoPath: repo });
    const store = openStore({ repoPath: repo, backend: "notes" });
    await store.write(record(first, ID_A));
    const second = await commitFiles(repo, { "a.txt": "hello" });
    await store.write(record(second, ID_B));
    expect((await store.forRevision(first))[0]!.id).toBe(ID_A);
    expect((await store.forRevision(second))[0]!.id).toBe(ID_B);
  });
});

describe("git helpers", () => {
  it("resolveRevision resolves HEAD and short SHAs to full SHAs", async () => {
    const repo = await makeScratchRepo();
    const full = await resolveRevision({ repoPath: repo });
    expect(full).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveRevision({ repoPath: repo }, full.slice(0, 7))).toBe(full);
    await expect(resolveRevision({ repoPath: repo }, "nope")).rejects.toThrow("rev-parse");
  });

  it("changedFiles lists the files a commit touched", async () => {
    const repo = await makeScratchRepo();
    const sha = await commitFiles(repo, {
      "src/auth/token.ts": "export {}\n",
      "src/db.ts": "export {}\n",
    });
    const files = await changedFiles({ repoPath: repo }, sha);
    expect(files.sort()).toEqual(["src/auth/token.ts", "src/db.ts"]);
  });
});
