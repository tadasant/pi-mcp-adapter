import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { logger } from "./logger.ts";
import type { ContentBlock, McpSettings } from "./types.ts";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;
/**
 * Estimated-token budget for a single MCP result. 10,000 tokens is ~5% of a
 * 200k-token context window: enough for a substantial preview, small enough
 * that a handful of tool calls cannot crowd out the conversation.
 */
export const DEFAULT_MCP_OUTPUT_MAX_TOKENS = 10_000;
/** Characters per token — the standard rough approximation for English text. */
export const CHARS_PER_TOKEN = 4;
/** Spill directory, relative to the Pi agent dir. */
export const MCP_SPILL_DIR = "mcp-output";
/** Spill files retained in the (durable) spill directory before the oldest are pruned. */
export const DEFAULT_MAX_SPILL_FILES = 200;

const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

type Recordish = Record<string, unknown>;
type ExceededLimit = "bytes" | "lines" | "tokens";

interface TextStats {
  bytes: number;
  lines: number;
  chars: number;
  tokens: number;
}

export interface McpOutputGuardDetails {
  truncated: true;
  /** Which configured limits the original output exceeded. */
  exceeded: ExceededLimit[];
  originalBytes: number;
  returnedBytes: number;
  originalLines: number;
  returnedLines: number;
  originalChars: number;
  returnedChars: number;
  /** Estimated tokens (chars / 4) of the original and returned text. */
  originalTokens: number;
  returnedTokens: number;
  /** Number of image content blocks returned untouched alongside the truncated text. */
  imageBlocksPassedThrough?: number;
  fullOutputPath?: string;
  writeError?: string;
}

export interface McpResultSummary {
  omitted: true;
  reason: string;
  isError: boolean;
  contentBlocks: number;
  contentSummary: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  extraFields?: Array<Record<string, unknown>>;
  rawResultBytes: number;
  fullResultPath?: string;
  resultWriteError?: string;
}

export interface McpOutputGuardOptions {
  enabled?: boolean;
  prefix?: string;
  suffix?: string;
  emptyTextFallback?: string;
  maxBytes?: number;
  maxLines?: number;
  /** Estimated-token budget for the text returned to the model. 0 disables the token cap. */
  maxTokens?: number;
  detailsMaxBytes?: number;
  /** Spill files kept in the durable spill directory. Exposed for tests. */
  maxSpillFiles?: number;
  /**
   * Raw MCP result to expose as details.mcpResult. Kept raw when its JSON
   * fits detailsMaxBytes (or when the guard is disabled); otherwise replaced
   * with a compact summary and spilled to a file. Omit for call sites
   * whose details never carried the raw result (e.g. direct tools).
   */
  rawMcpResult?: unknown;
}

export interface GuardedMcpOutput {
  content: ContentBlock[];
  outputGuard?: McpOutputGuardDetails;
  mcpResult?: unknown;
}

/** Estimated token count of a string, at CHARS_PER_TOKEN characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(charLength(text) / CHARS_PER_TOKEN);
}

export function resolveMcpOutputGuardOptions(settings?: McpSettings): Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "maxTokens" | "detailsMaxBytes"> {
  const configured = settings?.outputGuard;
  const tuning = typeof configured === "object" && configured !== null ? configured : undefined;
  return {
    enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
    maxBytes: positiveInt(tuning?.maxBytes) ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
    maxLines: positiveInt(tuning?.maxLines) ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
    // Precedence: explicit settings value, then env override, then the default.
    maxTokens: countOrZero(tuning?.maxTokens)
      ?? countOrZero(parseCount(process.env.MCP_OUTPUT_MAX_TOKENS))
      ?? DEFAULT_MCP_OUTPUT_MAX_TOKENS,
    detailsMaxBytes: positiveInt(tuning?.detailsMaxBytes) ?? DEFAULT_MCP_DETAILS_MAX_BYTES,
  };
}

/** Spread helper for tool-result details: includes mcpResult/outputGuard only when present. */
export function guardedMcpDetails(guarded: GuardedMcpOutput): Record<string, unknown> {
  return {
    ...(guarded.mcpResult !== undefined ? { mcpResult: guarded.mcpResult } : {}),
    ...(guarded.outputGuard ? { outputGuard: guarded.outputGuard } : {}),
  };
}

/**
 * Bound model-facing MCP output. Text output is capped at maxBytes/maxLines and
 * by an estimated-token budget (maxTokens) — whichever limit trips first governs —
 * and is spilled to a file under the Pi agent dir when oversized. Image blocks pass
 * through untouched: they are delivered to the provider as native image content,
 * not text context.
 */
