# pi-mcp-adapter (tadasant fork)

This is **`tadasant/pi-mcp-adapter`**, Tadas's fork of [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter): an MCP adapter extension for the [Pi](https://github.com/badlogic/pi-mono/) coding agent.

Read the **Fork Discipline** section before you push anything. Everything else in this file is context; that section is a rule.

## Fork Discipline

**PRs land on `tadasant/pi-mcp-adapter`. Never on `nicobailon/pi-mcp-adapter`.**

`gh` defaults a PR's base to the **parent** of a fork, so the natural-looking command opens a pull request against *upstream's* repository — a public PR, on someone else's project, from work that was never meant to go there. Pin the repo explicitly, every time:

```bash
gh pr create --repo tadasant/pi-mcp-adapter --base main --head <your-branch> \
  --title "..." --body "..."
```

Verify before you trust it: `gh pr view --repo tadasant/pi-mcp-adapter <n> --json baseRefName,headRepositoryOwner`. If a PR ever does land upstream by accident, close it immediately rather than leaving it open for a maintainer to triage.

The same care applies to `git push`: `origin` is the fork. Don't add an `upstream` push remote.

Writing changes that *could* go upstream is still the goal. Keep commits clean and self-contained, follow the surrounding code's style, don't bolt on fork-local hacks, and don't rename or restructure upstream files without reason — an upstreamable change is one a maintainer could cherry-pick without untangling it from anything personal. Proposing it upstream is a separate, deliberate act that Tadas takes, not something a session does on its own.

The fork currently sits exactly on upstream `v2.11.0` with no divergence beyond this file, so `git merge upstream/main` stays trivial. Keep it that way.

## Domain Context

MCP tool definitions are verbose. A single MCP server can burn 10k+ tokens of system prompt, and you pay that cost on every turn whether the agent uses those tools or not — connect a few servers and half the context window is gone before the conversation starts. This adapter's reason to exist is to give Pi the MCP ecosystem **without that bloat**.

Two ways tools reach the model, and the token math is the whole design:

- **Proxy mode (default)** — one `mcp` tool in context (~200 tokens) instead of hundreds. The agent discovers what it needs on demand (`search`, `list`, `describe`) and calls through `mcp({ tool, args })`. Implemented in `proxy-modes.ts`.
- **Direct tools (opt-in per server via `directTools`)** — selected MCP tools are registered as first-class Pi tools alongside `read`/`bash`/`edit`, costing ~150–300 tokens each in the system prompt. Good for a targeted 5–20 tools; wrong for a 75-tool server. Implemented in `direct-tools.ts`, registered through `tool-registrar.ts`.

Servers are **lazy**: they connect on first use, not at startup, and tool metadata is cached to disk (`metadata-cache.ts`) so search/list/describe work with no live connection. Idle servers disconnect and reconnect on demand (`lifecycle.ts`, `server-manager.ts`). Both stdio and HTTP servers are supported, including OAuth (`mcp-auth*.ts`, `mcp-oauth-provider.ts`, `mcp-callback-server.ts`, and `OAUTH.md`).

**Token efficiency is not only about tool *definitions* — it is equally about tool *results*.** `mcp-output-guard.ts` is the module that bounds what an MCP server can push into the model's context: inline text is capped (50 KiB / 2,000 lines by default), oversized output is truncated to a head preview with the full text spilled to a temp file the agent can `read`/`grep`, image blocks pass through untouched, and in proxy mode a raw `details.mcpResult` over ~16 KiB is replaced with a compact summary. When you touch result handling anywhere, ask what happens to a 5 MB response — the guard is the answer, and changes that route around it are a regression even when every test still passes.

`README.md` is the user-facing manual and is accurate; read it before designing a change. `CHANGELOG.md` tracks releases.

## Folder Hierarchy

Flat TypeScript at the repository root — there is no `src/`, and no build step: Pi loads the `.ts` files directly (`package.json` → `pi.extensions: ["./index.ts"]`, and `files` ships raw `.ts`).

