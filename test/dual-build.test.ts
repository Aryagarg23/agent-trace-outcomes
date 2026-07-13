import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultExec } from "../src/store";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const toFileUrl = (p: string) => `file:///${p.replace(/\\/g, "/")}`;

describe("dual ESM + CJS build", () => {
  it("is requireable from a plain Node CJS script", async () => {
    const script = `
      const api = require(${JSON.stringify(path.join(root, "dist", "index.cjs"))});
      const names = ["recordOutcome","queryLessons","queryLog","verdictFor","deriveVerdict","openStore","validateOutcomeRecord"];
      for (const n of names) if (typeof api[n] !== "function") throw new Error("missing " + n);
      if (api.deriveVerdict([{name:"t",kind:"test",status:"pass"}]) !== "verified") throw new Error("bad verdict");
      console.log("cjs-ok");
    `;
    const res = await defaultExec(process.execPath, ["-e", script]);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("cjs-ok");
  });

  it("is importable from a plain Node ESM script", async () => {
    const script = `
      import(${JSON.stringify(toFileUrl(path.join(root, "dist", "index.js")))}).then((api) => {
        const names = ["recordOutcome","queryLessons","queryLog","verdictFor","deriveVerdict","openStore","validateOutcomeRecord"];
        for (const n of names) if (typeof api[n] !== "function") throw new Error("missing " + n);
        if (api.deriveVerdict([]) !== "unverified") throw new Error("bad verdict");
        console.log("esm-ok");
      });
    `;
    const res = await defaultExec(process.execPath, ["--input-type=module", "-e", script]);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("esm-ok");
  });

  it("keeps the core bundle free of runtime dependencies", async () => {
    // The only declared dependency (commander) must not leak into the
    // library entry — it is CLI-only.
    for (const file of ["dist/index.js", "dist/index.cjs", "dist/schemas.js", "dist/schemas.cjs"]) {
      const text = await readFile(path.join(root, file), "utf8");
      expect(text.includes("commander"), `${file} must not import commander`).toBe(false);
    }
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["commander"]);
  });

  it("core bundles import only node builtins", async () => {
    const { builtinModules } = await import("node:module");
    const text = await readFile(path.join(root, "dist", "index.js"), "utf8");
    const imports = [...text.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      const isBuiltin = spec.startsWith("node:") || builtinModules.includes(spec);
      expect(isBuiltin, `unexpected import "${spec}" in core bundle`).toBe(true);
    }
  });
});
