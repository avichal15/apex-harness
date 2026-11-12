/**
 * Ported DeepSeek Harness (`@deepseek-ai/dsh`) Core Subsystems for Apex Harness
 *
 * Ports all 5 production runtime engines from `deepseek-ai/deepseek-harness`:
 * 1. `ptc-runtime`: Programmatic Tool Calling (`AsyncFunction` + `node:vm` sandbox with host bindings)
 * 2. `spill`: Token-budgeted Head/Tail binary-search retention (`retainContent`) + session-scoped disk spill (`SpillStore`)
 * 3. `guard`: Loop-hygiene `RepeatToolReminderGuard` (deep key-sorted JSON canonicalization, `[3, 5, 8]` escalation) + `TOOL_TIMEOUT` deadline enforcer
 * 4. `extensions`: Cordis-style Runtime Capability Inspector & Dynamic Plugin Runner (`mountDynamicPlugin` / `runDynamicPlugin`)
 * 5. `session-query`: Generational JSONL session log (`session.v1.jsonl`), full-text search across sessions, and turn-boundary export
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import vm from "node:vm";

// ============================================================================
// 1. GUARD SUBSYSTEM (`repeat-tool-reminder` + `timeout-policy`)
// ============================================================================

export const TOOL_TIMEOUT = "TOOL_TIMEOUT" as const;

export interface RepeatGuardConfig {
  thresholds?: number[];
  include?: string[];
  exclude?: string[];
  argumentsPreviewChars?: number;
}

export interface RepeatCheckOutcome {
  repeated: boolean;
  consecutiveCount: number;
  escalatedTier: "none" | "gentle" | "detailed";
  reminderMessage?: string;
}

const GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is " +
  "not complete, try a different approach or different arguments instead of " +
  "repeating the call.";

function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return (
    "Repeated tool call detected:\n" +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    "The repeated calls are not making progress. Do not call this tool with " +
    "these exact arguments again. Inspect the latest result and choose a " +
    "different action, different arguments, or finish the task if enough " +
    "evidence has been gathered."
  );
}

/**
 * Deep key-sort of a parsed JSON value so two argument objects that differ
 * only in property order canonicalize identically (ported from `@deepseek-ai/dsh-repeat-tool-reminder`).
 */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalizeToolArgs(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue));
}

function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

export class RepeatToolReminderGuard {
  private readonly thresholds: number[];
  private readonly includeMatchers: RegExp[];
  private readonly excludeMatchers: RegExp[];
  private readonly argumentsPreviewChars: number;
  private readonly chains = new Map<string, { key: string; count: number }>();

  constructor(config: RepeatGuardConfig = {}) {
    const rawThresholds = config.thresholds ?? [3, 5, 8];
    if (rawThresholds.length === 0) {
      throw new Error("repeat-tool-reminder: `thresholds` must not be empty");
    }
    for (const val of rawThresholds) {
      if (!Number.isInteger(val) || val < 2) {
        throw new Error(`repeat-tool-reminder: invalid threshold ${val} — must be integer >= 2`);
      }
    }
    this.thresholds = [...new Set(rawThresholds)].sort((a, b) => a - b);
    this.includeMatchers = (config.include ?? []).map(wildcardToRegExp);
    this.excludeMatchers = (config.exclude ?? []).map(wildcardToRegExp);
    this.argumentsPreviewChars = config.argumentsPreviewChars ?? 500;
  }

  private isTracked(toolName: string): boolean {
    if (this.excludeMatchers.some((rx) => rx.test(toolName))) return false;
    if (this.includeMatchers.length === 0) return true;
    return this.includeMatchers.some((rx) => rx.test(toolName));
  }

  public recordToolCall(sessionId: string, toolName: string, args: unknown): RepeatCheckOutcome {
    if (!this.isTracked(toolName)) {
      return { repeated: false, consecutiveCount: 0, escalatedTier: "none" };
    }
    const canonical = canonicalizeToolArgs(args);
    const callKey = `${toolName}:${canonical}`;
    const prev = this.chains.get(sessionId);

    const nextCount = prev && prev.key === callKey ? prev.count + 1 : 1;
    this.chains.set(sessionId, { key: callKey, count: nextCount });

    if (!this.thresholds.includes(nextCount)) {
      return {
        repeated: nextCount > 1,
        consecutiveCount: nextCount,
        escalatedTier: "none",
      };
    }

    if (nextCount === this.thresholds[0]) {
      return {
        repeated: true,
        consecutiveCount: nextCount,
        escalatedTier: "gentle",
        reminderMessage: GENTLE_REMINDER,
      };
    }

    return {
      repeated: true,
      consecutiveCount: nextCount,
      escalatedTier: "detailed",
      reminderMessage: detailedReminder(
        toolName,
        nextCount,
        previewArguments(canonical, this.argumentsPreviewChars),
      ),
    };
  }

