// Multi-Harness Driver and Session Architecture for Apex Harness (Section 5).
// Unifies API-backed providers (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, Ollama)
// and native CLI harnesses (Antigravity ACP, Claude Code CLI, Codex App-Server, Gemini CLI, OpenCode CLI)
// behind a single session-capable `ApexDriver` contract with idempotency-aware failover.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderConfigEntry, ProviderProtocol } from "../../shared/apex-contracts.ts";
import { callUnifiedFleetWithFailover, revertTurnCheckpoint } from "../apex-llm-engine.ts";
import { ensureCleanCarbonHome } from "./apex-fleet-sync.ts";
import { killProcessTree } from "./process-manager.ts";
import {
  AnthropicMessagesProtocolAdapter,
  GeminiProtocolAdapter,
  NativeCliJsonlProtocolAdapter,
  OpenAiChatProtocolAdapter,
  OpenAiResponsesProtocolAdapter,
  renderProtocolToolCallsAsApexActionBlocks,
  type NormalizedProtocolTurn,
} from "./protocol-adapters.ts";

export interface DriverCapabilities {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsSubagents: boolean;
  supportsSessionResume: boolean;
  supportsNativeApproval: boolean;
  supportsReasoningEffort: boolean;
  maxContextTokens: number;
}

export interface DriverHealthStatus {
  driverId: string;
  healthy: boolean;
  protocol: ProviderProtocol | "acp" | "cli-jsonl";
  latencyMs: number;
  detail: string;
  binaryPath?: string;
}

export interface DriverModelDescriptor {
  id: string;
  displayName: string;
  driverId: string;
  contextWindow: number;
}

export interface DriverSessionConfig {
  sessionId?: string;
  workspaceRoot: string;
  modelId: string;
  mode?: "ask" | "auto" | "turbo";
  effort?: "low" | "medium" | "high";
  systemPrompt?: string;
}

export interface DriverSession {
  sessionId: string;
  driverId: string;
  workspaceRoot: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "interrupted" | "cancelled" | "closed";
  resumedCount?: number;
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string }>;
}

export interface DriverTurnInput {
  prompt: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DriverStreamEvent {
  type: "delta" | "reasoning" | "tool_call" | "complete" | "error";
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  turn?: NormalizedProtocolTurn;
  error?: string;
}

export interface DriverTurnResult {
  ok: boolean;
  driverId: string;
  sessionId: string;
  modelId: string;
  text: string;
  normalizedTurn: NormalizedProtocolTurn;
  latencyMs: number;
  error?: string;
}

export interface ApexDriver {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol | "acp" | "cli-jsonl";
  readonly capabilities: DriverCapabilities;
  initialize(): Promise<void>;
  healthCheck(): Promise<DriverHealthStatus>;
  listModels(): Promise<DriverModelDescriptor[]>;
  createSession(config: DriverSessionConfig): Promise<DriverSession>;
  resumeSession(sessionId: string): Promise<DriverSession>;
  sendMessage(sessionId: string, input: DriverTurnInput): Promise<DriverTurnResult>;
  streamEvents(
    sessionId: string,
    input: DriverTurnInput,
    onEvent: (ev: DriverStreamEvent) => void,
  ): Promise<DriverTurnResult>;
  interrupt(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

function sessionsStorePath(dataDir: string): string {
  return join(dataDir, "apex-driver-sessions.json");
}

function loadPersistedSessions(dataDir: string): Record<string, DriverSession> {
  const fp = sessionsStorePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    return JSON.parse(readFileSync(fp, "utf8")) as Record<string, DriverSession>;
  } catch {
    return {};
  }
}

function savePersistedSession(dataDir: string, session: DriverSession): void {
  mkdirSync(dataDir, { recursive: true });
  const all = loadPersistedSessions(dataDir);
  all[session.sessionId] = session;
  writeFileSync(sessionsStorePath(dataDir), JSON.stringify(all, null, 2), "utf8");
}

/**
 * HTTP Protocol Driver supporting `openai-compat`, `openai-responses`, `anthropic`, `gemini`, `ollama`, and `local-http`.
 */
export class HttpProtocolDriver implements ApexDriver {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly capabilities: DriverCapabilities;
  private readonly dataDir: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModels: string[];
  private readonly customHeaders: Record<string, string>;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(options: {
    dataDir: string;
    provider: ProviderConfigEntry;
    resolvedApiKey?: string;
    supportsResponsesApi?: boolean;
  }) {
    this.dataDir = options.dataDir;
    this.id = `http:${options.provider.id}`;
    this.displayName = options.provider.name;
    this.protocol = options.provider.protocol;
    this.baseUrl = options.provider.baseUrl.replace(/\/$/, "");
    this.apiKey = options.resolvedApiKey ?? "";
    this.defaultModels = options.provider.defaultModels ?? [];
    this.customHeaders = options.provider.headers ?? {};
    this.capabilities = {
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsSubagents: true,
      supportsSessionResume: true,
      supportsNativeApproval: false,
      supportsReasoningEffort: true,
      maxContextTokens: 200_000,
    };
  }

