// Real Multi-Gateway LLM & Agentic Tool-Loop Engine for the Apex Harness App.
// Enforces:
// - Canonical workspace containment (`assertCanonicalWorkspacePath` against ../, absolute paths, sibling prefixes, and symlinks)
// - Asynchronous managed command execution (`runManagedCommand` with process-tree kill, timeouts, AbortSignal, and permission policy)
// - End-to-end AbortSignal propagation across HTTP provider calls, CLI fallbacks, shell commands, and MCP calls
// - Detailed execution evidence tracking (`filesInspected`, `filesCreated`, `filesModified`, `commandsExecuted`, `toolsInvoked`)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { AgentOfficeRole, ExecutedCommandEvidence } from "../shared/apex-contracts.ts";
import { callMcpServerTool } from "./harness/mcp-client-bridge.ts";
import { killProcessTree, runManagedCommand } from "./harness/process-manager.ts";
import {
  AnthropicMessagesProtocolAdapter,
  GeminiProtocolAdapter,
  OpenAiChatProtocolAdapter,
  OpenAiResponsesProtocolAdapter,
  renderProtocolToolCallsAsApexActionBlocks,
  type NormalizedProtocolTurn,
} from "./harness/protocol-adapters.ts";
import { parseAndScrubModelResponse } from "./harness/universal-tool-parser.ts";
import { assertCanonicalWorkspacePath, resolveCanonicalWorkspaceRoot } from "./harness/workspace-security.ts";

export type { AgentOfficeRole };

export interface AgentStepEvent {
  id: string;
  kind: "route" | "skill" | "read" | "search" | "command" | "edit" | "model" | "judge" | "todo";
  label: string;
  plainSummary?: string;
  agentRole?: AgentOfficeRole;
  detail?: string;
  outputPreview?: string;
  fileRef?: string;
  lineRange?: string;
  status: "running" | "done" | "error";
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  executionId?: string;
  modelId?: string;
  modelDisplayName?: string;
  domain?: string;
  durationMs?: number;
  checkpointId?: string;
  reverted?: boolean;
  steps?: AgentStepEvent[];
  mountedSkills?: Array<{ name: string; ecosystem: string; score: number }>;
  judgeVerdict?: {
    passed: boolean;
    score: number;
    recommendedAction: string;
    issues: string[];
  };
  completionStatus?: string;
}

interface GatewayConfig {
  base_url: string;
  api_key_env?: string;
  pool_key?: string;
  default_api_key?: string;
  user_agent?: string;
  ensure_script?: string;
}

interface MatrixCandidate {
  gateway: string;
  model: string;
  fallback_gateway?: string;
  fallback_model?: string;
  family?: string;
  seat_role?: string;
}

const MATRIX_PATH = join(homedir(), ".gemini", "config", "skills", "apex-orchestrator", "references", "model-matrix.json");
const POOL_PATH = join(homedir(), ".gemini", "config", "routing", "specialist_pool.json");

const poolCounters = new Map<string, number>();

function getPoolKey(poolField: string | undefined, fallback = ""): string {
  if (!poolField || !existsSync(POOL_PATH)) return fallback;
  try {
    const data = JSON.parse(readFileSync(POOL_PATH, "utf8")) as Record<string, unknown>;
    const list = data[poolField];
    if (Array.isArray(list) && list.length > 0) {
      const idx = (poolCounters.get(poolField) ?? 0) % list.length;
      poolCounters.set(poolField, idx + 1);
      const picked = list[idx];
      if (typeof picked === "string" && picked.trim()) return picked.trim();
    }
  } catch {
    // Ignore pool parse error
  }
  return fallback;
}

let freellmChecked = false;
function ensureFreeLlmApiAwake(ensureScript?: string): void {
  if (freellmChecked) return;
  freellmChecked = true;
  if (ensureScript && existsSync(ensureScript)) {
    try {
      spawnSync("node", [ensureScript], { timeout: 5_000, windowsHide: true });
    } catch {
      // Ignore wake error
    }
  }
}

export interface LlmCallResult {
  ok: boolean;
  text: string;
  usedModel: string;
  usedGateway: string;
  latencyMs: number;
  cancelled?: boolean;
  failoverAttempts?: Array<{ gateway: string; model: string; error?: string }>;
  error?: string;
}