```
pi-mcp-adapter/
├── index.ts                  # Extension entry point Pi loads
├── init.ts / state.ts        # Startup, lazy connect, shared extension state
├── config.ts                 # Config discovery + parsing (.mcp.json, Pi overrides, host imports)
├── agent-dir.ts              # Pi agent dir resolution ($PI_CODING_AGENT_DIR, ~/.pi/agent)
├── server-manager.ts         # MCP server processes/transports; lifecycle.ts = idle/keep-alive
├── proxy-modes.ts            # The single `mcp` proxy tool -- status/list/search/describe/call
├── direct-tools.ts           # Per-tool direct registration; tool-registrar.ts wires both paths
├── mcp-output-guard.ts       # Bounds model-facing MCP output -- the token-efficiency backstop
├── tool-metadata.ts          # Schema formatting + fuzzy tool-name matching
├── metadata-cache.ts         # On-disk tool metadata so discovery needs no live connection
├── mcp-auth*.ts              # OAuth: flow, storage, provider, loopback callback server
├── mcp-panel.ts              # `/mcp` TUI panel; mcp-setup-panel.ts = `/mcp setup`
├── types.ts                  # Shared types (McpSettings, DirectToolSpec, content blocks, ...)
├── examples/
│   └── interactive-visualizer/   # Example MCP server -- two tests depend on its build (see below)
├── __tests__/                # vitest suite -- one file per module
├── vitest.config.ts
└── tsconfig.json             # noEmit, include: ["*.ts"]
```

## Commands

npm, with a committed `package-lock.json`. Only the scripts that actually exist in `package.json`:

```bash
npm ci                      # install (lockfile-exact)
npm test                    # vitest run -- the full suite
npm run test:watch          # vitest (watch)
npm run test:coverage       # vitest run --coverage
npm run test:oauth-provider # node --import tsx --test mcp-oauth-provider.test.ts (single file, node:test)
```

There is **no `build` script and no `typecheck` script**. To type-check, run `tsc` against the committed config, which is already `noEmit`:

```bash
npx tsc -p tsconfig.json    # top-level *.ts only -- `include` is ["*.ts"], so __tests__/ is NOT covered
```

**`npm test` fails 2 tests on a fresh clone, and that is expected.** `__tests__/interactive-visualizer-server.test.ts` reads `examples/interactive-visualizer/dist/{app.html,server.js}`, which are build outputs, not committed. Build the example once and the suite is green (48 files / 435 tests):

```bash
npm --prefix examples/interactive-visualizer install
npm --prefix examples/interactive-visualizer run build
npm test
```

**There is no CI in this repository** — no `.github/workflows`, upstream ships none. So there is nothing for a "wait for CI" step to wait on: the gate is running `npm test` (with the example built) and `npx tsc -p tsconfig.json` locally, and pasting the real output into the PR. Don't claim a green build you didn't run.

## Core Principles

### Guard the context window, not just the tests

Every feature here is judged by what it costs the model's context. Before adding a tool, a schema field, or a result-rendering path, ask how many tokens it puts in front of the model on a turn where nobody uses it. The answer for tool metadata is "keep it behind the proxy unless the user opted into `directTools`", and the answer for results is "it goes through `mcp-output-guard.ts`".

### Match upstream's shape

This is a fork that intends to stay mergeable. Match the existing module boundaries, naming, and test layout (`__tests__/<module>.test.ts`). Prefer a change a maintainer would recognize as belonging in their codebase over one tailored to a private setup.

### Tests live in `__tests__/`, under vitest

New behavior gets a test in `__tests__/`, named after the module it covers. Note the two `*.test.ts` files at the repo root (`mcp-auth*.test.ts`, `mcp-oauth-provider.test.ts`) are upstream's; follow `__tests__/` for new work.

## What NOT to Do

- **Don't open a PR against `nicobailon/pi-mcp-adapter`.** See Fork Discipline. Always `--repo tadasant/pi-mcp-adapter`.
- **Don't merge your own PR.** Open it, prove it works, hand it back.
- **Don't invent npm scripts.** There is no `npm run build`, no `npm run lint`, no `npm run typecheck`. Use the commands above.
- **Don't bypass the output guard** to "just return the raw result" — that is the bug the guard exists to prevent.
- **Don't publish to npm.** The package name `pi-mcp-adapter` on npm is upstream's.

## FAQ / Learnings

- **Q: `npm test` fails two `interactive visualizer` tests on a clean checkout. Is main broken?**
  A: No. Those tests read build artifacts from `examples/interactive-visualizer/dist/`. Build the example (see Commands) and the suite is fully green.

- **Q: Where do I add a new capability — proxy or direct tools?**
  A: Both paths converge in `tool-registrar.ts` and share `mcp-output-guard.ts`. A change that only touches one path is usually incomplete; check whether the other needs it too.

- **Q: `tsc` passed, so the tests will pass?**
  A: Not necessarily — `tsconfig.json` has `include: ["*.ts"]` and `strict: false`, so `__tests__/` is not type-checked at all. Run `npm test`.