  async initialize(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
  }

  async healthCheck(): Promise<DriverHealthStatus> {
    const t0 = Date.now();
    try {
      const probeUrl =
        this.protocol === "anthropic"
          ? `${this.baseUrl}/messages`
          : this.protocol === "gemini"
            ? `${this.baseUrl}/models${this.apiKey ? `?key=${encodeURIComponent(this.apiKey)}` : ""}`
            : `${this.baseUrl}/models`;
      const headers: Record<string, string> = { ...this.customHeaders };
      if (this.apiKey && this.protocol !== "gemini") {
        if (this.protocol === "anthropic") {
          headers["x-api-key"] = this.apiKey;
          headers["anthropic-version"] = "2023-06-01";
        } else {
          headers.Authorization = `Bearer ${this.apiKey}`;
        }
      }
      const res = await fetch(probeUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(4000),
      });
      const healthy = res.ok || (this.protocol === "anthropic" && res.status === 405);
      return {
        driverId: this.id,
        healthy,
        protocol: this.protocol,
        latencyMs: Date.now() - t0,
        detail: healthy ? `HTTP ${res.status} reachable` : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        driverId: this.id,
        healthy: false,
        protocol: this.protocol,
        latencyMs: Date.now() - t0,
        detail: (err as Error).message,
      };
    }
  }

  async listModels(): Promise<DriverModelDescriptor[]> {
    return this.defaultModels.map((m) => ({
      id: m,
      displayName: m,
      driverId: this.id,
      contextWindow: this.capabilities.maxContextTokens,
    }));
  }

  async createSession(config: DriverSessionConfig): Promise<DriverSession> {
    const now = new Date().toISOString();
    const session: DriverSession = {
      sessionId: config.sessionId || `sess-${randomUUID().slice(0, 10)}`,
      driverId: this.id,
      workspaceRoot: config.workspaceRoot,
      modelId: config.modelId,
      createdAt: now,
      updatedAt: now,
      status: "active",
      messages: config.systemPrompt
        ? [{ role: "system", content: config.systemPrompt }]
        : [],
    };
    savePersistedSession(this.dataDir, session);
    return session;
  }

  async resumeSession(sessionId: string): Promise<DriverSession> {
    const all = loadPersistedSessions(this.dataDir);
    const existing = all[sessionId];
    if (!existing) {
      throw new Error(`Session '${sessionId}' not found in driver '${this.id}'.`);
    }
    existing.status = "active";
    existing.updatedAt = new Date().toISOString();
    savePersistedSession(this.dataDir, existing);
    return existing;
  }

