import { spawn } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { OutcomeRecord } from "../schemas";
import { serializeOutcomeRecord, validateOutcomeRecord } from "../schemas";

/** Git notes ref used by the notes backend. Prior art: git-ai uses refs/notes/ai. */
export const OUTCOME_NOTES_REF = "refs/notes/agent-trace/outcomes";

/** Repo-relative directory used by the files backend. */
export const OUTCOMES_DIR = ".agent-trace/outcomes";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Injectable process executor. Hosts can substitute a sandboxed or fake
 * implementation; the default spawns the command without a shell.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string },
) => Promise<ExecResult>;

/**
 * Injectable filesystem, a promise-based subset of node:fs/promises so hosts
 * can test without touching disk.
 */
export interface FsLike {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  writeFile(filePath: string, data: string): Promise<void>;
  mkdir(dirPath: string, opts: { recursive: true }): Promise<unknown>;
  readdir(dirPath: string): Promise<string[]>;
}

export type BackendName = "files" | "notes";

export interface StoreOptions {
  /** Repository root. Defaults to process.cwd(). */
  repoPath?: string;
  /** Storage backend. Defaults to "files". */
  backend?: BackendName;
  exec?: ExecFn;
  fs?: FsLike;
}

export interface OutcomeStore {
  readonly backend: BackendName;
  readonly repoPath: string;
  /** Persist a record. Returns where it was written (file path or notes ref). */
  write(record: OutcomeRecord): Promise<string>;
  /** All records in the store, unordered. */
  list(): Promise<OutcomeRecord[]>;
  /** Records whose vcs.revision equals the given full revision. */
  forRevision(revision: string): Promise<OutcomeRecord[]>;
}

export const defaultExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });

export const defaultFs: FsLike = fsPromises;

interface ResolvedOptions {
  repoPath: string;
  exec: ExecFn;
  fs: FsLike;
}

export function resolveOptions(opts: StoreOptions = {}): ResolvedOptions {
  return {
    repoPath: opts.repoPath ?? process.cwd(),
    exec: opts.exec ?? defaultExec,
    fs: opts.fs ?? defaultFs,
  };
}

async function git(ctx: ResolvedOptions, args: string[], input?: string): Promise<ExecResult> {
  return ctx.exec("git", args, { cwd: ctx.repoPath, input });
}

