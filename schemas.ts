/**
 * Outcome Record schema — JSON Schema (draft 2020-12) plus TypeScript types
 * and a zero-dependency validator.
 *
 * This is an additive extension to the Agent Trace specification
 * (https://github.com/cursor/agent-trace). Outcome records reference Agent
 * Trace records via `trace_ids`; they never duplicate attribution fields.
 *
 * See SPEC.md for the normative specification.
 */

export const OUTCOME_SPEC_VERSION = "0.1.0";

export const OUTCOME_MIME_TYPE = "application/vnd.agent-trace.outcome+json";

export type VcsType = "git" | "jj" | "hg" | "svn";

export type CheckKind =
  | "test"
  | "lint"
  | "typecheck"
  | "build"
  | "security"
  | "review"
  | "manual"
  | "deploy"
  | "other";

export type CheckStatus = "pass" | "fail" | "skip" | "error";

export type Verdict = "verified" | "failed" | "partial" | "unverified";

export type IntentSourceType =
  | "issue"
  | "plan"
  | "decision"
  | "conversation"
  | "manual";

export interface Vcs {
  type: VcsType;
  revision: string;
}

export interface IntentSource {
  type: IntentSourceType;
  url?: string;
  path?: string;
}

export interface Intent {
  summary: string;
  source?: IntentSource;
}

export interface Check {
  name: string;
  kind: CheckKind;
  status: CheckStatus;
  detail_url?: string;
  summary?: string;
}

export interface Reviewer {
  type: "human" | "ai";
  id: string;
}

export interface Lesson {
  summary: string;
  tags?: string[];
  applies_to?: string[];
}

export interface OutcomeRecord {
  version: string;
  id: string;
  timestamp: string;
  trace_ids?: string[];
  vcs: Vcs;
  intent?: Intent;
  checks: Check[];
  verdict: Verdict;
  reviewed_by?: Reviewer[];
  lesson?: Lesson;
  metadata?: Record<string, Record<string, unknown>>;
}

export const CHECK_KINDS: readonly CheckKind[] = [
  "test",
  "lint",
  "typecheck",
  "build",
  "security",
  "review",
  "manual",
  "deploy",
  "other",
];

export const CHECK_STATUSES: readonly CheckStatus[] = [
  "pass",
  "fail",
  "skip",
  "error",
];

export const VERDICTS: readonly Verdict[] = [
  "verified",
  "failed",
  "partial",
  "unverified",
];

export const VCS_TYPES: readonly VcsType[] = ["git", "jj", "hg", "svn"];

export const INTENT_SOURCE_TYPES: readonly IntentSourceType[] = [
  "issue",
  "plan",
  "decision",
  "conversation",
  "manual",
];

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const SEMVER_PATTERN = "^\\d+\\.\\d+\\.\\d+$";

const RFC3339_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?([Zz]|[+-]\\d{2}:\\d{2})$";

// Reverse-domain vendor namespace, per Agent Trace §7.2 metadata namespacing.
const METADATA_KEY_PATTERN = "^[a-z0-9-]+(\\.[a-zA-Z0-9-]+)+$";

/**
 * JSON Schema (draft 2020-12) for an Outcome Record.
 */
