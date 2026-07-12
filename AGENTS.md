# pi-mcp-adapter (Tadas's fork)

Token-efficient MCP adapter extension for the [Pi coding agent](https://github.com/badlogic/pi-mono). It connects to MCP servers on the user's behalf and exposes their tools to Pi while keeping tool metadata and tool results from flooding the model's context window.

**This repository is a fork.** `tadasant/pi-mcp-adapter` is forked from the upstream `nicobailon/pi-mcp-adapter`. Read [Fork Discipline](#fork-discipline) before you open a pull request — it is the single easiest thing to get catastrophically wrong here.

## Fork Discipline

**Every PR you open lands on `tadasant/pi-mcp-adapter`. Never on `nicobailon/pi-mcp-adapter`.**

`gh` defaults the base repo of a new PR to the **parent** of a fork, so the naive `gh pr create` opens a pull request against a third party's repository. Always pin the base repo explicitly:

```bash
gh pr create --repo tadasant/pi-mcp-adapter --base main --title "..." --body "..."
```

Before you push, confirm you are pointed at the fork:

```bash
git remote -v            # origin must be tadasant/pi-mcp-adapter
gh repo view --json nameWithOwner   # sanity-check what gh thinks the repo is
```

If a PR is ever opened against `nicobailon/pi-mcp-adapter` by accident, close it immediately and reopen against the fork.

### Write changes so they can be upstreamed later

Tadas may propose fork changes upstream as separate PRs. Keep every change clean and self-contained: one coherent concern per branch, no drive-by refactors, no fork-specific hacks in shared code paths. Follow the existing conventions of the file you are editing — an upstream maintainer should be able to read the diff without knowing it came from a fork.

Three files are **fork-local infrastructure** and are deliberately not upstream:

- `AGENTS.md` — this file
- `CLAUDE.md` — a symlink to `AGENTS.md`, so Claude Code loads the same content
- `.github/workflows/ci.yml` — upstream has no CI

When cherry-picking a change upstream, branch from `upstream/main` and take only the feature commits; do not carry these files into an upstream PR.

### Staying in sync with upstream

```bash
git remote add upstream https://github.com/nicobailon/pi-mcp-adapter.git   # once
git fetch upstream && git merge upstream/main
```

## Folder Hierarchy

The repo is **flat TypeScript at the root** — there is no `src/`. The tree below is abridged: it covers the modules you are most likely to touch, not all ~45 of them. `package.json`'s `files` array is the authoritative list of root source modules.

```
pi-mcp-adapter/
├── index.ts                  # Entry point — default-exports mcpAdapter(pi); registers the proxy tool,
│                             #   direct tools, /mcp + /mcp-auth commands, and session lifecycle hooks
├── config.ts                 # Discovers and merges .mcp.json / ~/.config/mcp/mcp.json / .pi/mcp.json,
│                             #   plus imports from cursor/claude-code/codex/windsurf/vscode configs
├── types.ts                  # Core types (ServerEntry, McpSettings, McpConfig, ToolMetadata,
│                             #   DirectToolSpec) and the tool-naming helpers
├── state.ts                  # McpExtensionState — the object threaded through every module
├── server-manager.ts         # McpServerManager: launches stdio servers and connects HTTP servers
│                             #   (Streamable HTTP with SSE fallback), wires bearer-token / OAuth auth
├── proxy-modes.ts            # The proxy tool's sub-commands: status, list, search, describe, connect,
│                             #   call, ui-messages, auth-start, auth-complete
├── direct-tools.ts           # Per-tool direct registration: resolveDirectTools, buildProxyDescription,
│                             #   createDirectToolExecutor
├── mcp-output-guard.ts       # Bounds model-facing MCP output (see "Output guarding" under Domain Context)
├── tool-registrar.ts         # Transforms MCP content blocks into Pi content blocks
├── tool-result-renderer.ts   # TUI rendering of tool calls/results (collapsed to 3 lines)
├── init.ts, lifecycle.ts     # Connection bring-up; idle disconnect and keep-alive health checks
├── metadata-cache.ts         # Disk cache of tool metadata (~/.pi/agent/mcp-cache.json)
├── agent-dir.ts              # Resolves the Pi agent dir ($PI_CODING_AGENT_DIR or ~/.pi/agent)
├── mcp-auth*.ts,             # OAuth: token storage, provider, loopback callback server, auth flow
│   mcp-oauth-provider.ts,
│   mcp-callback-server.ts
├── ui-*.ts, glimpse-ui.ts,   # MCP Apps / interactive UI resource support
│   host-html-template.ts
├── __tests__/                # The vitest suite — ALL new tests go here
├── examples/                 # Example MCP servers (interactive-visualizer is exercised by a test)
├── vitest.config.ts          # include: ["__tests__/**/*.test.ts"]
├── tsconfig.json             # noEmit, allowImportingTsExtensions, include: ["*.ts"] (root only)
└── OAUTH.md                  # OAuth design notes
```

## Domain Context

**Pi** is a coding agent; this package is a Pi extension (`"pi": { "extensions": ["./index.ts"] }` in `package.json`), installed with `pi install npm:pi-mcp-adapter`.

**The problem it solves:** MCP tool definitions are verbose. A single MCP server can burn 10k+ tokens of system prompt just declaring its tools. This adapter gives the agent access to those servers without the bloat.

**Two ways tools reach the model:**

- **Proxy mode (default)** — exactly one tool named `mcp` is registered (~200 tokens). The model uses it to `search`, `list`, `describe`, and `call` tools on demand. Tool metadata is served from a disk cache, so discovery works without live connections, and servers only start when actually used (`lifecycle: "lazy"` by default; `eager` and `keep-alive` also exist).
- **Direct tools** — the `directTools` config key (per-server `true | string[] | false`, or the `MCP_DIRECT_TOOLS` env override) registers selected MCP tools as first-class Pi tools, ~150–300 tokens each. Registration reads from the metadata cache, so it still costs no startup connections. `settings.disableProxyTool` hides the `mcp` tool once direct tools are available. Direct tools suit a targeted set of 5–20 tools; servers with 75+ tools should stay on the proxy.

**Output guarding:** `mcp-output-guard.ts` is the module that bounds what an MCP server can push into the model's context. `guardMcpOutput` head-truncates text over `DEFAULT_MCP_OUTPUT_MAX_BYTES` (50 KiB) or `DEFAULT_MCP_OUTPUT_MAX_LINES` (2000), appends a truncation notice, and spills the full payload to a mode-`0600` temp file; `details.mcpResult` is kept raw only while its JSON stays under `DEFAULT_MCP_DETAILS_MAX_BYTES` (16 KiB), and is otherwise replaced by a summary. Image blocks pass through untouched. `MCP_OUTPUT_GUARD=0` disables the guard.

## Commands

Node 22. npm (there is a committed `package-lock.json` — use `npm ci`).

```bash
npm ci                                  # install
npm test                                # vitest run — the whole suite
npx vitest run __tests__/config.test.ts # a single test file
npx tsc --noEmit                        # typecheck
```

There is **no build step and no lint step.** Pi loads the `.ts` files directly, which is why imports carry explicit `.ts` extensions (`import { loadMcpConfig } from "./config.ts"`) and `tsconfig.json` sets `allowImportingTsExtensions` with `noEmit`.

Two scope gotchas worth internalizing:

- **Nothing typechecks `__tests__/`.** `tsconfig.json`'s `include` is `["*.ts"]` — root-only and non-recursive — so `tsc` never sees the suite, and vitest transpiles through esbuild without typechecking. A type error in a test file is caught by neither command: `npm test` passes it happily. To typecheck a test, invoke `tsc` on it directly: `npx tsc --noEmit --allowImportingTsExtensions __tests__/foo.test.ts`.
- `npm test` runs **only** `__tests__/**/*.test.ts`. The four root-level `*.test.ts` files (`mcp-auth.test.ts`, `mcp-auth-flow.test.ts`, `mcp-callback-server.test.ts`, `mcp-oauth-provider.test.ts`) are `node:test` files outside vitest's include glob; only `mcp-oauth-provider.test.ts` is wired to a script (`npm run test:oauth-provider`). CI does not run them.

`__tests__/interactive-visualizer-server.test.ts` reads build artifacts from `examples/interactive-visualizer/dist/`. On a clean checkout those do not exist and the two tests in that file fail with `ENOENT`. Build the example once and the suite is fully green:

```bash
cd examples/interactive-visualizer && npm install --no-package-lock && npm run build && cd ../..
```

(`--no-package-lock`: the example has no committed lockfile, and a plain `npm install` leaves an untracked one behind for you to accidentally commit.)

CI does this for you (`.github/workflows/ci.yml`).

## Testing Conventions

- New tests go in `__tests__/<module>.test.ts`. Nowhere else — a root-level `*.test.ts` will never run under `npm test`.
- Import the module under test from the parent directory with an explicit extension: `import { guardMcpOutput } from "../mcp-output-guard.ts"`.
- `globals: true` is set, but tests still import `describe`/`it`/`expect` from `vitest` explicitly. Follow that.
- The house style is a plain unit test over hand-built `McpConfig` / `MetadataCache` literals — see `__tests__/direct-tools.test.ts`. Reach for `vi.mock` only to stub an **external** dependency at a real boundary, the way `__tests__/server-manager-http-auth.test.ts` mocks the MCP SDK's client transports. Internal modules are not mocked anywhere in this suite; don't start.
- Fixture MCP servers live in `__tests__/fixtures/`.

## Core Principles

### Token efficiency is the product

This is not a general-purpose MCP client; it is an MCP client whose reason to exist is that the model's context window is scarce. Any change that puts more bytes in front of the model — a longer tool description, an unbounded tool result, eagerly registered tools, a verbose error string — is working against the point of the package. When adding a code path that reaches the model, ask what its worst-case token cost is and bound it.

### Don't let CI be your first check

This fork has CI (`.github/workflows/ci.yml`); upstream has none, and there is no pre-commit hook anywhere. Run `npm test` and `npx tsc --noEmit` locally before you push, every time — CI is the confirmation, not the feedback loop. Remember that neither command typechecks `__tests__/` (above), so a test file's types are on you.

### Match the file you are in

`tsconfig.json` has `strict: false`, and the codebase's conventions (explicit `.ts` imports, module-scoped functions over classes except where a manager owns state) are already established. Write code that reads like the code around it — that is also what makes a change upstreamable.

## What NOT to Do

- **Do not open a PR against `nicobailon/pi-mcp-adapter`.** See [Fork Discipline](#fork-discipline).
- **Do not add a new root-level source module without adding it to the `files` array in `package.json`.** `__tests__/package-manifest.test.ts` asserts that every root `*.ts` other than tests and `vitest.config.ts` appears there — omitting it fails the suite.
- **Do not bump `version` in `package.json` as part of a feature PR.** Version bumps are separate release commits.
- **Do not put new tests at the repo root.** They will not run.
- **Do not treat the two `interactive-visualizer` failures on a fresh clone as your regression.** Build the example (above) and they pass.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add user-visible changes to the `## [Unreleased]` section under `### Added` / `### Changed` / `### Fixed`. Do not create a new version heading — that happens at release.
