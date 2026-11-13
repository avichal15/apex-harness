// Multi-Harness Driver and Session Architecture for Apex Harness (Section 5).
// Unifies API-backed providers (OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, Ollama)
// and native CLI harnesses (Antigravity ACP, Claude Code CLI, Codex App-Server, Gemini CLI, OpenCode CLI)
// behind a single session-capable `ApexDriver` contract with idempotency-aware failover.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderConfigEntry, ProviderProtocol } from "../../shared/apex-contracts.ts";
import { revertTurnCheckpoint } from "../apex-llm-engine.ts";
import { ensureCleanCarbonHome } from "./apex-fleet-sync.ts";
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
 * Native CLI / ACP Harness Driver (`antigravity-acp`, `claude-cli`, `codex-cli`, `gemini-cli`, `opencode-cli`).
 */
export class NativeCliHarnessDriver implements ApexDriver {
  readonly id: string;
  readonly displayName: string;
  readonly protocol = "cli-jsonl" as const;
  readonly capabilities: DriverCapabilities;
  private readonly dataDir: string;
  private readonly binaryName: string;
  private readonly defaultModels: string[];
  private readonly activeProcesses = new Map<string, ChildProcess>();

  constructor(options: {
    id: string;
    displayName: string;
    binaryName: string;
    dataDir: string;
    defaultModels: string[];
  }) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.binaryName = options.binaryName;
    this.dataDir = options.dataDir;
    this.defaultModels = options.defaultModels;
    this.capabilities = {
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsSubagents: true,
      supportsSessionResume: true,
      supportsNativeApproval: true,
      supportsReasoningEffort: true,
      maxContextTokens: 200_000,
    };
  }

  async initialize(): Promise<void> {
    ensureCleanCarbonHome(this.dataDir);
  }

  async healthCheck(): Promise<DriverHealthStatus> {
    const t0 = Date.now();
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
      messages: [],
    };
    savePersistedSession(this.dataDir, session);
    return session;
  }

  async resumeSession(sessionId: string): Promise<DriverSession> {
    const all = loadPersistedSessions(this.dataDir);
    const existing = all[sessionId];
    if (!existing) {
      throw new Error(`CLI session '${sessionId}' not found.`);
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

    const carbonHome = ensureCleanCarbonHome(this.dataDir);
    const args =
      this.binaryName === "claude"
        ? ["-p", input.prompt, "--output-format", "stream-json", "--verbose"]
        : this.binaryName === "codex"
          ? ["exec", "--skip-git-repo-check", input.prompt]
          : ["-p", input.prompt];

    return new Promise<DriverTurnResult>((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      let child: ChildProcess;
      try {
        child = spawn(this.binaryName, args, {
          cwd: session.workspaceRoot,
          env: {
            ...process.env,
            HOME: carbonHome,
            USERPROFILE: carbonHome,
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
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
          error: (err as Error).message,
        });
        return;
      }

      this.activeProcesses.set(sessionId, child);
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill();
        }
      }, input.timeoutMs ?? 20_000);

      if (input.signal) {
        input.signal.addEventListener(
          "abort",
          () => {
            child.kill();
          },
          { once: true },
        );
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeProcesses.delete(sessionId);
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
        this.activeProcesses.delete(sessionId);
        const parsed = NativeCliJsonlProtocolAdapter.parseJsonlLines(stdout.split(/\r?\n/));
        const ok = code === 0 && Boolean(parsed.visibleText || parsed.toolCalls.length > 0);
        resolvePromise({
          ok,
          driverId: this.id,
          sessionId,
          modelId: session.modelId,
          text: parsed.visibleText,
          normalizedTurn: parsed,
          latencyMs: Date.now() - t0,
          error: ok ? undefined : stderr.trim() || `CLI exited with code ${code}`,
        });
      });
    });
  }

  async streamEvents(
    sessionId: string,
    input: DriverTurnInput,
    onEvent: (ev: DriverStreamEvent) => void,
  ): Promise<DriverTurnResult> {
    const res = await this.sendMessage(sessionId, input);
    if (res.text) onEvent({ type: "delta", text: res.text });
    onEvent({ type: res.ok ? "complete" : "error", turn: res.normalizedTurn, error: res.error });
    return res;
  }

  async interrupt(sessionId: string): Promise<void> {
    this.activeProcesses.get(sessionId)?.kill("SIGINT");
  }

  async cancel(sessionId: string): Promise<void> {
    this.activeProcesses.get(sessionId)?.kill();
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
      proc.kill();
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
        displayName: "Antigravity ACP Driver",
        binaryName: "agy",
        defaultModels: ["agy-acp/gemini-4-argon-high", "agy-acp/claude-opus-4-6-thinking"],
      },
      {
        id: "cli:claude-cli",
        displayName: "Claude Code CLI Driver",
        binaryName: "claude",
        defaultModels: ["claude-cli/claude-sonnet-4-6", "claude-cli/claude-opus-4-6"],
      },
      {
        id: "cli:codex-cli",
        displayName: "Codex App-Server Driver",
        binaryName: "codex",
        defaultModels: ["codex/gpt-5.4", "codex/gpt-5.3-codex"],
      },
      {
        id: "cli:gemini-cli",
        displayName: "Gemini CLI Driver",
        binaryName: "gemini",
        defaultModels: ["gemini-cli/gemini-3.1-pro", "gemini-cli/gemini-3-flash"],
      },
      {
        id: "cli:opencode-cli",
        displayName: "OpenCode CLI Driver",
        binaryName: "opencode",
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
    if (lower.includes("gemini")) return this.drivers.get("http:google-gemini") ?? this.drivers.values().next().value;
    return this.drivers.get("http:omniroute-local") ?? this.drivers.values().next().value;
  }

  async checkAllDriversHealth(): Promise<DriverHealthStatus[]> {
    const list = this.listDrivers();
    return Promise.all(list.map((d) => d.healthCheck()));
  }
}
