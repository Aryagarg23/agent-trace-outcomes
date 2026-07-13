# Integration survey (Phase 0)

The design goal of this library is that it folds into any pre-existing loop architecture with 1–3 lines and zero refactoring on the host's side. This survey documents the extension points of the ecosystems a host loop is likely built on — for each: (a) how a third-party library gets called at a **post-verification/completion moment** (the write point), (b) how it gets called at a **context-assembly moment** (the read point), and the minimal snippet for each. Event and API names verified against current docs, July 2026.

The two touchpoints under integration:

- **Write** — `await recordOutcome({ intent, checks })` (library) or `atrace-outcomes record …` (CLI)
- **Read** — `await queryLessons({ paths })` (library) or `atrace-outcomes lessons <path> --json` (CLI); `atrace-outcomes verdict <sha>` is a native exit-code gate

## 1. Claude Code hooks

Hooks are declared in `settings.json` (`~/.claude/settings.json` or `.claude/settings.json`). Each hook receives event JSON on stdin and responds via exit codes and JSON on stdout.

- **Write point:** `Stop` (turn finished) or `PostToolUse` with matcher `Bash` (after a test command). The hook shells out to the CLI.
- **Read point:** `SessionStart` or `UserPromptSubmit` — both support `hookSpecificOutput.additionalContext`, a string Claude Code injects into model context. The CLI emits that envelope natively via `lessons --claude-hook` (this flag exists *because of* this survey: without it the read side needed a fragile `jq` wrapper — we treated that as an API design bug and fixed it in the CLI).

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
  "command": "npm test --silent && atrace-outcomes record --check unit:test:pass || atrace-outcomes record --check unit:test:fail" }] }] } }
```

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
  "command": "atrace-outcomes lessons . --claude-hook" }] }] } }
```

See [claude-code-hooks.md](./claude-code-hooks.md) for complete working configs.

## 2. GitHub Actions / generic CI

The extension point is a step after the test step (`if: always()` so failures record too); step outcomes are available as `${{ steps.<id>.outcome }}`, and `GITHUB_SHA`/`GITHUB_RUN_ID` etc. are ambient env vars, which `record --from-ci` reads.

```yaml
- if: always()
  run: npx -y agent-trace-outcomes record --from-ci --status "${{ steps.test.outcome }}"
```

```yaml
- run: npx -y agent-trace-outcomes lessons src/ --json > lessons.json
```

For zero-effort capture, the composite [action.yml](../action.yml) synthesizes the record from the Checks API on PR merge. See [ci-gate.md](./ci-gate.md).

## 3. Plain git hooks + husky

Executable scripts in `.git/hooks/` or `.husky/`. `post-commit` is the write moment; git has no LLM-context-assembly moment, so the read side degrades to an exit-code gate on `pre-push` — the one ecosystem where a true read point is genuinely absent (ecosystem limitation, not an API gap).

```sh
# .husky/post-commit
npm test --silent && npx atrace-outcomes record --check unit:test:pass || npx atrace-outcomes record --check unit:test:fail
```

```sh
# .husky/pre-push — refuse to push unverified work
npx atrace-outcomes verdict "$(git rev-parse HEAD)"
```

## 4. LangGraph / LangChain

Any function registered with `graph.addNode(name, fn)` receives and returns state — a verification-gate node after the test node is the write point; a prepare node before the agent node is the read point. LangChain's `BaseCallbackHandler` (`handleChainEnd`) is the cross-cutting alternative.

```ts
graph.addNode("record", async (s) => { await recordOutcome({ intent: s.task, checks: s.checks }); return s; });
```

```ts
graph.addNode("lessons", async (s) => ({ ...s, lessons: await queryLessons({ paths: s.paths }) }));
```

## 5. OpenAI Agents SDK

Lifecycle hooks: `RunHooks`/`AgentHooks` with `on_agent_start` / `on_agent_end` (Python), or the agent EventEmitter in the JS SDK. Read point: `instructions` may be a function computed at run start. Python hosts call the CLI (this package is TypeScript; the CLI is the language-neutral surface).

```ts
agent.on("agent_end", async () => { await recordOutcome({ intent: agent.name, checks: gateChecks }); });
```

```ts
const agent = new Agent({ name, instructions: async () => renderLessons(await queryLessons({ paths })) });
```

## 6. CrewAI (Python — CLI surface)

`Task(..., callback=fn)` fires after task completion; `@before_kickoff` mutates `inputs` before the crew runs.

```python
Task(description=d, expected_output=e, agent=a,
     callback=lambda o: subprocess.run(["npx", "atrace-outcomes", "record", "--intent", d, "--check", f"gate:{'pass' if o else 'fail'}"]))
```

```python
@before_kickoff
def add_lessons(self, inputs):
    inputs["lessons"] = subprocess.run(["npx", "atrace-outcomes", "lessons", inputs["path"], "--json"], capture_output=True, text=True).stdout; return inputs
```

## 7. Mastra

Workflow steps are `createStep({ id, execute: async ({ inputData }) => … })` chained with `.then()`; agents accept dynamic `instructions`.

