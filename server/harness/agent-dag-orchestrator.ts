// Milestone 3 (Parts 6, 7 & 8):
// 1. Configurable Multi-Protocol Provider Manager with AES-256-GCM Secret Vault & Connection Tester
// 2. 10-Role Engineering Model Routing Table & Capability-Aware Selector
// 3. Real Multi-Agent DAG Execution Engine (Coordinator -> [Scout || Architect] -> Builder -> Critic -> Verifier)
//    with parallel independent subtask execution, pause/cancel/approval propagation, bounded EGM correction cycles,
//    and structured CompletionEvidenceReport generation.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  AgentExecutionNode,
  AgentOfficeRole,
  CompletionEvidenceReport,
  DagTopologyMode,
  EngineeringRole10,
  ExecutedCommandEvidence,
  ExecutionRecord,
  NodeLifecycleEventType,
  PostImplReviewReport,
  ProviderConfigEntry,
  ProviderProtocol,
  RoleRoutingAssignment,
} from "../../shared/apex-contracts.ts";
import {
  callProviderEndpoint,
  callUnifiedFleetWithFailover,
  executeAgentToolBlocksAsync,
  gatherGroundedWorkspaceContext,
  type AgentStepEvent,
} from "../apex-llm-engine.ts";
import {
  buildOrchestrationPlan,
  classifyTaskPrompt,
  evaluateCompletedTurn,
  loadScoreboard,
  type OrchestrationPlan,
} from "../decider/apex-orchestrator-router.ts";
import {
  loadUnifiedModelFleet,
  type ModelDomain,
  type UnifiedModelEntry,
} from "./apex-fleet-sync.ts";
import {
  buildCompletionEvidenceReport,
  captureWorkspaceGitDiffSummary,
  classifyVerificationFromCommands,
  detectProjectVerificationCommands,
} from "./completion-evidence.ts";
import { applySpillPolicyToText, executePtcProgram } from "./deepseek-subsystems.ts";
import { ApexDriverRegistry } from "./driver-registry.ts";
import {
  buildDesk1GroundedManifest,
  runEgmBoardroomConference,
  runPostImplementationEgmReview,
  selectIndependentGoldfishModel,
  type EgmBoardroomBrief,
} from "./egm-boardroom.ts";
import type { TaskExecutionManager } from "./execution-manager.ts";
import {
  delegateParallelSubagentSwarm,
  delegateSubagentTask,
  promoteLearnedSkillProposal,
  proposeLearnedSkill,
  saveMemoryEntry,
  validateLearnedSkillProposal,
  type SubagentDelegationRequest,
  type SubagentDelegationResult,
} from "./hermes-memory-learning.ts";
import { runManagedCommand } from "./process-manager.ts";
import {
  decryptSecretWithMasterKey,
  encryptSecretWithMasterKey,
  type EncryptedVaultRecord,
} from "./secret-store.ts";
import { parseAndScrubModelResponse } from "./universal-tool-parser.ts";
import { estimateSkillTokens, discoverAllUniversalSkills } from "./universal-skill-loader.ts";
import { condenseConversationTrajectory } from "./workspace-runtime.ts";

// ============================================================================
// PART 7: CONFIGURABLE PROVIDER MANAGER & ENCRYPTED SECRET VAULT
// ============================================================================

