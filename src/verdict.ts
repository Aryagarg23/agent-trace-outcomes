import type { Check, Verdict } from "../schemas";
import { deriveVerdictFromChecks } from "../schemas";

/**
 * Derive the aggregate verdict from a set of checks.
 *
 * Normative rule (SPEC.md §6.6):
 * - `unverified` — no checks recorded, or every check was skipped
 * - `failed`     — any check failed
 * - `verified`   — all non-skipped checks passed and at least one check ran
 * - `partial`    — otherwise (a mix involving errors alongside passes/skips)
 *
 * Pure function; no I/O.
 */
export function deriveVerdict(checks: readonly Check[]): Verdict {
  return deriveVerdictFromChecks(checks);
}