export async function callProviderEndpoint(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  gatewayName: string;
  protocol?: "openai-compat" | "anthropic-compat" | "gemini" | "omniroute" | "freellmapi" | "openrouter" | "local-ollama";
  userAgent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LlmCallResult> {
  const t0 = Date.now();
  if (options.signal?.aborted) {
    return {
      ok: false,
      text: "",
      usedModel: options.model,
      usedGateway: options.gatewayName,
      latencyMs: 0,
      cancelled: true,
      error: "Provider request cancelled before start",
    };
  }

  const cleanBase = options.baseUrl.replace(/\/+$/, "");
  const isAnthropic = options.protocol === "anthropic-compat" || cleanBase.endsWith("/v1/messages");
  const isGeminiNative = options.protocol === "gemini" || cleanBase.includes("generativelanguage.googleapis.com");

  let url = `${cleanBase.replace(/\/chat\/completions$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": options.userAgent || "Kilo-Code/5.10.0",
  };

  let bodyPayload: Record<string, unknown>;

  if (isAnthropic) {
    url = cleanBase.endsWith("/messages") ? cleanBase : `${cleanBase}/messages`;
    if (options.apiKey) headers["x-api-key"] = options.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const sysMsg = options.messages.find((m) => m.role === "system")?.content;
    const chatMsgs = options.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    bodyPayload = {
      model: options.model,
      max_tokens: 4096,
      ...(sysMsg ? { system: sysMsg } : {}),
      messages: chatMsgs.length > 0 ? chatMsgs : [{ role: "user", content: "Hello" }],
    };
  } else if (isGeminiNative) {
    url = `${cleanBase}/models/${options.model}:generateContent${options.apiKey ? `?key=${encodeURIComponent(options.apiKey)}` : ""}`;
    const contents = options.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    bodyPayload = { contents };
  } else {
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`;
    }
    if (options.gatewayName === "openrouter" || cleanBase.includes("openrouter")) {
      headers["HTTP-Referer"] = "https://kilocode.ai";
      headers["X-Title"] = "Kilo Code";
    }
    bodyPayload = {
      model: options.model,
      messages: options.messages,
      max_tokens: 4096,
      temperature: 0.2,
    };
  }

  const controller = new AbortController();
  let cancelledByParent = false;
  const onParentAbort = () => {
    cancelledByParent = true;
    controller.abort();
  };
  if (options.signal) {
    options.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 35_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
      signal: controller.signal,
    });

    const rawText = await response.text();
    const latencyMs = Date.now() - t0;

    if (!response.ok) {
      return {
        ok: false,
        text: "",
        usedModel: options.model,
        usedGateway: options.gatewayName,
        latencyMs,
        error: `HTTP ${response.status}: ${rawText.slice(0, 200)}`,
      };
    }

    const proto = options.protocol;
    let normalized: NormalizedProtocolTurn;
    if (rawText.trim().startsWith("data:") || rawText.includes("\ndata:")) {
      normalized =
        proto === "anthropic-compat"
          ? AnthropicMessagesProtocolAdapter.parseSseStream([rawText])
          : OpenAiChatProtocolAdapter.parseSseStream([rawText]);
    } else {
      const data = JSON.parse(rawText) as Record<string, unknown>;
      if (proto === "anthropic-compat" || Array.isArray(data.content)) {
        normalized = AnthropicMessagesProtocolAdapter.parseResponse(data);
      } else if (proto === "gemini" || Array.isArray(data.candidates)) {
        normalized = GeminiProtocolAdapter.parseResponse(data);
      } else if (Array.isArray(data.output)) {
        normalized = OpenAiResponsesProtocolAdapter.parseResponse(data);
      } else {
        normalized = OpenAiChatProtocolAdapter.parseResponse(data);
      }
    }

    if (normalized.hasIncompleteToolCall) {
      return {
        ok: false,
        text: "",
        usedModel: options.model,
        usedGateway: options.gatewayName,
        latencyMs,
        error: `Incomplete tool call blocked: ${normalized.incompleteToolCalls.map((c) => c.reason).join("; ")}`,
      };
    }

    let combinedText = normalized.visibleText || normalized.reasoningText;
    if (normalized.toolCalls.length > 0) {
      const rendered = renderProtocolToolCallsAsApexActionBlocks(normalized.toolCalls);
      if (rendered.actionBlocksText) {
        combinedText = [combinedText, rendered.actionBlocksText].filter(Boolean).join("\n\n");
      }
    }

    const cleaned = combinedText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() || combinedText;

    if (!cleaned) {
      return {
        ok: false,
        text: "",
        usedModel: options.model,
        usedGateway: options.gatewayName,
        latencyMs,
        error: "Empty completion content",
      };
    }

    return {
      ok: true,
      text: cleaned,
      usedModel: options.model,
      usedGateway: options.gatewayName,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      usedModel: options.model,
      usedGateway: options.gatewayName,
      latencyMs: Date.now() - t0,
      cancelled: cancelledByParent || Boolean(options.signal?.aborted),
      error: cancelledByParent ? "Cancelled by user" : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

/**
 * Calls the requested model first, and if its local proxy is asleep, rate-limited, or returns 5xx,
 * automatically fails over across configured providers and live gateways while respecting `AbortSignal`
 * and idempotency rules (blocking blind retry after workspace mutation without checkpoint rollback).
 */
export async function callUnifiedFleetWithFailover(options: {
  preferredModelId: string;
  preferredBaseUrl?: string;
  preferredApiKey?: string;
  messages: Array<{ role: string; content: string }>;
  signal?: AbortSignal;
  hasWorkspaceMutatedInTurn?: boolean;
  checkpointId?: string;
  dataDir?: string;
  autoRollbackOnFailover?: boolean;
  extraCandidates?: Array<{
    gatewayName: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    protocol?: "openai-compat" | "anthropic-compat" | "gemini";
  }>;
}): Promise<LlmCallResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      text: "",
      usedModel: options.preferredModelId,
      usedGateway: "cancelled",
      latencyMs: 0,
      cancelled: true,
      error: "Cancelled before model invocation",
    };
  }

  let gateways: Record<string, GatewayConfig> = {};
  let candidates: MatrixCandidate[] = [];

  if (existsSync(MATRIX_PATH)) {
    try {
      const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8")) as {
        gateways?: Record<string, GatewayConfig>;
        lanes?: Record<string, { candidates?: MatrixCandidate[] }>;
      };
      gateways = matrix.gateways ?? {};
      candidates = [
        ...(matrix.lanes?.code_engine?.candidates ?? []),
        ...(matrix.lanes?.boardroom_conference?.candidates ?? []),
        ...(matrix.lanes?.fast_scout?.candidates ?? []),
      ];
    } catch {
      // Ignore matrix error
    }
  }

  if (gateways.freellmapi?.ensure_script) {
    ensureFreeLlmApiAwake(gateways.freellmapi.ensure_script);
  }

  const attempts: Array<{
    gatewayName: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    protocol?: "openai-compat" | "anthropic-compat" | "gemini";
    userAgent?: string;
  }> = [];

  const cleanModelId = options.preferredModelId
    .replace(/^agy-acp\//, "")
    .replace(/^models\//, "");

  const effectivePreferredBaseUrl = options.preferredBaseUrl || process.env.OMNIROUTE_BASE_URL;
  if (effectivePreferredBaseUrl && !effectivePreferredBaseUrl.includes("local-gcm:")) {
    const gwMatch = effectivePreferredBaseUrl.includes(":20128")
      ? gateways.omniroute
      : effectivePreferredBaseUrl.includes(":8765")
        ? gateways.gemini_web
        : effectivePreferredBaseUrl.includes(":3001")
          ? gateways.freellmapi
          : undefined;
    const resolvedKey =
      options.preferredApiKey && !options.preferredApiKey.startsWith("local-gcm:")
        ? options.preferredApiKey
        : gwMatch?.default_api_key ?? "";
    attempts.push({
      gatewayName: "preferred",
      baseUrl: effectivePreferredBaseUrl,
      apiKey: resolvedKey,
      model: cleanModelId,
    });
  }

  if (options.extraCandidates) {
    attempts.push(...options.extraCandidates);
  }

  const seen = new Set<string>();
  for (const cand of candidates) {
    const gw = gateways[cand.gateway];
    if (!gw) continue;
    const key = `${cand.gateway}:${cand.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const apiKey =
      (gw.api_key_env ? process.env[gw.api_key_env] : "") ||
      getPoolKey(gw.pool_key, gw.default_api_key ?? "") ||
      (gw.default_api_key ?? "");
    attempts.push({
      gatewayName: cand.gateway,
      baseUrl: gw.base_url,
      apiKey,
      model: cand.model,
      userAgent: gw.user_agent,
    });
  }

  const failoverAttempts: Array<{ gateway: string; model: string; error?: string }> = [];
  let lastError = "No gateways configured";

  for (let attemptIdx = 0; attemptIdx < Math.min(attempts.length, 6); attemptIdx++) {
    const attempt = attempts[attemptIdx]!;
    if (options.signal?.aborted) {
      return {
        ok: false,
        text: "",
        usedModel: attempt.model,
        usedGateway: attempt.gatewayName,
        latencyMs: 0,
        cancelled: true,
        failoverAttempts,
        error: "Cancelled during provider failover",
      };
    }

    // Idempotency guard: if the first model already failed after a workspace mutation occurred in this turn,
    // only allow failover if a pre-edit checkpoint is rolled back first.
    if (attemptIdx > 0 && options.hasWorkspaceMutatedInTurn) {
      if (options.autoRollbackOnFailover && options.checkpointId && options.dataDir) {
        revertTurnCheckpoint(options.dataDir, options.checkpointId);
      } else {
        failoverAttempts.push({
          gateway: attempt.gatewayName,
          model: attempt.model,
          error: "Blocked by idempotency guard: workspace mutated without checkpoint rollback",
        });
        lastError =
          "Idempotency guard blocked blind failover after workspace mutation without checkpoint rollback";
        break;
      }
    }

    const res = await callProviderEndpoint({
      baseUrl: attempt.baseUrl,
      apiKey: attempt.apiKey,
      model: attempt.model,
      messages: options.messages,
      gatewayName: attempt.gatewayName,
      protocol: attempt.protocol,
      userAgent: attempt.userAgent,
      timeoutMs: attempt.baseUrl.includes("127.0.0.1") || attempt.baseUrl.includes("localhost") ? 6_000 : 28_000,
      signal: options.signal,
    });

    if (res.cancelled) {
      return { ...res, failoverAttempts };
    }

    if (res.ok) {
      return { ...res, failoverAttempts };
    }

    failoverAttempts.push({
      gateway: attempt.gatewayName,
      model: attempt.model,
      error: res.error,
    });
    lastError = `${attempt.gatewayName}/${attempt.model}: ${res.error}`;
  }

  if (!options.signal?.aborted) {
    const cliFallback = await callLocalCliDriverFallbackAsync(
      options.preferredModelId,
      options.messages,
      options.signal,
    );
    if (cliFallback.ok || cliFallback.cancelled) {
      return { ...cliFallback, failoverAttempts };
    }
  }

  return {
    ok: false,
    text: "",
    usedModel: options.preferredModelId,
    usedGateway: "offline-fallback",
    latencyMs: 0,
    failoverAttempts,
    error: lastError,
  };
}

/**
 * Asynchronous CLI driver fallback supporting `AbortSignal` and process-tree kill.
 */
export async function callLocalCliDriverFallbackAsync(
  preferredModelId: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  const t0 = Date.now();
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!lastUser) {
    return { ok: false, text: "", usedModel: preferredModelId, usedGateway: "cli", latencyMs: 0, error: "Empty prompt" };
  }

  const cliCandidates: Array<{ name: string; bin: string; args: string[] }> = [];
  if (preferredModelId.startsWith("codex/")) {
    cliCandidates.push({ name: "codex-cli", bin: "codex", args: ["exec", "--skip-git-repo-check", lastUser] });
  } else if (preferredModelId.startsWith("claude/")) {
    cliCandidates.push({ name: "claude-cli", bin: "claude", args: ["-p", lastUser] });
  } else if (preferredModelId.includes("gemini")) {
    cliCandidates.push({ name: "gemini-cli", bin: "gemini", args: ["-p", lastUser] });
  }

  for (const cand of cliCandidates) {
    if (signal?.aborted) {
      return {
        ok: false,
        text: "",
        usedModel: preferredModelId,
        usedGateway: cand.name,
        latencyMs: Date.now() - t0,
        cancelled: true,
        error: "Cancelled",
      };
    }

    const res = await new Promise<LlmCallResult>((resolvePromise) => {
      let settled = false;
      const child = spawn(cand.bin, cand.args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
      const pid = child.pid;
      let stdout = "";

      const finish = (result: LlmCallResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };

      const onAbort = () => {
        killProcessTree(pid);
        finish({
          ok: false,
          text: "",
          usedModel: preferredModelId,
          usedGateway: cand.name,
          latencyMs: Date.now() - t0,
          cancelled: true,
          error: "CLI fallback cancelled",
        });
      };

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        killProcessTree(pid);
        finish({
          ok: false,
          text: "",
          usedModel: preferredModelId,
          usedGateway: cand.name,
          latencyMs: Date.now() - t0,
          error: "CLI timeout",
        });
      }, 16_000);

      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      child.on("error", (err) => {
        finish({
          ok: false,
          text: "",
          usedModel: preferredModelId,
          usedGateway: cand.name,
          latencyMs: Date.now() - t0,
          error: err.message,
        });
      });
      child.on("close", (code) => {
        const trimmed = stdout.trim();
        if (code === 0 && trimmed.length > 0) {
          finish({
            ok: true,
            text: trimmed,
            usedModel: preferredModelId,
            usedGateway: cand.name,
            latencyMs: Date.now() - t0,
          });
        } else {
          finish({
            ok: false,
            text: "",
            usedModel: preferredModelId,
            usedGateway: cand.name,
            latencyMs: Date.now() - t0,
            error: `CLI exited with ${code}`,
          });
        }
      });
    });

    if (res.ok || res.cancelled) return res;
  }

  return {
    ok: false,
    text: "",
    usedModel: preferredModelId,
    usedGateway: "cli-fallback",
    latencyMs: Date.now() - t0,
    error: "No local CLI driver responded",
  };
}

export function callLocalCliDriverFallback(
  preferredModelId: string,
  _messages: ReadonlyArray<{ role: string; content: string }>,
): LlmCallResult {
  return {
    ok: false,
    text: "",
    usedModel: preferredModelId,
    usedGateway: "cli-fallback",
    latencyMs: 0,
    error: "Use callLocalCliDriverFallbackAsync",
  };
}

const IGNORED_FOLDERS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-server",
  "dist-companion",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "build",
  "deepseek-harness",
  "vendor",
  "data",
  "coverage",
]);

/**
 * Gathers grounded workspace context (top files, README/GATES/package.json, and matching files)
 * while enforcing canonical path boundaries and emitting real-time AgentStepEvents.
 */
export function gatherGroundedWorkspaceContext(
  workspaceRoot: string,
  prompt: string,
  onStep: (step: AgentStepEvent) => void,
): { contextBlock: string; steps: AgentStepEvent[]; inspectedFiles: string[] } {
  const steps: AgentStepEvent[] = [];
  const inspectedFiles: string[] = [];
  const root = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const emit = (step: AgentStepEvent) => {
    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx >= 0) steps[idx] = step;
    else steps.push(step);
    onStep(step);
  };

  if (!existsSync(root)) {
    return { contextBlock: `Workspace path ${root} does not exist yet.`, steps, inspectedFiles };
  }

  const stepListId = `step-list-${Date.now()}`;
  const t0 = Date.now();
  emit({
    id: stepListId,
    kind: "search",
    agentRole: "Scout",
    label: "Scanning project files & folder structure",
    plainSummary: "Scout Agent indexing project files",
    detail: root,
    status: "running",
  });

  let topEntries: string[] = [];
  try {
    topEntries = readdirSync(root).filter((name) => !IGNORED_FOLDERS.has(name)).slice(0, 40);
  } catch {
    // Ignore
  }

  emit({
    id: stepListId,
    kind: "search",
    agentRole: "Scout",
    label: `Scanned project folder (${topEntries.length} items)`,
    plainSummary: `Scout Agent found ${topEntries.length} top-level files & folders`,
    detail: topEntries.slice(0, 6).join(", "),
    outputPreview: topEntries.join("\n"),
    status: "done",
    durationMs: Date.now() - t0,
  });

  const snippets: string[] = [
    `Workspace Root: ${root}`,
    `Top-level entries: ${topEntries.join(", ")}`,
  ];

  const priorityFiles = ["GATES.md", "README.md", "package.json", "pyproject.toml", "AGENTS.md"];
  const codeEntries = topEntries.filter((e) => /\.(?:py|ts|tsx|js|mjs|go|rs)$/i.test(e)).slice(0, 3);
  const promptFileMatches = prompt.match(/[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|mjs|py|json|md|html|css)/g) ?? [];
  const filesToRead = [...new Set([...promptFileMatches, ...priorityFiles, ...codeEntries])];

  let readCount = 0;
  for (const relCandidate of filesToRead) {
    if (readCount >= 4) break;
    const cleanRel = relCandidate.replace(/^[@/\\]+/, "");
    try {
      const fullPath = assertCanonicalWorkspacePath(root, cleanRel, { operation: "scout_read" });
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) continue;
      const tRead = Date.now();
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split(/\r?\n/);
      const maxLines = Math.min(lines.length, 75);
      const preview = lines.slice(0, maxLines).join("\n");
      const stepId = `step-read-${readCount}-${Date.now()}`;
      readCount += 1;
      const relName = (relative(root, fullPath) || cleanRel).replace(/\\/g, "/");
      inspectedFiles.push(relName);
      emit({
        id: stepId,
        kind: "read",
        agentRole: "Scout",
        label: `Read ${relName}`,
        plainSummary: `Scout Agent read ${relName} (lines 1–${maxLines})`,
        detail: `Lines 1–${maxLines} of ${lines.length}`,
        outputPreview: preview.slice(0, 1200),
        fileRef: relName,
        lineRange: `#L1-${maxLines}`,
        status: "done",
        durationMs: Date.now() - tRead,
      });
      snippets.push(`--- FILE: ${relName} (lines 1-${maxLines}) ---\n${preview}`);
    } catch {
      // Skip files outside workspace or unreadable
    }
  }

  return {
    contextBlock: snippets.join("\n\n"),
    steps,
    inspectedFiles,
  };
}

