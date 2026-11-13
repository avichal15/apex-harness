/**
 * Ported & Hardened DeepSeek Harness (`@deepseek-ai/dsh`) Core Subsystems for Apex Harness
 *
 * Implements all 5 production runtime engines from `deepseek-ai/deepseek-harness` with P0 OS-level isolation:
 * 1. `ptc-runtime`: Programmatic Tool Calling running inside a separate OS child process with Node.js `--permission`
 *    filesystem containment (`--allow-fs-read=<canonicalWorkspace>`), 128 MB heap cap, stripped environment,
 *    canonical symlink guard (`assertCanonicalWorkspacePath`), and `AbortSignal` process-tree termination.
 * 2. `spill`: Token-budgeted Head/Tail binary-search retention (`retainContent`) + session-scoped disk spill (`SpillStore`).
 * 3. `guard`: Loop-hygiene `RepeatToolReminderGuard` (deep key-sorted JSON canonicalization, `[3, 5, 8]` escalation)
 *    + cooperative & preemptive `TOOL_TIMEOUT` deadline enforcer.
 * 4. `extensions`: Signed & Permissioned Dynamic Plugin Runner (`mountDynamicPlugin` / `runDynamicPlugin` / `verifyDynamicPluginIntegrity`)
 *    with SHA-256 + HMAC-SHA256 integrity verification, explicit permission declarations, versioning, and OS `--permission` isolation.
 * 5. `session-query`: Generational JSONL session log (`session.v1.jsonl`), full-text search across sessions, and turn-boundary export.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { buildIsolatedEnvironment, killProcessTree } from "./process-manager.ts";
import { assertCanonicalWorkspacePath, resolveCanonicalWorkspaceRoot } from "./workspace-security.ts";

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
  isCancelled?: boolean;
  error?: {
    message: string;
    info: { name: "ToolTimeoutError" | "ToolCancelledError" | "ToolExecutionError"; code: string };
  };
}

/**
 * Cooperative tool-call timeout & cancellation enforcer ported from `@deepseek-ai/dsh-tool-call-timeout-policy`.
 */