  async sendMessage(sessionId: string, input: DriverTurnInput): Promise<DriverTurnResult> {
    const t0 = Date.now();
    const all = loadPersistedSessions(this.dataDir);
    const session =
      all[sessionId] ??
      (await this.createSession({
        sessionId,
        workspaceRoot: process.cwd(),
        modelId: this.defaultModels[0] ?? "default",
      }));

    const controller = new AbortController();
    this.activeControllers.set(sessionId, controller);
    if (input.signal) {
      input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 25_000);

    try {
      const effectiveMessages =
        input.messages && input.messages.length > 0
          ? input.messages
          : [
              ...session.messages
                .filter((m): m is { role: "system" | "user" | "assistant"; content: string } =>
                  m.role === "system" || m.role === "user" || m.role === "assistant",
                ),
              { role: "user" as const, content: input.prompt },
            ];

      const cleanModel = session.modelId.includes("/")
        ? session.modelId.split("/").slice(1).join("/")
        : session.modelId;

      let url = `${this.baseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...this.customHeaders,
      };
      let body: Record<string, unknown>;

      if (this.protocol === "anthropic") {
        url = `${this.baseUrl}/messages`;
        if (this.apiKey) headers["x-api-key"] = this.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        const sysMsg = effectiveMessages.find((m) => m.role === "system")?.content;
        const turns = effectiveMessages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          }));
        body = {
          model: cleanModel,
          max_tokens: 4096,
          ...(sysMsg ? { system: sysMsg } : {}),
          messages: turns.length > 0 ? turns : [{ role: "user", content: input.prompt }],
          ...(input.tools && input.tools.length > 0
            ? {
                tools: input.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
              }
            : {}),
        };
      } else if (this.protocol === "gemini") {
        const keyParam = this.apiKey ? `?key=${encodeURIComponent(this.apiKey)}` : "";
        url = `${this.baseUrl}/models/${encodeURIComponent(cleanModel)}:generateContent${keyParam}`;
        const sysMsg = effectiveMessages.find((m) => m.role === "system")?.content;
        body = {
          ...(sysMsg ? { systemInstruction: { parts: [{ text: sysMsg }] } } : {}),
          contents: effectiveMessages
            .filter((m) => m.role !== "system")
            .map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
        };
      } else {
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        body = {
          model: cleanModel,
          messages: effectiveMessages,
          temperature: 0.2,
          ...(input.tools && input.tools.length > 0
            ? {
                tools: input.tools.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
              }
            : {}),
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          driverId: this.id,
          sessionId,
          modelId: session.modelId,
          text: "",
          normalizedTurn: {
            visibleText: "",
            reasoningText: "",
            toolCalls: [],
            incompleteToolCalls: [],
            hasIncompleteToolCall: false,
            finishReason: "error",
          },
          latencyMs: Date.now() - t0,
          error: `HTTP ${res.status}: ${rawText.slice(0, 200)}`,
        };
      }

      // Check if server returned SSE stream or JSON payload
      let normalized: NormalizedProtocolTurn;
      if (rawText.trim().startsWith("data:") || rawText.includes("\ndata:")) {
        normalized =
          this.protocol === "anthropic"
            ? AnthropicMessagesProtocolAdapter.parseSseStream([rawText])
            : OpenAiChatProtocolAdapter.parseSseStream([rawText]);
      } else {
        const jsonObj = JSON.parse(rawText) as Record<string, unknown>;
        if (this.protocol === "anthropic") {
          normalized = AnthropicMessagesProtocolAdapter.parseResponse(jsonObj);
        } else if (this.protocol === "gemini") {
          normalized = GeminiProtocolAdapter.parseResponse(jsonObj);
        } else if (Array.isArray(jsonObj.output)) {
          normalized = OpenAiResponsesProtocolAdapter.parseResponse(jsonObj);
        } else {
          normalized = OpenAiChatProtocolAdapter.parseResponse(jsonObj);
        }
      }

      // If structured tool calls were returned, render validated tool calls as ```apex-action blocks
      // so the unified tool executor executes them with full checkpoint & path-containment guarantees.
      let combinedText = normalized.visibleText;
      if (normalized.toolCalls.length > 0 && !normalized.hasIncompleteToolCall) {
        const rendered = renderProtocolToolCallsAsApexActionBlocks(normalized.toolCalls);
        if (rendered.actionBlocksText) {
          combinedText = [combinedText, rendered.actionBlocksText].filter(Boolean).join("\n\n");
        }
      }

      session.messages.push({ role: "user", content: input.prompt });
      session.messages.push({ role: "assistant", content: combinedText });
      session.updatedAt = new Date().toISOString();
      savePersistedSession(this.dataDir, session);

      return {
        ok: !normalized.hasIncompleteToolCall && normalized.finishReason !== "error",
        driverId: this.id,
        sessionId,
        modelId: session.modelId,
        text: combinedText,
        normalizedTurn: normalized,
        latencyMs: Date.now() - t0,
        error: normalized.hasIncompleteToolCall
          ? normalized.incompleteToolCalls.map((c) => c.reason).join("; ")
          : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        driverId: this.id,
        sessionId,
        modelId: session.modelId,
        text: "",
        normalizedTurn: {
          visibleText: "",
          reasoningText: "",
          toolCalls: [],
          incompleteToolCalls: [],
          hasIncompleteToolCall: false,
          finishReason: "error",
        },
        latencyMs: Date.now() - t0,
        error: (err as Error).message,
      };
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(sessionId);
    }
  }

  async streamEvents(
    sessionId: string,
    input: DriverTurnInput,
    onEvent: (ev: DriverStreamEvent) => void,
  ): Promise<DriverTurnResult> {
    const result = await this.sendMessage(sessionId, input);
    if (result.normalizedTurn.reasoningText) {
      onEvent({ type: "reasoning", text: result.normalizedTurn.reasoningText });
    }
    if (result.normalizedTurn.visibleText) {
      onEvent({ type: "delta", text: result.normalizedTurn.visibleText });
    }
    for (const tc of result.normalizedTurn.toolCalls) {
      onEvent({
        type: "tool_call",
        toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
      });
    }
    onEvent({
      type: result.ok ? "complete" : "error",
      turn: result.normalizedTurn,
      error: result.error,
    });
    return result;
  }

