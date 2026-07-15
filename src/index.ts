import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Check,
  CheckKind,
  CheckStatus,
  Coverage,
  Intent,
  Lesson,
  OutcomeRecord,
  Reviewer,
  Verdict,
  WorkspaceState,
} from "../schemas";
import {
  deriveCoverage,
  OUTCOME_SPEC_VERSION,
  serializeOutcomeRecord,
  validateOutcomeRecord,
} from "../schemas";
import { deriveVerdict } from "./verdict";
import {
  changedFiles,
  openStore,
  resolveOptions,
  resolveRevision,
  type StoreOptions,
} from "./store";

export * from "../schemas";
export { deriveVerdict } from "./verdict";
export {
  openStore,
  resolveRevision,
  changedFiles,
  defaultExec,
  defaultFs,
  OUTCOME_NOTES_REF,
  OUTCOMES_DIR,
} from "./store";
export type {
  OutcomeStore,
  StoreOptions,
  BackendName,
  ExecFn,
  ExecResult,
  FsLike,
} from "./store";
export {
  fetchCheckRuns,
  checksFromCheckRuns,
  inferCheckKind,
  ciContextFromEnv,
  parseGitHubRepo,
} from "./github";
export type { CheckRun, CiContext } from "./github";

/** A check as accepted by recordOutcome: kind defaults to "other". */
export interface CheckInput {
  name: string;
  status: CheckStatus;
  kind?: CheckKind;
  detail_url?: string;
  summary?: string;
}

export interface RecordOutcomeOptions extends StoreOptions {
  /** What the change was trying to do. A plain string becomes intent.summary. */
  intent?: string | Intent;
  /** Verification events. Omitted/empty ⇒ verdict "unverified". */
  checks?: CheckInput[];
  /** Agent Trace record IDs this outcome verifies. */
  traceIds?: string[];
  /** Stable identifier shared by every attempt at the same task, across revisions. */
  taskId?: string;
  /** id of the parent outcome record this attempt forked from. */
  derivedFrom?: string;
  /** Humans/AI systems that reviewed the change. */
  reviewedBy?: Reviewer[];
  /** What this change taught. A plain string becomes lesson.summary. */
  lesson?: string | Lesson;
  /** Full commit SHA. Defaults to HEAD of repoPath. */
  revision?: string;
  /** Marks the checks as having run against a dirty worktree on top of revision. */
  workspaceState?: WorkspaceState;
  /** Unified-diff text of exactly what was tested (e.g. a dirty worktree's diff). */
  diff?: string;
  /** Explicit verdict override. Defaults to deriveVerdict(checks). */
  verdict?: Verdict;
  /** Explicit coverage override. Defaults to deriveCoverage(checks, reviewedBy) when checks is non-empty. */
  coverage?: Coverage;
  /** Whether this explored branch was the one kept (true) or pruned (false). */
  selected?: boolean;
  /** Vendor extensions under reverse-domain namespaces. */
  metadata?: Record<string, Record<string, unknown>>;
  /** Override the generated UUID (e.g. for reproducible tests). */
  id?: string;
  /** Override the generated RFC 3339 timestamp. */
  timestamp?: string;
}

/**
 * Write an outcome record for a change. The 1-line write point:
 *
 *     await recordOutcome({ intent: "fix token refresh", checks })
 *
 * Everything else is auto-detected (revision from HEAD, verdict from checks)
 * or optional. Returns the validated record that was persisted.
 */