export async function guardMcpOutput(
  content: ContentBlock[],
  options: McpOutputGuardOptions = {},
): Promise<GuardedMcpOutput> {
  const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
  const maxTokens = options.maxTokens ?? DEFAULT_MCP_OUTPUT_MAX_TOKENS;
  const detailsMaxBytes = options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES;
  const maxSpillFiles = options.maxSpillFiles ?? DEFAULT_MAX_SPILL_FILES;
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";

  const normalizedContent = withEmptyTextFallback(
    content.length > 0
      ? sanitizeContent(content)
      : [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
    options.emptyTextFallback,
  );

  if (options.enabled === false) {
    return {
      content: addAffixes(normalizedContent, prefix, suffix),
      mcpResult: options.rawMcpResult,
    };
  }

  const imageBlocks = normalizedContent.filter((block) => block.type === "image");
  const textOutput = normalizedContent
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const composedOutput = `${prefix}${textOutput}${suffix}`;
  const stats = textStats(composedOutput);

  let guardedContent: ContentBlock[] = addAffixes(normalizedContent, prefix, suffix);
  let outputGuard: McpOutputGuardDetails | undefined;

  const exceeded = exceededLimits(stats, maxBytes, maxLines, maxTokens);

  if (exceeded.length > 0) {
    const { path: fullOutputPath, error: writeError } = await saveArtifact("output", composedOutput, maxSpillFiles);
    const notice = formatTruncationNotice(stats, exceeded, { maxBytes, maxLines, maxTokens }, fullOutputPath, writeError);
    const previewBudget = reserveBudget(maxBytes, maxLines, maxTokens, notice);
    const preview = truncateHead(composedOutput, previewBudget);
    const finalText = `${preview}\n\n${notice}`;
    const finalStats = textStats(finalText);

    guardedContent = [{ type: "text" as const, text: finalText }, ...imageBlocks];
    outputGuard = {
      truncated: true,
      exceeded,
      originalBytes: stats.bytes,
      returnedBytes: finalStats.bytes,
      originalLines: stats.lines,
      returnedLines: finalStats.lines,
      originalChars: stats.chars,
      returnedChars: finalStats.chars,
      originalTokens: stats.tokens,
      returnedTokens: finalStats.tokens,
      ...(imageBlocks.length > 0 ? { imageBlocksPassedThrough: imageBlocks.length } : {}),
      fullOutputPath,
      writeError,
    };
  }

  const mcpResult = options.rawMcpResult === undefined
    ? undefined
    : await boundMcpResult(options.rawMcpResult, detailsMaxBytes, maxSpillFiles);

  return { content: guardedContent, outputGuard, mcpResult };
}

function exceededLimits(stats: TextStats, maxBytes: number, maxLines: number, maxTokens: number): ExceededLimit[] {
  const exceeded: ExceededLimit[] = [];
  if (stats.bytes > maxBytes) exceeded.push("bytes");
  if (stats.lines > maxLines) exceeded.push("lines");
  if (maxTokens > 0 && stats.tokens > maxTokens) exceeded.push("tokens");
  return exceeded;
}

function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const mimeType = typeof block.mimeType === "string" && block.mimeType.trim()
      ? block.mimeType.trim().slice(0, 100)
      : "image/png";
    return { ...block, mimeType };
  });
}

