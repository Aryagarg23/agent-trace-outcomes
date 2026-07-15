import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateOutcomeRecord } from "../schemas";

const dir = path.resolve(fileURLToPath(import.meta.url), "..", "..", "examples");

describe("examples/", () => {
  it("contains at least 3 example records, all valid with no warnings", async () => {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      const value: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      const result = validateOutcomeRecord(value);
      expect(result.errors, `${name} should be valid`).toEqual([]);
      expect(result.warnings, `${name} should derive its verdict cleanly`).toEqual([]);
    }
  });

  it("includes a minimal record and a failed record with a lesson", async () => {
    const minimal = JSON.parse(await readFile(path.join(dir, "minimal.json"), "utf8")) as {
      trace_ids?: unknown;
      intent?: unknown;
    };
    expect(minimal.trace_ids).toBeUndefined();
    expect(minimal.intent).toBeUndefined();

    const failed = JSON.parse(
      await readFile(path.join(dir, "failed-with-lesson.json"), "utf8"),
    ) as { verdict: string; lesson?: { summary: string } };
    expect(failed.verdict).toBe("failed");
    expect(failed.lesson?.summary).toBeTruthy();
  });

  it("includes a fleet attempt record demonstrating the v0.2.0 fields", async () => {
    const fleet = JSON.parse(
      await readFile(path.join(dir, "fleet-attempt.json"), "utf8"),
    ) as {
      version: string;
      task_id?: string;
      derived_from?: string;
      selected?: boolean;
      vcs: { workspace_state?: string; diff?: string };
      coverage?: { total: number };
    };
    expect(fleet.version).toBe("0.2.0");
    expect(fleet.task_id).toBeTruthy();
    expect(fleet.derived_from).toBeTruthy();
    expect(fleet.selected).toBe(true);
    expect(fleet.vcs.workspace_state).toBe("dirty");
    expect(fleet.vcs.diff).toBeTruthy();
    expect(fleet.coverage?.total).toBeGreaterThan(0);
  });
});