export async function recordOutcome(
  opts: RecordOutcomeOptions = {},
): Promise<OutcomeRecord> {
  const revision = opts.revision ?? (await resolveRevision(opts));
  const checks: Check[] = (opts.checks ?? []).map((c) => ({
    name: c.name,
    kind: c.kind ?? "other",
    status: c.status,
    ...(c.detail_url !== undefined ? { detail_url: c.detail_url } : {}),
    ...(c.summary !== undefined ? { summary: c.summary } : {}),
  }));

  const record: OutcomeRecord = {
    version: OUTCOME_SPEC_VERSION,
    id: opts.id ?? randomUUID(),
    timestamp: opts.timestamp ?? new Date().toISOString(),
    ...(opts.traceIds?.length ? { trace_ids: opts.traceIds } : {}),
    ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
    ...(opts.derivedFrom !== undefined ? { derived_from: opts.derivedFrom } : {}),
    vcs: {
      type: "git",
      revision,
      ...(opts.workspaceState !== undefined ? { workspace_state: opts.workspaceState } : {}),
      ...(opts.diff !== undefined ? { diff: opts.diff } : {}),
    },
    ...(opts.intent !== undefined
      ? { intent: typeof opts.intent === "string" ? { summary: opts.intent } : opts.intent }
      : {}),
    checks,
    verdict: opts.verdict ?? deriveVerdict(checks),
    ...(opts.coverage !== undefined
      ? { coverage: opts.coverage }
      : checks.length > 0
        ? { coverage: deriveCoverage(checks, opts.reviewedBy) }
        : {}),
    ...(opts.reviewedBy?.length ? { reviewed_by: opts.reviewedBy } : {}),
    ...(opts.lesson !== undefined
      ? { lesson: typeof opts.lesson === "string" ? { summary: opts.lesson } : opts.lesson }
      : {}),
    ...(opts.selected !== undefined ? { selected: opts.selected } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };

  const result = validateOutcomeRecord(record);
  if (!result.valid) {
    throw new Error(`invalid outcome record:\n  ${result.errors.join("\n  ")}`);
  }

  await openStore(opts).write(record);
  return record;
}

/* ------------------------------------------------------------------ */
/* Path matching                                                       */
/* ------------------------------------------------------------------ */

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * True if a pattern (path, directory prefix, or glob) and a query path refer
 * to overlapping parts of the tree. Symmetric on plain-path prefixes so
 * querying "src/auth" matches a lesson scoped to "src/auth/token.ts" and
 * vice versa.
 */
export function pathsOverlap(pattern: string, queryPath: string): boolean {
  const a = normalizePath(pattern);
  const b = normalizePath(queryPath);
  if (a === "" || b === "") return true;
  if (a === b) return true;
  if (a.includes("*") || a.includes("?")) {
    if (globToRegExp(a).test(b)) return true;
    // Allow a directory query to match a glob scoped beneath it.
    const prefix = a.split(/[*?]/, 1)[0]!.replace(/\/[^/]*$/, "");
    return prefix !== "" && (prefix === b || prefix.startsWith(`${b}/`));
  }
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/* ------------------------------------------------------------------ */
/* Joining records to files                                            */
/* ------------------------------------------------------------------ */

interface TraceFileIndex {
  /** trace record id → files[].path entries */
  byId: Map<string, string[]>;
}

/**
 * Best-effort resolver for Agent Trace records stored in the repo. The
 * parent reference implementation appends records to
 * `.agent-trace/traces.jsonl`; we also accept any sibling *.json/*.jsonl
 * files under `.agent-trace/` (excluding outcomes/).
 */
async function loadTraceFileIndex(opts: StoreOptions): Promise<TraceFileIndex> {
  const ctx = resolveOptions(opts);
  const byId = new Map<string, string[]>();
  const dir = path.join(ctx.repoPath, ".agent-trace");
  let names: string[];
  try {
    names = await ctx.fs.readdir(dir);
  } catch {
    return { byId };
  }
  for (const name of names) {
    if (!/\.jsonl?$/.test(name)) continue;
    let text: string;
    try {
      text = await ctx.fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const chunks = name.endsWith(".jsonl")
      ? text.split("\n").filter((l) => l.trim())
      : [text];
    for (const chunk of chunks) {
      try {
        const value: unknown = JSON.parse(chunk);
        const rec = value as { id?: unknown; files?: Array<{ path?: unknown }> };
        if (typeof rec.id !== "string" || !Array.isArray(rec.files)) continue;
        const files = rec.files
          .map((f) => (typeof f?.path === "string" ? f.path : undefined))
          .filter((p): p is string => p !== undefined);
        if (files.length) byId.set(rec.id, files);
      } catch {
        // Not a trace record; ignore.
      }
    }
  }
  return { byId };
}

/**
 * Resolve an outcome record's attribution reference(s) to the repo-relative
 * files they cover. The single seam through which queries join records to
 * attribution formats: the default resolver reads Agent Trace trace_ids;
 * hosts can substitute one for other formats (git notes, commit trailers)
 * without touching storage or callers.
 */
export type ResolveAttribution = (
  record: OutcomeRecord,
  opts: StoreOptions,
) => Promise<string[]>;

/** Default resolver: trace_ids → Agent Trace records' files[].path. */
export const resolveTraceAttribution: ResolveAttribution = async (record, opts) => {
  if (!record.trace_ids?.length) return [];
  const index = await loadTraceFileIndex(opts);
  return [...new Set(record.trace_ids.flatMap((id) => index.byId.get(id) ?? []))];
};

export interface AttributionOptions {
  /** Attribution resolver override. Default: resolveTraceAttribution. */
  resolveAttribution?: ResolveAttribution;
}

/**
 * Files associated with an outcome record: whatever its attribution resolves
 * to (by default, linked Agent Trace records' files[].path), else the
 * commit's diff.
 */
export async function filesForRecord(
  record: OutcomeRecord,
  opts: StoreOptions & AttributionOptions = {},
): Promise<string[]> {
  const resolve = opts.resolveAttribution ?? resolveTraceAttribution;
  const fromAttribution = await resolve(record, opts);
  if (fromAttribution.length) return fromAttribution;
  return changedFiles(opts, record.vcs.revision);
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

function byNewest(a: OutcomeRecord, b: OutcomeRecord): number {
  return Date.parse(b.timestamp) - Date.parse(a.timestamp);
}

export interface QueryLogOptions extends StoreOptions, AttributionOptions {
  /** Only records touching this repo-relative path (file or directory). */
  path?: string;
  /** Maximum records to return. Default: no limit. */
  limit?: number;
}

/**
 * Outcome records, newest first, optionally filtered to those touching a
 * path. "Touching" means: the linked Agent Trace records list a file under
 * the path, or the commit's diff does, or the record's lesson is scoped to
 * it via applies_to.
 */
export async function queryLog(opts: QueryLogOptions = {}): Promise<OutcomeRecord[]> {
  const records = (await openStore(opts).list()).sort(byNewest);
  let filtered = records;
  if (opts.path !== undefined) {
    const q = opts.path;
    filtered = [];
    for (const record of records) {
      const scoped = record.lesson?.applies_to ?? [];
      if (scoped.some((p) => pathsOverlap(p, q))) {
        filtered.push(record);
        continue;
      }
      const files = await filesForRecord(record, opts);
      if (files.some((f) => pathsOverlap(f, q))) filtered.push(record);
    }
  }
  return opts.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
}

export interface LessonEntry {
  summary: string;
  tags: string[];
  applies_to: string[];
  verdict: Verdict;
  revision: string;
  timestamp: string;
  intent?: string;
  record_id: string;
}

export interface QueryLessonsOptions extends StoreOptions, AttributionOptions {
  /** Repo-relative paths the caller is about to touch. */
  paths?: string[];
  /** Only lessons carrying at least one of these tags. */
  tags?: string[];
  /** Maximum lessons to return. Default 20. */
  limit?: number;
}

/**
 * Lessons from past outcomes, newest first — the read point for agents. The
 * 1-line contract:
 *
 *     const lessons = await queryLessons({ paths: ["src/auth/"] })
 *
 * Returns plain JSON. A lesson matches a path query via its applies_to
 * globs, or — when it has none — via the files its change touched.
 */
export async function queryLessons(
  opts: QueryLessonsOptions = {},
): Promise<LessonEntry[]> {
  const records = (await openStore(opts).list())
    .filter((r) => r.lesson !== undefined)
    .sort(byNewest);

  const entries: LessonEntry[] = [];
  const limit = opts.limit ?? 20;

  for (const record of records) {
    if (entries.length >= limit) break;
    const lesson = record.lesson!;
    if (opts.tags?.length) {
      const tags = lesson.tags ?? [];
      if (!opts.tags.some((t) => tags.includes(t))) continue;
    }
    if (opts.paths?.length) {
      const scoped = lesson.applies_to ?? [];
      let matches: boolean;
      if (scoped.length) {
        matches = scoped.some((p) => opts.paths!.some((q) => pathsOverlap(p, q)));
      } else {
        const files = await filesForRecord(record, opts);
        matches = files.some((f) => opts.paths!.some((q) => pathsOverlap(f, q)));
      }
      if (!matches) continue;
    }
    entries.push({
      summary: lesson.summary,
      tags: lesson.tags ?? [],
      applies_to: lesson.applies_to ?? [],
      verdict: record.verdict,
      revision: record.vcs.revision,
      timestamp: record.timestamp,
      ...(record.intent ? { intent: record.intent.summary } : {}),
      record_id: record.id,
    });
  }
  return entries;
}

export interface VerdictReport {
  verdict: Verdict;
  checks: Check[];
  /** The record the verdict came from (the newest for the revision), if any. */
  record?: OutcomeRecord;
  /** All records for the revision, newest first. */
  records: OutcomeRecord[];
}

/**
 * The verdict for a commit: taken from the newest outcome record for that
 * revision, or "unverified" if none exists. Accepts short revisions when
 * git is available.
 */
export async function verdictFor(
  revision: string,
  opts: StoreOptions = {},
): Promise<VerdictReport> {
  let full = revision;
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    full = await resolveRevision(opts, revision);
  }
  const records = (await openStore(opts).forRevision(full)).sort(byNewest);
  const record = records[0];
  if (!record) {
    return { verdict: "unverified", checks: [], records: [] };
  }
  return { verdict: record.verdict, checks: record.checks, record, records };
}

export { serializeOutcomeRecord };