  async interrupt(sessionId: string): Promise<void> {
    this.activeControllers.get(sessionId)?.abort();
    const all = loadPersistedSessions(this.dataDir);
    if (all[sessionId]) {
      all[sessionId].status = "interrupted";
      savePersistedSession(this.dataDir, all[sessionId]);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.activeControllers.get(sessionId)?.abort();
    const all = loadPersistedSessions(this.dataDir);
    if (all[sessionId]) {
      all[sessionId].status = "cancelled";
      savePersistedSession(this.dataDir, all[sessionId]);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.activeControllers.get(sessionId)?.abort();
    const all = loadPersistedSessions(this.dataDir);
    if (all[sessionId]) {
      all[sessionId].status = "closed";
      savePersistedSession(this.dataDir, all[sessionId]);
    }
  }

  async dispose(): Promise<void> {
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort();
    }
    this.activeControllers.clear();
  }
}

/**
 * Native CLI Harness Driver (`cli:antigravity-acp`, `cli:claude-cli`, `cli:codex-cli`, `cli:gemini-cli`, `cli:opencode-cli`).
 * Streams incremental JSONL/stdout chunks line-by-line as they arrive from the child process,
 * terminates child process trees safely on Windows (`killProcessTree`), and reports honest capabilities.
 */
export class NativeCliHarnessDriver implements ApexDriver {
  readonly id: string;
  readonly displayName: string;
  readonly protocol = "cli-jsonl" as const;
  readonly capabilities: DriverCapabilities;
  private readonly dataDir: string;
  private readonly binaryName: string;
  private readonly binaryPath?: string;
  private readonly argsPrefix: string[];
  private readonly resumeFlag?: string;
  private readonly defaultModels: string[];
  private readonly activeProcesses = new Map<string, ChildProcess>();