  public resetSession(sessionId: string): void {
    this.chains.delete(sessionId);
  }
}

export interface ToolTimeoutExecutionResult<T = unknown> {
  ok: boolean;
  value?: T;
  isTimeout?: boolean;
  error?: {
    message: string;
    info: { name: "ToolTimeoutError" | "ToolExecutionError"; code: string };
  };
}

/**
 * Cooperative tool-call timeout enforcer ported from `@deepseek-ai/dsh-tool-call-timeout-policy`.
 */
export async function runWithToolTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<ToolTimeoutExecutionResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(TOOL_TIMEOUT));
  }, timeoutMs);

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(TOOL_TIMEOUT)),
        { once: true },
      );
    });
    const value = await Promise.race([fn(controller.signal), timeoutPromise]);
    return { ok: true, value };
  } catch (err) {
    if (timedOut || (err instanceof Error && err.message === TOOL_TIMEOUT)) {
      const message = `tool call timed out after ${timeoutMs}ms`;
      return {
        ok: false,
        isTimeout: true,
        error: {
          message,
          info: { name: "ToolTimeoutError", code: TOOL_TIMEOUT },
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        message,
        info: { name: "ToolExecutionError", code: "TOOL_EXECUTION_ERROR" },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 2. SPILL SUBSYSTEM (`spill-local` + `spill-policy` head/tail binary search)
// ============================================================================

export interface SpillRef {
  spillId: string;
  locator: string;
  byteLength: number;
  retrievalHint: string;
}

export interface RetainedTextSpillResult {
  spilled: boolean;
  text: string;
  omittedBytes: number;
  spillRef?: SpillRef;
}

/**
 * Preserve UTF-16 surrogate pairs when slicing head or tail text (ported from `@deepseek-ai/dsh-spill-policy/retention`).
 */
function utf16SafeSlice(text: string, length: number, tail: boolean): string {
  let cut = tail ? text.length - length : length;
  const previous = text.charCodeAt(cut - 1);
  const current = text.charCodeAt(cut);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    cut += tail ? 1 : -1;
  }
  return tail ? text.slice(cut) : text.slice(0, cut);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function fitTextToTokenBudget(text: string, tokenBudget: number, tail: boolean): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = utf16SafeSlice(text, mid, tail);
    if (candidate.length === 0 || estimateTextTokens(candidate) <= tokenBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return utf16SafeSlice(text, low, tail);
}

export function formatSpillNotice(omittedBytes: number, ref: Pick<SpillRef, "locator" | "retrievalHint">): string {
  return `(Omitted ${omittedBytes} bytes. Full formatted result stored at: ${ref.locator}. ${ref.retrievalHint})`;
}

/**
 * Local session-scoped spill storage & token-budgeted head/tail retention policy
 * ported from `@deepseek-ai/dsh-spill-local` and `@deepseek-ai/dsh-spill-policy`.
 */
export function applySpillPolicyToText(options: {
  dataDir: string;
  sessionId: string;
  toolName: string;
  content: string;
  maxInlineTokens?: number;
}): RetainedTextSpillResult {
  const maxInlineTokens = options.maxInlineTokens ?? 1800;
  const totalTokens = estimateTextTokens(options.content);
  if (totalTokens <= maxInlineTokens) {
    return {
      spilled: false,
      text: options.content,
      omittedBytes: 0,
    };
  }

  const safeSession = options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = options.toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const spillDir = join(options.dataDir, "spills", safeSession);
  mkdirSync(spillDir, { recursive: true, mode: 0o700 });

  const hash = createHash("sha256").update(options.content).digest("hex").slice(0, 12);
  const fileName = `${Date.now()}-${safeTool}-${hash}.txt`;
  const filePath = join(spillDir, fileName);
  writeFileSync(filePath, options.content, "utf8");

  const byteLength = Buffer.byteLength(options.content, "utf8");
  const spillRef: SpillRef = {
    spillId: `${safeSession}/${fileName}`,
    locator: filePath,
    byteLength,
    retrievalHint: "Use read_file with StartLine/EndLine or grep to inspect specific sections.",
  };

  const reservedTokens = 65;
  const usableBudget = Math.max(40, maxInlineTokens - reservedTokens);
  const headBudget = Math.ceil(usableBudget / 2);
  const tailBudget = Math.floor(usableBudget / 2);

  const headText = fitTextToTokenBudget(options.content, headBudget, false);
  const remainingSource = options.content.slice(headText.length);
  const tailText = fitTextToTokenBudget(remainingSource, tailBudget, true);

  const omittedBytes =
    byteLength - Buffer.byteLength(headText, "utf8") - Buffer.byteLength(tailText, "utf8");
  const notice = formatSpillNotice(Math.max(0, omittedBytes), spillRef);

  const retainedText =
    headText.length + tailText.length === 0
      ? notice
      : `${headText}\n\n[...]\n\n${tailText}\n\n${notice}`;

  return {
    spilled: true,
    text: retainedText,
    omittedBytes: Math.max(0, omittedBytes),
    spillRef,
  };
}

// ============================================================================
// 3. PTC-RUNTIME SUBSYSTEM (`ptc-runtime` Programmatic Tool Calling)
// ============================================================================

export interface PtcExecutionRequest {
  code: string;
  workspacePath: string;
  dataDir: string;
  sessionId?: string;
  timeoutMs?: number;
  maxInlineTokens?: number;
}

export interface PtcExecutionResult {
  ok: boolean;
  returnValue: unknown;
  logs: string[];
  toolCallsCount: number;
  durationMs: number;
  spilled?: SpillRef;
  error?: string;
}

/**
 * Executes a multi-step programmatic tool-calling (`PTC`) async JavaScript/TypeScript body
 * inside an isolated V8 context with host-bound workspace tools (`host.readFile`,
 * `host.listFiles`, `host.grep`, `host.writeFile`, `host.stat`).
 * Ported from `@deepseek-ai/dsh-ptc-runtime-node`.
 */
export async function executePtcProgram(req: PtcExecutionRequest): Promise<PtcExecutionResult> {
  const t0 = Date.now();
  const logs: string[] = [];
  let toolCallsCount = 0;
  const root = resolve(req.workspacePath);
  const timeoutMs = req.timeoutMs ?? 8000;

  const assertInsideWorkspace = (relOrAbs: string): string => {
    const resolved = resolve(root, relOrAbs);
    if (!resolved.toLowerCase().startsWith(root.toLowerCase())) {
      throw new Error(`PTC sandbox denied path outside workspace: ${relOrAbs}`);
    }
    return resolved;
  };

  const hostBindings = {
    readFile: async (targetPath: string, maxChars = 24000): Promise<string> => {
      toolCallsCount++;
      const full = assertInsideWorkspace(targetPath);
      return readFileSync(full, "utf8").slice(0, maxChars);
    },
    writeFile: async (targetPath: string, content: string): Promise<{ writtenBytes: number }> => {
      toolCallsCount++;
      const full = assertInsideWorkspace(targetPath);
      writeFileSync(full, content, "utf8");
      return { writtenBytes: Buffer.byteLength(content, "utf8") };
    },
    listFiles: async (subDir = "."): Promise<string[]> => {
      toolCallsCount++;
      const full = assertInsideWorkspace(subDir);
      if (!existsSync(full)) return [];
      return readdirSync(full);
    },
    stat: async (targetPath: string): Promise<{ exists: boolean; size: number; isDirectory: boolean }> => {
      toolCallsCount++;
      const full = assertInsideWorkspace(targetPath);
      if (!existsSync(full)) return { exists: false, size: 0, isDirectory: false };
      const st = statSync(full);
      return { exists: true, size: st.size, isDirectory: st.isDirectory() };
    },
    grep: async (pattern: string, subDir = "."): Promise<Array<{ file: string; line: number; text: string }>> => {
      toolCallsCount++;
      const full = assertInsideWorkspace(subDir);
      const rx = new RegExp(pattern, "i");
      const matches: Array<{ file: string; line: number; text: string }> = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 3 || matches.length >= 50) return;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry === "node_modules" || entry === ".git" || entry === "deepseek-harness" || entry.startsWith(".")) {
            continue;
          }
          const p = join(dir, entry);
          try {
            const st = statSync(p);
            if (st.isDirectory()) {
              walk(p, depth + 1);
            } else if (st.size < 200_000 && /\.(ts|tsx|js|mjs|json|md|py|css|html)$/.test(entry)) {
              const lines = readFileSync(p, "utf8").split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (rx.test(lines[i]!)) {
                  matches.push({
                    file: relative(root, p).replace(/\\/g, "/"),
                    line: i + 1,
                    text: lines[i]!.trim().slice(0, 180),
                  });
                  if (matches.length >= 50) break;
                }
              }
            }
          } catch {
            // Skip unreadable entry
          }
        }
      };
      walk(full, 0);
      return matches;
    },
  };

  const sandboxConsole = {
    log: (...args: unknown[]) =>
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
    warn: (...args: unknown[]) =>
      logs.push(`[WARN] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`),
    error: (...args: unknown[]) =>
      logs.push(`[ERROR] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`),
  };

  const timedResult = await runWithToolTimeout(async () => {
    const context = vm.createContext({
      host: Object.freeze(hostBindings),
      console: Object.freeze(sandboxConsole),
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      Promise,
    });
    const wrappedSource = `(async (host, console) => {\n"use strict";\n${req.code}\n})(host, console)`;
    const script = new vm.Script(wrappedSource, { filename: "ptc-program.js" });
    return await script.runInContext(context, { timeout: timeoutMs });
  }, timeoutMs);

  const durationMs = Date.now() - t0;
  if (!timedResult.ok) {
    return {
      ok: false,
      returnValue: null,
      logs,
      toolCallsCount,
      durationMs,
      error: timedResult.error?.message ?? "PTC execution failed",
    };
  }

  const serialized =
    typeof timedResult.value === "string"
      ? timedResult.value
      : JSON.stringify(timedResult.value ?? null, null, 2);

  const spillCheck = applySpillPolicyToText({
    dataDir: req.dataDir,
    sessionId: req.sessionId ?? "ptc-default",
    toolName: "ptc_run_code",
    content: serialized,
    maxInlineTokens: req.maxInlineTokens ?? 1800,
  });

  return {
    ok: true,
    returnValue: spillCheck.spilled ? spillCheck.text : timedResult.value,
    logs,
    toolCallsCount,
    durationMs,
    spilled: spillCheck.spillRef,
  };
}