export interface ToolExecutionAction {
  tool:
    | "write_file"
    | "edit_file"
    | "read_file"
    | "list_dir"
    | "grep_search"
    | "run_command"
    | "call_mcp_tool"
    | "todo_write"
    | "repo_map"
    | "delegate_subagent";
  path?: string;
  content?: string;
  target?: string;
  replacement?: string;
  startLine?: number;
  endLine?: number;
  pattern?: string;
  query?: string;
  relDir?: string;
  command?: string;
  serverName?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  role?: string;
  task?: string;
  preferredModelId?: string;
  tokenBudget?: number;
}

export interface FileBackupEntry {
  fullPath: string;
  existedBefore: boolean;
  previousContent?: string;
}

export interface TurnCheckpoint {
  checkpointId: string;
  workspaceRoot: string;
  createdAt: string;
  reverted: boolean;
  files: FileBackupEntry[];
}

export function saveTurnCheckpoint(dataDir: string, checkpoint: TurnCheckpoint): void {
  const dir = join(dataDir, "checkpoints");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${checkpoint.checkpointId}.json`), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

export function revertTurnCheckpoint(
  dataDir: string,
  checkpointId: string,
): { ok: boolean; restoredFiles: string[]; error?: string } {
  const p = join(dataDir, "checkpoints", `${checkpointId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
  if (!existsSync(p)) {
    return { ok: false, restoredFiles: [], error: `Checkpoint '${checkpointId}' not found.` };
  }
  try {
    const cp = JSON.parse(readFileSync(p, "utf8")) as TurnCheckpoint;
    const canonicalRoot = resolveCanonicalWorkspaceRoot(cp.workspaceRoot);
    const restored: string[] = [];
    for (const f of cp.files) {
      const safePath = assertCanonicalWorkspacePath(canonicalRoot, f.fullPath, { operation: "checkpoint_revert" });
      if (f.existedBefore && typeof f.previousContent === "string") {
        mkdirSync(dirname(safePath), { recursive: true });
        writeFileSync(safePath, f.previousContent, "utf8");
        restored.push(safePath);
      } else if (!f.existedBefore && existsSync(safePath)) {
        rmSync(safePath, { force: true });
        restored.push(`${safePath} (removed new file)`);
      }
    }
    cp.reverted = true;
    writeFileSync(p, `${JSON.stringify(cp, null, 2)}\n`, "utf8");
    return { ok: true, restoredFiles: restored };
  } catch (err) {
    return {
      ok: false,
      restoredFiles: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AgentToolExecutionReport {
  cleanedResponse: string;
  executedSteps: AgentStepEvent[];
  toolObservations: string[];
  checkpoint?: TurnCheckpoint;
  checkpointId?: string;
  filesInspected: string[];
  filesCreated: string[];
  filesModified: string[];
  commandsExecuted: ExecutedCommandEvidence[];
  toolsInvoked: Array<{ tool: string; target?: string; status: "done" | "error"; durationMs: number }>;
  delegatedSubagents?: Array<{
    subagentId: string;
    sessionId: string;
    parentTaskId?: string;
    role: AgentOfficeRole;
    engineeringRole: string;
    assignedModelId: string;
    status: string;
    summary: string;
    isolatedContextVerified: boolean;
    durationMs: number;
  }>;
}

/**
 * Asynchronous Agent Tool Block Executor with:
 * - Canonical workspace path containment (`assertCanonicalWorkspacePath`)
 * - Asynchronous managed command execution (`runManagedCommand` with process-tree kill & permission policy)
 * - End-to-end `AbortSignal` cancellation
 * - Pre-edit file checkpointing and detailed execution evidence tracking
 */
export async function executeAgentToolBlocksAsync(
  arg1:
    | string
    | {
        responseText: string;
        workspaceRoot: string;
        dataDir?: string;
        checkpointId?: string;
        mode?: "turbo" | "auto_edit" | "ask";
        signal?: AbortSignal;
        onApprovalRequired?: (command: string, reason: string) => Promise<boolean>;
        onStep: (step: AgentStepEvent) => void;
      },
  workspaceRootArg?: string,
  onStepArg?: (step: AgentStepEvent) => void,
  extraOpts?: {
    dataDir?: string;
    conversationId?: string;
    checkpointId?: string;
    mode?: "turbo" | "auto_edit" | "ask";
    signal?: AbortSignal;
    onApprovalRequired?: (command: string, reason: string) => Promise<boolean>;
  },
): Promise<AgentToolExecutionReport> {
  const options =
    typeof arg1 === "string"
      ? {
          responseText: arg1,
          workspaceRoot: workspaceRootArg!,
          dataDir: extraOpts?.dataDir,
          checkpointId: extraOpts?.checkpointId,
          mode: extraOpts?.mode,
          signal: extraOpts?.signal,
          onApprovalRequired: extraOpts?.onApprovalRequired,
          onStep: onStepArg!,
        }
      : arg1;

  const executedSteps: AgentStepEvent[] = [];
  const toolObservations: string[] = [];
  const filesInspected = new Set<string>();
  const filesCreated = new Set<string>();
  const filesModified = new Set<string>();
  const commandsExecuted: ExecutedCommandEvidence[] = [];
  const toolsInvoked: Array<{ tool: string; target?: string; status: "done" | "error"; durationMs: number }> = [];
  const delegatedSubagents: NonNullable<AgentToolExecutionReport["delegatedSubagents"]> = [];

  const root = resolveCanonicalWorkspaceRoot(options.workspaceRoot);
  const backups = new Map<string, FileBackupEntry>();

  const recordBackupIfNeeded = (targetPath: string): boolean => {
    const existed = existsSync(targetPath) && statSync(targetPath).isFile();
    if (!backups.has(targetPath)) {
      if (existed) {
        backups.set(targetPath, {
          fullPath: targetPath,
          existedBefore: true,
          previousContent: readFileSync(targetPath, "utf8"),
        });
      } else {
        backups.set(targetPath, {
          fullPath: targetPath,
          existedBefore: false,
        });
      }
    }
    return existed;
  };

  const resolveSafeTargetPath = (rawPath: string, op: string): string => {
    return assertCanonicalWorkspacePath(root, rawPath, { operation: op });
  };

  const parsedOutput = parseAndScrubModelResponse(options.responseText);
  const cleanedResponse = parsedOutput.visibleText;

  for (const action of parsedOutput.toolCalls) {
    if (options.signal?.aborted) {
      toolObservations.push("[tool_cancelled] Execution cancelled via AbortSignal.");
      break;
    }

    const t0 = Date.now();
    try {
      if (action.tool === "write_file" && action.path && typeof action.content === "string") {
        if (options.mode === "ask") {
          throw new Error("write_file blocked in 'ask' mode without explicit write approval");
        }
        const targetPath = resolveSafeTargetPath(action.path, "write_file");
        const existedBefore = recordBackupIfNeeded(targetPath);
        mkdirSync(dirname(targetPath), { recursive: true });
        // Re-verify canonical path after mkdirSync in case parent was a symlink
        const verifiedTarget = resolveSafeTargetPath(action.path, "write_file_post_mkdir");
        writeFileSync(verifiedTarget, action.content, "utf8");
        const rel = (relative(root, verifiedTarget) || action.path).replace(/\\/g, "/");
        if (existedBefore) filesModified.add(rel);
        else filesCreated.add(rel);

        const linesCount = action.content.split(/\r?\n/).length;
        const dur = Date.now() - t0;
        toolsInvoked.push({ tool: "write_file", target: rel, status: "done", durationMs: dur });
        const step: AgentStepEvent = {
          id: `step-write-${Date.now()}-${executedSteps.length}`,
          kind: "edit",
          agentRole: "Builder",
          label: `${existedBefore ? "Updated" : "Created"} file ${rel}`,
          plainSummary: `Builder Agent wrote ${linesCount} lines to ${rel}`,
          detail: `${linesCount} lines · ${action.content.length} bytes`,
          outputPreview: action.content.slice(0, 1200),
          fileRef: rel,
          lineRange: `#L1-${linesCount}`,
          status: "done",
          durationMs: dur,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[write_file: ${rel}] Wrote ${action.content.length} bytes (${linesCount} lines).`);
        continue;
      }

      if (
        action.tool === "edit_file" &&
        action.path &&
        typeof action.target === "string" &&
        typeof action.replacement === "string"
      ) {
        if (options.mode === "ask") {
          throw new Error("edit_file blocked in 'ask' mode without explicit edit approval");
        }
        const targetPath = resolveSafeTargetPath(action.path, "edit_file");
        const rel = (relative(root, targetPath) || action.path).replace(/\\/g, "/");
        if (!existsSync(targetPath)) {
          throw new Error(`edit_file target does not exist: ${rel}`);
        }
        const current = readFileSync(targetPath, "utf8");
        if (!current.includes(action.target)) {
          throw new Error(`edit_file target snippet not found in ${rel}`);
        }
        recordBackupIfNeeded(targetPath);
        const updated = current.replaceAll(action.target, action.replacement);
        writeFileSync(targetPath, updated, "utf8");
        filesModified.add(rel);

        const addedLines = action.replacement.split(/\r?\n/).length;
        const removedLines = action.target.split(/\r?\n/).length;
        const dur = Date.now() - t0;
        toolsInvoked.push({ tool: "edit_file", target: rel, status: "done", durationMs: dur });
        const step: AgentStepEvent = {
          id: `step-edit-${Date.now()}-${executedSteps.length}`,
          kind: "edit",
          agentRole: "Builder",
          label: `Updated ${rel}`,
          plainSummary: `Builder Agent patched ${rel} (+${addedLines} / -${removedLines} lines)`,
          detail: `+${addedLines} / -${removedLines} lines`,
          outputPreview: `- ${action.target.slice(0, 400)}\n+ ${action.replacement.slice(0, 400)}`,
          fileRef: rel,
          lineRange: `Δ +${addedLines}/-${removedLines}`,
          status: "done",
          durationMs: dur,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[edit_file: ${rel}] Applied surgical patch (+${addedLines}/-${removedLines} lines).`);
        continue;
      }

      if (action.tool === "read_file" && action.path) {
        const targetPath = resolveSafeTargetPath(action.path, "read_file");
        const rel = (relative(root, targetPath) || action.path).replace(/\\/g, "/");
        if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
          throw new Error(`File not found: ${rel}`);
        }
        filesInspected.add(rel);
        const raw = readFileSync(targetPath, "utf8");
        const allLines = raw.split(/\r?\n/);
        const sLine = Math.max(1, action.startLine ?? 1);
        const eLine = Math.min(allLines.length, action.endLine ?? Math.min(allLines.length, sLine + 199));
        const slice = allLines.slice(sLine - 1, eLine).join("\n");
        const dur = Date.now() - t0;
        toolsInvoked.push({ tool: "read_file", target: rel, status: "done", durationMs: dur });
        const step: AgentStepEvent = {
          id: `step-read-act-${Date.now()}-${executedSteps.length}`,
          kind: "read",
          agentRole: "Scout",
          label: `Read ${rel}`,
          plainSummary: `Scout Agent inspected ${rel} (lines ${sLine}–${eLine})`,
          detail: `Lines ${sLine}–${eLine} of ${allLines.length}`,
          outputPreview: slice.slice(0, 1400),
          fileRef: rel,
          lineRange: `#L${sLine}-${eLine}`,
          status: "done",
          durationMs: dur,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[read_file: ${rel} #L${sLine}-${eLine}]\n${slice}`);
        continue;
      }

      if (action.tool === "list_dir") {
        const targetDir = action.path ? resolveSafeTargetPath(action.path, "list_dir") : root;
        const rel = (relative(root, targetDir) || ".").replace(/\\/g, "/");
        const entries =
          existsSync(targetDir) && statSync(targetDir).isDirectory()
            ? readdirSync(targetDir).filter((e) => !IGNORED_FOLDERS.has(e)).slice(0, 80)
            : [];
        const dur = Date.now() - t0;
        toolsInvoked.push({ tool: "list_dir", target: rel, status: "done", durationMs: dur });
        const step: AgentStepEvent = {
          id: `step-listdir-${Date.now()}-${executedSteps.length}`,
          kind: "read",
          agentRole: "Scout",
          label: `Listed directory ${rel}`,
          plainSummary: `Scout Agent listed ${entries.length} items in ${rel}`,
          detail: `${entries.length} entries`,
          outputPreview: entries.join("\n"),
          fileRef: rel,
          status: "done",
          durationMs: dur,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[list_dir: ${rel}]\n${entries.join("\n")}`);
        continue;
      }

      const grepPattern = action.pattern || action.query;
      const grepRelPath = action.path || action.relDir;
      if (action.tool === "grep_search" && grepPattern) {
        const searchDir = grepRelPath ? resolveSafeTargetPath(grepRelPath, "grep_search") : root;
        const rx = new RegExp(grepPattern, "i");
        const hits: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 3 || hits.length >= 30) return;
          let entries: string[] = [];
          try {
            entries = readdirSync(dir);
          } catch {
            return;
          }
          for (const e of entries) {
            if (IGNORED_FOLDERS.has(e) || e.startsWith(".")) continue;
            const p = join(dir, e);
            try {
              const lst = lstatSync(p);
              if (lst.isSymbolicLink()) continue; // Do not follow symlinks during grep
              if (lst.isDirectory()) walk(p, depth + 1);
              else if (lst.size < 200_000) {
                const lines = readFileSync(p, "utf8").split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                  if (rx.test(lines[i]!)) {
                    const relFile = relative(root, p).replace(/\\/g, "/");
                    filesInspected.add(relFile);
                    hits.push(`${relFile}:${i + 1}: ${lines[i]!.trim().slice(0, 140)}`);
                    if (hits.length >= 30) break;
                  }
                }
              }
            } catch {
              // Ignore
            }
          }
        };
        walk(searchDir, 0);
        const dur = Date.now() - t0;
        toolsInvoked.push({ tool: "grep_search", target: grepPattern, status: "done", durationMs: dur });
        const step: AgentStepEvent = {
          id: `step-grep-${Date.now()}-${executedSteps.length}`,
          kind: "search",
          agentRole: "Scout",
          label: `Searched codebase for "${grepPattern}"`,
          plainSummary: `Scout Agent found ${hits.length} matches for "${grepPattern}"`,
          detail: `${hits.length} matches`,
          outputPreview: hits.join("\n") || "No matches found.",
          status: "done",
          durationMs: dur,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[grep_search: ${grepPattern}]\n${hits.join("\n") || "No matches found."}`);
        continue;
      }

      if (action.tool === "todo_write" && Array.isArray(action.todos)) {
        const summary = action.todos.map((t) => `[${t.status}] ${t.content}`).join("\n");
        const dur = Date.now() - t0;
        toolsInvoked.push({ tool: "todo_write", status: "done", durationMs: dur });
        const step: AgentStepEvent = {
          id: `step-todo-${Date.now()}-${executedSteps.length}`,
          kind: "todo",
          agentRole: "Coordinator",
          label: `Updated task checklist (${action.todos.length} items)`,
          plainSummary: `Coordinator updated live execution checklist`,
          detail: `${action.todos.filter((t) => t.status === "completed").length}/${action.todos.length} completed`,
          outputPreview: summary,
          status: "done",
          durationMs: dur,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[todo_write]\n${summary}`);
        continue;
      }

      if (action.tool === "repo_map") {
        const targetDir = action.path ? resolveSafeTargetPath(action.path, "repo_map") : root;
        const topFiles = readdirSync(targetDir).filter((e) => !IGNORED_FOLDERS.has(e)).slice(0, 50);
        const dur = Date.now() - t0;
        toolsInvoked.push({ tool: "repo_map", status: "done", durationMs: dur });
        const step: AgentStepEvent = {
          id: `step-repomap-${Date.now()}-${executedSteps.length}`,
          kind: "read",
          agentRole: "Architect",
          label: `Generated repository map`,
          plainSummary: `Architect mapped ${topFiles.length} workspace modules`,
          detail: `${topFiles.length} modules`,
          outputPreview: topFiles.join("\n"),
          status: "done",
          durationMs: dur,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[repo_map]\n${topFiles.join("\n")}`);
        continue;
      }

      if (action.tool === "run_command" && action.command) {
        const cmdRes = await runManagedCommand({
          command: action.command,
          cwd: action.path || ".",
          workspaceRoot: root,
          timeoutMs: 20_000,
          mode: options.mode ?? "turbo",
          signal: options.signal,
          onApprovalRequired: options.onApprovalRequired,
        });

        commandsExecuted.push({
          command: action.command,
          cwd: cmdRes.cwd,
          exitCode: cmdRes.exitCode,
          durationMs: cmdRes.durationMs,
          timedOut: cmdRes.timedOut,
          cancelled: cmdRes.cancelled,
          stdoutPreview: cmdRes.stdout.slice(0, 1500),
          stderrPreview: cmdRes.stderr.slice(0, 1500),
        });

        toolsInvoked.push({
          tool: "run_command",
          target: action.command.slice(0, 80),
          status: cmdRes.ok ? "done" : "error",
          durationMs: cmdRes.durationMs,
        });

        const step: AgentStepEvent = {
          id: `step-cmd-${Date.now()}-${executedSteps.length}`,
          kind: "command",
          agentRole: "Builder",
          label: `Ran terminal command: ${action.command.slice(0, 55)}`,
          plainSummary: cmdRes.ok
            ? `Builder Agent executed command (exit 0)`
            : `Command exited with ${cmdRes.exitCode ?? (cmdRes.timedOut ? "TIMEOUT" : "CANCELLED")}`,
          detail: cmdRes.combinedOutput.slice(0, 140) || `exit ${cmdRes.exitCode ?? 0}`,
          outputPreview: `$ ${action.command}\n[exit=${cmdRes.exitCode}]\n${cmdRes.combinedOutput.slice(0, 1500)}`,
          status: cmdRes.ok ? "done" : "error",
          durationMs: cmdRes.durationMs,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(
          `[run_command: ${action.command} | exit=${cmdRes.exitCode}]\n${cmdRes.combinedOutput.slice(0, 3000)}`,
        );
        continue;
      }

      if (action.tool === "call_mcp_tool" && action.serverName && action.toolName) {
        const mcpRes = await callMcpServerTool({
          serverName: action.serverName,
          toolName: action.toolName,
          args: action.args ?? {},
          signal: options.signal,
        });
        toolsInvoked.push({
          tool: `mcp:${action.serverName}/${action.toolName}`,
          target: action.serverName,
          status: mcpRes.ok ? "done" : "error",
          durationMs: mcpRes.durationMs,
        });
        const step: AgentStepEvent = {
          id: `step-mcp-${Date.now()}-${executedSteps.length}`,
          kind: "command",
          agentRole: "Scout",
          label: `Called MCP integration: ${action.serverName} → ${action.toolName}`,
          plainSummary: `Connected to ${action.serverName} MCP server`,
          detail: mcpRes.ok ? "Completed" : "Error",
          outputPreview: mcpRes.content.slice(0, 1200),
          status: mcpRes.ok ? "done" : "error",
          durationMs: mcpRes.durationMs,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[call_mcp_tool: ${action.serverName}/${action.toolName}]\n${mcpRes.content.slice(0, 2500)}`);
        continue;
      }

      if (action.tool === "delegate_subagent" && (action.task || action.pattern || action.content)) {
        const subTask = action.task || action.pattern || action.content || "Inspect workspace";
        const validRoles = new Set(["Coordinator", "Scout", "Architect", "Builder", "Critic", "Verifier"]);
        const normalizedRole = (action.role && validRoles.has(action.role) ? action.role : "Scout") as AgentOfficeRole;
        const { delegateSubagentTask } = await import("./harness/hermes-memory-learning.ts");
        const subRes = await delegateSubagentTask({
          dataDir: options.dataDir || join(root, ".apex-data"),
          workspaceRoot: root,
          parentExecutionId: extraOpts?.conversationId,
          parentTaskId: "node-builder",
          role: normalizedRole,
          task: subTask,
          preferredModelId: action.preferredModelId,
          tokenBudget: action.tokenBudget,
          mode: options.mode ?? "turbo",
          signal: options.signal,
          onStep: options.onStep,
        });
        for (const f of subRes.filesInspected) filesInspected.add(f);
        for (const f of subRes.filesModified) filesModified.add(f);
        commandsExecuted.push(...subRes.commandsExecuted);
        delegatedSubagents.push({
          subagentId: subRes.subagentId,
          sessionId: subRes.sessionId,
          parentTaskId: subRes.parentTaskId ?? "node-builder",
          role: subRes.role,
          engineeringRole: subRes.engineeringRole,
          assignedModelId: subRes.assignedModelId,
          status: subRes.status,
          summary: subRes.summary,
          isolatedContextVerified: subRes.isolatedContextVerified,
          durationMs: subRes.durationMs,
        });
        toolsInvoked.push({
          tool: "delegate_subagent",
          target: `${subRes.role}:${subRes.subagentId}`,
          status: subRes.status === "completed" ? "done" : "error",
          durationMs: subRes.durationMs,
        });
        toolObservations.push(
          `[delegate_subagent: ${subRes.role} (${subRes.subagentId} / ${subRes.sessionId})]\n${subRes.summary.slice(0, 2500)}`,
        );
        continue;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dur = Date.now() - t0;
      toolsInvoked.push({
        tool: action.tool,
        target: action.path || action.command,
        status: "error",
        durationMs: dur,
      });
      const step: AgentStepEvent = {
        id: `step-err-${Date.now()}-${executedSteps.length}`,
        kind: "command",
        agentRole: "Verifier",
        label: `Tool notice: ${msg}`,
        status: "error",
        durationMs: dur,
      };
      executedSteps.push(step);
      options.onStep(step);
      toolObservations.push(`[tool_error] ${msg}`);
    }
  }

  let checkpoint: TurnCheckpoint | undefined;
  if (backups.size > 0 && options.dataDir) {
    checkpoint = {
      checkpointId: options.checkpointId || `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceRoot: root,
      createdAt: new Date().toISOString(),
      reverted: false,
      files: [...backups.values()],
    };
    saveTurnCheckpoint(options.dataDir, checkpoint);
  }

  return {
    cleanedResponse,
    executedSteps,
    toolObservations,
    checkpoint,
    checkpointId: checkpoint?.checkpointId,
    filesInspected: [...filesInspected],
    filesCreated: [...filesCreated],
    filesModified: [...filesModified],
    commandsExecuted,
    toolsInvoked,
    delegatedSubagents,
  };
}

export function executeAgentToolBlocks(
  responseText: string,
  workspaceRoot: string,
  onStep: (step: AgentStepEvent) => void,
): { cleanedResponse: string; executedSteps: AgentStepEvent[] } {
  const executedSteps: AgentStepEvent[] = [];
  const root = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const regex = /```apex-action\r?\n([\s\S]*?)```/g;

  const cleanedResponse = responseText.replace(regex, (fullMatch, jsonBlock: string) => {
    try {
      const action = JSON.parse(jsonBlock.trim()) as ToolExecutionAction;
      const t0 = Date.now();
      if (action.tool === "write_file" && action.path && typeof action.content === "string") {
        const targetPath = assertCanonicalWorkspacePath(root, action.path, { operation: "write_file" });
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, action.content, "utf8");
        const step: AgentStepEvent = {
          id: `step-write-${Date.now()}-${executedSteps.length}`,
          kind: "edit",
          label: `Wrote ${relative(root, targetPath) || action.path}`,
          fileRef: relative(root, targetPath) || action.path,
          lineRange: `#L1-${action.content.split(/\r?\n/).length}`,
          status: "done",
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        onStep(step);
        return `\n> **Executed File Write**: \`${relative(root, targetPath) || action.path}\` (${action.content.length} bytes)\n`;
      }
      if (
        action.tool === "edit_file" &&
        action.path &&
        typeof action.target === "string" &&
        typeof action.replacement === "string"
      ) {
        const targetPath = assertCanonicalWorkspacePath(root, action.path, { operation: "edit_file" });
        const current = readFileSync(targetPath, "utf8");
        if (!current.includes(action.target)) {
          throw new Error(`Target snippet not found in ${action.path}`);
        }
        const updated = current.replaceAll(action.target, action.replacement);
        writeFileSync(targetPath, updated, "utf8");
        const step: AgentStepEvent = {
          id: `step-edit-${Date.now()}-${executedSteps.length}`,
          kind: "edit",
          label: `Edited ${relative(root, targetPath) || action.path}`,
          fileRef: relative(root, targetPath) || action.path,
          status: "done",
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        onStep(step);
        return `\n> **Executed File Edit**: \`${relative(root, targetPath) || action.path}\`\n`;
      }
    } catch (err) {
      const step: AgentStepEvent = {
        id: `step-err-${Date.now()}-${executedSteps.length}`,
        kind: "command",
        label: `Action error: ${err instanceof Error ? err.message : String(err)}`,
        status: "error",
      };
      executedSteps.push(step);
      onStep(step);
    }
    return fullMatch;
  });

  return { cleanedResponse, executedSteps };
}
