import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MCP_OUTPUT_MAX_TOKENS, estimateTokens } from "../mcp-output-guard.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpSettings, ToolMetadata } from "../types.ts";

// End-to-end: the real proxy `call` path against a real stdio MCP server that
// returns an oversized payload. Proves the blob never reaches the model and is
// fully recoverable from the spill file.

const fixture = fileURLToPath(new URL("./fixtures/large-output-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

const TOOLS: ToolMetadata[] = [
  { name: "big_firehose", originalName: "firehose", description: "Return a very large text payload" },
  { name: "big_trickle", originalName: "trickle", description: "Return a small text payload" },
];

// Kept in sync with firehosePayload() in fixtures/large-output-server.mjs.
function firehosePayload(lines: number): string {
  const rows = ["FIREHOSE-START"];
  for (let i = 0; i < lines; i++) {
    rows.push(`row ${i}: ${"payload-".repeat(8)}${i}`);
  }
  rows.push("FIREHOSE-END");
  return rows.join("\n");
}

async function createState(settings: McpSettings): Promise<McpExtensionState> {
  const manager = new McpServerManager();
  await manager.connect("big", definition);
  managers.push(manager);
  return {
    manager,
    config: { settings, mcpServers: { big: definition } },
    toolMetadata: new Map([["big", TOOLS]]),
    failureTracker: new Map(),
    completedUiSessions: [],
    uiServer: null,
  } as unknown as McpExtensionState;
}

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

// The guard reads these from the environment; a developer with them exported must not
// get a red suite, and spills must not land in the real agent dir.
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "MCP_OUTPUT_MAX_TOKENS", "MCP_OUTPUT_GUARD"] as const;
const originalEnv: Record<string, string | undefined> = {};
let agentDir: string;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-e2e-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
});

describe("token budget over a real stdio MCP server", () => {
  it("keeps an oversized tool result out of the model context and recoverable on disk", async () => {
    // Byte and line caps are lifted so the token cap is the only thing that can trip.
    const state = await createState({
      outputGuard: { maxBytes: 50_000_000, maxLines: 5_000_000 },
    });

    const lines = 20_000;
    const expected = firehosePayload(lines);
    expect(estimateTokens(expected)).toBeGreaterThan(DEFAULT_MCP_OUTPUT_MAX_TOKENS * 10);

    const result = await executeCall(state, "big_firehose", { lines }, "big");

    const seenByModel = modelText(result);
    expect(estimateTokens(seenByModel)).toBeLessThanOrEqual(DEFAULT_MCP_OUTPUT_MAX_TOKENS);
    expect(seenByModel).toContain("FIREHOSE-START");
    expect(seenByModel).not.toContain("FIREHOSE-END");
    expect(seenByModel).toContain("[MCP output truncated");

    const guard = (result.details as Record<string, any>).outputGuard;
    expect(guard).toMatchObject({ truncated: true, exceeded: ["tokens"] });
    expect(guard.originalTokens).toBe(estimateTokens(expected));

    const path: string = guard.fullOutputPath;
    expect(path.startsWith(join(agentDir, "mcp-output"))).toBe(true);
    expect(seenByModel).toContain(path);

    const saved = await readFile(path, "utf8");
    expect(saved).toBe(expected);

    // The raw result must not sneak back in through details either.
    const details = JSON.stringify(result.details);
    expect(details).not.toContain("FIREHOSE-END");
    expect((result.details as Record<string, any>).mcpResult).toMatchObject({ omitted: true });
  });

  it("leaves a small tool result inline and untouched", async () => {
    const state = await createState({});

    const result = await executeCall(state, "big_trickle", {}, "big");

    expect(modelText(result)).toBe("small and tidy");
    expect((result.details as Record<string, any>).outputGuard).toBeUndefined();
  });

  it("returns the full payload inline when the token cap is disabled", async () => {
    const state = await createState({
      outputGuard: { maxBytes: 50_000_000, maxLines: 5_000_000, maxTokens: 0 },
    });

    const lines = 5_000;
    const result = await executeCall(state, "big_firehose", { lines }, "big");

    expect(modelText(result)).toBe(firehosePayload(lines));
    expect((result.details as Record<string, any>).outputGuard).toBeUndefined();
  });
});