const DEFAULT_PROVIDERS: ReadonlyArray<ProviderConfigEntry> = [
  {
    id: "omniroute-local",
    name: "OmniRoute Local Gateway (:20128)",
    protocol: "omniroute",
    baseUrl: process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1",
    apiKeyEnv: "OMNIROUTE_API_KEY",
    hasStoredSecret: false,
    enabled: true,
    priority: 1,
    timeoutMs: 30_000,
    defaultModels: [
      "agy-acp/gemini-4-argon-high",
      "agy-acp/claude-opus-4-6-thinking",
      "codex/gpt-5.4",
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "freellmapi-local",
    name: "FreeLLMAPI Multi-Provider Mesh (:8765)",
    protocol: "freellmapi",
    baseUrl: process.env.FREELLM_BASE_URL || "http://127.0.0.1:8765/v1",
    apiKeyEnv: "FREELLM_API_KEY",
    hasStoredSecret: false,
    enabled: true,
    priority: 2,
    timeoutMs: 30_000,
    defaultModels: [
      "nvidia_nim/nvidia/nemotron-3-ultra-550b-a50b",
      "nvidia_nim/qwen/qwen3.5-397b-a17b",
      "openrouter/google/gemma-4-31b-it:free",
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "openai-direct",
    name: "OpenAI Compatible API",
    protocol: "openai-compat",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    hasStoredSecret: Boolean(process.env.OPENAI_API_KEY),
    enabled: Boolean(process.env.OPENAI_API_KEY),
    priority: 3,
    timeoutMs: 30_000,
    defaultModels: ["gpt-5.4", "gpt-4.1"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "anthropic-direct",
    name: "Anthropic Messages API",
    protocol: "anthropic-compat",
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    hasStoredSecret: Boolean(process.env.ANTHROPIC_API_KEY),
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    priority: 4,
    timeoutMs: 30_000,
    defaultModels: ["claude-opus-4-6-thinking", "claude-sonnet-4-6-thinking"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "gemini-direct",
    name: "Google Gemini API",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    hasStoredSecret: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    enabled: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    priority: 5,
    timeoutMs: 30_000,
    defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "openrouter-direct",
    name: "OpenRouter API",
    protocol: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    hasStoredSecret: Boolean(process.env.OPENROUTER_API_KEY),
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
    priority: 6,
    timeoutMs: 30_000,
    defaultModels: ["google/gemma-4-31b-it:free", "qwen/qwen3-coder:free"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "local-ollama",
    name: "Local Ollama / LM Studio (:11434)",
    protocol: "local-ollama",
    baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
    hasStoredSecret: false,
    enabled: true,
    priority: 7,
    timeoutMs: 25_000,
    defaultModels: ["qwen2.5-coder:14b", "llama3.3:latest"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "local-cli-engines",
    name: "Local CLI Drivers (codex / claude / gemini / opencode)",
    protocol: "cli",
    baseUrl: "cli://local",
    hasStoredSecret: false,
    enabled: true,
    priority: 8,
    timeoutMs: 35_000,
    defaultModels: ["codex-cli", "claude-cli", "gemini-cli"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function secretsVaultPath(dataDir: string): string {
  return join(resolve(dataDir), "apex-provider-secrets.enc.json");
}

function providersConfigPath(dataDir: string): string {
  return join(resolve(dataDir), "apex-providers.json");
}

type EncryptedSecretRecord = EncryptedVaultRecord;

function loadSecretVault(dataDir: string): Record<string, EncryptedSecretRecord> {
  const path = secretsVaultPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, EncryptedSecretRecord>;
  } catch {
    return {};
  }
}

export function storeEncryptedProviderSecret(
  dataDir: string,
  providerId: string,
  rawSecret: string,
): void {
  const vault = loadSecretVault(dataDir);
  vault[providerId] = encryptSecretWithMasterKey(dataDir, rawSecret);
  const path = secretsVaultPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(vault, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function resolveProviderSecret(dataDir: string, provider: ProviderConfigEntry): string {
  const vault = loadSecretVault(dataDir);
  const rec = vault[provider.id];
  if (rec) {
    const res = decryptSecretWithMasterKey(dataDir, rec);
    if (res) {
      if (res.migratedFromLegacy) {
        try {
          storeEncryptedProviderSecret(dataDir, provider.id, res.plaintext);
        } catch {
          // Best-effort re-encryption to CSPRNG master key
        }
      }
      return res.plaintext;
    }
  }
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) {
    return process.env[provider.apiKeyEnv]!;
  }
  return "";
}

export function loadProviderConfigs(dataDir: string): ProviderConfigEntry[] {
  const path = providersConfigPath(dataDir);
  const vault = loadSecretVault(dataDir);
  const map = new Map<string, ProviderConfigEntry>();

  for (const def of DEFAULT_PROVIDERS) {
    const hasEnv = Boolean(def.apiKeyEnv && process.env[def.apiKeyEnv]);
    map.set(def.id, {
      ...def,
      hasStoredSecret: Boolean(vault[def.id]) || hasEnv,
    });
  }

  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as ProviderConfigEntry[];
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (item && typeof item.id === "string") {
            const hasEnv = Boolean(item.apiKeyEnv && process.env[item.apiKeyEnv]);
            map.set(item.id, {
              ...item,
              hasStoredSecret: Boolean(vault[item.id]) || hasEnv || Boolean(item.hasStoredSecret),
            });
          }
        }
      }
    } catch {
      // Ignore malformed file
    }
  }

  return [...map.values()].sort((a, b) => a.priority - b.priority);
}

export function saveProviderConfig(
  dataDir: string,
  input: Partial<ProviderConfigEntry> & { id: string; apiKey?: string },
): ProviderConfigEntry {
  const existingList = loadProviderConfigs(dataDir);
  const existing = existingList.find((p) => p.id === input.id);

  if (input.apiKey && input.apiKey.trim()) {
    storeEncryptedProviderSecret(dataDir, input.id, input.apiKey.trim());
  }

  const vault = loadSecretVault(dataDir);
  const apiKeyEnv = input.apiKeyEnv ?? existing?.apiKeyEnv;
  const hasStoredSecret =
    Boolean(vault[input.id]) || Boolean(apiKeyEnv && process.env[apiKeyEnv]);

  const updated: ProviderConfigEntry = {
    id: input.id,
    name: input.name ?? existing?.name ?? input.id,
    protocol: (input.protocol ?? existing?.protocol ?? "openai-compat") as ProviderProtocol,
    baseUrl: (input.baseUrl ?? existing?.baseUrl ?? "http://127.0.0.1:11434/v1").replace(/\/+$/, ""),
    apiKeyEnv,
    hasStoredSecret,
    enabled: input.enabled ?? existing?.enabled ?? true,
    priority: input.priority ?? existing?.priority ?? existingList.length + 1,
    timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? 30_000,
    defaultModels: input.defaultModels ?? existing?.defaultModels ?? [],
    headers: input.headers ?? existing?.headers,
    updatedAt: new Date().toISOString(),
  };

  const merged = existingList.filter((p) => p.id !== updated.id);
  merged.push(updated);
  merged.sort((a, b) => a.priority - b.priority);

  const path = providersConfigPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return updated;
}

export function deleteProviderConfig(dataDir: string, providerId: string): boolean {
  const existingList = loadProviderConfigs(dataDir);
  const filtered = existingList.filter((p) => p.id !== providerId);
  if (filtered.length === existingList.length) return false;
  const path = providersConfigPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(filtered, null, 2)}\n`, "utf8");
  return true;
}

export async function testProviderConnection(
  dataDir: string,
  providerId: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  providerId: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  latencyMs: number;
  detectedModels: string[];
  message: string;
}> {
  const providers = loadProviderConfigs(dataDir);
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    return {
      ok: false,
      providerId,
      protocol: "openai-compat",
      baseUrl: "",
      latencyMs: 0,
      detectedModels: [],
      message: `Provider '${providerId}' not found`,
    };
  }

  const t0 = Date.now();
  if (provider.protocol === "cli") {
    const res = await runManagedCommand({
      command: "node --version",
      cwd: process.cwd(),
      timeoutMs: 4_000,
      signal,
      mode: "turbo",
    });
    return {
      ok: res.exitCode === 0,
      providerId: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      latencyMs: Date.now() - t0,
      detectedModels: provider.defaultModels,
      message: res.exitCode === 0 ? `Local CLI runtime available (${res.stdout.trim()})` : "CLI probe failed",
    };
  }

  const apiKey = resolveProviderSecret(dataDir, provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(provider.timeoutMs, 6_000));
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const modelsUrl =
      provider.protocol === "gemini"
        ? `${provider.baseUrl}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`
        : `${provider.baseUrl}/models`;

    const headers: Record<string, string> = { ...(provider.headers ?? {}) };
    if (apiKey && provider.protocol !== "gemini") {
      if (provider.protocol === "anthropic-compat") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.Authorization = `Bearer ${apiKey}`;
      }
    }

    const res = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (res.ok) {
      const data = (await res.json()) as {
        data?: Array<{ id?: string }>;
        models?: Array<{ name?: string }>;
      };
      const detected =
        data.data?.map((m) => m.id || "").filter(Boolean).slice(0, 15) ??
        data.models?.map((m) => m.name || "").filter(Boolean).slice(0, 15) ??
        provider.defaultModels;

      return {
        ok: true,
        providerId: provider.id,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        latencyMs: Date.now() - t0,
        detectedModels: detected.length > 0 ? detected : provider.defaultModels,
        message: `Connected (${res.status} OK, ${detected.length || provider.defaultModels.length} models)`,
      };
    }

    // Fallback ping via chat completion probe if /models is not exposed
    const testModel = provider.defaultModels[0] || "gpt-4.1";
    const probe = await callProviderEndpoint({
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey,
      model: testModel,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
      timeoutMs: 4_000,
      signal: controller.signal,
    });

    return {
      ok: probe.ok,
      providerId: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      latencyMs: Date.now() - t0,
      detectedModels: provider.defaultModels,
      message: probe.ok ? `Connected via inference probe (${testModel})` : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      providerId: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      latencyMs: Date.now() - t0,
      detectedModels: provider.defaultModels,
      message: `Unreachable: ${(err as Error).message.slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// PART 8: 10-ROLE CONFIGURABLE MODEL ROUTING TABLE
// ============================================================================

const DEFAULT_ROLE_ROUTING_TABLE: ReadonlyArray<RoleRoutingAssignment> = [
  {
    role: "main_planning",
    officeRole: "Coordinator",
    description: "Task decomposition, DAG synthesis, and multi-agent coordination",
    preferredModelId: "agy-acp/gemini-4-argon-high",
    fallbackModelIds: ["agy-acp/claude-opus-4-6-thinking", "codex/gpt-5.4"],
    requiredCapabilities: { tools: true, minContextWindow: 128_000 },
  },
  {
    role: "repo_exploration",
    officeRole: "Scout",
    description: "High-speed codebase symbol indexing, file discovery, and dependency mapping",
    preferredModelId: "agy-acp/gemini-3-flash-high",
    fallbackModelIds: ["openrouter/google/gemma-4-31b-it:free", "agy-acp/gemini-4-argon-high"],
    requiredCapabilities: { tools: true, minContextWindow: 200_000 },
  },
  {
    role: "architecture",
    officeRole: "Architect",
    description: "System architecture, contract design, and cross-module boundary verification",
    preferredModelId: "agy-acp/claude-opus-4-6-thinking",
    fallbackModelIds: [
      "nvidia_nim/nvidia/nemotron-3-ultra-550b-a50b",
      "agy-acp/gemini-4-argon-high",
    ],
    requiredCapabilities: { tools: true, minContextWindow: 128_000 },
  },
  {
    role: "frontend_impl",
    officeRole: "Builder",
    description: "UI components, CSS layouts, accessibility, and interactive frontend engineering",
    preferredModelId: "agy-acp/gemini-4-argon-high",
    fallbackModelIds: ["agy-acp/claude-sonnet-4-6-thinking", "codex/gpt-5.4"],
    requiredCapabilities: { tools: true, vision: true },
  },
  {
    role: "backend_impl",
    officeRole: "Builder",
    description: "Server APIs, process management, database schemas, and surgical code execution",
    preferredModelId: "codex/gpt-5.4",
    fallbackModelIds: ["agy-acp/claude-opus-4-6-thinking", "agy-acp/gemini-4-argon-high"],
    requiredCapabilities: { tools: true },
  },
  {
    role: "testing_verification",
    officeRole: "Verifier",
    description: "Automated unit/integration test authoring and test-runner verification",
    preferredModelId: "codex/gpt-5.4",
    fallbackModelIds: ["agy-acp/gemini-3-flash-high", "nvidia_nim/qwen/qwen3.5-397b-a17b"],
    requiredCapabilities: { tools: true },
  },
  {
    role: "code_review",
    officeRole: "Critic",
    description: "Independent post-implementation code review and regression detection",
    preferredModelId: "agy-acp/claude-opus-4-6-thinking",
    fallbackModelIds: [
      "nvidia_nim/nvidia/nemotron-3-ultra-550b-a50b",
      "codex/gpt-5.4",
    ],
    requiredCapabilities: { tools: true },
  },
  {
    role: "security_review",
    officeRole: "Critic",
    description: "Workspace containment, sandbox isolation, CSRF/Origin, and vulnerability auditing",
    preferredModelId: "agy-acp/gemini-4-argon-high",
    fallbackModelIds: ["nvidia_nim/qwen/qwen3.5-397b-a17b", "codex/gpt-5.4"],
    requiredCapabilities: { tools: true, unfiltered: true },
  },
  {
    role: "documentation",
    officeRole: "Builder",
    description: "Technical architecture documentation, setup guides, and API specifications",
    preferredModelId: "agy-acp/claude-sonnet-4-6-thinking",
    fallbackModelIds: ["agy-acp/gemini-3-flash-high", "openrouter/google/gemma-4-31b-it:free"],
    requiredCapabilities: { minContextWindow: 128_000 },
  },
  {
    role: "final_verification",
    officeRole: "Verifier",
    description: "Evidence-backed completion report assembly and acceptance gate sign-off",
    preferredModelId: "agy-acp/gemini-4-argon-high",
    fallbackModelIds: ["codex/gpt-5.4", "agy-acp/claude-opus-4-6-thinking"],
    requiredCapabilities: { tools: true },
  },
];

function roleRoutingPath(dataDir: string): string {
  return join(resolve(dataDir), "apex-role-routing.json");
}

export function loadRoleRoutingTable(dataDir: string): RoleRoutingAssignment[] {
  const path = roleRoutingPath(dataDir);
  const byRole = new Map<EngineeringRole10, RoleRoutingAssignment>();
  for (const item of DEFAULT_ROLE_ROUTING_TABLE) {
    byRole.set(item.role, { ...item, fallbackModelIds: [...item.fallbackModelIds] });
  }

  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as RoleRoutingAssignment[];
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (item && byRole.has(item.role)) {
            const base = byRole.get(item.role)!;
            byRole.set(item.role, {
              ...base,
              ...item,
              fallbackModelIds: Array.isArray(item.fallbackModelIds)
                ? item.fallbackModelIds
                : base.fallbackModelIds,
            });
          }
        }
      }
    } catch {
      // Ignore malformed file
    }
  }

  return [...byRole.values()];
}

export function saveRoleRoutingTable(
  dataDir: string,
  overrides: ReadonlyArray<Partial<RoleRoutingAssignment> & { role: EngineeringRole10 }>,
): RoleRoutingAssignment[] {
  const current = loadRoleRoutingTable(dataDir);
  const byRole = new Map<EngineeringRole10, RoleRoutingAssignment>(
    current.map((r) => [r.role, r]),
  );

  for (const patch of overrides) {
    const existing = byRole.get(patch.role);
    if (!existing) continue;
    byRole.set(patch.role, {
      ...existing,
      preferredModelId: patch.preferredModelId ?? existing.preferredModelId,
      fallbackModelIds: patch.fallbackModelIds ?? existing.fallbackModelIds,
      requiredCapabilities: {
        ...existing.requiredCapabilities,
        ...(patch.requiredCapabilities ?? {}),
      },
    });
  }

  const updated = [...byRole.values()];
  const path = roleRoutingPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

const ROLE_TO_DOMAIN: Record<EngineeringRole10, ModelDomain> = {
  main_planning: "architecture",
  repo_exploration: "deep_repo_audit",
  architecture: "architecture",
  frontend_impl: "frontend_ui",
  backend_impl: "surgical_code",
  testing_verification: "debugging",
  code_review: "debugging",
  security_review: "security_audit",
  documentation: "fast_triage",
  final_verification: "surgical_code",
};

/**
 * Selects the optimal model and fallback chain for a specific 10-Role Engineering Role,
 * respecting user overrides, capability constraints, and EMA domain scores.
 */
export function selectModelForEngineeringRole(
  dataDir: string,
  role: EngineeringRole10,
  options: {
    manualOverrideModelId?: string;
    requiresVision?: boolean;
    requiresUnfiltered?: boolean;
  } = {},
): {
  assignment: RoleRoutingAssignment;
  primaryModel: UnifiedModelEntry;
  fallbackModels: UnifiedModelEntry[];
} {
  const fleet = loadUnifiedModelFleet();
  const board = loadScoreboard(dataDir, fleet);
  const table = loadRoleRoutingTable(dataDir);
  const assignment =
    table.find((r) => r.role === role) ?? DEFAULT_ROLE_ROUTING_TABLE[0]!;

  const domain = ROLE_TO_DOMAIN[role];
  const needsVision = Boolean(options.requiresVision || assignment.requiredCapabilities.vision);
  const needsUnfiltered = Boolean(
    options.requiresUnfiltered || assignment.requiredCapabilities.unfiltered,
  );
  const minCtx = assignment.requiredCapabilities.minContextWindow ?? 0;

  const eligible = fleet.filter((m) => {
    if (options.manualOverrideModelId && m.id === options.manualOverrideModelId) return true;
    if (needsUnfiltered && m.strictFirewall) return false;
    if (needsVision && !m.supportsVision) return false;
    if (minCtx > 0 && m.contextWindow < minCtx) return false;
    return true;
  });

  const pool = eligible.length > 0 ? eligible : fleet;
  const preferredId =
    options.manualOverrideModelId && options.manualOverrideModelId !== "auto"
      ? options.manualOverrideModelId
      : assignment.preferredModelId;

  const ranked = [...pool].sort((a, b) => {
    if (a.id === preferredId) return -1;
    if (b.id === preferredId) return 1;
    const aFallbackIdx = assignment.fallbackModelIds.indexOf(a.id);
    const bFallbackIdx = assignment.fallbackModelIds.indexOf(b.id);
    if (aFallbackIdx !== -1 && bFallbackIdx === -1) return -1;
    if (bFallbackIdx !== -1 && aFallbackIdx === -1) return 1;
    if (aFallbackIdx !== -1 && bFallbackIdx !== -1) return aFallbackIdx - bFallbackIdx;

    const scoreA = board.entries[a.id]?.domainScores[domain] ?? a.baseEmaScore;
    const scoreB = board.entries[b.id]?.domainScores[domain] ?? b.baseEmaScore;
    return scoreB - scoreA;
  });

  return {
    assignment,
    primaryModel: ranked[0]!,
    fallbackModels: ranked.slice(1, 4),
  };
}

// ============================================================================
// PART 6: REAL MULTI-AGENT DAG TASK-GRAPH ORCHESTRATOR
// ============================================================================

/**
 * Validates that a task graph contains no missing dependencies or circular cycles.
 */
export function detectDagCycle(nodes: readonly AgentExecutionNode[]): {
  valid: boolean;
  cyclePath?: string[];
  missingDependency?: string;
} {
  const byId = new Map<string, AgentExecutionNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        return { valid: false, missingDependency: `${node.id} -> ${dep}` };
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const pathStack: string[] = [];

  function dfs(nodeId: string): boolean {
    visiting.add(nodeId);
    pathStack.push(nodeId);

    const node = byId.get(nodeId)!;
    for (const depId of node.dependsOn) {
      if (visiting.has(depId)) {
        pathStack.push(depId);
        return true;
      }
      if (!visited.has(depId)) {
        if (dfs(depId)) return true;
      }
    }

    visiting.delete(nodeId);
    pathStack.pop();
    visited.add(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      if (dfs(node.id)) {
        return { valid: false, cyclePath: [...pathStack] };
      }
    }
  }

  return { valid: true };
}

/**
 * Builds the 6-Agent Execution DAG for a user request, assigning each agent its specialized
 * 10-role engineering role, model, context budget, mounted skills, and explicit dependency edges.
 *
 * DAG Topology:
 *   node-coordinator
 *      ├──> node-scout      (parallel layer 1)
 *      └──> node-architect  (parallel layer 1)
 *              └──> node-builder (waits for both Scout + Architect)
 *                      └──> node-critic
 *                              └──> node-verifier
 */
export function determineDagTopologyMode(
  prompt: string,
  options: { isIndependent?: boolean; adaptiveTopology?: boolean } = {},
): DagTopologyMode {
  if (!options.adaptiveTopology && !options.isIndependent) {
    return "full_engineering";
  }
  const trimmed = prompt.trim();
  const hasEngineeringIntent =
    /\b(file|code|repo|project|fix|bug|test|build|refactor|implement|audit|security|function|class|module|server|ui|git|diff|edit|write|create)\b/i.test(
      trimmed,
    );
  if (options.isIndependent && !hasEngineeringIntent) {
    return "fast_path";
  }
  if (
    options.adaptiveTopology &&
    trimmed.length < 80 &&
    !hasEngineeringIntent &&
    /^(hi|hello|hey|what\s+is|who\s+are|ping|thanks|thank\s+you|\d+\s*[+\-*/]\s*\d+)/i.test(trimmed)
  ) {
    return "fast_path";
  }
  const classification = classifyTaskPrompt(trimmed);
  if (
    options.adaptiveTopology &&
    (classification.complexity === "trivial" ||
      (classification.complexity === "moderate" &&
        !/\b(refactor|implement|rewrite|migrate)\b/i.test(trimmed))) &&
    !/\b(architecture|design|boardroom|audit|security|multi-agent)\b/i.test(trimmed)
  ) {
    return "standard";
  }
  return "full_engineering";
}

export function buildExecutionDag(input: {
  dataDir: string;
  prompt: string;
  preferredModelId?: string;
  mountedSkills: string[];
  executionId?: string;
  isIndependent?: boolean;
  adaptiveTopology?: boolean;
}): AgentExecutionNode[] {
  const classification = classifyTaskPrompt(input.prompt);
  const topologyMode = determineDagTopologyMode(input.prompt, {
    isIndependent: input.isIndependent,
    adaptiveTopology: input.adaptiveTopology,
  });
  const execPrefix = input.executionId || "dag";
  const nowIso = new Date().toISOString();
  const manualOverride =
    input.preferredModelId && input.preferredModelId !== "auto"
      ? input.preferredModelId
      : undefined;

  const builderEngRole: EngineeringRole10 =
    classification.primaryDomain === "frontend_ui"
      ? "frontend_impl"
      : classification.primaryDomain === "fast_triage" &&
          /\b(doc|readme|markdown|guide)\b/i.test(input.prompt)
        ? "documentation"
        : "backend_impl";

  const criticEngRole: EngineeringRole10 =
    classification.requiresUnfiltered || classification.primaryDomain === "security_audit"
      ? "security_review"
      : "code_review";

  const coordModel = selectModelForEngineeringRole(input.dataDir, "main_planning", {
    manualOverrideModelId: manualOverride,
  });
  const scoutModel = selectModelForEngineeringRole(input.dataDir, "repo_exploration");
  const archModel = selectModelForEngineeringRole(input.dataDir, "architecture");
  const builderModel = selectModelForEngineeringRole(input.dataDir, builderEngRole, {
    manualOverrideModelId: manualOverride,
    requiresVision: classification.requiresVision,
    requiresUnfiltered: classification.requiresUnfiltered,
  });
  const criticModel = selectModelForEngineeringRole(input.dataDir, criticEngRole, {
    requiresUnfiltered: classification.requiresUnfiltered,
  });
  const verifierModel = selectModelForEngineeringRole(input.dataDir, "final_verification");

  const skipScout = topologyMode === "fast_path";
  const skipArchitect = topologyMode === "fast_path" || topologyMode === "standard";
  const skipCritic = topologyMode === "fast_path";

  const builderDeps =
    topologyMode === "fast_path"
      ? ["node-coordinator"]
      : topologyMode === "standard"
        ? ["node-scout"]
        : ["node-scout", "node-architect"];

  const verifierDeps = skipCritic ? ["node-builder"] : ["node-critic"];

  const nodes: AgentExecutionNode[] = [
    {
      id: "node-coordinator",
      role: "Coordinator",
      engineeringRole: "main_planning",
      assignedTask: `Classify request domain (${topologyMode}), assign specialist models, and mount context-budgeted skills`,
      assignedModelId: coordModel.primaryModel.id,
      driverId: `${coordModel.primaryModel.provider}:${coordModel.primaryModel.driver}`,
      sessionId: `sess_${execPrefix}_node-coordinator`,
      retryCount: 0,
      maxRetries: 1,
      capabilities: ["task_classification", "dag_scheduling", "skill_budgeting"],
      contextBudgetTokens: 16_000,
      mountedSkills: input.mountedSkills,
      toolPermissions: ["read"],
      state: "queued",
      dependsOn: [],
      events: [{ type: "queued", timestamp: nowIso, detail: `Topology: ${topologyMode}` }],
    },
    {
      id: "node-scout",
      role: "Scout",
      engineeringRole: "repo_exploration",
      assignedTask: "Scan canonical workspace files, extract AST symbols, and load operational memory",
      assignedModelId: scoutModel.primaryModel.id,
      driverId: `${scoutModel.primaryModel.provider}:${scoutModel.primaryModel.driver}`,
      sessionId: `sess_${execPrefix}_node-scout`,
      retryCount: 0,
      maxRetries: 1,
      capabilities: ["ast_symbol_indexing", "file_discovery", "memory_recall"],
      contextBudgetTokens: 32_000,
      mountedSkills: input.mountedSkills.slice(0, 2),
      toolPermissions: ["read", "mcp"],
      state: skipScout ? "skipped" : "queued",
      outputSummary: skipScout ? "Skipped on fast_path (no repository scan required)" : undefined,
      dependsOn: ["node-coordinator"],
      parentTaskId: "node-coordinator",
      events: [
        {
          type: skipScout ? "skipped" : "queued",
          timestamp: nowIso,
          detail: skipScout ? "Bypassed on fast_path" : "Queued for parallel exploration",
        },
      ],
    },
    {
      id: "node-architect",
      role: "Architect",
      engineeringRole: "architecture",
      assignedTask: "Run 4 stateless Goldfish specialist lenses and synthesize architectural constraints",
      assignedModelId: archModel.primaryModel.id,
      driverId: `${archModel.primaryModel.provider}:${archModel.primaryModel.driver}`,
      sessionId: `sess_${execPrefix}_node-architect`,
      retryCount: 0,
      maxRetries: 1,
      capabilities: ["egm_4_lenses", "contract_design", "boundary_analysis"],
      contextBudgetTokens: 32_000,
      mountedSkills: input.mountedSkills,
      toolPermissions: ["read"],
      state: skipArchitect ? "skipped" : "queued",
      outputSummary: skipArchitect
        ? `Skipped on ${topologyMode} topology`
        : undefined,
      dependsOn: ["node-coordinator"],
      parentTaskId: "node-coordinator",
      events: [
        {
          type: skipArchitect ? "skipped" : "queued",
          timestamp: nowIso,
          detail: skipArchitect ? `Bypassed on ${topologyMode}` : "Queued for EGM Desk 1-3",
        },
      ],
    },
    {
      id: "node-builder",
      role: "Builder",
      engineeringRole: builderEngRole,
      assignedTask: "Create safety checkpoint, execute workspace tools, and synthesize implementation",
      assignedModelId: builderModel.primaryModel.id,
      driverId: `${builderModel.primaryModel.provider}:${builderModel.primaryModel.driver}`,
      sessionId: `sess_${execPrefix}_node-builder`,
      retryCount: 0,
      maxRetries: 1,
      capabilities: ["file_read_write", "managed_command_exec", "ptc_sandbox", "mcp_tools", "subagent_delegation"],
      contextBudgetTokens: 64_000,
      mountedSkills: input.mountedSkills,
      toolPermissions: ["read", "write", "command", "mcp", "ptc", "subagent"],
      state: "queued",
      dependsOn: builderDeps,
      parentTaskId: "node-coordinator",
      events: [{ type: "queued", timestamp: nowIso }],
    },
    {
      id: "node-critic",
      role: "Critic",
      engineeringRole: criticEngRole,
      assignedTask: "Perform independent post-implementation EGM review of code diffs and command outputs",
      assignedModelId: criticModel.primaryModel.id,
      driverId: `${criticModel.primaryModel.provider}:${criticModel.primaryModel.driver}`,
      sessionId: `sess_${execPrefix}_node-critic`,
      retryCount: 0,
      maxRetries: 1,
      capabilities: ["post_impl_egm_audit", "defect_detection", "correction_loop"],
      contextBudgetTokens: 32_000,
      mountedSkills: input.mountedSkills.slice(0, 2),
      toolPermissions: ["read"],
      state: skipCritic ? "skipped" : "queued",
      outputSummary: skipCritic ? "Skipped on fast_path (no code mutation)" : undefined,
      dependsOn: ["node-builder"],
      parentTaskId: "node-builder",
      events: [
        {
          type: skipCritic ? "skipped" : "queued",
          timestamp: nowIso,
        },
      ],
    },
    {
      id: "node-verifier",
      role: "Verifier",
      engineeringRole: "final_verification",
      assignedTask: "Verify test/build evidence, update EMA model scoreboard, and assemble CompletionEvidenceReport",
      assignedModelId: verifierModel.primaryModel.id,
      driverId: `${verifierModel.primaryModel.provider}:${verifierModel.primaryModel.driver}`,
      sessionId: `sess_${execPrefix}_node-verifier`,
      retryCount: 0,
      maxRetries: 1,
      capabilities: ["evidence_verification", "ema_scoreboard_update", "completion_report"],
      contextBudgetTokens: 16_000,
      mountedSkills: [],
      toolPermissions: ["read", "command"],
      state: "queued",
      dependsOn: verifierDeps,
      parentTaskId: skipCritic ? "node-builder" : "node-critic",
      events: [{ type: "queued", timestamp: nowIso }],
    },
  ];

  const validation = detectDagCycle(nodes);
  if (!validation.valid) {
    throw new Error(
      `Invalid execution DAG: ${validation.cyclePath?.join(" -> ") || validation.missingDependency}`,
    );
  }

  return nodes;
}

export interface ExecuteTaskDagOptions {
  executionManager: TaskExecutionManager;
  executionId: string;
  dataDir: string;
  workspaceRoot: string;
  prompt: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  preferredModelId?: string;
  effort?: "high" | "medium" | "low";
  mode?: "turbo" | "auto_edit" | "ask";
  isIndependent?: boolean;
  adaptiveTopology?: boolean;
  maxParallelNodes?: number;
  systemPromptPrefix?: string;
  memorySnippet?: string;
  maxCorrectionCycles?: number;
  simulateReviewerUnavailable?: boolean;
  reviewerEndpointUrl?: string;
  reviewerProviderId?: string;
  reviewerModelId?: string;
  requireLiveGoldfishModel?: boolean;
  enableSubagentScout?: boolean;
  parallelSubagentTasks?: readonly SubagentDelegationRequest[];
  autoPromoteLearnedSkills?: boolean;
  driverRegistry?: ApexDriverRegistry;
  customBuilderFn?: (context: {
    prompt: string;
    workspaceRoot: string;
    correctionCycle: number;
    signal?: AbortSignal;
  }) => Promise<{
    responseText: string;
    usedModel?: string;
    usedGateway?: string;
    checkpointId?: string;
    filesInspected?: string[];
    filesCreated?: string[];
    filesModified?: string[];
    commandsExecuted?: ExecutedCommandEvidence[];
    toolsInvoked?: Array<{ tool: string; target?: string; status: "done" | "error"; durationMs: number }>;
  }>;
  onPlan?: (plan: OrchestrationPlan) => void;
  onEgmBrief?: (brief: EgmBoardroomBrief) => void;
  onNodeEvent?: (
    nodeId: string,
    event: { type: NodeLifecycleEventType; timestamp: string; detail?: string },
  ) => void;
  onStep?: (step: AgentStepEvent) => void;
  onDagUpdate?: (subtasks: AgentExecutionNode[], state: ExecutionRecord["state"]) => void;
}

export interface ExecuteTaskDagResult {
  executionRecord: ExecutionRecord;
  plan: OrchestrationPlan;
  dagTopologyMode: DagTopologyMode;
  egmPreBrief: EgmBoardroomBrief;
  postImplReview: PostImplReviewReport;
  completionReport: CompletionEvidenceReport;
  responseText: string;
  usedModel: string;
  usedGateway: string;
  checkpointId: string;
}

async function runBuilderCodingPass(input: {
  prompt: string;
  workspacePath: string;
  dataDir: string;
  executionId: string;
  sessionId?: string;
  driverRegistry?: ApexDriverRegistry;
  preferredModelId: string;
  transpiledSkillsBlock: string;
  systemPromptPrefix?: string;
  memorySnippet: string;
  isIndependent?: boolean;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  maxToolIterations: number;
  mode: "turbo" | "auto_edit" | "ask";
  signal?: AbortSignal;
  onToolStateChange?: (toolName?: string) => void;
  onApprovalRequest?: (info: {
    command: string;
    cwd: string;
    reason: string;
    classification: "read_only" | "workspace_mutation" | "dangerous";
  }) => Promise<boolean>;
  onStep: (step: AgentStepEvent) => void;
}): Promise<{
  responseText: string;
  usedModel: string;
  usedGateway: string;
  driverId: string;
  sessionId: string;
  checkpointId?: string;
  filesInspected: string[];
  filesCreated: string[];
  filesModified: string[];
  commandsExecuted: ExecutedCommandEvidence[];
  toolsInvoked: Array<{ tool: string; target?: string; status: "done" | "error"; durationMs: number }>;
  delegatedSubagents: NonNullable<CompletionEvidenceReport["delegatedSubagents"]>;
}> {
  const filesInspected = new Set<string>();
  const filesCreated = new Set<string>();
  const filesModified = new Set<string>();
  const commandsExecuted: ExecutedCommandEvidence[] = [];
  const toolsInvoked: Array<{ tool: string; target?: string; status: "done" | "error"; durationMs: number }> = [];
  const delegatedSubagents: NonNullable<CompletionEvidenceReport["delegatedSubagents"]> = [];
  let checkpointId: string | undefined;
  const registry =
    input.driverRegistry ??
    new ApexDriverRegistry(
      input.dataDir,
      loadProviderConfigs(input.dataDir),
      (p) => resolveProviderSecret(input.dataDir, p),
    );
  const builderSessionId = input.sessionId || `sess_${input.executionId.slice(0, 8)}_node-builder`;
  let usedDriverId = registry.resolveDriverForModel(input.preferredModelId)?.id ?? "http:omniroute-local";

  let contextBlock = "Independent General Chat Mode (No project repository bound).";
  if (!input.isIndependent) {
    const grounded = gatherGroundedWorkspaceContext(input.workspacePath, input.prompt, input.onStep);
    for (const f of grounded.inspectedFiles) filesInspected.add(f);
    const spilled = applySpillPolicyToText({
      dataDir: input.dataDir,
      sessionId: input.executionId,
      toolName: "workspace_context",
      content: grounded.contextBlock,
      maxInlineTokens: 2800,
    });
    contextBlock = spilled.text;
  }

  const systemContent = [
    "You are the Apex Harness Builder Agent.",
    input.systemPromptPrefix,
    input.isIndependent
      ? "Active Mode: Independent General Chat (not bound to a specific project folder unless the user provides a path)."
      : `Active Workspace: ${input.workspacePath}`,
    `Execution Mode: ${input.mode}`,
    input.transpiledSkillsBlock,
    input.memorySnippet,
    `--- GROUNDED WORKSPACE CONTEXT ---\n${contextBlock}`,
    input.mode !== "ask"
      ? `Emit executable tools inside \`\`\`apex-action JSON blocks when reading, editing, writing, delegating subagents, or running commands:\n- {"tool":"read_file","path":"rel/path.ts","startLine":1,"endLine":180}\n- {"tool":"list_dir","path":"."}\n- {"tool":"grep_search","query":"pattern","relDir":"."}\n- {"tool":"edit_file","path":"rel/path.ts","target":"old","replacement":"new"}\n- {"tool":"write_file","path":"rel/path.ts","content":"..."}\n- {"tool":"todo_write","todos":[{"content":"Task","status":"in_progress"}]}\n- {"tool":"run_command","command":"node --test"}\n- {"tool":"delegate_subagent","role":"Scout","task":"Focused exploration task"}\n- {"tool":"call_mcp_tool","serverName":"context7","toolName":"resolve-library-id","args":{"libraryName":"react"}}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const rawMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemContent },
    ...input.conversationHistory,
    { role: "user", content: input.prompt },
  ];
  const condensedInit = condenseConversationTrajectory({ messages: rawMessages });
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    ...condensedInit.messages,
  ];

  const narrativeSegments: string[] = [];
  let usedModel = input.preferredModelId;
  let usedGateway = "local";
  const maxIter = input.mode === "ask" ? 1 : Math.max(1, input.maxToolIterations);

  for (let iter = 0; iter < maxIter; iter++) {
    if (input.signal?.aborted) {
      throw new Error("Execution cancelled");
    }

    const llmRes = await registry.dispatchTurnWithFailover({
      sessionId: builderSessionId,
      workspaceRoot: input.workspacePath,
      preferredModelId: input.preferredModelId,
      prompt: input.prompt,
      messages,
      signal: input.signal,
      hasWorkspaceMutatedInTurn:
        filesCreated.size + filesModified.size > 0 || commandsExecuted.length > 0,
      checkpointId,
    });

    if (llmRes.ok) {
      usedModel = llmRes.modelId;
      usedGateway = llmRes.usedGateway;
      usedDriverId = llmRes.driverId;
    } else {
      if (narrativeSegments.length === 0) {
        narrativeSegments.push(
          [
            `### Workspace Synthesis for \`${input.workspacePath}\``,
            `- **Assigned Model**: \`${input.preferredModelId}\``,
            "```text",
            contextBlock.slice(0, 1800),
            "```",
          ].join("\n"),
        );
      }
      break;
    }

    const parsed = parseAndScrubModelResponse(llmRes.text);
    const hasPtc = llmRes.text.includes("```ptc-action");
    if (parsed.visibleText) {
      const cleanVis = parsed.visibleText.replace(/```ptc-action[\s\S]*?```/g, "").trim();
      if (cleanVis) narrativeSegments.push(cleanVis);
    }

    if (input.mode === "ask" || (parsed.toolCalls.length === 0 && !hasPtc)) {
      break;
    }

    const observations: string[] = [];
    if (parsed.toolCalls.length > 0) {
      input.onToolStateChange?.(parsed.toolCalls[0]?.tool);
      const execRes = await executeAgentToolBlocksAsync(llmRes.text, input.workspacePath, input.onStep, {
        dataDir: input.dataDir,
        conversationId: input.executionId,
        checkpointId,
        mode: input.mode,
        signal: input.signal,
        onApprovalRequired: input.onApprovalRequest,
      });
      input.onToolStateChange?.(undefined);
      if (execRes.checkpointId) checkpointId = execRes.checkpointId;
      for (const f of execRes.filesInspected) filesInspected.add(f);
      for (const f of execRes.filesCreated) filesCreated.add(f);
      for (const f of execRes.filesModified) filesModified.add(f);
      commandsExecuted.push(...execRes.commandsExecuted);
      toolsInvoked.push(...execRes.toolsInvoked);
      if (execRes.delegatedSubagents?.length) {
        delegatedSubagents.push(
          ...execRes.delegatedSubagents.map((s) => ({
            ...s,
            engineeringRole: s.engineeringRole as EngineeringRole10,
          })),
        );
      }
      observations.push(...execRes.toolObservations);
    }

    if (hasPtc) {
      input.onToolStateChange?.("ptc-action");
      const ptcRegex = /```ptc-action\r?\n([\s\S]*?)```/g;
      let match: RegExpExecArray | null;
      while ((match = ptcRegex.exec(llmRes.text)) !== null) {
        const ptcRes = await executePtcProgram({
          code: match[1] ?? "",
          workspacePath: input.workspacePath,
          dataDir: input.dataDir,
          sessionId: input.executionId,
          signal: input.signal,
        });
        toolsInvoked.push({
          tool: "ptc-action",
          status: ptcRes.ok ? "done" : "error",
          durationMs: ptcRes.durationMs,
        });
        observations.push(
          `[ptc-action] ok=${ptcRes.ok} returnValue=${JSON.stringify(ptcRes.returnValue).slice(0, 1200)}`,
        );
      }
      input.onToolStateChange?.(undefined);
    }

    if (observations.length === 0 || iter + 1 >= maxIter) {
      break;
    }

    messages.push({ role: "assistant", content: parsed.visibleText || "Executed workspace tools." });
    messages.push({
      role: "user",
      content: `Tool results:\n${observations.join("\n\n")}\nProvide the final answer without raw tool XML tags.`,
    });
  }

  return {
    responseText:
      narrativeSegments.join("\n\n").trim() ||
      "Completed workspace operations. Expand the execution steps above for details.",
    usedModel,
    usedGateway,
    driverId: usedDriverId,
    sessionId: builderSessionId,
    checkpointId,
    filesInspected: [...filesInspected],
    filesCreated: [...filesCreated],
    filesModified: [...filesModified],
    commandsExecuted,
    toolsInvoked,
    delegatedSubagents,
  };
}