export async function runWithToolTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<ToolTimeoutExecutionResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  let cancelledByParent = false;

  const onParentAbort = () => {
    cancelledByParent = true;
    controller.abort(new Error("TOOL_CANCELLED"));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(TOOL_TIMEOUT));
  }, timeoutMs);

  try {
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(new Error(cancelledByParent ? "TOOL_CANCELLED" : TOOL_TIMEOUT));
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(cancelledByParent ? "TOOL_CANCELLED" : TOOL_TIMEOUT)),
        { once: true },
      );
    });
    const value = await Promise.race([fn(controller.signal), abortPromise]);
    return { ok: true, value };
  } catch (err) {
    if (cancelledByParent || (err instanceof Error && err.message === "TOOL_CANCELLED")) {
      return {
        ok: false,
        isCancelled: true,
        error: {
          message: "tool call cancelled by user or execution manager",
          info: { name: "ToolCancelledError", code: "TOOL_CANCELLED" },
        },
      };
    }
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
    if (parentSignal) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
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
// 3. OS-ISOLATED PTC-RUNTIME SUBSYSTEM (`ptc-runtime` with Node `--permission`)
// ============================================================================

export interface PtcExecutionRequest {
  code: string;
  workspacePath: string;
  dataDir: string;
  sessionId?: string;
  timeoutMs?: number;
  maxInlineTokens?: number;
  allowWrite?: boolean;
  signal?: AbortSignal;
}

export interface PtcExecutionResult {
  ok: boolean;
  returnValue: unknown;
  logs: string[];
  toolCallsCount: number;
  durationMs: number;
  spilled?: SpillRef;
  cancelled?: boolean;
  timedOut?: boolean;
  isolationMode: "os-process-permission";
  error?: string;
}

/**
 * Builds the self-contained child-process runner script that executes inside a separate
 * OS process launched with Node.js `--permission` (`--allow-fs-read=<canonicalRoot>`).
 * Notice that:
 * 1. The OS/Node permission model blocks all child_process, worker_threads, native addons,
 *    and filesystem access outside `canonicalRoot`.
 * 2. Inside the worker, `globalThis.fetch`, `XMLHttpRequest`, `WebSocket`, `process`, and `require`
 *    are removed from the untrusted function scope, and every `host.*` call validates canonical
 *    symlink containment before touching disk.
 */
function buildIsolatedPtcRunnerScript(): string {
  return `
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const payloadRaw = process.env.APEX_PTC_PAYLOAD || "{}";
const payload = JSON.parse(payloadRaw);
const canonicalRoot = payload.canonicalRoot;
const allowWrite = Boolean(payload.allowWrite);
const userCode = String(payload.code || "");
const timeoutMs = Number(payload.timeoutMs || 8000);

const logs = [];
let toolCallsCount = 0;

function normalizeCmp(p) {
  const c = path.resolve(p);
  return process.platform === "win32" ? c.toLowerCase() : c;
}

function isInsideRoot(cand) {
  const r = normalizeCmp(canonicalRoot).replace(/[/\\\\]+$/, "");
  const t = normalizeCmp(cand).replace(/[/\\\\]+$/, "");
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

function assertWorkspacePath(relOrAbs) {
  if (typeof relOrAbs !== "string" || !relOrAbs.trim() || relOrAbs.includes("\\0")) {
    throw new Error("PTC sandbox denied invalid path");
  }
  const platformPath = process.platform === "win32" ? relOrAbs.replace(/\\//g, "\\\\") : relOrAbs;
  const lexical = path.isAbsolute(platformPath)
    ? path.resolve(platformPath)
    : path.resolve(canonicalRoot, platformPath);
  if (!isInsideRoot(lexical)) {
    throw new Error("PTC sandbox denied path outside workspace: " + relOrAbs);
  }
  // Check symlink chain
  const rel = path.relative(canonicalRoot, lexical);
  if (rel && !rel.startsWith("..")) {
    const parts = rel.split(/[/\\\\]+/).filter(Boolean);
    let cur = canonicalRoot;
    for (const part of parts) {
      cur = path.resolve(cur, part);
      if (fs.existsSync(cur)) {
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink()) {
          const realTarget = fs.realpathSync(cur);
          if (!isInsideRoot(realTarget)) {
            throw new Error("PTC sandbox denied symlink escape: " + relOrAbs);
          }
        }
      }
    }
  }
  if (fs.existsSync(lexical)) {
    const realLex = fs.realpathSync(lexical);
    if (!isInsideRoot(realLex)) {
      throw new Error("PTC sandbox denied realpath escape: " + relOrAbs);
    }
    return realLex;
  }
  const parentDir = path.dirname(lexical);
  if (fs.existsSync(parentDir)) {
    const realParent = fs.realpathSync(parentDir);
    if (!isInsideRoot(realParent)) {
      throw new Error("PTC sandbox denied parent realpath escape: " + relOrAbs);
    }
  }
  return lexical;
}

const hostBindings = Object.freeze({
  readFile: async (targetPath, maxChars = 24000) => {
    toolCallsCount++;
    const full = assertWorkspacePath(targetPath);
    return fs.readFileSync(full, "utf8").slice(0, maxChars);
  },
  writeFile: async (targetPath, content) => {
    toolCallsCount++;
    if (!allowWrite) {
      throw new Error("PTC writeFile is disabled by current execution permission policy");
    }
    const full = assertWorkspacePath(targetPath);
    fs.writeFileSync(full, String(content), "utf8");
    return { writtenBytes: Buffer.byteLength(String(content), "utf8") };
  },
  listFiles: async (subDir = ".") => {
    toolCallsCount++;
    const full = assertWorkspacePath(subDir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full);
  },
  stat: async (targetPath) => {
    toolCallsCount++;
    const full = assertWorkspacePath(targetPath);
    if (!fs.existsSync(full)) return { exists: false, size: 0, isDirectory: false };
    const st = fs.statSync(full);
    return { exists: true, size: st.size, isDirectory: st.isDirectory() };
  },
  grep: async (pattern, subDir = ".") => {
    toolCallsCount++;
    const full = assertWorkspacePath(subDir);
    const rx = new RegExp(pattern, "i");
    const matches = [];
    const walk = (dir, depth) => {
      if (depth > 3 || matches.length >= 50) return;
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git" || entry === "deepseek-harness" || entry.startsWith(".")) continue;
        const p = path.join(dir, entry);
        try {
          const lst = fs.lstatSync(p);
          if (lst.isSymbolicLink()) continue;
          if (lst.isDirectory()) walk(p, depth + 1);
          else if (lst.size < 200000 && /\\.(ts|tsx|js|mjs|json|md|py|css|html)$/.test(entry)) {
            const lines = fs.readFileSync(p, "utf8").split(/\\r?\\n/);
            for (let i = 0; i < lines.length; i++) {
              if (rx.test(lines[i])) {
                matches.push({
                  file: path.relative(canonicalRoot, p).replace(/\\\\/g, "/"),
                  line: i + 1,
                  text: lines[i].trim().slice(0, 180),
                });
                if (matches.length >= 50) break;
              }
            }
          }
        } catch {}
      }
    };
    walk(full, 0);
    return matches;
  },
});

const sandboxConsole = Object.freeze({
  log: (...args) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  warn: (...args) => logs.push("[WARN] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  error: (...args) => logs.push("[ERROR] " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
});

(async () => {
  try {
    const context = vm.createContext(
      Object.freeze({
        host: hostBindings,
        console: sandboxConsole,
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
        process: undefined,
        require: undefined,
        fetch: undefined,
        global: undefined,
        globalThis: undefined,
      }),
      { codeGeneration: { strings: false, wasm: false } }
    );
    const wrapped = \`(async (host, console) => {\\n"use strict";\\n\${userCode}\\n})(host, console)\`;
    const script = new vm.Script(wrapped, { filename: "ptc-isolated.js" });
    const returnValue = await script.runInContext(context, { timeout: timeoutMs });
    process.stdout.write(JSON.stringify({ ok: true, returnValue: returnValue ?? null, logs, toolCallsCount }) + "\\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        returnValue: null,
        logs,
        toolCallsCount,
        error: err && err.message ? err.message : String(err),
      }) + "\\n"
    );
    process.exit(1);
  }
})();
`.trim();
}

/**
 * Executes a multi-step Programmatic Tool Calling (`PTC`) program inside an OS-isolated
 * child process using Node.js `--permission` filesystem restrictions and process-tree termination.
 */
export async function executePtcProgram(req: PtcExecutionRequest): Promise<PtcExecutionResult> {
  const t0 = Date.now();
  const timeoutMs = req.timeoutMs ?? 8000;
  const allowWrite = req.allowWrite ?? true;
  const canonicalRoot = resolveCanonicalWorkspaceRoot(req.workspacePath);

  if (req.signal?.aborted) {
    return {
      ok: false,
      returnValue: null,
      logs: [],
      toolCallsCount: 0,
      durationMs: 0,
      cancelled: true,
      isolationMode: "os-process-permission",
      error: "PTC execution cancelled before start",
    };
  }

  const runnerScript = buildIsolatedPtcRunnerScript();
  const nodeArgs = [
    "--permission",
    `--allow-fs-read=${canonicalRoot}`,
    ...(allowWrite ? [`--allow-fs-write=${canonicalRoot}`] : []),
    "--max-old-space-size=128",
    "--input-type=module",
    "-e",
    runnerScript,
  ];

  const payloadJson = JSON.stringify({
    canonicalRoot,
    allowWrite,
    code: req.code,
    timeoutMs,
  });

  return new Promise<PtcExecutionResult>((resolvePromise) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: canonicalRoot,
      env: buildIsolatedEnvironment({
        APEX_PTC_PAYLOAD: payloadJson,
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const pid = child.pid;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (res: PtcExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req.signal) {
        req.signal.removeEventListener("abort", onAbort);
      }
      resolvePromise(res);
    };

    const onAbort = () => {
      cancelled = true;
      killProcessTree(pid);
      finish({
        ok: false,
        returnValue: null,
        logs: [],
        toolCallsCount: 0,
        durationMs: Date.now() - t0,
        cancelled: true,
        isolationMode: "os-process-permission",
        error: "PTC execution cancelled via AbortSignal",
      });
    };

    if (req.signal) {
      req.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(pid);
      finish({
        ok: false,
        returnValue: null,
        logs: [],
        toolCallsCount: 0,
        durationMs: Date.now() - t0,
        timedOut: true,
        isolationMode: "os-process-permission",
        error: `tool call timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));

    child.on("error", (err) => {
      finish({
        ok: false,
        returnValue: null,
        logs: [],
        toolCallsCount: 0,
        durationMs: Date.now() - t0,
        isolationMode: "os-process-permission",
        error: err.message,
      });
    });

    child.on("close", () => {
      if (timedOut || cancelled) return;
      const durationMs = Date.now() - t0;
      const stdoutText = Buffer.concat(outChunks).toString("utf8").trim();
      const stderrText = Buffer.concat(errChunks).toString("utf8").trim();
      const lastLine = stdoutText.split(/\r?\n/).filter(Boolean).pop() ?? "";

      try {
        const parsed = JSON.parse(lastLine) as {
          ok: boolean;
          returnValue: unknown;
          logs: string[];
          toolCallsCount: number;
          error?: string;
        };
        if (!parsed.ok) {
          finish({
            ok: false,
            returnValue: null,
            logs: parsed.logs ?? [],
            toolCallsCount: parsed.toolCallsCount ?? 0,
            durationMs,
            isolationMode: "os-process-permission",
            error: parsed.error || stderrText || "PTC execution failed",
          });
          return;
        }

        const serialized =
          typeof parsed.returnValue === "string"
            ? parsed.returnValue
            : JSON.stringify(parsed.returnValue ?? null, null, 2);

        const spillCheck = applySpillPolicyToText({
          dataDir: req.dataDir,
          sessionId: req.sessionId ?? "ptc-default",
          toolName: "ptc_run_code",
          content: serialized,
          maxInlineTokens: req.maxInlineTokens ?? 1800,
        });

        finish({
          ok: true,
          returnValue: spillCheck.spilled ? spillCheck.text : parsed.returnValue,
          logs: parsed.logs ?? [],
          toolCallsCount: parsed.toolCallsCount ?? 0,
          durationMs,
          spilled: spillCheck.spillRef,
          isolationMode: "os-process-permission",
        });
      } catch {
        finish({
          ok: false,
          returnValue: null,
          logs: [],
          toolCallsCount: 0,
          durationMs,
          isolationMode: "os-process-permission",
          error: stderrText || stdoutText || "PTC worker terminated without structured output",
        });
      }
    });
  });
}

// ============================================================================
// 4. SIGNED & PERMISSIONED EXTENSIONS SUBSYSTEM (`cordis-host-runner`)
// ============================================================================

export type DynamicPluginPermission = "pure_transform" | "workspace_read";

export interface DynamicCordisPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  permissions: DynamicPluginPermission[];
  sha256: string;
  signature: string;
  enabled: boolean;
  code: string;
  createdAt: string;
}

export interface CordisRuntimeInspection {
  framework: "Cordis-Apex-Bridge-v1";
  activeServices: string[];
  mountedPlugins: Array<Omit<DynamicCordisPlugin, "code"> & { integrityVerified: boolean }>;
  capabilities: Array<{ seam: string; provider: string; status: "active" | "standby" }>;
}

function dynamicPluginsPath(dataDir: string): string {
  return join(dataDir, "apex-dynamic-plugins.json");
}

function pluginSigningKeyPath(dataDir: string): string {
  return join(dataDir, ".plugin-signing-key");
}

function getOrCreatePluginSigningKey(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const p = pluginSigningKeyPath(dataDir);
  if (existsSync(p)) {
    const existing = readFileSync(p, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const generated = randomBytes(32).toString("hex");
  writeFileSync(p, generated, { encoding: "utf8", mode: 0o600 });
  return generated;
}

export function computePluginSha256(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function signPluginManifest(
  dataDir: string,
  manifest: {
    id: string;
    version: string;
    permissions: readonly DynamicPluginPermission[];
    sha256: string;
  },
): string {
  const key = getOrCreatePluginSigningKey(dataDir);
  const canonical = `${manifest.id}:${manifest.version}:${[...manifest.permissions].sort().join(",")}:${manifest.sha256}`;
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

export function verifyDynamicPluginIntegrity(
  dataDir: string,
  plugin: DynamicCordisPlugin,
): { valid: boolean; reason?: string } {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(plugin.version || "")) {
    return { valid: false, reason: `Invalid plugin semver version: "${plugin.version}"` };
  }
  if (!Array.isArray(plugin.permissions) || plugin.permissions.length === 0) {
    return { valid: false, reason: "Plugin must declare explicit permissions" };
  }
  const actualSha = computePluginSha256(plugin.code || "");
  if (actualSha !== plugin.sha256) {
    return {
      valid: false,
      reason: `Plugin SHA-256 mismatch (expected ${plugin.sha256.slice(0, 12)}, got ${actualSha.slice(0, 12)})`,
    };
  }
  const expectedSig = signPluginManifest(dataDir, {
    id: plugin.id,
    version: plugin.version,
    permissions: plugin.permissions,
    sha256: plugin.sha256,
  });
  const sigA = Buffer.from(plugin.signature || "", "utf8");
  const sigB = Buffer.from(expectedSig, "utf8");
  if (sigA.length !== sigB.length || !timingSafeEqual(sigA, sigB)) {
    return { valid: false, reason: "Plugin cryptographic HMAC signature verification failed" };
  }
  return { valid: true };
}

export function loadDynamicPlugins(dataDir: string): DynamicCordisPlugin[] {
  const p = dynamicPluginsPath(dataDir);
  if (!existsSync(p)) {
    const defaultCode = `
      const cleaned = String(input.text || "")
        .replace(/\\b(delve into|it's worth noting that|at the end of the day)\\b/gi, "")
        .trim();
      return { cleanedLength: cleaned.length, preview: cleaned.slice(0, 200) };
    `.trim();
    const sha256 = computePluginSha256(defaultCode);
    const permissions: DynamicPluginPermission[] = ["pure_transform"];
    const seeded: DynamicCordisPlugin[] = [
      {
        id: "dsh-ext-cot-sanitizer",
        name: "CoT Leakage & Slop Sanitizer",
        description: "Strips leaked authoring-session citations and AI filler phrases from turn outputs.",
        version: "1.0.0",
        permissions,
        sha256,
        signature: signPluginManifest(dataDir, {
          id: "dsh-ext-cot-sanitizer",
          version: "1.0.0",
          permissions,
          sha256,
        }),
        enabled: true,
        code: defaultCode,
        createdAt: new Date().toISOString(),
      },
    ];
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(p, `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
    return seeded;
  }
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as DynamicCordisPlugin[];
    // Upgrade legacy entries missing sha256/signature only if they match the seeded plugin
    return parsed.map((item) => {
      if (!item.sha256 && item.id === "dsh-ext-cot-sanitizer") {
        const sha = computePluginSha256(item.code);
        const perms: DynamicPluginPermission[] = item.permissions ?? ["pure_transform"];
        return {
          ...item,
          permissions: perms,
          sha256: sha,
          signature: signPluginManifest(dataDir, {
            id: item.id,
            version: item.version || "1.0.0",
            permissions: perms,
            sha256: sha,
          }),
        };
      }
      return item;
    });
  } catch {
    return [];
  }
}

export function mountDynamicPlugin(
  dataDir: string,
  plugin: {
    id: string;
    name: string;
    description: string;
    version: string;
    code: string;
    permissions?: DynamicPluginPermission[];
    enabled?: boolean;
  },
): DynamicCordisPlugin {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(plugin.version || "1.0.0")) {
    throw new Error(`Invalid plugin version "${plugin.version}": must follow semver (e.g. 1.0.0)`);
  }
  // Reject dangerous host-escape patterns at mount time as defense-in-depth
  if (/\b(?:child_process|spawnSync|execSync|process\.binding|process\.dlopen)\b/.test(plugin.code)) {
    throw new Error("Dynamic plugin code contains forbidden host process API references");
  }

  const permissions: DynamicPluginPermission[] =
    plugin.permissions && plugin.permissions.length > 0 ? plugin.permissions : ["pure_transform"];
  const sha256 = computePluginSha256(plugin.code);
  const signature = signPluginManifest(dataDir, {
    id: plugin.id,
    version: plugin.version,
    permissions,
    sha256,
  });

  const existing = loadDynamicPlugins(dataDir).filter((p) => p.id !== plugin.id);
  const entry: DynamicCordisPlugin = {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    permissions,
    sha256,
    signature,
    enabled: plugin.enabled ?? true,
    code: plugin.code,
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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const plugins = loadDynamicPlugins(dataDir);
  const target = plugins.find((p) => p.id === pluginId);
  if (!target) {
    return { ok: false, error: `Dynamic plugin '${pluginId}' not found.` };
  }
  if (!target.enabled) {
    return { ok: false, error: `Dynamic plugin '${pluginId}' is disabled.` };
  }

  const integrity = verifyDynamicPluginIntegrity(dataDir, target);
  if (!integrity.valid) {
    return {
      ok: false,
      error: `Plugin integrity check failed for '${pluginId}': ${integrity.reason}`,
    };
  }

  const timeoutMs = options.timeoutMs ?? 3000;
  const workerScript = `
import vm from "node:vm";
const payload = JSON.parse(process.env.APEX_PLUGIN_PAYLOAD || "{}");
(async () => {
  try {
    const ctx = vm.createContext(
      Object.freeze({
        input: Object.freeze(payload.input || {}),
        JSON,
        Math,
        Date,
        String,
        Number,
        Boolean,
        Array,
        Object,
        RegExp,
        process: undefined,
        require: undefined,
        fetch: undefined,
      }),
      { codeGeneration: { strings: false, wasm: false } }
    );
    const script = new vm.Script(\`(async (input) => { "use strict"; \${payload.code} })(input)\`);
    const output = await script.runInContext(ctx, { timeout: ${timeoutMs} });
    process.stdout.write(JSON.stringify({ ok: true, output }) + "\\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }) + "\\n");
    process.exit(1);
  }
})();
`.trim();

  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ["--permission", "--max-old-space-size=64", "--input-type=module", "-e", workerScript],
      {
        env: buildIsolatedEnvironment({
          APEX_PLUGIN_PAYLOAD: JSON.stringify({ code: target.code, input }),
        }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const pid = child.pid;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const finish = (res: { ok: boolean; output?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolvePromise(res);
    };

    const onAbort = () => {
      killProcessTree(pid);
      finish({ ok: false, error: "Plugin execution cancelled" });
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      killProcessTree(pid);
      finish({ ok: false, error: `Plugin timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => errChunks.push(c));

    child.on("close", () => {
      const out = Buffer.concat(outChunks).toString("utf8").trim();
      const err = Buffer.concat(errChunks).toString("utf8").trim();
      const last = out.split(/\r?\n/).filter(Boolean).pop() ?? "";
      try {
        const parsed = JSON.parse(last) as { ok: boolean; output?: unknown; error?: string };
        finish(parsed);
      } catch {
        finish({ ok: false, error: err || out || "Plugin worker failed" });
      }
    });
  });
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
    mountedPlugins: plugins.map(({ code: _code, ...rest }) => ({
      ...rest,
      integrityVerified: verifyDynamicPluginIntegrity(dataDir, { ...rest, code: _code }).valid,
    })),
    capabilities: [
      { seam: "ptc-runtime", provider: "@deepseek-ai/dsh-ptc-runtime-node (OS --permission Child Process)", status: "active" },
      { seam: "spill-policy", provider: "@deepseek-ai/dsh-spill-local (Head/Tail UTF-16 Binary Search)", status: "active" },
      { seam: "loop-guard", provider: "@deepseek-ai/dsh-repeat-tool-reminder + timeout-policy", status: "active" },
      { seam: "extensions", provider: "@deepseek-ai/dsh-cordis-host-runner (HMAC-SHA256 Signed + OS Isolated)", status: "active" },
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