export const OUTCOME_RECORD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/agent-trace-outcomes/spec/outcome-record.schema.json",
  title: "Agent Trace Outcome Record",
  description:
    "A record of the verified outcome of a code change: which checks ran, their results, who reviewed it, and what lesson was learned.",
  type: "object",
  required: ["version", "id", "timestamp", "vcs", "checks", "verdict"],
  additionalProperties: false,
  properties: {
    version: {
      type: "string",
      pattern: SEMVER_PATTERN,
      description: "Outcome Record spec version this record conforms to.",
    },
    id: {
      type: "string",
      pattern: UUID_PATTERN,
      description: "Unique identifier (UUID) for this outcome record.",
    },
    timestamp: {
      type: "string",
      pattern: RFC3339_PATTERN,
      description: "RFC 3339 timestamp of when the outcome was recorded.",
    },
    trace_ids: {
      type: "array",
      items: { type: "string", pattern: UUID_PATTERN },
      description:
        "IDs of the Agent Trace record(s) this outcome verifies. Optional: outcome records are writable even when no Agent Trace producer is installed.",
    },
    vcs: { $ref: "#/$defs/vcs" },
    intent: { $ref: "#/$defs/intent" },
    checks: {
      type: "array",
      items: { $ref: "#/$defs/check" },
      description:
        "Verification events observed for this change. May be empty (verdict is then 'unverified').",
    },
    verdict: {
      type: "string",
      enum: VERDICTS as Verdict[],
      description:
        "Aggregate result derived from checks per the normative rule in SPEC.md §6.6.",
    },
    reviewed_by: {
      type: "array",
      items: { $ref: "#/$defs/reviewer" },
      description: "Humans or AI systems that reviewed the change.",
    },
    lesson: { $ref: "#/$defs/lesson" },
    metadata: {
      type: "object",
      propertyNames: { pattern: METADATA_KEY_PATTERN },
      additionalProperties: { type: "object" },
      description:
        "Vendor extensions under reverse-domain namespaces, per Agent Trace §7.2.",
    },
  },
  $defs: {
    vcs: {
      type: "object",
      required: ["type", "revision"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: VCS_TYPES as VcsType[] },
        revision: { type: "string", minLength: 1 },
      },
      if: { properties: { type: { const: "git" } } },
      then: { properties: { revision: { pattern: "^[0-9a-f]{40}$" } } },
      description:
        "Version control reference for the change, mirroring Agent Trace $defs/vcs.",
    },
    intent: {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          description:
            "One-line human/agent-readable statement of what the change was trying to do.",
        },
        source: {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: INTENT_SOURCE_TYPES as IntentSourceType[],
            },
            url: { type: "string" },
            path: {
              type: "string",
              description: "Repo-relative path to the source document.",
            },
          },
        },
      },
    },
    check: {
      type: "object",
      required: ["name", "kind", "status"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        kind: { type: "string", enum: CHECK_KINDS as CheckKind[] },
        status: { type: "string", enum: CHECK_STATUSES as CheckStatus[] },
        detail_url: {
          type: "string",
          description: "Link to the CI run / check-run for this check.",
        },
        summary: {
          type: "string",
          description: "Optional short result summary, e.g. '3 failures in auth.spec.ts'.",
        },
      },
    },
    reviewer: {
      type: "object",
      required: ["type", "id"],
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["human", "ai"] },
        id: {
          type: "string",
          minLength: 1,
          description:
            "Login for humans; provider/model-name (models.dev convention, Agent Trace §6.7) for AI.",
        },
      },
    },
    lesson: {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          description:
            "One paragraph: what this change taught, written for retrieval by future agents.",
        },
        tags: { type: "array", items: { type: "string", minLength: 1 } },
        applies_to: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Repo-relative paths/globs this lesson is relevant to.",
        },
      },
    },
  },
} as const;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Non-fatal issues, e.g. a verdict that does not match the derivation rule. */
  warnings: string[];
}

const reUuid = new RegExp(UUID_PATTERN);
const reSemver = new RegExp(SEMVER_PATTERN);
const reRfc3339 = new RegExp(RFC3339_PATTERN);
const reMetaKey = new RegExp(METADATA_KEY_PATTERN);
const reGitSha = /^[0-9a-f]{40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkString(
  errors: string[],
  path: string,
  v: unknown,
  opts: { pattern?: RegExp; nonEmpty?: boolean } = {},
): v is string {
  if (typeof v !== "string") {
    errors.push(`${path}: expected string, got ${v === null ? "null" : typeof v}`);
    return false;
  }
  if (opts.nonEmpty && v.length === 0) {
    errors.push(`${path}: must not be empty`);
    return false;
  }
  if (opts.pattern && !opts.pattern.test(v)) {
    errors.push(`${path}: "${v}" does not match required format`);
    return false;
  }
  return true;
}

function checkEnum(
  errors: string[],
  path: string,
  v: unknown,
  allowed: readonly string[],
): boolean {
  if (typeof v !== "string" || !allowed.includes(v)) {
    errors.push(`${path}: must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`);
    return false;
  }
  return true;
}

// Unknown properties are warnings, not errors: minor spec versions add
// optional fields (SPEC.md §7.1), and readers must not reject records
// written against them.
function checkNoExtraKeys(
  warnings: string[],
  path: string,
  obj: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      warnings.push(`${path}: unknown property "${key}" (ignored; possibly from a later spec version)`);
    }
  }
}

