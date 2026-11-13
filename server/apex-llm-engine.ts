// Real Multi-Gateway LLM & Agentic Tool-Loop Engine for the Apex Harness App.
// Connects to custom_models.json, model-matrix.json (KiloCode, NVIDIA NIM, OpenRouter, FreeLLMAPI :3001,
// OmniRoute :20128, Gemini Web :8765), and executes real workspace tools (list_dir, read_file, write_file,
// edit_file, grep_search, run_command) with live SSE step callbacks and automatic model failover.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { callMcpServerTool } from "./harness/mcp-client-bridge.ts";
import { parseAndScrubModelResponse } from "./harness/universal-tool-parser.ts";

export type AgentOfficeRole =
  | "Coordinator"
  | "Scout"
  | "Architect"
  | "Builder"
  | "Critic"
  | "Verifier";

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
  error?: string;
}

async function callOpenAiCompatibleEndpoint(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  gatewayName: string;
  userAgent?: string;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const t0 = Date.now();
  const cleanBase = options.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  const url = `${cleanBase}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": options.userAgent || "Kilo-Code/5.10.0",
  };
  if (options.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }
  if (options.gatewayName === "openrouter" || cleanBase.includes("openrouter")) {
    headers["HTTP-Referer"] = "https://kilocode.ai";
    headers["X-Title"] = "Kilo Code";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 35_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        max_tokens: 4096,
        temperature: 0.2,
      }),
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

    const data = JSON.parse(rawText) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = data.choices?.[0]?.message;
    const rawContent = (msg?.content || msg?.reasoning_content || "").trim();
    const cleaned = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() || rawContent;

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
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls the requested model first, and if its local proxy is asleep or rate-limited,
 * automatically fails over across the live gateways in `model-matrix.json` & `specialist_pool.json`.
 */
export async function callUnifiedFleetWithFailover(options: {
  preferredModelId: string;
  preferredBaseUrl?: string;
  preferredApiKey?: string;
  messages: Array<{ role: string; content: string }>;
}): Promise<LlmCallResult> {
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

  // 1. Try preferred endpoint if baseUrl is provided and not a local closed port, or try waking FreeLLMAPI
  if (gateways.freellmapi?.ensure_script) {
    ensureFreeLlmApiAwake(gateways.freellmapi.ensure_script);
  }

  const attempts: Array<{
    gatewayName: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    userAgent?: string;
  }> = [];

  // Map preferredModelId to a live gateway when possible
  const cleanModelId = options.preferredModelId
    .replace(/^agy-acp\//, "")
    .replace(/^models\//, "");

  if (options.preferredBaseUrl && !options.preferredBaseUrl.includes("local-gcm:")) {
    const gwMatch = options.preferredBaseUrl.includes(":20128")
      ? gateways.omniroute
      : options.preferredBaseUrl.includes(":8765")
        ? gateways.gemini_web
        : options.preferredBaseUrl.includes(":3001")
          ? gateways.freellmapi
          : undefined;
    const resolvedKey =
      options.preferredApiKey && !options.preferredApiKey.startsWith("local-gcm:")
        ? options.preferredApiKey
        : gwMatch?.default_api_key ?? "";
    attempts.push({
      gatewayName: "preferred",
      baseUrl: options.preferredBaseUrl,
      apiKey: resolvedKey,
      model: cleanModelId,
    });
  }

  // Add high-speed cloud & local candidates from model-matrix.json
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
      ( gw.default_api_key ?? "" );
    attempts.push({
      gatewayName: cand.gateway,
      baseUrl: gw.base_url,
      apiKey,
      model: cand.model,
      userAgent: gw.user_agent,
    });
  }

  let lastError = "No gateways configured";
  for (const attempt of attempts.slice(0, 6)) {
    const res = await callOpenAiCompatibleEndpoint({
      baseUrl: attempt.baseUrl,
      apiKey: attempt.apiKey,
      model: attempt.model,
      messages: options.messages,
      gatewayName: attempt.gatewayName,
      userAgent: attempt.userAgent,
      timeoutMs: attempt.baseUrl.includes("127.0.0.1") ? 6_000 : 28_000,
    });
    if (res.ok) {
      return res;
    }
    lastError = `${attempt.gatewayName}/${attempt.model}: ${res.error}`;
  }

  // Native Local CLI Driver Fallback (codex / claude / gemini)
  const cliFallback = callLocalCliDriverFallback(options.preferredModelId, options.messages);
  if (cliFallback.ok) {
    return cliFallback;
  }

  return {
    ok: false,
    text: "",
    usedModel: options.preferredModelId,
    usedGateway: "offline-fallback",
    latencyMs: 0,
    error: lastError,
  };
}

/**
 * Spawns local installed CLI agent binaries (`codex`, `claude`, `gemini`) non-interactively
 * when HTTP gateways are offline or when a native CLI driver is explicitly selected.
 */
export function callLocalCliDriverFallback(
  preferredModelId: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
): LlmCallResult {
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
    try {
      const proc = spawnSync(cand.bin, cand.args, {
        encoding: "utf8",
        timeout: 18_000,
        windowsHide: true,
        shell: process.platform === "win32",
      });
      const out = (proc.stdout ?? "").trim();
      if (proc.status === 0 && out.length > 0) {
        return {
          ok: true,
          text: out,
          usedModel: preferredModelId,
          usedGateway: cand.name,
          latencyMs: Date.now() - t0,
        };
      }
    } catch {
      // Try next CLI candidate
    }
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
 * while emitting real-time AgentStepEvents (just like Antigravity's "Explored files, ran commands" UI).
 */
export function gatherGroundedWorkspaceContext(
  workspaceRoot: string,
  prompt: string,
  onStep: (step: AgentStepEvent) => void,
): { contextBlock: string; steps: AgentStepEvent[] } {
  const steps: AgentStepEvent[] = [];
  const root = resolve(workspaceRoot);
  const emit = (step: AgentStepEvent) => {
    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx >= 0) steps[idx] = step;
    else steps.push(step);
    onStep(step);
  };

  if (!existsSync(root)) {
    return { contextBlock: `Workspace path ${root} does not exist yet.`, steps };
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

  // Check priority files + any file mentioned in prompt + top code entrypoints
  const priorityFiles = ["GATES.md", "README.md", "package.json", "pyproject.toml", "AGENTS.md"];
  const codeEntries = topEntries.filter((e) => /\.(?:py|ts|tsx|js|mjs|go|rs)$/i.test(e)).slice(0, 3);
  const promptFileMatches = prompt.match(/[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|mjs|py|json|md|html|css)/g) ?? [];
  const filesToRead = [...new Set([...promptFileMatches, ...priorityFiles, ...codeEntries])];

  let readCount = 0;
  for (const relCandidate of filesToRead) {
    if (readCount >= 4) break;
    const cleanRel = relCandidate.replace(/^[@/\\]+/, "");
    const fullPath = join(root, cleanRel);
    try {
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) continue;
      const tRead = Date.now();
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split(/\r?\n/);
      const maxLines = Math.min(lines.length, 75);
      const preview = lines.slice(0, maxLines).join("\n");
      const stepId = `step-read-${readCount}-${Date.now()}`;
      readCount += 1;
      const relName = relative(root, fullPath) || cleanRel;
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
      // Ignore unreadable file
    }
  }

  return {
    contextBlock: snippets.join("\n\n"),
    steps,
  };
}

export interface ToolExecutionAction {
  tool: "write_file" | "edit_file" | "read_file" | "grep_search" | "run_command" | "call_mcp_tool";
  path?: string;
  content?: string;
  target?: string;
  replacement?: string;
  startLine?: number;
  endLine?: number;
  pattern?: string;
  command?: string;
  serverName?: string;
  toolName?: string;
  args?: Record<string, unknown>;
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
    const restored: string[] = [];
    for (const f of cp.files) {
      if (f.existedBefore && typeof f.previousContent === "string") {
        mkdirSync(dirname(f.fullPath), { recursive: true });
        writeFileSync(f.fullPath, f.previousContent, "utf8");
        restored.push(f.fullPath);
      } else if (!f.existedBefore && existsSync(f.fullPath)) {
        rmSync(f.fullPath, { force: true });
        restored.push(`${f.fullPath} (removed new file)`);
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

/**
 * Synchronous + Asynchronous Agent Tool Block Executor:
 * Executes `write_file`, `edit_file`, `read_file`, `grep_search`, `run_command`, and `call_mcp_tool`
 * emitted inside ```apex-action blocks, records pre-edit file snapshots for 1-click undo,
 * and returns structured `toolObservations` for the multi-step ReAct loop.
 */
export async function executeAgentToolBlocksAsync(
  arg1:
    | string
    | {
        responseText: string;
        workspaceRoot: string;
        dataDir?: string;
        checkpointId?: string;
        onStep: (step: AgentStepEvent) => void;
      },
  workspaceRootArg?: string,
  onStepArg?: (step: AgentStepEvent) => void,
  extraOpts?: { dataDir?: string; conversationId?: string; checkpointId?: string },
): Promise<{
  cleanedResponse: string;
  executedSteps: AgentStepEvent[];
  toolObservations: string[];
  checkpoint?: TurnCheckpoint;
  checkpointId?: string;
}> {
  const options =
    typeof arg1 === "string"
      ? {
          responseText: arg1,
          workspaceRoot: workspaceRootArg!,
          dataDir: extraOpts?.dataDir,
          checkpointId: extraOpts?.checkpointId,
          onStep: onStepArg!,
        }
      : arg1;
  const executedSteps: AgentStepEvent[] = [];
  const toolObservations: string[] = [];
  const root = resolve(options.workspaceRoot);
  const backups = new Map<string, FileBackupEntry>();

  const recordBackupIfNeeded = (targetPath: string) => {
    if (backups.has(targetPath)) return;
    if (existsSync(targetPath) && statSync(targetPath).isFile()) {
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
  };

  const resolveTargetPath = (rawPath: string): string => {
    const normalized = process.platform === "win32" ? rawPath.replace(/\//g, "\\") : rawPath;
    return resolve(root, normalized);
  };

  const parsedOutput = parseAndScrubModelResponse(options.responseText);
  let cleanedResponse = parsedOutput.visibleText;

  for (const action of parsedOutput.toolCalls) {
    const t0 = Date.now();
    try {
      if (action.tool === "write_file" && action.path && typeof action.content === "string") {
        const targetPath = resolveTargetPath(action.path);
        recordBackupIfNeeded(targetPath);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, action.content, "utf8");
        const rel = relative(root, targetPath) || action.path;
        const linesCount = action.content.split(/\r?\n/).length;
        const step: AgentStepEvent = {
          id: `step-write-${Date.now()}-${executedSteps.length}`,
          kind: "edit",
          agentRole: "Builder",
          label: `Created file ${rel}`,
          plainSummary: `Builder Agent wrote ${linesCount} lines to ${rel}`,
          detail: `${linesCount} lines · ${action.content.length} bytes`,
          outputPreview: action.content.slice(0, 1200),
          fileRef: rel,
          lineRange: `#L1-${linesCount}`,
          status: "done",
          durationMs: Date.now() - t0,
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
        const targetPath = resolveTargetPath(action.path);
        const rel = relative(root, targetPath) || action.path;
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
        const addedLines = action.replacement.split(/\r?\n/).length;
        const removedLines = action.target.split(/\r?\n/).length;
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
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[edit_file: ${rel}] Applied surgical patch (+${addedLines}/-${removedLines} lines).`);
        continue;
      }

      if (action.tool === "read_file" && action.path) {
        const targetPath = resolveTargetPath(action.path);
        const rel = relative(root, targetPath) || action.path;
        if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
          throw new Error(`File not found: ${rel}`);
        }
        const raw = readFileSync(targetPath, "utf8");
        const allLines = raw.split(/\r?\n/);
        const sLine = Math.max(1, action.startLine ?? 1);
        const eLine = Math.min(allLines.length, action.endLine ?? Math.min(allLines.length, sLine + 199));
        const slice = allLines.slice(sLine - 1, eLine).join("\n");
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
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[read_file: ${rel} #L${sLine}-${eLine}]\n${slice}`);
        continue;
      }

      if (action.tool === "list_dir") {
        const targetDir = action.path ? resolveTargetPath(action.path) : root;
        const rel = relative(root, targetDir) || ".";
        const entries = existsSync(targetDir) && statSync(targetDir).isDirectory()
          ? readdirSync(targetDir).filter((e) => !IGNORED_FOLDERS.has(e)).slice(0, 80)
          : [];
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
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[list_dir: ${rel}]\n${entries.join("\n")}`);
        continue;
      }

      const grepPattern = action.pattern || (action as { query?: string }).query;
      const grepRelPath = action.path || (action as { relDir?: string }).relDir;
      if (action.tool === "grep_search" && grepPattern) {
        const searchDir = grepRelPath ? resolveTargetPath(grepRelPath) : root;
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
              const st = statSync(p);
              if (st.isDirectory()) walk(p, depth + 1);
              else if (st.size < 200_000) {
                const lines = readFileSync(p, "utf8").split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                  if (rx.test(lines[i]!)) {
                    hits.push(`${relative(root, p)}:${i + 1}: ${lines[i]!.trim().slice(0, 140)}`);
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
        const step: AgentStepEvent = {
          id: `step-grep-${Date.now()}-${executedSteps.length}`,
          kind: "search",
          agentRole: "Scout",
          label: `Searched codebase for "${grepPattern}"`,
          plainSummary: `Scout Agent found ${hits.length} matches for "${grepPattern}"`,
          detail: `${hits.length} matches`,
          outputPreview: hits.join("\n") || "No matches found.",
          status: "done",
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[grep_search: ${grepPattern}]\n${hits.join("\n") || "No matches found."}`);
        continue;
      }

      if (action.tool === "todo_write" && Array.isArray(action.todos)) {
        const summary = action.todos.map((t) => `[${t.status}] ${t.content}`).join("\n");
        const step: AgentStepEvent = {
          id: `step-todo-${Date.now()}-${executedSteps.length}`,
          kind: "todo",
          agentRole: "Coordinator",
          label: `Updated task checklist (${action.todos.length} items)`,
          plainSummary: `Coordinator updated live execution checklist`,
          detail: `${action.todos.filter((t) => t.status === "completed").length}/${action.todos.length} completed`,
          outputPreview: summary,
          status: "done",
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[todo_write]\n${summary}`);
        continue;
      }

      if (action.tool === "repo_map") {
        const topFiles = readdirSync(root).filter((e) => !IGNORED_FOLDERS.has(e)).slice(0, 50);
        const step: AgentStepEvent = {
          id: `step-repomap-${Date.now()}-${executedSteps.length}`,
          kind: "read",
          agentRole: "Architect",
          label: `Generated repository map`,
          plainSummary: `Architect mapped ${topFiles.length} workspace modules`,
          detail: `${topFiles.length} modules`,
          outputPreview: topFiles.join("\n"),
          status: "done",
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[repo_map]\n${topFiles.join("\n")}`);
        continue;
      }

      if (action.tool === "run_command" && action.command) {
        const out = execSync(action.command, {
          cwd: root,
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        });
        const step: AgentStepEvent = {
          id: `step-cmd-${Date.now()}-${executedSteps.length}`,
          kind: "command",
          agentRole: "Builder",
          label: `Ran terminal command: ${action.command.slice(0, 55)}`,
          plainSummary: `Builder Agent executed command in terminal`,
          detail: out.trim().slice(0, 140) || "Completed (exit 0)",
          outputPreview: `$ ${action.command}\n${out.trim().slice(0, 1500)}`,
          status: "done",
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        options.onStep(step);
        toolObservations.push(`[run_command: ${action.command}]\n${out.trim().slice(0, 3000)}`);
        continue;
      }

      if (action.tool === "call_mcp_tool" && action.serverName && action.toolName) {
        const mcpRes = await callMcpServerTool({
          serverName: action.serverName,
          toolName: action.toolName,
          args: action.args ?? {},
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const step: AgentStepEvent = {
        id: `step-err-${Date.now()}-${executedSteps.length}`,
        kind: "command",
        agentRole: "Verifier",
        label: `Tool notice: ${msg}`,
        status: "error",
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
  };
}

export function executeAgentToolBlocks(
  responseText: string,
  workspaceRoot: string,
  onStep: (step: AgentStepEvent) => void,
): { cleanedResponse: string; executedSteps: AgentStepEvent[] } {
  const executedSteps: AgentStepEvent[] = [];
  const root = resolve(workspaceRoot);
  const regex = /```apex-action\r?\n([\s\S]*?)```/g;

  const cleanedResponse = responseText.replace(regex, (fullMatch, jsonBlock: string) => {
    try {
      const action = JSON.parse(jsonBlock.trim()) as ToolExecutionAction;
      const t0 = Date.now();
      if (action.tool === "write_file" && action.path && typeof action.content === "string") {
        const targetPath = resolve(root, action.path);
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
        const targetPath = resolve(root, action.path);
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
      if (action.tool === "run_command" && action.command) {
        const out = execSync(action.command, {
          cwd: root,
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
        });
        const step: AgentStepEvent = {
          id: `step-cmd-${Date.now()}-${executedSteps.length}`,
          kind: "command",
          label: `Ran ${action.command.slice(0, 60)}`,
          detail: out.trim().slice(0, 300),
          status: "done",
          durationMs: Date.now() - t0,
        };
        executedSteps.push(step);
        onStep(step);
        return `\n\`\`\`text\n$ ${action.command}\n${out.trim().slice(0, 1200)}\n\`\`\`\n`;
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