/**
 * Executes the 6-agent DAG with genuine parallel execution for independent subtasks (`Scout` || `Architect`),
 * adaptive topology (`fast_path` | `standard` | `full_engineering`), bounded concurrency,
 * live state transitions, cancellation & pause propagation, bounded EGM correction cycles, and
 * evidence-backed completion reporting.
 */
export async function executeTaskDag(
  options: ExecuteTaskDagOptions,
): Promise<ExecuteTaskDagResult> {
  const { executionManager, executionId, dataDir, workspaceRoot, prompt } = options;
  const signal = executionManager.getSignal(executionId);

  const emitStep = (step: AgentStepEvent): void => {
    options.onStep?.(step);
  };

  const notifyDag = (): void => {
    const rec = executionManager.getExecution(executionId);
    if (rec) {
      options.onDagUpdate?.(rec.subtasks, rec.state);
    }
  };

  const appendNodeEvent = (
    nodeId: string,
    type: NodeLifecycleEventType,
    detail?: string,
  ): AgentNodeLifecycleEvent[] => {
    const rec = executionManager.getExecution(executionId);
    const existing = rec?.subtasks.find((s) => s.id === nodeId)?.events ?? [];
    return [
      ...existing,
      {
        type,
        timestamp: new Date().toISOString(),
        detail,
      },
    ];
  };

  const dagTopologyMode = determineDagTopologyMode({
    prompt,
    isIndependent: options.isIndependent,
    adaptiveTopology: options.adaptiveTopology,
  });

  // Build orchestration plan & initial 6-node DAG
  const plan = buildOrchestrationPlan(prompt, {
    dataDir,
    workspaceRoot,
    preferredModelId:
      options.preferredModelId && options.preferredModelId !== "auto"
        ? options.preferredModelId
        : undefined,
  });
  options.onPlan?.(plan);

  const dagNodes = buildExecutionDag({
    dataDir,
    prompt,
    executionId,
    preferredModelId: options.preferredModelId,
    mountedSkills: plan.mountedSkills.map((s) => s.name),
    isIndependent: options.isIndependent,
    adaptiveTopology: options.adaptiveTopology,
  });

  executionManager.transitionState(executionId, "planning", { subtasks: dagNodes });
  notifyDag();

  // State shared across DAG nodes
  let desk1Manifest = buildDesk1GroundedManifest(workspaceRoot, prompt);
  let egmPreBrief: EgmBoardroomBrief = {
    desk1Manifest,
    desk2GoldfishLenses: [],
    desk3Auditor: {
      comprehensionParaphrase: `Topology mode '${dagTopologyMode}': executing task "${prompt.slice(0, 120)}".`,
      resolutions: [],
      readyToExecute: true,
      score: 95,
    },
    formattedBriefForElephant: "",
    totalDurationMs: 0,
  };
  let checkpointId = "";
  let responseText = "";
  let usedModel = plan.primaryModel.id;
  let usedGateway: string = plan.primaryModel.provider;
  const filesInspected = new Set<string>();
  const filesCreated = new Set<string>();
  const filesModified = new Set<string>();
  const commandsExecuted: ExecutedCommandEvidence[] = [];
  const toolsInvoked: Array<{
    tool: string;
    target?: string;
    status: "done" | "error";
    durationMs: number;
  }> = [];
  const delegatedSubagents: NonNullable<CompletionEvidenceReport["delegatedSubagents"]> = [];
  let postImplReview: PostImplReviewReport = {
    outcome: "approve",
    reviewerAvailable: true,
    reviewerModel: "skipped",
    comprehensionParaphrase: "Fast-path topology: no code mutation critic required.",
    score: 95,
    correctionCyclesRun: 0,
    findings: [],
    summary: "Fast-path conversational turn completed.",
  };
  let completionReport!: CompletionEvidenceReport;

  const driverRegistry =
    options.driverRegistry ??
    new ApexDriverRegistry(dataDir, loadProviderConfigs(dataDir), (p) =>
      resolveProviderSecret(dataDir, p),
    );

  // Individual node executors
  const runNode = async (node: AgentExecutionNode): Promise<void> => {
    await executionManager.waitIfPaused(executionId);
    if (signal?.aborted) {
      throw new Error("Execution cancelled");
    }

    const t0 = Date.now();
    const subSignal = executionManager.createSubtaskSignal(executionId, node.id);
    const resolvedNodeDriver =
      driverRegistry.resolveDriverForModel(node.assignedModelId) ??
      driverRegistry.listDrivers()[0];
    const nodeDriverId = resolvedNodeDriver?.id ?? node.driverId ?? "http:omniroute-local";
    const nodeSessionId =
      node.sessionId ?? `sess_${executionId.slice(0, 8)}_${node.id}`;
    if (resolvedNodeDriver) {
      try {
        await resolvedNodeDriver.createSession({
          sessionId: nodeSessionId,
          workspaceRoot,
          modelId: node.assignedModelId,
        });
      } catch {
        // Non-fatal session initialization
      }
    }
    subSignal.addEventListener(
      "abort",
      () => {
        void resolvedNodeDriver?.cancel(nodeSessionId);
      },
      { once: true },
    );

    executionManager.updateSubtask(executionId, node.id, {
      state: "running",
      driverId: nodeDriverId,
      sessionId: nodeSessionId,
      startedAt: new Date(t0).toISOString(),
      events: appendNodeEvent(
        node.id,
        "started",
        `Assigned model ${node.assignedModelId} via ${nodeDriverId} (${nodeSessionId})`,
      ),
    });
    notifyDag();

    try {
      if (node.id === "node-coordinator") {
        emitStep({
          id: `step-coord-${Date.now()}`,
          kind: "route",
          agentRole: "Coordinator",
          label: `Lead Coordinator assigned ${plan.primaryModel.displayName} (${dagTopologyMode})`,
          plainSummary: `Coordinator scheduled DAG (${dagTopologyMode}) across ${plan.classification.primaryDomain.replace(/_/g, " ")}`,
          detail: `Primary: ${plan.primaryModel.id} · Skills: ${plan.mountedSkills.map((s) => s.name).join(", ") || "none"}`,
          status: "done",
          durationMs: Date.now() - t0,
        });

        executionManager.updateSubtask(executionId, node.id, {
          state: "completed",
          actualModelUsed: plan.primaryModel.id,
          inputSummary: prompt.slice(0, 200),
          outputSummary: `Topology: ${dagTopologyMode}, Domain: ${plan.classification.primaryDomain}, Skills: ${plan.mountedSkills.length}`,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          verificationPassed: true,
          events: appendNodeEvent(node.id, "completed", `Planned ${dagTopologyMode} DAG`),
        });
        executionManager.transitionState(executionId, "running");
        notifyDag();
        return;
      }

      if (node.id === "node-scout") {
        desk1Manifest = buildDesk1GroundedManifest(workspaceRoot, prompt);
        for (const f of desk1Manifest.scannedFiles) {
          filesInspected.add(f.file);
        }

        const shouldRunSubagentScout =
          Boolean(options.enableSubagentScout) ||
          Boolean(options.parallelSubagentTasks?.length) ||
          (dagTopologyMode === "full_engineering" && !options.customBuilderFn);

        let scoutSubagentSummary = "";
        if (options.parallelSubagentTasks?.length) {
          const swarmResults = await delegateParallelSubagentSwarm(
            options.parallelSubagentTasks.map((t) => ({
              ...t,
              dataDir,
              workspaceRoot,
              parentExecutionId: executionId,
              parentTaskId: node.id,
              signal: subSignal,
              onStep: emitStep,
            })),
          );
          for (const sr of swarmResults) {
            for (const f of sr.filesInspected) filesInspected.add(f);
            delegatedSubagents.push({
              subagentId: sr.subagentId,
              sessionId: sr.sessionId,
              parentTaskId: sr.parentTaskId ?? node.id,
              role: sr.role,
              engineeringRole: sr.engineeringRole,
              assignedModelId: sr.assignedModelId,
              status: sr.status,
              summary: sr.summary,
              isolatedContextVerified: sr.isolatedContextVerified,
              durationMs: sr.durationMs,
            });
          }
          scoutSubagentSummary = ` · Parallel Subagent Swarm: ${swarmResults.length} subagent(s) completed`;
        } else if (shouldRunSubagentScout) {
          const scoutSub = await delegateSubagentTask({
            dataDir,
            workspaceRoot,
            parentExecutionId: executionId,
            parentTaskId: node.id,
            sessionId: `${nodeSessionId}_subagent`,
            role: "Scout",
            engineeringRole: "repo_exploration",
            preferredModelId: node.assignedModelId,
            task: `Index workspace symbols and files relevant to: ${prompt.slice(0, 200)}`,
            tokenBudget: 8_000,
            timeoutMs: 12_000,
            toolPermissions: ["read", "mcp"],
            mode: "ask",
            signal: subSignal,
            onStep: emitStep,
          });
          for (const f of scoutSub.filesInspected) filesInspected.add(f);
          delegatedSubagents.push({
            subagentId: scoutSub.subagentId,
            sessionId: scoutSub.sessionId,
            parentTaskId: node.id,
            role: scoutSub.role,
            engineeringRole: scoutSub.engineeringRole,
            assignedModelId: scoutSub.assignedModelId,
            status: scoutSub.status,
            summary: scoutSub.summary,
            isolatedContextVerified: scoutSub.isolatedContextVerified,
            durationMs: scoutSub.durationMs,
          });
          scoutSubagentSummary = ` · Isolated Subagent (${scoutSub.subagentId})`;
        }

        const scanLabelPrefix = shouldRunSubagentScout
          ? "Codebase Scout (Deterministic Scan + Isolated Subagent)"
          : "[Deterministic Scan] Codebase Scout";

        emitStep({
          id: `step-scout-${Date.now()}`,
          kind: "search",
          agentRole: "Scout",
          label: `${scanLabelPrefix} indexed ${desk1Manifest.scannedFiles.length} files & ${desk1Manifest.activeAntibodies.length} guardrails`,
          plainSummary: `Scout mapped ${desk1Manifest.scannedFiles.length} workspace files${scoutSubagentSummary}`,
          detail: desk1Manifest.scannedFiles.map((f) => f.file).slice(0, 4).join(", ") || "workspace root",
          status: "done",
          durationMs: Date.now() - t0,
        });

        executionManager.updateSubtask(executionId, node.id, {
          state: "completed",
          actualModelUsed: shouldRunSubagentScout ? node.assignedModelId : "deterministic-scanner",
          inputSummary: `Workspace: ${workspaceRoot}`,
          outputSummary: `[Deterministic Scan] Indexed ${desk1Manifest.scannedFiles.length} files and ${desk1Manifest.activeAntibodies.length} antibodies${scoutSubagentSummary}`,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          verificationPassed: true,
          events: appendNodeEvent(
            node.id,
            "completed",
            `[Deterministic Scan] Indexed ${desk1Manifest.scannedFiles.length} files${scoutSubagentSummary}`,
          ),
        });
        notifyDag();
        return;
      }

      if (node.id === "node-architect") {
        egmPreBrief = await runEgmBoardroomConference({
          workspacePath: workspaceRoot,
          prompt: plan.effectivePrompt,
          fastMode: options.effort !== "high",
          signal: subSignal,
        });
        options.onEgmBrief?.(egmPreBrief);

        emitStep({
          id: `step-arch-${Date.now()}`,
          kind: "route",
          agentRole: "Architect",
          label: `System Architect completed 4-lens design & boundary review`,
          plainSummary: `Architect synthesized 4 specialist lenses (score ${egmPreBrief.desk3Auditor.score}/100)`,
          detail: egmPreBrief.desk2GoldfishLenses.map((l) => l.lens).join(", "),
          status: "done",
          durationMs: Date.now() - t0,
        });

        executionManager.updateSubtask(executionId, node.id, {
          state: "completed",
          actualModelUsed: node.assignedModelId,
          inputSummary: `Prompt + Desk 1 symbol manifest`,
          outputSummary: egmPreBrief.desk3Auditor.comprehensionParaphrase,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          verificationPassed: true,
          events: appendNodeEvent(node.id, "completed", `Score ${egmPreBrief.desk3Auditor.score}/100`),
        });
        notifyDag();
        return;
      }

      if (node.id === "node-builder") {
        if (!egmPreBrief.desk2GoldfishLenses.length) {
          options.onEgmBrief?.(egmPreBrief);
        }
        const loopRes = options.customBuilderFn
          ? await options.customBuilderFn({
              prompt: plan.effectivePrompt,
              workspaceRoot,
              correctionCycle: 0,
              signal: subSignal,
            })
          : await runBuilderCodingPass({
              prompt: plan.effectivePrompt,
              workspacePath: workspaceRoot,
              dataDir,
              executionId,
              sessionId: nodeSessionId,
              driverRegistry,
              preferredModelId: node.assignedModelId,
              transpiledSkillsBlock: [
                plan.transpiledSkillsPrompt,
                egmPreBrief?.formattedBriefForElephant ?? "",
              ]
                .filter(Boolean)
                .join("\n\n"),
              memorySnippet: options.memorySnippet ?? "",
              systemPromptPrefix: options.systemPromptPrefix,
              isIndependent: options.isIndependent,
              conversationHistory: options.conversationHistory,
              maxToolIterations: options.effort === "low" ? 1 : 3,
              mode: options.mode ?? "turbo",
              signal: subSignal,
              onToolStateChange: (toolName) => {
                executionManager.updateSubtask(executionId, node.id, {
                  currentTool: toolName,
                });
                notifyDag();
              },
              onApprovalRequest:
                options.mode === "ask"
                  ? async (info) =>
                      executionManager.requestUserApproval(executionId, {
                        tool: "run_command",
                        commandOrPath: info.command,
                        reason: info.reason,
                      })
                  : undefined,
              onStep: emitStep,
            });

        responseText = loopRes.responseText;
        usedModel = loopRes.usedModel || node.assignedModelId;
        usedGateway = loopRes.usedGateway || "local";
        if (loopRes.checkpointId) {
          checkpointId = loopRes.checkpointId;
          executionManager.transitionState(executionId, "running", { checkpointId });
        }
        for (const f of loopRes.filesInspected ?? []) filesInspected.add(f);
        for (const f of loopRes.filesCreated ?? []) filesCreated.add(f);
        for (const f of loopRes.filesModified ?? []) filesModified.add(f);
        commandsExecuted.push(...(loopRes.commandsExecuted ?? []));
        toolsInvoked.push(...(loopRes.toolsInvoked ?? []));
        if ("delegatedSubagents" in loopRes && Array.isArray(loopRes.delegatedSubagents)) {
          delegatedSubagents.push(...loopRes.delegatedSubagents);
        }

        executionManager.updateSubtask(executionId, node.id, {
          state: "completed",
          actualModelUsed: usedModel,
          driverId:
            "driverId" in loopRes && typeof loopRes.driverId === "string"
              ? loopRes.driverId
              : nodeDriverId,
          sessionId:
            "sessionId" in loopRes && typeof loopRes.sessionId === "string"
              ? loopRes.sessionId
              : nodeSessionId,
          currentTool: undefined,
          inputSummary: `Scout (${desk1Manifest.scannedFiles.length} files) + Architect EGM brief`,
          outputSummary: loopRes.responseText.slice(0, 260),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          verificationPassed: true,
          events: appendNodeEvent(node.id, "completed", `Used ${usedModel} (${toolsInvoked.length} tools)`),
        });
        notifyDag();
        return;
      }

      if (node.id === "node-critic") {
        const maxCycles = options.maxCorrectionCycles ?? 1;
        let cycle = 0;

        const roleTable = loadRoleRoutingTable(dataDir);
        const criticRoleEntry =
          roleTable.find((r) => r.role === node.engineeringRole) ??
          roleTable.find((r) => r.role === "code_review");
        const candidateReviewerModels = [
          ...(options.reviewerModelId ? [options.reviewerModelId] : []),
          node.assignedModelId,
          ...(criticRoleEntry?.fallbackModelIds ?? []),
        ].filter(Boolean);

        const configuredProviders = loadProviderConfigs(dataDir);
        const explicitReviewerProviderId =
          options.reviewerProviderId ||
          process.env.APEX_EGM_REVIEWER_PROVIDER_ID ||
          undefined;
        const matchedReviewerProvider = configuredProviders.find(
          (p) =>
            p.enabled &&
            ((explicitReviewerProviderId && p.id === explicitReviewerProviderId) ||
              p.id === "egm-reviewer"),
        );
        const resolvedReviewerEndpointUrl =
          options.reviewerEndpointUrl ||
          process.env.APEX_EGM_REVIEWER_BASE_URL ||
          matchedReviewerProvider?.baseUrl ||
          undefined;
        const resolvedReviewerProviderId =
          explicitReviewerProviderId ||
          matchedReviewerProvider?.id ||
          (resolvedReviewerEndpointUrl ? "egm-http-reviewer" : "egm-goldfish-independent");
        const hasCodeChanges = filesCreated.size + filesModified.size > 0;
        const requireLiveGoldfish =
          options.requireLiveGoldfishModel ??
          (Boolean(resolvedReviewerEndpointUrl) ||
            (hasCodeChanges && process.env.APEX_EGM_REQUIRE_LIVE_GOLDFISH === "1"));

        const invokeProductionGoldfishCritic = async (cycleNum: number) => {
          const freshReviewerSessionId = `${node.sessionId || `sess_${executionId.slice(0, 8)}_critic`}_c${cycleNum}`;
          const gitDiffSummary = hasCodeChanges
            ? captureWorkspaceGitDiffSummary(workspaceRoot)
            : "";
          return runPostImplementationEgmReview({
            originalRequirement: prompt,
            workspacePath: workspaceRoot,
            responseText,
            filesCreated: [...filesCreated],
            filesModified: [...filesModified],
            commandsExecuted,
            gitDiffSummary,
            builderModelId: usedModel,
            candidateReviewerModels,
            reviewerProviderId: resolvedReviewerProviderId,
            reviewerEndpointUrl: resolvedReviewerEndpointUrl,
            reviewerSessionId: freshReviewerSessionId,
            requireLiveGoldfishModel: requireLiveGoldfish,
            correctionCycle: cycleNum,
            simulateReviewerUnavailable: options.simulateReviewerUnavailable,
            signal: subSignal,
          });
        };

        postImplReview = await invokeProductionGoldfishCritic(cycle);

        // Bounded correction loop when Critic requests changes on concrete code defects
        while (
          postImplReview.outcome === "request_changes" &&
          cycle < maxCycles &&
          !subSignal.aborted
        ) {
          cycle += 1;
          const findingsText = postImplReview.findings
            .map((f) => `- [${f.severity}] ${f.file ? `(${f.file}) ` : ""}${f.description}`)
            .join("\n");

          emitStep({
            id: `step-critic-retry-${Date.now()}`,
            kind: "judge",
            agentRole: "Critic",
            label: `Critic requested correction cycle #${cycle} (${postImplReview.findings.length} findings)`,
            plainSummary: `Critic found issues; Builder is running correction pass #${cycle}`,
            detail: findingsText.slice(0, 200),
            status: "running",
          });

          const fixRes = options.customBuilderFn
            ? await options.customBuilderFn({
                prompt: `${plan.effectivePrompt}\n\n[POST-IMPLEMENTATION EGM CRITIC — CORRECTION CYCLE #${cycle}]\n${findingsText}`,
                workspaceRoot,
                correctionCycle: cycle,
                signal: subSignal,
              })
            : await runBuilderCodingPass({
                prompt: `${plan.effectivePrompt}\n\n[POST-IMPLEMENTATION EGM CRITIC — CORRECTION CYCLE #${cycle}]\nResolve every finding below completely without leaving TODOs or broken tests:\n${findingsText}`,
                workspacePath: workspaceRoot,
                dataDir,
                executionId,
                preferredModelId: usedModel,
                transpiledSkillsBlock: plan.transpiledSkillsPrompt,
                memorySnippet: options.memorySnippet ?? "",
                systemPromptPrefix: options.systemPromptPrefix,
                isIndependent: options.isIndependent,
                conversationHistory: [
                  ...options.conversationHistory,
                  { role: "assistant", content: responseText },
                ],
                maxToolIterations: 2,
                mode: options.mode ?? "turbo",
                signal: subSignal,
                onStep: emitStep,
              });

          if (fixRes.responseText.trim()) {
            responseText = fixRes.responseText;
          }
          for (const f of fixRes.filesInspected ?? []) filesInspected.add(f);
          for (const f of fixRes.filesCreated ?? []) filesCreated.add(f);
          for (const f of fixRes.filesModified ?? []) filesModified.add(f);
          commandsExecuted.push(...(fixRes.commandsExecuted ?? []));
          toolsInvoked.push(...(fixRes.toolsInvoked ?? []));

          postImplReview = await invokeProductionGoldfishCritic(cycle);
        }

        emitStep({
          id: `step-critic-${Date.now()}`,
          kind: "judge",
          agentRole: "Critic",
          label: `Post-Implementation EGM Critic: ${postImplReview.outcome.toUpperCase()} (${postImplReview.score}/100)`,
          plainSummary: postImplReview.summary,
          detail: `Outcome: ${postImplReview.outcome} · Reviewer: ${postImplReview.reviewerModel} · Cycles: ${postImplReview.correctionCyclesRun}`,
          status:
            postImplReview.outcome === "approve"
              ? "done"
              : postImplReview.outcome === "decline" || postImplReview.outcome === "unavailable"
                ? "error"
                : "done",
          durationMs: Date.now() - t0,
        });

        executionManager.updateSubtask(executionId, node.id, {
          state: "completed",
          actualModelUsed: postImplReview.reviewerModel,
          driverId: postImplReview.reviewerProviderId || node.driverId,
          sessionId: postImplReview.reviewerSessionId || node.sessionId,
          retryCount: cycle,
          inputSummary: `Changed files: ${filesCreated.size + filesModified.size}, Commands: ${commandsExecuted.length}, Endpoint: ${postImplReview.reviewerEndpointUrl || "local"}`,
          outputSummary: postImplReview.summary,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          verificationPassed: postImplReview.outcome === "approve",
          events: appendNodeEvent(
            node.id,
            "completed",
            `Outcome: ${postImplReview.outcome} (model=${postImplReview.reviewerModel}, session=${postImplReview.reviewerSessionId || "local"})`,
          ),
        });
        notifyDag();
        return;
      }

      if (node.id === "node-verifier") {
        const hasCodeChanges = filesCreated.size + filesModified.size > 0;
        const runDiscoveredVerificationCommands = async (commandsToRun: string[]) => {
          for (const vCmd of commandsToRun) {
            if (subSignal.aborted) break;
            executionManager.updateSubtask(executionId, node.id, {
              currentTool: "run_command",
            });
            notifyDag();

            const cmdRes = await runManagedCommand({
              command: vCmd,
              cwd: ".",
              workspaceRoot,
              timeoutMs: 25_000,
              mode: options.mode ?? "turbo",
              signal: subSignal,
              onApprovalRequired:
                options.mode === "ask"
                  ? async (command, reason) =>
                      executionManager.requestUserApproval(executionId, {
                        tool: "run_command",
                        commandOrPath: command,
                        reason,
                      })
                  : undefined,
            });
            executionManager.updateSubtask(executionId, node.id, {
              currentTool: undefined,
            });
            notifyDag();

            commandsExecuted.push({
              command: vCmd,
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
              target: vCmd,
              status: cmdRes.ok ? "done" : "error",
              durationMs: cmdRes.durationMs,
            });
            emitStep({
              id: `step-verifier-cmd-${Date.now()}-${commandsExecuted.length}`,
              kind: "command",
              agentRole: "Verifier",
              label: `Verifier executed project verification command: ${vCmd}`,
              plainSummary: cmdRes.ok
                ? `Verifier passed \`${vCmd}\` (exit 0)`
                : `Verifier command \`${vCmd}\` exited with ${cmdRes.exitCode ?? "error"}`,
              detail: cmdRes.combinedOutput.slice(0, 160) || `exit ${cmdRes.exitCode ?? 0}`,
              outputPreview: `$ ${vCmd}\n[exit=${cmdRes.exitCode}]\n${cmdRes.combinedOutput.slice(0, 1200)}`,
              status: cmdRes.ok ? "done" : "error",
              durationMs: cmdRes.durationMs,
            });
          }
        };

        // Group 5: Automatically detect & run project verification commands when code was mutated
        // and no verification command has been executed yet.
        if (
          !options.isIndependent &&
          hasCodeChanges &&
          options.mode !== "ask" &&
          resolve(workspaceRoot) !== resolve(process.cwd())
        ) {
          const initialVerif = classifyVerificationFromCommands(commandsExecuted);
          if (!initialVerif.ranVerificationCommands) {
            const detected = detectProjectVerificationCommands(workspaceRoot);
            const autoQueue = [
              ...(detected.testCommands.slice(0, 1)),
              ...(detected.typecheckCommands.slice(0, 1)),
              ...(detected.lintCommands.slice(0, 1)),
            ].filter(Boolean);
            if (autoQueue.length > 0) {
              await runDiscoveredVerificationCommands(autoQueue);
            }
          }

          // Bounded Verifier -> Builder repair loop if any verification command failed
          const maxRepairCycles = options.maxCorrectionCycles ?? 1;
          const postVerif = classifyVerificationFromCommands(commandsExecuted);
          const hasVerifFailure =
            postVerif.testsPassed === false ||
            postVerif.buildPassed === false ||
            postVerif.lintPassed === false;

          if (
            hasVerifFailure &&
            postImplReview.correctionCyclesRun < maxRepairCycles &&
            !subSignal.aborted
          ) {
            const repairCycle = postImplReview.correctionCyclesRun + 1;
            const failedCmds = commandsExecuted.filter(
              (c) => c.exitCode !== 0 || c.timedOut || c.cancelled,
            );
            const failureDigest = failedCmds
              .map(
                (c) =>
                  `$ ${c.command} (exit=${c.exitCode})\n${c.stderrPreview || c.stdoutPreview}`,
              )
              .join("\n\n");

            emitStep({
              id: `step-verifier-repair-${Date.now()}`,
              kind: "judge",
              agentRole: "Verifier",
              label: `Verifier triggered bounded Builder repair cycle #${repairCycle}`,
              plainSummary: `Verification command failed; Builder is repairing and re-running checks`,
              detail: failureDigest.slice(0, 180),
              status: "running",
            });

            const repairPrompt = `${plan.effectivePrompt}\n\n[VERIFIER COMMAND FAILURE — REPAIR CYCLE #${repairCycle}]\nFix the code so the project verification command(s) pass:\n${failureDigest}`;
            const repairRes = options.customBuilderFn
              ? await options.customBuilderFn({
                  prompt: repairPrompt,
                  workspaceRoot,
                  correctionCycle: repairCycle,
                  signal: subSignal,
                })
              : await runBuilderCodingPass({
                  prompt: repairPrompt,
                  workspacePath: workspaceRoot,
                  dataDir,
                  executionId,
                  preferredModelId: usedModel,
                  transpiledSkillsBlock: plan.transpiledSkillsPrompt,
                  memorySnippet: options.memorySnippet ?? "",
                  systemPromptPrefix: options.systemPromptPrefix,
                  isIndependent: options.isIndependent,
                  conversationHistory: [
                    ...options.conversationHistory,
                    { role: "assistant", content: responseText },
                  ],
                  maxToolIterations: 2,
                  mode: options.mode ?? "turbo",
                  signal: subSignal,
                  onStep: emitStep,
                });

            if (repairRes.responseText.trim()) {
              responseText = repairRes.responseText;
            }
            for (const f of repairRes.filesInspected ?? []) filesInspected.add(f);
            for (const f of repairRes.filesCreated ?? []) filesCreated.add(f);
            for (const f of repairRes.filesModified ?? []) filesModified.add(f);
            commandsExecuted.push(...(repairRes.commandsExecuted ?? []));
            toolsInvoked.push(...(repairRes.toolsInvoked ?? []));
            if ("delegatedSubagents" in repairRes && Array.isArray(repairRes.delegatedSubagents)) {
              delegatedSubagents.push(...repairRes.delegatedSubagents);
            }
            postImplReview = {
              ...postImplReview,
              correctionCyclesRun: repairCycle,
            };

            // Re-run failed verification commands after repair
            const retryCmdNames = [...new Set(failedCmds.map((c) => c.command))];
            await runDiscoveredVerificationCommands(retryCmdNames);

            // Re-evaluate post-implementation review with updated commandsExecuted & repaired files
            postImplReview = await runPostImplementationEgmReview({
              originalRequirement: prompt,
              workspacePath: workspaceRoot,
              responseText,
              filesCreated: [...filesCreated],
              filesModified: [...filesModified],
              commandsExecuted,
              gitDiffSummary: captureWorkspaceGitDiffSummary(workspaceRoot),
              builderModelId: usedModel,
              candidateReviewerModels: [postImplReview.reviewerModel].filter(Boolean),
              reviewerProviderId: postImplReview.reviewerProviderId,
              reviewerEndpointUrl: postImplReview.reviewerEndpointUrl,
              reviewerSessionId: `${postImplReview.reviewerSessionId || nodeSessionId}_r${repairCycle}`,
              requireLiveGoldfishModel: Boolean(postImplReview.reviewerEndpointUrl),
              correctionCycle: repairCycle,
              simulateReviewerUnavailable: options.simulateReviewerUnavailable,
              signal: subSignal,
            });
          }
        }

        const allSkills = discoverAllUniversalSkills({ workspaceRoot });
        const skillsWithTokens = plan.mountedSkills.map((ms) => {
          const found = allSkills.find((s) => s.name === ms.name);
          return {
            name: ms.name,
            ecosystem: ms.ecosystem,
            tokenEstimate: found ? found.estimatedTokens || estimateSkillTokens(found.rawBody) : 250,
          };
        });

        const currentRec = executionManager.getExecution(executionId);
        // Temporarily mark verifier completed in snapshot used for report
        const subtasksSnapshot = (currentRec?.subtasks ?? dagNodes).map((s) =>
          s.id === "node-verifier"
            ? {
                ...s,
                state: "completed" as const,
                actualModelUsed: node.assignedModelId,
                durationMs: Date.now() - t0,
              }
            : s,
        );

        completionReport = buildCompletionEvidenceReport({
          executionId,
          originalRequirement: prompt,
          executionPlanSummary: `6-Agent DAG (${dagTopologyMode} · ${plan.classification.primaryDomain}) routed via ${usedModel}`,
          workspaceRoot,
          subtasks: subtasksSnapshot,
          skillsMounted: skillsWithTokens,
          toolsInvoked,
          filesInspected: [...filesInspected],
          filesCreated: [...filesCreated],
          filesModified: [...filesModified],
          commandsExecuted,
          egmReview: postImplReview,
          responseText,
          wasCancelled: Boolean(signal?.aborted),
          delegatedSubagents,
        });

        // Group 6: Hermes Persistent Memory & Validated Learned Skill Proposal on verified multi-step completion
        if (
          completionReport.status === "implemented_and_verified" &&
          !options.isIndependent &&
          (hasCodeChanges || toolsInvoked.length >= 2)
        ) {
          try {
            const changedSummary = [...filesCreated, ...filesModified].join(", ") || "workspace";
            const cmdSummary = commandsExecuted.map((c) => c.command).join(", ") || "deterministic checks";
            const savedMem = saveMemoryEntry(dataDir, {
              scope: "project",
              workspaceRoot,
              category: "lesson_learned",
              title: `Verified Task (${plan.classification.primaryDomain}): ${prompt.slice(0, 64)}`,
              content: `Verified implementation in ${workspaceRoot}. Changed files: ${changedSummary}. Verification commands: ${cmdSummary}. Reviewer: ${postImplReview.reviewerModel} (${postImplReview.outcome}).`,
              tags: [
                plan.classification.primaryDomain,
                ...plan.mountedSkills.map((s) => s.name),
              ],
              provenance: {
                executionId,
                sourceModel: usedModel,
              },
            });

            const rawSlug = prompt
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 28);
            const proposedSkillName = `learned-${rawSlug || "workflow"}-${executionId.slice(-6).toLowerCase()}`;
            const rawProposal = proposeLearnedSkill(dataDir, {
              skillName: proposedSkillName,
              description: `Verified procedural workflow for ${prompt.slice(0, 90)}`,
              triggers: [plan.classification.primaryDomain.replace(/_/g, " "), rawSlug.replace(/-/g, " ")].filter(Boolean),
              instructions: [
                "## Grounded Workflow",
                `1. Inspect workspace target files (${[...filesInspected].slice(0, 4).join(", ") || changedSummary}).`,
                `2. Apply surgical edits to ${changedSummary} with a pre-edit safety checkpoint.`,
                `3. Execute project verification commands (${cmdSummary}) and confirm independent Goldfish review approval.`,
              ].join("\n"),
              sourceExecutionId: executionId,
            });
            const validatedProposal = validateLearnedSkillProposal(
              dataDir,
              rawProposal.proposalId,
              workspaceRoot,
            );
            if (options.autoPromoteLearnedSkills && validatedProposal.status === "validated") {
              promoteLearnedSkillProposal(dataDir, validatedProposal.proposalId);
            }

            completionReport.hermesLearning = {
              memoryEntryId: savedMem.entry.id,
              learnedSkillProposalId: validatedProposal.proposalId,
              learnedSkillName: validatedProposal.skillName,
              learnedSkillStatus: options.autoPromoteLearnedSkills && validatedProposal.status === "validated"
                ? "promoted"
                : validatedProposal.status,
            };
          } catch {
            // Non-fatal post-completion Hermes learning hook
          }
        }

        evaluateCompletedTurn({
          dataDir,
          modelId: usedModel,
          domain: plan.classification.primaryDomain,
          responseText,
          linterErrors:
            completionReport.verificationResults.lintPassed === false
              ? ["Lint verification command failed"]
              : [],
          testFailures:
            completionReport.verificationResults.testsPassed === false
              ? ["Test verification command failed"]
              : [],
          fallbackModelIds: plan.fallbackModels.map((m) => m.id),
        });

        emitStep({
          id: `step-verifier-${Date.now()}`,
          kind: "judge",
          agentRole: "Verifier",
          label: `Test & Quality Verifier: ${completionReport.status.toUpperCase()}`,
          plainSummary: `Verifier recorded status '${completionReport.status.replace(/_/g, " ")}' with ${completionReport.remainingIssues.length} remaining issue(s)`,
          detail: `Files changed: ${filesCreated.size + filesModified.size} · Commands: ${commandsExecuted.length}`,
          status: completionReport.status === "failed" ? "error" : "done",
          durationMs: Date.now() - t0,
        });

        executionManager.updateSubtask(executionId, node.id, {
          state: "completed",
          actualModelUsed: node.assignedModelId,
          inputSummary: `Critic verdict: ${postImplReview.outcome}`,
          outputSummary: `Completion status: ${completionReport.status}`,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          verificationPassed:
            completionReport.status === "implemented_and_verified" ||
            completionReport.status === "implemented_not_verified",
          events: appendNodeEvent(node.id, "completed", `Status: ${completionReport.status}`),
        });
        notifyDag();
      }
    } catch (err) {
      const isAbort = Boolean(signal?.aborted) || /cancel|abort/i.test((err as Error).message);
      executionManager.updateSubtask(executionId, node.id, {
        state: isAbort ? "cancelled" : "failed",
        error: (err as Error).message,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        events: appendNodeEvent(node.id, isAbort ? "cancelled" : "failed", (err as Error).message),
      });
      notifyDag();
      throw err;
    }
  };

  // Topological parallel layer scheduler with bounded concurrency and skipped-node handling
  try {
    const completedIds = new Set<string>(
      dagNodes.filter((n) => n.state === "skipped").map((n) => n.id),
    );
    const maxParallel = Math.max(1, options.maxParallelNodes ?? 4);

    while (completedIds.size < dagNodes.length) {
      await executionManager.waitIfPaused(executionId);
      if (signal?.aborted) {
        throw new Error("Execution cancelled");
      }

      const rec = executionManager.getExecution(executionId);
      const currentNodes = rec?.subtasks ?? dagNodes;
      const readyNodes = currentNodes
        .filter(
          (n) =>
            !completedIds.has(n.id) &&
            n.state === "queued" &&
            n.dependsOn.every((depId) => completedIds.has(depId)),
        )
        .slice(0, maxParallel);

      if (readyNodes.length === 0) {
        break;
      }

      // Execute all ready independent nodes in this bounded layer concurrently!
      await Promise.all(readyNodes.map((n) => runNode(n)));
      for (const n of readyNodes) {
        completedIds.add(n.id);
      }
    }

    const finalState =
      completionReport?.status === "failed"
        ? "failed"
        : completionReport?.status === "blocked"
          ? "blocked"
          : "completed";

    const finalRec = executionManager.transitionState(executionId, finalState, {
      checkpointId,
      completionReport,
    });
    notifyDag();

    return {
      executionRecord: finalRec,
      plan,
      egmPreBrief,
      postImplReview,
      completionReport,
      responseText,
      usedModel,
      usedGateway,
      checkpointId,
      dagTopologyMode,
    };
  } catch (err) {
    const isCancelled =
      Boolean(signal?.aborted) ||
      executionManager.getExecution(executionId)?.state === "cancelled" ||
      /cancel|abort/i.test((err as Error).message);

    if (isCancelled && executionManager.getExecution(executionId)?.state !== "cancelled") {
      executionManager.cancelExecution(executionId, (err as Error).message);
    } else if (!isCancelled) {
      executionManager.transitionState(executionId, "failed", {
        error: (err as Error).message,
      });
    }

    const failedRec = executionManager.getExecution(executionId)!;
    if (!postImplReview || postImplReview.reviewerModel === "skipped") {
      postImplReview = {
        outcome: "unavailable",
        reviewerAvailable: false,
        reviewerModel: "none",
        comprehensionParaphrase: "Execution aborted before post-implementation review.",
        score: 0,
        correctionCyclesRun: 0,
        findings: [],
        summary: isCancelled ? "Execution cancelled." : `Execution failed: ${(err as Error).message}`,
      };
    }

    if (!completionReport) {
      completionReport = buildCompletionEvidenceReport({
        executionId,
        originalRequirement: prompt,
        executionPlanSummary: "Execution aborted before completion.",
        workspaceRoot,
        subtasks: failedRec.subtasks,
        skillsMounted: [],
        toolsInvoked,
        filesInspected: [...filesInspected],
        filesCreated: [...filesCreated],
        filesModified: [...filesModified],
        commandsExecuted,
        egmReview: postImplReview,
        responseText,
        wasCancelled: isCancelled,
      });
    }

    notifyDag();
    return {
      executionRecord: failedRec,
      plan,
      egmPreBrief,
      postImplReview,
      completionReport,
      responseText,
      usedModel,
      usedGateway,
      checkpointId,
      dagTopologyMode,
    };
  }
}