/**
 * Validate a value against the Outcome Record schema.
 *
 * Implements every rule of OUTCOME_RECORD_SCHEMA by hand so the core ships
 * with zero runtime dependencies. Verdict/derivation consistency is reported
 * as a warning, not an error (SPEC.md §6.6), and so are unknown properties
 * (SPEC.md §7.1: minor versions add optional fields).
 */
export function validateOutcomeRecord(value: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(value)) {
    return { valid: false, errors: ["record: expected a JSON object"], warnings };
  }

  checkNoExtraKeys(warnings, "record", value, [
    "version",
    "id",
    "timestamp",
    "trace_ids",
    "vcs",
    "intent",
    "checks",
    "verdict",
    "reviewed_by",
    "lesson",
    "metadata",
  ]);

  for (const field of ["version", "id", "timestamp", "vcs", "checks", "verdict"]) {
    if (!(field in value)) errors.push(`record: missing required field "${field}"`);
  }

  if ("version" in value) {
    checkString(errors, "version", value.version, { pattern: reSemver });
  }
  if ("id" in value) {
    checkString(errors, "id", value.id, { pattern: reUuid });
  }
  if ("timestamp" in value) {
    if (
      checkString(errors, "timestamp", value.timestamp, { pattern: reRfc3339 }) &&
      Number.isNaN(Date.parse(value.timestamp as string))
    ) {
      errors.push(`timestamp: "${value.timestamp}" is not a parseable date`);
    }
  }

  if ("trace_ids" in value && value.trace_ids !== undefined) {
    if (!Array.isArray(value.trace_ids)) {
      errors.push("trace_ids: expected array");
    } else {
      value.trace_ids.forEach((t, i) =>
        checkString(errors, `trace_ids[${i}]`, t, { pattern: reUuid }),
      );
    }
  }

  if ("vcs" in value) {
    if (!isObject(value.vcs)) {
      errors.push("vcs: expected object");
    } else {
      checkNoExtraKeys(warnings, "vcs", value.vcs, ["type", "revision"]);
      const typeOk = checkEnum(errors, "vcs.type", value.vcs.type, VCS_TYPES);
      if (checkString(errors, "vcs.revision", value.vcs.revision, { nonEmpty: true })) {
        if (typeOk && value.vcs.type === "git" && !reGitSha.test(value.vcs.revision as string)) {
          errors.push("vcs.revision: git revisions must be full 40-character lowercase hex SHAs");
        }
      }
    }
  }

  if ("intent" in value && value.intent !== undefined) {
    if (!isObject(value.intent)) {
      errors.push("intent: expected object");
    } else {
      checkNoExtraKeys(warnings, "intent", value.intent, ["summary", "source"]);
      checkString(errors, "intent.summary", value.intent.summary, { nonEmpty: true });
      if (value.intent.source !== undefined) {
        if (!isObject(value.intent.source)) {
          errors.push("intent.source: expected object");
        } else {
          checkNoExtraKeys(warnings, "intent.source", value.intent.source, ["type", "url", "path"]);
          checkEnum(errors, "intent.source.type", value.intent.source.type, INTENT_SOURCE_TYPES);
          if (value.intent.source.url !== undefined) {
            checkString(errors, "intent.source.url", value.intent.source.url);
          }
          if (value.intent.source.path !== undefined) {
            checkString(errors, "intent.source.path", value.intent.source.path);
          }
        }
      }
    }
  }

  if ("checks" in value) {
    if (!Array.isArray(value.checks)) {
      errors.push("checks: expected array");
    } else {
      value.checks.forEach((c, i) => {
        const p = `checks[${i}]`;
        if (!isObject(c)) {
          errors.push(`${p}: expected object`);
          return;
        }
        checkNoExtraKeys(warnings, p, c, ["name", "kind", "status", "detail_url", "summary"]);
        checkString(errors, `${p}.name`, c.name, { nonEmpty: true });
        checkEnum(errors, `${p}.kind`, c.kind, CHECK_KINDS);
        checkEnum(errors, `${p}.status`, c.status, CHECK_STATUSES);
        if (c.detail_url !== undefined) checkString(errors, `${p}.detail_url`, c.detail_url);
        if (c.summary !== undefined) checkString(errors, `${p}.summary`, c.summary);
      });
    }
  }

  if ("verdict" in value) {
    checkEnum(errors, "verdict", value.verdict, VERDICTS);
  }

  if ("reviewed_by" in value && value.reviewed_by !== undefined) {
    if (!Array.isArray(value.reviewed_by)) {
      errors.push("reviewed_by: expected array");
    } else {
      value.reviewed_by.forEach((r, i) => {
        const p = `reviewed_by[${i}]`;
        if (!isObject(r)) {
          errors.push(`${p}: expected object`);
          return;
        }
        checkNoExtraKeys(warnings, p, r, ["type", "id"]);
        checkEnum(errors, `${p}.type`, r.type, ["human", "ai"]);
        checkString(errors, `${p}.id`, r.id, { nonEmpty: true });
      });
    }
  }

  if ("lesson" in value && value.lesson !== undefined) {
    if (!isObject(value.lesson)) {
      errors.push("lesson: expected object");
    } else {
      checkNoExtraKeys(warnings, "lesson", value.lesson, ["summary", "tags", "applies_to"]);
      checkString(errors, "lesson.summary", value.lesson.summary, { nonEmpty: true });
      for (const field of ["tags", "applies_to"] as const) {
        const arr = value.lesson[field];
        if (arr === undefined) continue;
        if (!Array.isArray(arr)) {
          errors.push(`lesson.${field}: expected array`);
        } else {
          arr.forEach((s, i) =>
            checkString(errors, `lesson.${field}[${i}]`, s, { nonEmpty: true }),
          );
        }
      }
    }
  }

  if ("metadata" in value && value.metadata !== undefined) {
    if (!isObject(value.metadata)) {
      errors.push("metadata: expected object");
    } else {
      for (const [key, val] of Object.entries(value.metadata)) {
        if (!reMetaKey.test(key)) {
          errors.push(
            `metadata: key "${key}" must be a reverse-domain vendor namespace (e.g. "com.example")`,
          );
        }
        if (!isObject(val)) {
          errors.push(`metadata["${key}"]: expected object`);
        }
      }
    }
  }

  // Verdict consistency with the derivation rule (SPEC.md §6.6) — warning only,
  // so records with an explicitly overridden verdict still validate.
  if (errors.length === 0) {
    const record = value as unknown as OutcomeRecord;
    const derived = deriveVerdictFromChecks(record.checks);
    if (record.verdict !== derived) {
      warnings.push(
        `verdict: "${record.verdict}" does not match the derivation rule (expected "${derived}" from checks)`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * The normative verdict derivation rule (SPEC.md §6.6). Kept here so the
 * validator has no import cycle; re-exported as deriveVerdict from src/verdict.
 */
export function deriveVerdictFromChecks(checks: readonly Check[]): Verdict {
  if (checks.length === 0) return "unverified";
  if (checks.some((c) => c.status === "fail")) return "failed";
  const ran = checks.filter((c) => c.status !== "skip");
  if (ran.length === 0) return "unverified";
  if (ran.every((c) => c.status === "pass")) return "verified";
  return "partial";
}

/**
 * Canonical field order for serialization. Deterministic ordering keeps
 * outcome records digestible under any cryptographic profile adopted
 * upstream (see cursor/agent-trace#31).
 */
const FIELD_ORDER: Record<string, readonly string[]> = {
  "": [
    "version",
    "id",
    "timestamp",
    "trace_ids",
    "vcs",
    "intent",
    "checks",
    "verdict",
    "reviewed_by",
    "lesson",
    "metadata",
  ],
  vcs: ["type", "revision"],
  intent: ["summary", "source"],
  "intent.source": ["type", "url", "path"],
  "checks[]": ["name", "kind", "status", "detail_url", "summary"],
  "reviewed_by[]": ["type", "id"],
  lesson: ["summary", "tags", "applies_to"],
};

function orderKeys(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => orderKeys(v, `${path}[]`));
  }
  if (!isObject(value)) return value;
  const order = FIELD_ORDER[path];
  const keys = Object.keys(value);
  const sorted = order
    ? [...keys].sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
      })
    : [...keys].sort();
  const out: Record<string, unknown> = {};
  for (const key of sorted) {
    const childPath = path === "" ? key : `${path}.${key}`;
    out[key] = orderKeys(value[key], FIELD_ORDER[childPath] ? childPath : childPath);
  }
  return out;
}

/**
 * Serialize an outcome record with deterministic field ordering
 * (schema declaration order; unknown keys sorted last).
 */
export function serializeOutcomeRecord(record: OutcomeRecord): string {
  return JSON.stringify(orderKeys(record, ""), null, 2);
}
