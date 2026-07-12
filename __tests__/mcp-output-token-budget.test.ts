import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_OUTPUT_MAX_TOKENS,
  estimateTokens,
  guardMcpOutput,
  resolveMcpOutputGuardOptions,
} from "../mcp-output-guard.ts";

const ENV_KEYS = ["MCP_OUTPUT_MAX_TOKENS", "MCP_OUTPUT_GUARD", "PI_CODING_AGENT_DIR", "TMPDIR"] as const;
const originalEnv: Record<string, string | undefined> = {};

let agentDir: string;

function textOf(guarded: { content: Array<{ type: string; text?: string }> }): string {
  return guarded.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe("estimateTokens", () => {
  it("estimates 4 characters per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("counts characters (code points), not bytes or UTF-16 code units", () => {
    // 8 CJK characters = 24 UTF-8 bytes = 8 UTF-16 code units => 2 estimated tokens.
    expect(estimateTokens("漢字漢字漢字漢字")).toBe(2);
    // 4 astral-plane emoji = 16 UTF-8 bytes = 8 UTF-16 code units, but only 4 characters => 1 token.
    expect(estimateTokens("😀😀😀😀")).toBe(1);
  });
});

describe("token budget configuration precedence", () => {
  it("falls back to the built-in default when nothing is configured", () => {
    expect(resolveMcpOutputGuardOptions(undefined).maxTokens).toBe(DEFAULT_MCP_OUTPUT_MAX_TOKENS);
  });

  it("uses the env override when settings do not specify a cap", () => {
    process.env.MCP_OUTPUT_MAX_TOKENS = "1234";
    expect(resolveMcpOutputGuardOptions(undefined).maxTokens).toBe(1234);
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxBytes: 10 } }).maxTokens).toBe(1234);
  });

  it("prefers an explicit settings value over the env override", () => {
    process.env.MCP_OUTPUT_MAX_TOKENS = "1234";
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxTokens: 4321 } }).maxTokens).toBe(4321);
  });

  it("treats 0 as an explicit disable from settings and from the env", () => {
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxTokens: 0 } }).maxTokens).toBe(0);

    process.env.MCP_OUTPUT_MAX_TOKENS = "0";
    expect(resolveMcpOutputGuardOptions(undefined).maxTokens).toBe(0);

    // An explicit settings cap still wins over a disabling env value.
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxTokens: 500 } }).maxTokens).toBe(500);
  });

  it("ignores unparseable or negative env values", () => {
    for (const value of ["", "  ", "abc", "-5", "1e5", "12.5", "NaN", "Infinity"]) {
      process.env.MCP_OUTPUT_MAX_TOKENS = value;
      expect(resolveMcpOutputGuardOptions(undefined).maxTokens).toBe(DEFAULT_MCP_OUTPUT_MAX_TOKENS);
    }
  });

  it("ignores unusable settings values", () => {
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxTokens: -1 } as never }).maxTokens).toBe(DEFAULT_MCP_OUTPUT_MAX_TOKENS);
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxTokens: "500" } as never }).maxTokens).toBe(DEFAULT_MCP_OUTPUT_MAX_TOKENS);
  });
});