/** Resolve a revision (or HEAD) to a full SHA via git rev-parse. */
export async function resolveRevision(
  opts: StoreOptions = {},
  revision = "HEAD",
): Promise<string> {
  const ctx = resolveOptions(opts);
  const res = await git(ctx, ["rev-parse", `${revision}^{commit}`]);
  if (res.code !== 0) {
    throw new Error(`git rev-parse failed for "${revision}": ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

/** Files changed by a commit (repo-relative, forward-slash paths). */
export async function changedFiles(
  opts: StoreOptions,
  revision: string,
): Promise<string[]> {
  const ctx = resolveOptions(opts);
  const res = await git(ctx, [
    "diff-tree",
    "-r",
    "--root",
    "--no-commit-id",
    "--name-only",
    revision,
  ]);
  if (res.code !== 0) return [];
  let files = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (files.length === 0) {
    // Merge commits produce no combined diff; compare against first parent.
    const merge = await git(ctx, ["diff", "--name-only", `${revision}^1`, revision]);
    if (merge.code === 0) {
      files = merge.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    }
  }
  return files;
}

function parseRecord(text: string, source: string): OutcomeRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    const result = validateOutcomeRecord(value);
    if (!result.valid) return undefined;
    return value as OutcomeRecord;
  } catch {
    return undefined;
  }
}

class FilesStore implements OutcomeStore {
  readonly backend = "files" as const;
  constructor(private ctx: ResolvedOptions) {}

  get repoPath(): string {
    return this.ctx.repoPath;
  }

  private get dir(): string {
    return path.join(this.ctx.repoPath, ".agent-trace", "outcomes");
  }

  async write(record: OutcomeRecord): Promise<string> {
    const shortSha = record.vcs.revision.slice(0, 7);
    const idPrefix = record.id.slice(0, 8);
    const fileName = `${shortSha}-${idPrefix}.json`;
    await this.ctx.fs.mkdir(this.dir, { recursive: true });
    await this.ctx.fs.writeFile(
      path.join(this.dir, fileName),
      serializeOutcomeRecord(record) + "\n",
    );
    return `${OUTCOMES_DIR}/${fileName}`;
  }

  async list(): Promise<OutcomeRecord[]> {
    let names: string[];
    try {
      names = await this.ctx.fs.readdir(this.dir);
    } catch {
      return [];
    }
    const records: OutcomeRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const text = await this.ctx.fs.readFile(path.join(this.dir, name), "utf8");
        const record = parseRecord(text, name);
        if (record) records.push(record);
      } catch {
        // Unreadable file: skip rather than fail the whole query.
      }
    }
    return records;
  }

  async forRevision(revision: string): Promise<OutcomeRecord[]> {
    const all = await this.list();
    return all.filter((r) => r.vcs.revision === revision);
  }
}

class NotesStore implements OutcomeStore {
  readonly backend = "notes" as const;
  constructor(private ctx: ResolvedOptions) {}

  get repoPath(): string {
    return this.ctx.repoPath;
  }

  private async showNote(revision: string): Promise<string | undefined> {
    const res = await git(this.ctx, ["notes", `--ref=${OUTCOME_NOTES_REF}`, "show", revision]);
    return res.code === 0 ? res.stdout : undefined;
  }

  private parseNote(text: string): OutcomeRecord[] {
    // Notes hold NDJSON: one outcome record per line, so a commit can
    // accumulate multiple outcomes (e.g. CI then a later manual review).
    const records: OutcomeRecord[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = parseRecord(trimmed, OUTCOME_NOTES_REF);
      if (record) records.push(record);
    }
    return records;
  }

  async write(record: OutcomeRecord): Promise<string> {
    const revision = record.vcs.revision;
    const existing = (await this.showNote(revision)) ?? "";
    const line = JSON.stringify(JSON.parse(serializeOutcomeRecord(record)));
    const content = existing.trimEnd()
      ? `${existing.trimEnd()}\n${line}\n`
      : `${line}\n`;
    const res = await git(
      this.ctx,
      ["notes", `--ref=${OUTCOME_NOTES_REF}`, "add", "-f", "-F", "-", revision],
      content,
    );
    if (res.code !== 0) {
      throw new Error(`git notes add failed: ${res.stderr.trim()}`);
    }
    return `${OUTCOME_NOTES_REF}:${revision}`;
  }

  async list(): Promise<OutcomeRecord[]> {
    const res = await git(this.ctx, ["notes", `--ref=${OUTCOME_NOTES_REF}`, "list"]);
    if (res.code !== 0) return [];
    const records: OutcomeRecord[] = [];
    for (const line of res.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const annotated = parts[1];
      if (!annotated) continue;
      const note = await this.showNote(annotated);
      if (note) records.push(...this.parseNote(note));
    }
    return records;
  }

  async forRevision(revision: string): Promise<OutcomeRecord[]> {
    const note = await this.showNote(revision);
    if (!note) return [];
    return this.parseNote(note).filter((r) => r.vcs.revision === revision);
  }
}

/**
 * Open an outcome store against a repository.
 *
 * - `files` (default): `.agent-trace/outcomes/<short-sha>-<id-prefix>.json` —
 *   durable, survives clones, reviewable in PRs.
 * - `notes`: git notes under `refs/notes/agent-trace/outcomes` —
 *   history-clean, zero repo clutter. Notes must be pushed explicitly:
 *   `git push origin refs/notes/*`.
 */
export function openStore(opts: StoreOptions = {}): OutcomeStore {
  const ctx = resolveOptions(opts);
  return (opts.backend ?? "files") === "files"
    ? new FilesStore(ctx)
    : new NotesStore(ctx);
}