  constructor(options: {
    id: string;
    displayName: string;
    binaryName: string;
    binaryPath?: string;
    argsPrefix?: string[];
    resumeFlag?: string;
    supportsSessionResume?: boolean;
    supportsNativeApproval?: boolean;
    dataDir: string;
    defaultModels: string[];
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.binaryName = options.binaryName;
    this.binaryPath = options.binaryPath;
    this.argsPrefix = options.argsPrefix ?? [];
    this.resumeFlag =
      options.resumeFlag ??
      (options.binaryName === "claude" || options.binaryName === "codex" ? "--resume" : undefined);
    this.dataDir = options.dataDir;
    this.defaultModels = options.defaultModels;
    const canResume = options.supportsSessionResume ?? Boolean(this.resumeFlag);
    this.capabilities = {
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsSubagents: options.binaryName === "claude" || options.binaryName === "codex",
      supportsSessionResume: canResume,
      supportsNativeApproval: options.supportsNativeApproval ?? false,
      supportsReasoningEffort: options.binaryName === "codex" || options.binaryName === "claude",
      maxContextTokens: 200_000,
    };
  }

  async initialize(): Promise<void> {
    ensureCleanCarbonHome(this.dataDir);
  }

  async healthCheck(): Promise<DriverHealthStatus> {
    const t0 = Date.now();
    if (this.binaryPath && existsSync(this.binaryPath)) {
      return {
        driverId: this.id,
        healthy: true,
        protocol: this.protocol,
        latencyMs: Date.now() - t0,
        detail: `Executable verified at ${this.binaryPath}`,
        binaryPath: this.binaryPath,
      };
    }
    try {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      const out = execFileSync(cmd, [this.binaryName], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split(/\r?\n/)[0];
      return {
        driverId: this.id,
        healthy: Boolean(out),
        protocol: this.protocol,
        latencyMs: Date.now() - t0,
        detail: out ? `Binary verified at ${out}` : `${this.binaryName} not found`,
        binaryPath: out,
      };
    } catch {
      return {
        driverId: this.id,
        healthy: false,
        protocol: this.protocol,
        latencyMs: Date.now() - t0,
        detail: `CLI binary '${this.binaryName}' not installed on PATH`,
      };
    }
  }

  async listModels(): Promise<DriverModelDescriptor[]> {
    return this.defaultModels.map((m) => ({
      id: m,
      displayName: m,
      driverId: this.id,
      contextWindow: this.capabilities.maxContextTokens,
    }));
  }

  async createSession(config: DriverSessionConfig): Promise<DriverSession> {
    const now = new Date().toISOString();
    const session: DriverSession = {
      sessionId: config.sessionId || `cli-sess-${randomUUID().slice(0, 10)}`,
      driverId: this.id,
      workspaceRoot: config.workspaceRoot,
      modelId: config.modelId,
      createdAt: now,
      updatedAt: now,
      status: "active",
      resumedCount: 0,
      messages: [],
    };
    savePersistedSession(this.dataDir, session);
    return session;
  }

  async resumeSession(sessionId: string): Promise<DriverSession> {
    if (!this.capabilities.supportsSessionResume) {
      throw new Error(
        `Driver '${this.id}' (${this.binaryName}) does not support native CLI session resumption.`,
      );
    }
    const all = loadPersistedSessions(this.dataDir);
    const existing = all[sessionId];
    if (!existing) {
      throw new Error(`CLI session '${sessionId}' not found.`);
    }
    existing.status = "active";
    existing.resumedCount = (existing.resumedCount ?? 0) + 1;
    existing.updatedAt = new Date().toISOString();
    savePersistedSession(this.dataDir, existing);
    return existing;
  }

  private buildSpawnArgs(session: DriverSession, prompt: string): string[] {
    const resumeArgs =
      this.capabilities.supportsSessionResume &&
      this.resumeFlag &&
      (session.resumedCount ?? 0) > 0
        ? [this.resumeFlag, session.sessionId]
        : [];

    if (this.argsPrefix.length > 0) {
      return [...this.argsPrefix, ...resumeArgs, "-p", prompt];
    }
    if (this.binaryName === "claude") {
      return [...resumeArgs, "-p", prompt, "--output-format", "stream-json", "--verbose"];
    }
    if (this.binaryName === "codex") {
      return ["exec", "--skip-git-repo-check", ...resumeArgs, prompt];
    }
    return [...resumeArgs, "-p", prompt];
  }

  async sendMessage(sessionId: string, input: DriverTurnInput): Promise<DriverTurnResult> {
    return this.streamEvents(sessionId, input, () => {});
  }

  async streamEvents(
    sessionId: string,
    input: DriverTurnInput,
    onEvent: (ev: DriverStreamEvent) => void,
  ): Promise<DriverTurnResult> {
    const t0 = Date.now();
    const all = loadPersistedSessions(this.dataDir);
    const session =
      all[sessionId] ??
      (await this.createSession({
        sessionId,
        workspaceRoot: process.cwd(),
        modelId: this.defaultModels[0] ?? "default",
      }));

    const carbonHome = ensureCleanCarbonHome(this.dataDir);
    const executable = this.binaryPath || this.binaryName;
    const args = this.buildSpawnArgs(session, input.prompt);

    return new Promise<DriverTurnResult>((resolvePromise) => {
      let stdoutAll = "";
      let stdoutRemainder = "";
      let stderr = "";
      let settled = false;
      let cancelledBySignal = false;
      const emittedToolCallIds = new Set<string>();

      const emitIncrementalLine = (rawLine: string) => {
        const trimmed = rawLine.trim();
        if (!trimmed) return;
        const parsedLine = NativeCliJsonlProtocolAdapter.parseJsonlLines([trimmed]);
        if (parsedLine.reasoningText) {
          onEvent({ type: "reasoning", text: parsedLine.reasoningText });
        }
        if (parsedLine.visibleText) {
          onEvent({ type: "delta", text: parsedLine.visibleText });
        }
        for (const tc of parsedLine.toolCalls) {
          if (!emittedToolCallIds.has(tc.id)) {
            emittedToolCallIds.add(tc.id);
            onEvent({
              type: "tool_call",
              toolCall: { id: tc.id, name: tc.name, arguments: tc.arguments },
            });
          }
        }
      };

      let child: ChildProcess;
      try {
        child = spawn(executable, args, {
          cwd: session.workspaceRoot,
          env: {
            ...process.env,
            HOME: carbonHome,
            USERPROFILE: carbonHome,
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (err) {
        const errMsg = (err as Error).message;
        onEvent({ type: "error", error: errMsg });
        resolvePromise({
          ok: false,
          driverId: this.id,
          sessionId,
          modelId: session.modelId,
          text: "",
          normalizedTurn: {
            visibleText: "",
            reasoningText: "",
            toolCalls: [],
            incompleteToolCalls: [],
            hasIncompleteToolCall: false,
            finishReason: "error",
          },
          latencyMs: Date.now() - t0,
          error: errMsg,
        });
        return;
      }

      this.activeProcesses.set(sessionId, child);
      const timer = setTimeout(() => {
        if (!settled) {
          killProcessTree(child.pid);
        }
      }, input.timeoutMs ?? 20_000);

      const onAbort = () => {
        cancelledBySignal = true;
        killProcessTree(child.pid);
      };

      if (input.signal) {
        if (input.signal.aborted) {
          onAbort();
        } else {
          input.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const str = chunk.toString("utf8");
        stdoutAll += str;
        stdoutRemainder += str;
        let newlineIdx = stdoutRemainder.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = stdoutRemainder.slice(0, newlineIdx).replace(/\r$/, "");
          stdoutRemainder = stdoutRemainder.slice(newlineIdx + 1);
          emitIncrementalLine(line);
          newlineIdx = stdoutRemainder.indexOf("\n");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
        this.activeProcesses.delete(sessionId);
        onEvent({ type: "error", error: err.message });
        resolvePromise({
          ok: false,
          driverId: this.id,
          sessionId,
          modelId: session.modelId,
          text: "",
          normalizedTurn: {
            visibleText: "",
            reasoningText: "",
            toolCalls: [],
            incompleteToolCalls: [],
            hasIncompleteToolCall: false,
            finishReason: "error",
          },
          latencyMs: Date.now() - t0,
          error: err.message,
        });
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
        this.activeProcesses.delete(sessionId);

        if (stdoutRemainder.trim()) {
          emitIncrementalLine(stdoutRemainder);
          stdoutRemainder = "";
        }

        const parsed = NativeCliJsonlProtocolAdapter.parseJsonlLines(stdoutAll.split(/\r?\n/));
        let combinedText = parsed.visibleText;
        if (parsed.toolCalls.length > 0 && !parsed.hasIncompleteToolCall) {
          const rendered = renderProtocolToolCallsAsApexActionBlocks(parsed.toolCalls);
          if (rendered.actionBlocksText) {
            combinedText = [combinedText, rendered.actionBlocksText].filter(Boolean).join("\n\n");
          }
        }

        const ok =
          !cancelledBySignal &&
          code === 0 &&
          !parsed.hasIncompleteToolCall &&
          Boolean(combinedText || parsed.toolCalls.length > 0);

        session.messages.push({ role: "user", content: input.prompt });
        if (combinedText) {
          session.messages.push({
            role: "assistant",
            content: combinedText,
            toolCallId: parsed.toolCalls[0]?.id,
          });
        }
        if (cancelledBySignal) {
          session.status = "cancelled";
        }
        session.updatedAt = new Date().toISOString();
        savePersistedSession(this.dataDir, session);

        const errText = ok
          ? undefined
          : cancelledBySignal
            ? "CLI process cancelled via AbortSignal"
            : stderr.trim() || `CLI exited with code ${code}`;

        onEvent({
          type: ok ? "complete" : "error",
          turn: parsed,
          error: errText,
        });

        resolvePromise({
          ok,
          driverId: this.id,
          sessionId,
          modelId: session.modelId,
          text: combinedText,
          normalizedTurn: parsed,
          latencyMs: Date.now() - t0,
          error: errText,
        });
      });
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    const proc = this.activeProcesses.get(sessionId);
    if (proc?.pid) {
      if (process.platform === "win32") {
        killProcessTree(proc.pid);
      } else {
        proc.kill("SIGINT");
      }
    }
    const all = loadPersistedSessions(this.dataDir);
    if (all[sessionId]) {
      all[sessionId].status = "interrupted";
      savePersistedSession(this.dataDir, all[sessionId]);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const proc = this.activeProcesses.get(sessionId);
    if (proc?.pid) {
      killProcessTree(proc.pid);
    }
    const all = loadPersistedSessions(this.dataDir);
    if (all[sessionId]) {
      all[sessionId].status = "cancelled";
      savePersistedSession(this.dataDir, all[sessionId]);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
    const all = loadPersistedSessions(this.dataDir);
    if (all[sessionId]) {
      all[sessionId].status = "closed";
      savePersistedSession(this.dataDir, all[sessionId]);
    }
  }

  async dispose(): Promise<void> {
    for (const proc of this.activeProcesses.values()) {
      if (proc.pid) {
        killProcessTree(proc.pid);
      }
    }
    this.activeProcesses.clear();
  }
}

/**
 * Idempotency-Aware Failover Policy (Section 5).
 * Prevents blind retry of a mutating turn on a second model if workspace mutations already occurred
 * unless the pre-edit checkpoint is rolled back first.
 */
export function evaluateIdempotentFailoverPolicy(options: {
  dataDir: string;
  hasWorkspaceMutatedInTurn: boolean;
  checkpointId?: string;
  autoRollbackOnFailover?: boolean;
}): {
  allowRetry: boolean;
  rolledBackCheckpoint: boolean;
  reason: string;
} {
  if (!options.hasWorkspaceMutatedInTurn) {
    return {
      allowRetry: true,
      rolledBackCheckpoint: false,
      reason: "Turn is read-only / pre-mutation; safe to fail over to fallback model.",
    };
  }

  if (options.autoRollbackOnFailover && options.checkpointId) {
    const reverted = revertTurnCheckpoint(options.dataDir, options.checkpointId);
    if (reverted.ok) {
      return {
        allowRetry: true,
        rolledBackCheckpoint: true,
        reason: `Rolled back ${reverted.restoredFiles.length} mutated file(s) via checkpoint ${options.checkpointId} before failover.`,
      };
    }
  }

  return {
    allowRetry: false,
    rolledBackCheckpoint: false,
    reason:
      "Workspace mutation already occurred in this turn without checkpoint rollback; blocking non-idempotent blind failover.",
  };
}

/**
 * Authoritative Registry of all API and CLI Harness Drivers.
 */
export class ApexDriverRegistry {
  private readonly drivers = new Map<string, ApexDriver>();
  private readonly dataDir: string;

  constructor(
    dataDir: string,
    providers: ProviderConfigEntry[] = [],
    secretResolver?: (provider: ProviderConfigEntry) => string,
  ) {
    this.dataDir = dataDir;

    for (const p of providers) {
      if (p.protocol === "cli") continue;
      const driver = new HttpProtocolDriver({
        dataDir,
        provider: p,
        resolvedApiKey: secretResolver ? secretResolver(p) : undefined,
      });
      this.drivers.set(driver.id, driver);
    }

    const cliSpecs = [
      {
        id: "cli:antigravity-acp",
        displayName: "Antigravity CLI Headless Driver (agy -p)",
        binaryName: "agy",
        supportsSessionResume: false,
        supportsNativeApproval: false,
        defaultModels: ["agy-acp/gemini-4-argon-high", "agy-acp/claude-opus-4-6-thinking"],
      },
      {
        id: "cli:claude-cli",
        displayName: "Claude Code CLI Driver",
        binaryName: "claude",
        resumeFlag: "--resume",
        supportsSessionResume: true,
        supportsNativeApproval: false,
        defaultModels: ["claude-cli/claude-sonnet-4-6", "claude-cli/claude-opus-4-6"],
      },
      {
        id: "cli:codex-cli",
        displayName: "Codex App-Server Driver",
        binaryName: "codex",
        resumeFlag: "--resume",
        supportsSessionResume: true,
        supportsNativeApproval: false,
        defaultModels: ["codex/gpt-5.4", "codex/gpt-5.3-codex"],
      },
      {
        id: "cli:gemini-cli",
        displayName: "Gemini CLI Driver",
        binaryName: "gemini",
        supportsSessionResume: false,
        supportsNativeApproval: false,
        defaultModels: ["gemini-cli/gemini-3.1-pro", "gemini-cli/gemini-3-flash"],
      },
      {
        id: "cli:opencode-cli",
        displayName: "OpenCode CLI Driver",
        binaryName: "opencode",
        supportsSessionResume: false,
        supportsNativeApproval: false,
        defaultModels: ["opencode/default"],
      },
    ];

    for (const spec of cliSpecs) {
      this.drivers.set(
        spec.id,
        new NativeCliHarnessDriver({
          ...spec,
          dataDir,
        }),
      );
    }
  }

  registerDriver(driver: ApexDriver): void {
    this.drivers.set(driver.id, driver);
  }

  listDrivers(): ApexDriver[] {
    return [...this.drivers.values()];
  }

  getDriver(driverId: string): ApexDriver | undefined {
    return this.drivers.get(driverId);
  }

  resolveDriverForModel(modelId: string): ApexDriver | undefined {
    const lower = modelId.toLowerCase();
    if (lower.startsWith("agy-acp/")) return this.drivers.get("cli:antigravity-acp");
    if (lower.startsWith("claude-cli/")) return this.drivers.get("cli:claude-cli");
    if (lower.startsWith("codex/")) return this.drivers.get("cli:codex-cli");
    if (lower.startsWith("gemini-cli/")) return this.drivers.get("cli:gemini-cli");
    if (lower.startsWith("opencode/")) return this.drivers.get("cli:opencode-cli");
    if (lower.includes("claude")) return this.drivers.get("http:anthropic-direct") ?? this.drivers.values().next().value;
    if (lower.includes("gemini")) return this.drivers.get("http:gemini-direct") ?? this.drivers.values().next().value;
    return this.drivers.get("http:omniroute-local") ?? this.drivers.values().next().value;
  }

  /**
   * Unified production driver dispatch with session management, live event streaming,
   * and idempotent failover protection.
   */
  async dispatchTurnWithFailover(options: {
    sessionId?: string;
    workspaceRoot: string;
    preferredModelId: string;
    prompt: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    signal?: AbortSignal;
    hasWorkspaceMutatedInTurn?: boolean;
    checkpointId?: string;
    autoRollbackOnFailover?: boolean;
    onStreamEvent?: (ev: DriverStreamEvent) => void;
  }): Promise<
    DriverTurnResult & {
      usedGateway: string;
       rolledBackCheckpoint?: boolean;
    }
  > {
    const t0 = Date.now();
    const resolvedDriver =
      this.resolveDriverForModel(options.preferredModelId) ??
      this.getDriver("http:omniroute-local") ??
      this.listDrivers()[0]!;
    const effectiveSessionId =
      options.sessionId || `sess-${randomUUID().slice(0, 10)}`;

    const allSessions = loadPersistedSessions(this.dataDir);
    let session = allSessions[effectiveSessionId];
    if (!session) {
      session = await resolvedDriver.createSession({
        sessionId: effectiveSessionId,
        workspaceRoot: options.workspaceRoot,
        modelId: options.preferredModelId,
      });
    } else if (resolvedDriver.capabilities.supportsSessionResume) {
      try {
        session = await resolvedDriver.resumeSession(effectiveSessionId);
      } catch {
        // Keep existing session active
      }
    }

    // If a custom CLI driver with an explicit binaryPath was registered, execute it directly via streamEvents
    const cliDriver =
      resolvedDriver instanceof NativeCliHarnessDriver ? resolvedDriver : undefined;
    const health = cliDriver ? await cliDriver.healthCheck() : undefined;
    if (
      cliDriver &&
      health?.healthy &&
      health.binaryPath &&
      !process.env.OMNIROUTE_BASE_URL
    ) {
      const cliRes = await cliDriver.streamEvents(
        session.sessionId,
        {
          prompt: options.prompt,
          messages: options.messages,
          signal: options.signal,
        },
        options.onStreamEvent ?? (() => {}),
      );
      if (cliRes.ok) {
        return {
          ...cliRes,
          usedGateway: cliDriver.id,
        };
      }
      const failoverCheck = evaluateIdempotentFailoverPolicy({
        dataDir: this.dataDir,
        hasWorkspaceMutatedInTurn: Boolean(options.hasWorkspaceMutatedInTurn),
        checkpointId: options.checkpointId,
        autoRollbackOnFailover: options.autoRollbackOnFailover,
      });
      if (!failoverCheck.allowRetry) {
        return {
          ...cliRes,
          usedGateway: cliDriver.id,
        };
      }
    }

    // Dispatch via HTTP gateway / fleet failover spine and record session + streaming events
    const fleetRes = await callUnifiedFleetWithFailover({
      preferredModelId: options.preferredModelId,
      messages: options.messages,
      signal: options.signal,
      hasWorkspaceMutatedInTurn: options.hasWorkspaceMutatedInTurn,
      checkpointId: options.checkpointId,
      dataDir: this.dataDir,
      autoRollbackOnFailover: options.autoRollbackOnFailover,
    });

    const normalizedTurn = OpenAiChatProtocolAdapter.parseResponse({
      choices: [
        {
          message: { role: "assistant", content: fleetRes.text },
          finish_reason: fleetRes.ok ? "stop" : "error",
        },
      ],
    });

    if (normalizedTurn.visibleText) {
      options.onStreamEvent?.({ type: "delta", text: normalizedTurn.visibleText });
    }
    options.onStreamEvent?.({
      type: fleetRes.ok ? "complete" : "error",
      turn: normalizedTurn,
      error: fleetRes.error,
    });

    const actualDriverId =
      fleetRes.usedGateway && fleetRes.usedGateway !== "local"
        ? `http:${fleetRes.usedGateway}`
        : resolvedDriver.id;

    session.driverId = actualDriverId;
    session.modelId = fleetRes.usedModel || options.preferredModelId;
    session.messages.push({ role: "user", content: options.prompt });
    if (fleetRes.text) {
      session.messages.push({ role: "assistant", content: fleetRes.text });
    }
    session.updatedAt = new Date().toISOString();
    savePersistedSession(this.dataDir, session);

    return {
      ok: fleetRes.ok,
      driverId: actualDriverId,
      sessionId: session.sessionId,
      modelId: fleetRes.usedModel || options.preferredModelId,
      usedGateway: fleetRes.usedGateway || actualDriverId,
      text: fleetRes.text,
      normalizedTurn,
      latencyMs: Date.now() - t0,
      error: fleetRes.error,
    };
  }

  async checkAllDriversHealth(): Promise<DriverHealthStatus[]> {
    const list = this.listDrivers();
    return Promise.all(list.map((d) => d.healthCheck()));
  }
}
