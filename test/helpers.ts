import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { defaultExec } from "../src/store";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await defaultExec(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd },
  );
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

/** Create a scratch git repo with one initial commit; returns its path. */
export async function makeScratchRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "atrace-outcomes-"));
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "README.md"), "# scratch\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "initial commit");
  return dir;
}

/** Commit files (paths relative to repo root) and return the new HEAD sha. */
export async function commitFiles(
  repo: string,
  files: Record<string, string>,
  message = "change",
): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}