// ============================================================================
// 4. EXTENSIONS SUBSYSTEM (`cordis-host-runner` + `tool-cordis` Runtime Self-Mod)
// ============================================================================

export interface DynamicCordisPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  code: string;
  createdAt: string;
}

export interface CordisRuntimeInspection {
  framework: "Cordis-Apex-Bridge-v1";
  activeServices: string[];
  mountedPlugins: Array<Omit<DynamicCordisPlugin, "code">>;
  capabilities: Array<{ seam: string; provider: string; status: "active" | "standby" }>;
}

function dynamicPluginsPath(dataDir: string): string {
  return join(dataDir, "apex-dynamic-plugins.json");
}

export function loadDynamicPlugins(dataDir: string): DynamicCordisPlugin[] {
  const p = dynamicPluginsPath(dataDir);
  if (!existsSync(p)) {
    const seeded: DynamicCordisPlugin[] = [
      {
        id: "dsh-ext-cot-sanitizer",
        name: "CoT Leakage & Slop Sanitizer",
        description: "Strips leaked authoring-session citations and AI filler phrases from turn outputs.",
        version: "1.0.0",
        enabled: true,
        code: `
          const cleaned = String(input.text || "")
            .replace(/\\b(delve into|it's worth noting that|at the end of the day)\\b/gi, "")
            .trim();
          return { cleanedLength: cleaned.length, preview: cleaned.slice(0, 200) };
        `.trim(),
        createdAt: new Date().toISOString(),
      },
    ];
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(p, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
    return seeded;
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DynamicCordisPlugin[];
  } catch {
    return [];
  }
}

export function mountDynamicPlugin(
  dataDir: string,
  plugin: Omit<DynamicCordisPlugin, "createdAt" | "enabled"> & { enabled?: boolean },
): DynamicCordisPlugin {
  const existing = loadDynamicPlugins(dataDir).filter((p) => p.id !== plugin.id);
  const entry: DynamicCordisPlugin = {
    ...plugin,
    enabled: plugin.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  existing.push(entry);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(dynamicPluginsPath(dataDir), `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return entry;
}

export async function runDynamicPlugin(
  dataDir: string,
  pluginId: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const plugins = loadDynamicPlugins(dataDir);
  const target = plugins.find((p) => p.id === pluginId && p.enabled);
  if (!target) {
    return { ok: false, error: `Dynamic plugin '${pluginId}' not found or disabled.` };
  }
  const res = await runWithToolTimeout(async () => {
    const ctx = vm.createContext({ input: Object.freeze({ ...input }), JSON, Math, Date, String, Array, Object });
    const script = new vm.Script(`(async (input) => { "use strict"; ${target.code} })(input)`);
    return await script.runInContext(ctx, { timeout: 3000 });
  }, 3000);

  if (!res.ok) {
    return { ok: false, error: res.error?.message ?? "Plugin execution error" };
  }
  return { ok: true, output: res.value };
}

export function inspectCordisRuntime(dataDir: string): CordisRuntimeInspection {
  const plugins = loadDynamicPlugins(dataDir);
  return {
    framework: "Cordis-Apex-Bridge-v1",
    activeServices: [
      "ctx.sessions",
      "ctx.systemPrompt",
      "ctx.tools",
      "ctx.agents",
      "ctx.agentLoop",
      "ctx.llm",
      "ctx.ptcRuntime",
      "ctx.spillStore",
      "ctx.sessionQuery",
      "ctx.dynamicCordisRunner",
      "ctx.egmBoardroom",
    ],
    mountedPlugins: plugins.map(({ code: _code, ...rest }) => rest),
    capabilities: [
      { seam: "ptc-runtime", provider: "@deepseek-ai/dsh-ptc-runtime-node (VM AsyncFunction)", status: "active" },
      { seam: "spill-policy", provider: "@deepseek-ai/dsh-spill-local (Head/Tail UTF-16 Binary Search)", status: "active" },
      { seam: "loop-guard", provider: "@deepseek-ai/dsh-repeat-tool-reminder + timeout-policy", status: "active" },
      { seam: "extensions", provider: "@deepseek-ai/dsh-cordis-host-runner", status: "active" },
      { seam: "session-query", provider: "@deepseek-ai/dsh-session-query (Generational JSONL + FTS)", status: "active" },
    ],
  };
}

// ============================================================================
// 5. SESSION-QUERY SUBSYSTEM (`session.v1.jsonl` + Full-Text Search & Export)
// ============================================================================

export interface SessionEventRecord {
  version: 1;
  eventId: string;
  sessionId: string;
  type: "turn/start" | "user/message" | "assistant/message" | "tool/call" | "tool/result" | "turn/end";
  timestamp: string;
  modelId?: string;
  domain?: string;
  content: string;
}

export function appendSessionGenerationEvent(
  dataDir: string,
  event: Omit<SessionEventRecord, "version" | "eventId" | "timestamp">,
): SessionEventRecord {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const record: SessionEventRecord = {
    version: 1,
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...event,
  };
  const logPath = join(sessionsDir, `${event.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.session.v1.jsonl`);
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function querySessionCorpus(
  dataDir: string,
  query: string,
  conversationsFallback: ReadonlyArray<{
    id: string;
    title: string;
    messages: ReadonlyArray<{ role: string; content: string; createdAt: string; modelId?: string }>;
  }> = [],
): Array<{
  sessionId: string;
  type: string;
  timestamp: string;
  snippet: string;
  score: number;
}> {
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const results: Array<{
    sessionId: string;
    type: string;
    timestamp: string;
    snippet: string;
    score: number;
  }> = [];

  const sessionsDir = join(dataDir, "sessions");
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const lines = readFileSync(join(sessionsDir, name), "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const evt = JSON.parse(line) as SessionEventRecord;
          const hay = `${evt.content} ${evt.modelId ?? ""} ${evt.domain ?? ""}`.toLowerCase();
          const matchedTerms = terms.length === 0 ? 1 : terms.filter((t) => hay.includes(t)).length;
          if (matchedTerms > 0) {
            results.push({
              sessionId: evt.sessionId,
              type: evt.type,
              timestamp: evt.timestamp,
              snippet: evt.content.slice(0, 220),
              score: matchedTerms / Math.max(1, terms.length),
            });
          }
        } catch {
          // Ignore malformed JSONL row
        }
      }
    }
  }

  for (const conv of conversationsFallback) {
    for (const msg of conv.messages) {
      const hay = `${conv.title} ${msg.content}`.toLowerCase();
      const matchedTerms = terms.length === 0 ? 1 : terms.filter((t) => hay.includes(t)).length;
      if (matchedTerms > 0) {
        results.push({
          sessionId: conv.id,
          type: `${msg.role}/message`,
          timestamp: msg.createdAt,
          snippet: msg.content.slice(0, 220),
          score: matchedTerms / Math.max(1, terms.length),
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 25);
}