function withEmptyTextFallback(content: ContentBlock[], fallback: string | undefined): ContentBlock[] {
  if (!fallback) return content;
  const textOutput = content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  if (textOutput) return content;
  return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
  if (!prefix && !suffix) return content;
  const next: ContentBlock[] = [...content];

  if (prefix) {
    const index = next.findIndex((block) => block.type === "text");
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${prefix}${block.text}` };
    } else {
      next.unshift({ type: "text", text: prefix });
    }
  }

  if (suffix) {
    let index = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].type === "text") {
        index = i;
        break;
      }
    }
    const block = next[index];
    if (index >= 0 && block.type === "text") {
      next[index] = { ...block, text: `${block.text}${suffix}` };
    } else {
      next.push({ type: "text", text: suffix });
    }
  }

  return next;
}

interface PreviewBudget {
  maxBytes: number;
  maxLines: number;
  maxChars: number;
}

/**
 * Budget for the head preview: the configured limits minus what the truncation
 * notice itself costs, so preview + notice stays inside every limit.
 */
function reserveBudget(maxBytes: number, maxLines: number, maxTokens: number, notice: string): PreviewBudget {
  const noticeStats = textStats(`\n\n${notice}`);
  return {
    maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
    maxLines: Math.max(0, maxLines - noticeStats.lines),
    // ceil(previewChars / 4) + ceil(noticeChars / 4) >= ceil(totalChars / 4), so
    // bounding the preview by the leftover token budget bounds the whole payload.
    maxChars: maxTokens > 0
      ? Math.max(0, (maxTokens - noticeStats.tokens) * CHARS_PER_TOKEN)
      : Number.POSITIVE_INFINITY,
  };
}

function truncateHead(text: string, budget: PreviewBudget): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;
  let chars = 0;

  for (const line of lines) {
    if (output.length >= budget.maxLines) break;
    const separator = output.length > 0 ? 1 : 0;
    const lineBytes = byteLength(line);
    const lineChars = charLength(line);
    if (bytes + separator + lineBytes > budget.maxBytes || chars + separator + lineChars > budget.maxChars) {
      const partial = truncateString(line, budget.maxBytes - bytes - separator, budget.maxChars - chars - separator);
      if (partial) output.push(partial);
      break;
    }
    output.push(line);
    bytes += separator + lineBytes;
    chars += separator + lineChars;
  }

  return output.join("\n");
}

/** Take the longest prefix of `value` fitting both budgets, never splitting a character. */
function truncateString(value: string, maxBytes: number, maxChars: number): string {
  if (maxBytes <= 0 || maxChars <= 0) return "";
  let bytes = 0;
  let chars = 0;
  let end = 0;

  for (const char of value) {
    const charBytes = byteLength(char);
    if (bytes + charBytes > maxBytes || chars + 1 > maxChars) break;
    bytes += charBytes;
    chars += 1;
    end += char.length;
  }

  return value.slice(0, end);
}

function formatTruncationNotice(
  stats: TextStats,
  exceeded: ExceededLimit[],
  limits: { maxBytes: number; maxLines: number; maxTokens: number },
  fullOutputPath: string | undefined,
  writeError: string | undefined,
): string {
  const size = `${stats.chars.toLocaleString()} chars / ~${stats.tokens.toLocaleString()} est. tokens / ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}`;
  const over = exceeded.map((limit) => describeLimit(limit, limits)).join(", ");
  const head = `[MCP output truncated: ${size} — over the configured ${over}. Only the head is shown above.`;

  if (!fullOutputPath) {
    return `${head} Full output could not be saved (${writeError ?? "unknown error"}), so the rest is unavailable — re-run the tool with narrower arguments.]`;
  }

  return `${head}
Full output saved to: ${fullOutputPath}
Work through the file instead of pulling it back inline: read it with offset/limit, grep it for what you need, or run a structured query (jq, rg) over it.]`;
}

function describeLimit(limit: ExceededLimit, limits: { maxBytes: number; maxLines: number; maxTokens: number }): string {
  if (limit === "bytes") return `byte limit (${formatSize(limits.maxBytes)})`;
  if (limit === "lines") return `line limit (${limits.maxLines.toLocaleString()})`;
  return `token budget (${limits.maxTokens.toLocaleString()} est. tokens)`;
}

/**
 * Bound details.mcpResult: keep the raw result when its JSON fits within
 * detailsMaxBytes; otherwise replace it with a compact summary and spill the
 * raw JSON to a file.
 */
async function boundMcpResult(result: unknown, detailsMaxBytes: number, maxSpillFiles: number): Promise<unknown> {
  const raw = safeStringify(result);
  const rawBytes = byteLength(raw);
  if (rawBytes <= detailsMaxBytes) return result;
  return summarizeMcpResult(result, raw, rawBytes, maxSpillFiles);
}

async function summarizeMcpResult(result: unknown, raw: string, rawBytes: number, maxSpillFiles: number): Promise<McpResultSummary> {
  const { path: fullResultPath, error: resultWriteError } = await saveArtifact("mcp-result", raw, maxSpillFiles);

  const record = asRecord(result);
  const content = Array.isArray(record?.content) ? record.content : [];
  const summary: McpResultSummary = {
    omitted: true,
    reason: "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
    isError: record?.isError === true,
    contentBlocks: content.length,
    contentSummary: summarizeContent(content),
    rawResultBytes: rawBytes,
    fullResultPath,
    resultWriteError,
  };

  if (record && "structuredContent" in record) {
    summary.structuredContent = summarizeValue(record.structuredContent);
  }
  if (record && "_meta" in record) {
    summary.meta = summarizeValue(record._meta);
  }
  if (record) {
    const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
    const extraFields = Object.keys(record)
      .filter((key) => !standard.has(key))
      .slice(0, KEY_PREVIEW_LIMIT)
      .map((key) => ({ key: truncateKey(key), type: typeof record[key], estimatedBytes: estimateValueBytes(record[key]), omitted: true }));
    if (extraFields.length > 0) summary.extraFields = extraFields;
  }

  return summary;
}

function summarizeContent(content: unknown[]): Array<Record<string, unknown>> {
  const summaries: Array<Record<string, unknown>> = content.slice(0, CONTENT_SUMMARY_LIMIT).map((block) => {
    const record = asRecord(block);
    if (!record) return { type: typeof block, omitted: true };
    if (record.type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      return { type: "text", bytes: byteLength(text), lines: textStats(text).lines, textOmitted: true };
    }
    if (record.type === "image") {
      const data = typeof record.data === "string" ? record.data : "";
      return { type: "image", mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined, dataBytes: byteLength(data), dataOmitted: true };
    }
    return { type: typeof record.type === "string" ? record.type : "unknown", estimatedBytes: estimateValueBytes(record), omitted: true };
  });
  if (content.length > CONTENT_SUMMARY_LIMIT) {
    summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
  }
  return summaries;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    return { type: value === null ? "null" : typeof value, estimatedBytes: estimateValueBytes(value), omitted: true };
  }
  const keys = Object.keys(record);
  return {
    type: Array.isArray(value) ? "array" : "object",
    estimatedBytes: estimateValueBytes(value),
    keyCount: keys.length,
    keysPreview: keys.slice(0, KEY_PREVIEW_LIMIT).map(truncateKey),
    omitted: true,
  };
}

function estimateValueBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return byteLength(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return byteLength(String(value));
  const record = asRecord(value);
  if (!record || depth >= 2) return 0;
  const values = Array.isArray(value) ? value.slice(0, KEY_PREVIEW_LIMIT) : Object.values(record).slice(0, KEY_PREVIEW_LIMIT);
  return values.reduce((total, item) => total + estimateValueBytes(item, depth + 1), 0);
}

function truncateKey(key: string): string {
  return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}

/**
 * Spill an oversized payload to disk. Preferred location is the Pi agent dir
 * (durable, predictable, honors PI_CODING_AGENT_DIR) so the model can come back
 * to it later; an unwritable agent dir falls back to an ephemeral temp dir so a
 * payload is never lost just because the agent dir is read-only.
 */
async function saveArtifact(kind: string, text: string, maxSpillFiles: number): Promise<{ path?: string; error?: string }> {
  const name = artifactName(kind);
  const durableDir = getAgentPath(MCP_SPILL_DIR);

  try {
    await mkdir(durableDir, { recursive: true, mode: 0o700 });
    const path = resolveWithin(durableDir, name);
    // "wx" fails rather than following a pre-existing file or symlink at that path.
    await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await pruneSpillDir(durableDir, maxSpillFiles);
    return { path };
  } catch (durableError) {
    try {
      const dir = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
      const path = resolveWithin(dir, name);
      await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { path };
    } catch (fallbackError) {
      return { error: `${errorMessage(durableError)}; temp fallback: ${errorMessage(fallbackError)}` };
    }
  }
}

function artifactName(kind: string): string {
  const safeKind = kind.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 32) || "output";
  // pid + random suffix: unique across concurrent calls and across processes
  // sharing one agent dir. The timestamp only makes the directory browsable.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safeKind}-${stamp}-${process.pid}-${randomBytes(8).toString("hex")}.txt`;
}