```ts
const record = createStep({ id: "record", inputSchema, outputSchema,
  execute: async ({ inputData }) => { await recordOutcome({ intent: inputData.task, checks: inputData.checks }); return inputData; } });
```

```ts
const agent = new Agent({ name, model, instructions: async () => renderLessons(await queryLessons({ paths })) });
```

## 8. Vercel AI SDK

`generateText`/`streamText` accept `onFinish`; the read side is the `system` prompt (or `wrapLanguageModel` middleware's `transformParams`).

```ts
await generateText({ model, prompt, onFinish: async () => { await recordOutcome({ intent: task, checks: gateChecks }); } });
```

```ts
await generateText({ model, system: renderLessons(await queryLessons({ paths })), prompt });
```

## 9. MCP (read-side surface)

A ~10-line stdio MCP server exposes `query_lessons` as a tool any MCP client (Claude Code, Cursor, …) can call during context assembly. MCP tools are model-invoked, so MCP is deliberately a **read** surface — an unreliable write path (don't rely on the model remembering to call `record_outcome`).

```ts
server.registerTool("query_lessons", { inputSchema: { paths: z.array(z.string()) } },
  async ({ paths }) => ({ content: [{ type: "text", text: JSON.stringify(await queryLessons({ paths })) }] }));
```

Client registration (`.mcp.json`): `{ "mcpServers": { "lessons": { "command": "node", "args": ["lessons-server.mjs"] } } }`

## 10. git-ai's agent-hook approach (prior art)

git-ai does not wrap the git binary or use git hooks; it registers pre/post tool-call hooks in every supported agent's own hook surface and runs `git ai checkpoint` after each edit — one machine-level install, every repo tracked. The analogue here would be an `atrace-outcomes install` command that writes the Stop/SessionStart hooks into each detected agent's settings. Deliberately **not shipped** in the core (it belongs in a downstream tool per the size budget), but the hook configs in [claude-code-hooks.md](./claude-code-hooks.md) are exactly what such an installer would write.

## Common denominator

All ten surfaces reduce to a three-shaped API, which is why the public surface is exactly this and nothing more:

1. **Plain async functions, JSON in / JSON out** (`recordOutcome`, `queryLessons`) — drop into every programmatic hook: LangGraph node, `on_agent_end`, CrewAI callback, Mastra `execute`, Vercel `onFinish`, MCP handler. No framework types anywhere in the public surface.
2. **A CLI with meaningful exit codes** (`record`, `lessons --json`, `verdict <sha>` → 0/1) — covers every shell-shaped host: Claude Code hooks, CI steps, git hooks, Python frameworks.
3. **Two universal timing moments** every ecosystem exposes: post-completion (write) and pre-task context assembly (read).

## Integration matrix

Every cell ≤ 3 lines; a cell that couldn't hit that was treated as a core-API design bug (one was found and fixed: `--claude-hook`).

| Environment | Write point | Read point | LOC (w/r) |
|---|---|---|---|
| Claude Code hooks | `Stop` hook → `… && atrace-outcomes record --check unit:test:pass \|\| atrace-outcomes record --check unit:test:fail` | `SessionStart` hook → `atrace-outcomes lessons . --claude-hook` | 1 / 1 |
| GitHub Actions / CI | `- if: always()`<br>`  run: npx -y agent-trace-outcomes record --from-ci --status "${{ steps.test.outcome }}"` | `- run: npx -y agent-trace-outcomes lessons src/ --json` | 2 / 1 |
| git hooks / husky | `.husky/post-commit` → test && `record --check …` | `.husky/pre-push` → `atrace-outcomes verdict "$(git rev-parse HEAD)"` (gate; git has no context moment) | 1 / 1 |
| LangGraph | `graph.addNode("record", async s => { await recordOutcome({intent: s.task, checks: s.checks}); return s; })` | `graph.addNode("lessons", async s => ({...s, lessons: await queryLessons({paths: s.paths})}))` | 1 / 1 |
| OpenAI Agents SDK | `agent.on("agent_end", async () => recordOutcome({intent: agent.name, checks}))` | `new Agent({ instructions: async () => renderLessons(await queryLessons({paths})) })` | 1 / 1 |
| CrewAI (Python) | `Task(..., callback=lambda o: subprocess.run([...record...]))` | `@before_kickoff` + `inputs["lessons"] = …lessons --json…` | 1 / 2 |
| Mastra | `createStep({ id: "record", execute: async ({inputData}) => { await recordOutcome(...); return inputData; } })` | `new Agent({ instructions: async () => renderLessons(await queryLessons({paths})) })` | 2 / 1 |
| Vercel AI SDK | `generateText({ ..., onFinish: async () => recordOutcome({intent, checks}) })` | `generateText({ system: renderLessons(await queryLessons({paths})), ... })` | 1 / 1 |
| MCP | (read-only surface by design) | `server.registerTool("query_lessons", …, async ({paths}) => …queryLessons({paths})…)` | — / 2 |
| Generic orchestrator | `await recordOutcome({ intent: task.brief, checks: gate.results })` | `const lessons = await queryLessons({ paths: task.paths })` | 1 / 1 |