describe("token budget enforcement", () => {
  it("spills output that is within the byte and line caps but over the token cap", async () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i} ${"x".repeat(90)}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 10_000_000,
      maxLines: 1_000_000,
      maxTokens: 500,
    });

    expect(guarded.outputGuard).toMatchObject({ truncated: true, exceeded: ["tokens"] });
    expect(guarded.outputGuard?.originalTokens).toBe(estimateTokens(text));

    const returned = textOf(guarded);
    expect(estimateTokens(returned)).toBeLessThanOrEqual(500);
    expect(returned).toContain("line-0");
    expect(returned).not.toContain("line-199");

    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe(text);
  });

  it("does not truncate output that sits exactly on the token cap, and truncates one character past it", async () => {
    // maxTokens 10 => 40 characters is exactly 10 estimated tokens.
    const atCap = "x".repeat(40);
    const overCap = "x".repeat(41);
    const limits = { maxBytes: 1_000_000, maxLines: 1_000_000, maxTokens: 10 };

    const inline = await guardMcpOutput([{ type: "text", text: atCap }], limits);
    expect(inline.outputGuard).toBeUndefined();
    expect(textOf(inline)).toBe(atCap);

    const spilled = await guardMcpOutput([{ type: "text", text: overCap }], limits);
    expect(spilled.outputGuard).toMatchObject({ truncated: true });
  });

  it("counts the token budget in characters, so multibyte text is not double-charged", async () => {
    // 40 CJK characters = 120 UTF-8 bytes, but exactly 10 estimated tokens.
    const text = "漢".repeat(40);
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 1_000_000,
      maxLines: 1_000_000,
      maxTokens: 10,
    });

    expect(guarded.outputGuard).toBeUndefined();
    expect(textOf(guarded)).toBe(text);
  });

  it("never splits a multibyte character when trimming the preview to the token budget", async () => {
    const text = "😀".repeat(5_000);
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 1_000_000,
      maxLines: 1_000_000,
      maxTokens: 500,
    });

    const returned = textOf(guarded);
    expect(returned).not.toContain("�");
    // Every high surrogate still paired with its low surrogate.
    expect(returned.split("\uD83D").length).toBe(returned.split("\uDE00").length);
    expect(estimateTokens(returned)).toBeLessThanOrEqual(500);
    expect(await readFile(guarded.outputGuard!.fullOutputPath!, "utf8")).toBe(text);
  });

  it("returns just the pointer when the cap is too small to fit a preview alongside it", async () => {
    const text = "b".repeat(100_000);
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 10_000_000,
      maxLines: 1_000_000,
      maxTokens: 1,
    });

    const returned = textOf(guarded);
    expect(returned.trim().startsWith("[MCP output truncated")).toBe(true);
    expect(returned).not.toContain("bbbb");
    // The notice is the floor: a cap below its size cannot shrink it further, but
    // it is still ~2 orders of magnitude smaller than the payload it replaces.
    expect(estimateTokens(returned)).toBeLessThan(200);
    expect(estimateTokens(returned) * 50).toBeLessThan(estimateTokens(text));
    expect(await readFile(guarded.outputGuard!.fullOutputPath!, "utf8")).toBe(text);
  });

  it("keeps the whole guarded payload — preview plus notice — inside the token cap", async () => {
    const text = Array.from({ length: 500 }, (_, i) => `row-${i} ${"y".repeat(60)}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 10_000_000,
      maxLines: 1_000_000,
      maxTokens: 300,
    });

    expect(guarded.outputGuard).toMatchObject({ truncated: true });
    expect(estimateTokens(textOf(guarded))).toBeLessThanOrEqual(300);
    expect(guarded.outputGuard!.returnedTokens).toBeLessThanOrEqual(300);
  });

  it("applies whichever cap trips first when several are configured", async () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");

    const byLines = await guardMcpOutput([{ type: "text", text }], { maxBytes: 10_000_000, maxLines: 10, maxTokens: 0 });
    expect(byLines.outputGuard).toMatchObject({ truncated: true, exceeded: ["lines"] });

    const byBytes = await guardMcpOutput([{ type: "text", text }], { maxBytes: 100, maxLines: 1_000_000, maxTokens: 0 });
    expect(byBytes.outputGuard).toMatchObject({ truncated: true, exceeded: ["bytes"] });

    const byAll = await guardMcpOutput([{ type: "text", text }], { maxBytes: 100, maxLines: 10, maxTokens: 10 });
    expect(byAll.outputGuard?.exceeded).toEqual(["bytes", "lines", "tokens"]);
  });

  it("disables the token cap when it is 0, leaving byte and line caps in force", async () => {
    const text = "z".repeat(200_000);

    const uncapped = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 10_000_000,
      maxLines: 1_000_000,
      maxTokens: 0,
    });
    expect(uncapped.outputGuard).toBeUndefined();
    expect(textOf(uncapped)).toBe(text);

    const stillByteCapped = await guardMcpOutput([{ type: "text", text }], {
      maxBytes: 1_000,
      maxLines: 1_000_000,
      maxTokens: 0,
    });
    expect(stillByteCapped.outputGuard).toMatchObject({ truncated: true, exceeded: ["bytes"] });
  });

  it("is inert when the guard itself is disabled", async () => {
    const text = "q".repeat(200_000);
    const guarded = await guardMcpOutput([{ type: "text", text }], { enabled: false, maxTokens: 10 });

    expect(guarded.outputGuard).toBeUndefined();
    expect(textOf(guarded)).toBe(text);
  });

  it("passes non-text blocks through when the token cap trips", async () => {
    const image = { type: "image" as const, data: "A".repeat(50_000), mimeType: "image/png" };
    const text = "w".repeat(10_000);
    const guarded = await guardMcpOutput([{ type: "text", text }, image], {
      maxBytes: 10_000_000,
      maxLines: 1_000_000,
      maxTokens: 100,
    });

    expect(guarded.outputGuard).toMatchObject({ truncated: true, imageBlocksPassedThrough: 1 });
    expect(guarded.content).toHaveLength(2);
    expect(guarded.content[1]).toEqual(image);
    expect(await readFile(guarded.outputGuard!.fullOutputPath!, "utf8")).toBe(text);
  });
});

describe("durable spill location", () => {
  it("saves spilled output under the Pi agent dir and keeps it recoverable", async () => {
    const text = Array.from({ length: 5_000 }, (_, i) => `record-${i}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], { maxTokens: 200 });

    const path = guarded.outputGuard!.fullOutputPath!;
    expect(path.startsWith(join(agentDir, "mcp-output"))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("gives the model a compact, actionable pointer instead of the payload", async () => {
    const text = Array.from({ length: 5_000 }, (_, i) => `record-${i} ${"v".repeat(50)}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], { maxTokens: 500 });

    const returned = textOf(guarded);
    const notice = returned.slice(returned.indexOf("[MCP output truncated"));

    expect(notice).toContain("chars");
    expect(notice).toContain("est. tokens");
    expect(notice).toContain("lines");
    expect(notice).toContain(guarded.outputGuard!.fullOutputPath!);
    expect(notice).toMatch(/offset\/limit/);
    expect(notice).toMatch(/grep/);
    expect(estimateTokens(notice)).toBeLessThan(200);
    expect(returned).not.toContain("record-4999");
  });

  it("writes concurrent spills to distinct files", async () => {
    const texts = Array.from({ length: 12 }, (_, i) => `${i}\n${"c".repeat(4_000)}`);
    const guarded = await Promise.all(
      texts.map(text => guardMcpOutput([{ type: "text", text }], { maxTokens: 50 })),
    );

    const paths = guarded.map(g => g.outputGuard!.fullOutputPath!);
    expect(new Set(paths).size).toBe(texts.length);

    const saved = await Promise.all(paths.map(path => readFile(path, "utf8")));
    expect(saved.sort()).toEqual([...texts].sort());
  });

  it("bounds the spill directory so a long-lived agent dir cannot grow without limit", async () => {
    const text = "g".repeat(5_000);
    for (let i = 0; i < 6; i++) {
      await guardMcpOutput([{ type: "text", text: `${i}\n${text}` }], { maxTokens: 50, maxSpillFiles: 3 });
    }

    const entries = await readdir(join(agentDir, "mcp-output"));
    expect(entries.length).toBeLessThanOrEqual(3);
  });
});

describe("spill write failures", () => {
  it("falls back to inline truncation and reports the error when the payload cannot be saved", async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), "pi-mcp-blocked-")), "not-a-dir");
    writeFileSync(blocker, "x");
    process.env.PI_CODING_AGENT_DIR = blocker;
    process.env.TMPDIR = blocker;

    const text = Array.from({ length: 400 }, (_, i) => `line-${i} ${"n".repeat(40)}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], { maxTokens: 200 });

    expect(guarded.outputGuard).toMatchObject({ truncated: true });
    expect(guarded.outputGuard?.fullOutputPath).toBeUndefined();
    expect(guarded.outputGuard?.writeError).toBeTruthy();

    const returned = textOf(guarded);
    expect(returned).toContain("line-0");
    expect(returned).toContain("could not be saved");
    expect(returned).not.toContain("line-399");
  });

  it("keeps the payload recoverable in a temp file when only the agent dir is unwritable", async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), "pi-mcp-blocked-")), "not-a-dir");
    writeFileSync(blocker, "x");
    process.env.PI_CODING_AGENT_DIR = blocker;

    const text = Array.from({ length: 400 }, (_, i) => `line-${i}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], { maxTokens: 100 });

    const path = guarded.outputGuard!.fullOutputPath!;
    expect(path.startsWith(blocker)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(text);
  });
});