/** Join and assert the result stays inside `dir` — belt and braces against a crafted name. */
function resolveWithin(dir: string, name: string): string {
  const path = resolve(dir, name);
  if (!path.startsWith(resolve(dir) + sep)) {
    throw new Error(`Refusing to write MCP output outside ${dir}`);
  }
  return path;
}

/**
 * Keep the durable spill directory bounded: a long-lived agent dir would
 * otherwise accumulate spill files forever. Best-effort — a prune failure must
 * not fail the tool call whose output we just saved.
 */
async function pruneSpillDir(dir: string, maxSpillFiles: number): Promise<void> {
  if (!(maxSpillFiles > 0)) return;
  try {
    const names = await readdir(dir);
    if (names.length <= maxSpillFiles) return;

    const entries = await Promise.all(names.map(async (name) => {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        return info.isFile() ? { path, mtimeMs: info.mtimeMs } : undefined;
      } catch {
        return undefined; // Raced with another prune; nothing to do.
      }
    }));

    const files = entries.filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of files.slice(0, Math.max(0, files.length - maxSpillFiles))) {
      try {
        await unlink(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.debug("Failed to prune MCP output spill file", { path: file.path, error: errorMessage(error) });
        }
      }
    }
  } catch (error) {
    logger.debug("Failed to prune MCP output spill directory", { path: dir, error: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Recordish | undefined {
  return typeof value === "object" && value !== null ? value as Recordish : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function textStats(text: string): TextStats {
  const chars = charLength(text);
  return {
    bytes: byteLength(text),
    lines: text.length === 0 ? 0 : text.split("\n").length,
    chars,
    tokens: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Characters (Unicode code points), not UTF-16 code units — an emoji is one character, not two. */
function charLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

function positiveInt(value: unknown): number | undefined {
  const count = countOrZero(value);
  return count === 0 ? undefined : count;
}

/** A non-negative count, where 0 is a meaningful "disabled" value. */
function countOrZero(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const count = Math.floor(value);
  // A fractional value below 1 is a mistake, not a request to disable the limit.
  if (count === 0 && value !== 0) return undefined;
  return count;
}

function parseCount(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
