# Orchestrator integration

The generic pattern for any multi-agent loop — orchestrator + subagents + verification queue. The library is called *by* the loop at exactly two points and has no opinion about the loop itself; it replaces the ad-hoc "append results to a wiki page" step with a spec-shaped record.

1. **Write — at the verification gate.** When a subagent's change passes or fails the gate, the gate calls `recordOutcome()` with the task brief as `intent.summary` and the gate's results as `checks[]`.
2. **Read — at context assembly.** When the orchestrator assembles context for a new subagent, it calls `queryLessons()` for the paths the task touches and prepends the results.

Complete example with a fake task queue:

```ts
import { recordOutcome, queryLessons, type CheckInput } from "agent-trace-outcomes";

interface Task { brief: string; paths: string[]; traceId?: string }

async function runLoop(queue: Task[], repoPath: string) {
  for (const task of queue) {
    // READ POINT — what has been tried near these paths, and did it work?
    const lessons = await queryLessons({ paths: task.paths, repoPath });
    const context = lessons.length
      ? `Lessons from past outcomes:\n${lessons.map((l) => `- [${l.verdict}] ${l.summary}`).join("\n")}`
      : "";

    const result = await runSubagent(task, context); // your agent, unchanged
    const checks: CheckInput[] = await verificationGate(result); // your gate, unchanged
    // e.g. [{ name: "unit-tests", kind: "test", status: "fail", summary: "3 failures" }]

    // WRITE POINT — the gate's results become a durable outcome record.
    await recordOutcome({
      repoPath,
      intent: task.brief,
      checks,
      traceIds: task.traceId ? [task.traceId] : [],
      lesson: result.lesson, // optional: ask the subagent to state what it learned
    });
  }
}

declare function runSubagent(task: Task, context: string): Promise<{ lesson?: string }>;
declare function verificationGate(result: unknown): Promise<CheckInput[]>;
```

That is the entire integration: one call after the gate, one call before dispatch. Notes:

- **Failed outcomes are the valuable ones.** When a subagent's change fails the gate, the record (intent + failing checks + lesson) is exactly what the *next* attempt needs to avoid repeating it. Record failures, not just wins.
- **`repoPath` is explicit** — no global state, no init, no config file — so one orchestrator process can manage many repos.
- **Everything is plain JSON in/out.** No framework types cross the boundary; the same two calls work from a LangGraph node, a Mastra step, an OpenAI Agents hook, or a bare `while` loop (see [integration-survey.md](./integration-survey.md)).
- **Injectable `exec`/`fs`** (`recordOutcome({ ..., exec, fs })`) let sandboxed hosts intercept the git/filesystem access.
- To gate merges on the recorded outcome later, use `verdictFor(sha)` or the CLI's `atrace-outcomes verdict <sha>` (exit 0 iff verified) — see [ci-gate.md](./ci-gate.md).
