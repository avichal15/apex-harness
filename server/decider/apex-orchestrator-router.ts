// Phase 3: Intelligent Task-to-Model Orchestration Router & Self-Judging Verification Gate.
// Combines OpenMausBot's sub-second Decider pattern with AutoTune's domain classification,
// an EMA (Exponential Moving Average) Model Scoreboard, and a Self-Judging Verification Gate
// that prevents unverified or stubbed completions and continuously updates model weights.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  loadUnifiedModelFleet,
  sanitizeForStrictModel,
  type ModelDomain,
  type UnifiedModelEntry,
} from "../harness/apex-fleet-sync.ts";
import {
  discoverAllUniversalSkills,
  selectTopKSkillsForTurn,
} from "../harness/universal-skill-loader.ts";

export interface ModelScoreEntry {
  modelId: string;
  emaScore: number;
  domainScores: Partial<Record<ModelDomain, number>>;
  successCount: number;
  failureCount: number;
  lastUpdated: string;
}

export interface ScoreboardDocument {
  schema: "apex.scoreboard.v1";
  alpha: number;
  entries: Record<string, ModelScoreEntry>;
}

export interface TaskClassification {
  primaryDomain: ModelDomain;
  secondaryDomains: ModelDomain[];
  requiresVision: boolean;
  requiresLargeContext: boolean;
  requiresUnfiltered: boolean;
  complexity: "trivial" | "moderate" | "complex" | "architectural";
  parallelizable: boolean;
}

export interface OrchestrationPlan {
  classification: TaskClassification;
  primaryModel: UnifiedModelEntry;
  fallbackModels: UnifiedModelEntry[];
  councilReviewers: UnifiedModelEntry[];
  mountedSkills: Array<{ name: string; ecosystem: string; score: number }>;
  transpiledSkillsPrompt: string;
  effectivePrompt: string;
  strictSanitized: boolean;
  redactionsCount: number;
}

export interface SelfJudgeVerdict {
  passed: boolean;
  score: number;
  issues: string[];
  stubDetected: boolean;
  recommendedAction: "accept" | "retry_same_model" | "escalate_to_fallback" | "trigger_harness2_evolve";
  nextModelId?: string;
}

const DOMAIN_PATTERNS: ReadonlyArray<{ domain: ModelDomain; regex: RegExp }> = [
  {
    domain: "security_audit",
    regex: /\b(security|audit|pentest|penetration|vulnerability|cve|aircrack|reaver|red-team|exploit|xss|sqli|csrf|auth\s+bypass|hardening)\b/i,
  },
  {
    domain: "frontend_ui",
    regex: /\b(ui|ux|css|tailwind|react|vite|component|layout|responsive|animation|stitch|shadcn|hero|landing\s+page|3d|three\.?js|webgl|design)\b/i,
  },
  {
    domain: "browser_automation",
    regex: /\b(browser|scrape|playwright|puppeteer|obscura|camofox|click|login|cloudflare|turnstile|dom|screenshot|web\s+app)\b/i,
  },
  {
    domain: "data_sql",
    regex: /\b(sql|postgres|sqlite|duckdb|supabase|database|schema|migration|query|rls|table|csv|dataframe|analytics)\b/i,
  },
  {
    domain: "media_generation",
    regex: /\b(video|image|nano-banana|google-vids|ffmpeg|remotion|hyperframes|audio|tts|watermark|pptx|slides)\b/i,
  },
  {
    domain: "deep_repo_audit",
    regex: /\b(entire\s+repo|codebase|monorepo|all\s+files|graphify|trace\s+across|1m\s+context|deep\s+analysis|audit\s+all)\b/i,
  },
  {
    domain: "debugging",
    regex: /\b(bug|error|exception|stack\s*trace|crash|fix|failing\s+test|regression|broken|403|500|undefined)\b/i,
  },
  {
    domain: "architecture",
    regex: /\b(architect|design\s+system|harness|orchestrat|plan|blueprint|scalable|microservice|protocol|spec|multi-agent)\b/i,
  },
  {
    domain: "surgical_code",
    regex: /\b(implement|refactor|function|class|typescript|python|rust|go|patch|commit|unit\s+test|api\s+endpoint)\b/i,
  },
];

/**
 * Classifies a user prompt into domains, complexity, and security requirements in <2ms.
 */
export function classifyTaskPrompt(
  prompt: string,
  options: { hasImages?: boolean; estimatedContextTokens?: number } = {},
): TaskClassification {
  const matchedDomains: ModelDomain[] = [];
  for (const { domain, regex } of DOMAIN_PATTERNS) {
    if (regex.test(prompt)) {
      matchedDomains.push(domain);
    }
  }

  if (matchedDomains.length === 0) {
    if (prompt.trim().length < 140) {
      matchedDomains.push("fast_triage");
    } else {
      matchedDomains.push("surgical_code");
    }
  }

  const primaryDomain = matchedDomains[0]!;
  const secondaryDomains = matchedDomains.slice(1, 4);
  const requiresUnfiltered =
    matchedDomains.includes("security_audit") ||
    /\b(aircrack|reaver|pentagi|mythos|unfiltered|red-team|exploit|bypass)\b/i.test(prompt);
  const requiresVision = Boolean(options.hasImages) || /\b(screenshot|image|visual|compare\s+ui)\b/i.test(prompt);
  const requiresLargeContext =
    (options.estimatedContextTokens ?? 0) > 180_000 || matchedDomains.includes("deep_repo_audit");

  const wordCount = prompt.trim().split(/\s+/).length;
  let complexity: TaskClassification["complexity"] = "moderate";
  if (wordCount < 18 && primaryDomain === "fast_triage") {
    complexity = "trivial";
  } else if (matchedDomains.includes("architecture") || matchedDomains.length >= 3 || wordCount > 180) {
    complexity = "architectural";
  } else if (matchedDomains.length >= 2 || wordCount > 60) {
    complexity = "complex";
  }

  const parallelizable = complexity === "architectural" || complexity === "complex";

  return {
    primaryDomain,
    secondaryDomains,
    requiresVision,
    requiresLargeContext,
    requiresUnfiltered,
    complexity,
    parallelizable,
  };
}

export function scoreboardPath(dataDir: string): string {
  return join(resolve(dataDir), "apex-model-scoreboard.json");
}

export function loadScoreboard(dataDir: string, fleet: readonly UnifiedModelEntry[]): ScoreboardDocument {
  const path = scoreboardPath(dataDir);
  const doc: ScoreboardDocument = {
    schema: "apex.scoreboard.v1",
    alpha: 0.2,
    entries: {},
  };

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ScoreboardDocument;
      if (parsed?.schema === "apex.scoreboard.v1" && parsed.entries) {
        Object.assign(doc.entries, parsed.entries);
      }
    } catch {
      // Rebuild if corrupted
    }
  }

  for (const model of fleet) {
    if (!doc.entries[model.id]) {
      const domainScores: Partial<Record<ModelDomain, number>> = {};
      for (const spec of model.specialties) {
        domainScores[spec] = Math.min(0.99, Number((model.baseEmaScore + 0.03).toFixed(3)));
      }
      doc.entries[model.id] = {
        modelId: model.id,
        emaScore: model.baseEmaScore,
        domainScores,
        successCount: 1,
        failureCount: 0,
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  return doc;
}

export function saveScoreboard(dataDir: string, doc: ScoreboardDocument): void {
  const path = scoreboardPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/**
 * Updates a model's EMA score after a turn is judged by the Self-Judging Gate.
 */
export function recordModelOutcome(
  dataDir: string,
  modelId: string,
  domain: ModelDomain,
  passed: boolean,
  qualityScore: number,
): ModelScoreEntry {
  const fleet = loadUnifiedModelFleet();
  const board = loadScoreboard(dataDir, fleet);
  const alpha = board.alpha;
  const existing = board.entries[modelId] ?? {
    modelId,
    emaScore: 0.85,
    domainScores: {},
    successCount: 0,
    failureCount: 0,
    lastUpdated: new Date().toISOString(),
  };

  const clampedScore = Math.max(0, Math.min(1, qualityScore));
  existing.emaScore = Number(((1 - alpha) * existing.emaScore + alpha * clampedScore).toFixed(4));
  const prevDomainScore = existing.domainScores[domain] ?? existing.emaScore;
  existing.domainScores[domain] = Number(((1 - alpha) * prevDomainScore + alpha * clampedScore).toFixed(4));

  if (passed) {
    existing.successCount += 1;
  } else {
    existing.failureCount += 1;
  }
  existing.lastUpdated = new Date().toISOString();
  board.entries[modelId] = existing;
  saveScoreboard(dataDir, board);
  return existing;
}

/**
 * Computes the complete Orchestration Plan for a turn:
 * - Selects primary model, fallback chain, and Council reviewers based on EMA domain scores
 * - Mounts and transpiles Top-K universal skills across all IDEs
 * - Applies automatic context sanitization if a strict-firewall model is chosen
 */
export function buildOrchestrationPlan(
  prompt: string,
  options: {
    dataDir: string;
    workspaceRoot?: string;
    preferredModelId?: string;
    hasImages?: boolean;
    estimatedContextTokens?: number;
    topKSkills?: number;
  },
): OrchestrationPlan {
  const fleet = loadUnifiedModelFleet();
  const board = loadScoreboard(options.dataDir, fleet);
  const classification = classifyTaskPrompt(prompt, {
    hasImages: options.hasImages,
    estimatedContextTokens: options.estimatedContextTokens,
  });

  const eligible = fleet.filter((model) => {
    if (options.preferredModelId && model.id === options.preferredModelId) return true;
    if (classification.requiresUnfiltered && model.strictFirewall) return false;
    if (classification.requiresVision && !model.supportsVision) return false;
    if (classification.requiresLargeContext && model.contextWindow < 500_000) return false;
    return true;
  });

  const pool = eligible.length > 0 ? eligible : fleet;

  const ranked = [...pool].sort((a, b) => {
    if (options.preferredModelId) {
      if (a.id === options.preferredModelId) return -1;
      if (b.id === options.preferredModelId) return 1;
    }
    const entryA = board.entries[a.id];
    const entryB = board.entries[b.id];
    const domainScoreA =
      entryA?.domainScores[classification.primaryDomain] ??
      (a.specialties.includes(classification.primaryDomain) ? a.baseEmaScore + 0.04 : a.baseEmaScore - 0.04);
    const domainScoreB =
      entryB?.domainScores[classification.primaryDomain] ??
      (b.specialties.includes(classification.primaryDomain) ? b.baseEmaScore + 0.04 : b.baseEmaScore - 0.04);
    return domainScoreB - domainScoreA;
  });

  const primaryModel = ranked[0]!;
  const fallbackModels = ranked.slice(1, 5);
  const councilReviewers = ranked
    .filter((m) => m.id !== primaryModel.id && m.provider !== primaryModel.provider)
    .slice(0, 3);

  const allSkills = discoverAllUniversalSkills({ workspaceRoot: options.workspaceRoot });
  const selectedSkills = selectTopKSkillsForTurn(prompt, allSkills, {
    topK: options.topKSkills ?? 4,
    strictFirewall: primaryModel.strictFirewall,
    targetDriver: primaryModel.driver,
  });

  const transpiledSkillsPrompt = selectedSkills.map((s) => s.transpiledPromptBlock).join("\n---\n");
  let effectivePrompt = prompt;
  let redactionsCount = 0;

  if (primaryModel.strictFirewall) {
    const sanitized = sanitizeForStrictModel(prompt);
    effectivePrompt = sanitized.sanitizedText;
    redactionsCount = sanitized.redactionsCount;
  }

  return {
    classification,
    primaryModel,
    fallbackModels,
    councilReviewers,
    mountedSkills: selectedSkills.map((s) => ({
      name: s.skill.name,
      ecosystem: s.skill.ecosystem,
      score: s.score,
    })),
    transpiledSkillsPrompt,
    effectivePrompt,
    strictSanitized: primaryModel.strictFirewall,
    redactionsCount,
  };
}

const STUB_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "Unfinished TODO placeholder", regex: /\/\/\s*TODO\b|#\s*TODO\b/i },
  { label: "NotImplementedError stub", regex: /\bNotImplementedError\b/ },
  { label: "Placeholder ellipsis implementation", regex: /\/\/\s*\.\.\.\s*(?:rest of|existing|implementation)\s+code/i },
];

/**
 * Self-Judging Verification Gate:
 * Evaluates the output of a turn + deterministic linter/test signals, updates the EMA scoreboard,
 * and decides whether to accept, retry, escalate to a fallback model, or trigger Harness² evolution.
 */
export function evaluateCompletedTurn(input: {
  dataDir: string;
  modelId: string;
  domain: ModelDomain;
  responseText: string;
  linterErrors?: string[];
  testFailures?: string[];
  fallbackModelIds?: string[];
  attemptNumber?: number;
}): SelfJudgeVerdict {
  const issues: string[] = [];
  let stubDetected = false;

  if (!input.responseText || input.responseText.trim().length < 10) {
    issues.push("Empty or truncated model response.");
  }

  for (const { label, regex } of STUB_PATTERNS) {
    if (regex.test(input.responseText)) {
      stubDetected = true;
      issues.push(`Stub/placeholder detected: ${label}`);
    }
  }

  for (const lintErr of input.linterErrors ?? []) {
    if (lintErr.trim()) issues.push(`Linter/Compiler error: ${lintErr.trim()}`);
  }

  for (const testFail of input.testFailures ?? []) {
    if (testFail.trim()) issues.push(`Test failure: ${testFail.trim()}`);
  }

  let score = 1.0;
  if (stubDetected) score -= 0.45;
  score -= (input.linterErrors?.length ?? 0) * 0.25;
  score -= (input.testFailures?.length ?? 0) * 0.35;
  if (!input.responseText || input.responseText.trim().length < 10) score = 0.0;
  score = Math.max(0, Math.min(1, Number(score.toFixed(3))));

  const passed = issues.length === 0 && score >= 0.75;
  recordModelOutcome(input.dataDir, input.modelId, input.domain, passed, score);

  const attempt = input.attemptNumber ?? 1;
  let recommendedAction: SelfJudgeVerdict["recommendedAction"] = "accept";
  let nextModelId: string | undefined;

  if (!passed) {
    if (attempt === 1 && !stubDetected && (input.linterErrors?.length ?? 0) <= 2) {
      recommendedAction = "retry_same_model";
      nextModelId = input.modelId;
    } else if ((input.fallbackModelIds?.length ?? 0) > 0 && attempt <= 2) {
      recommendedAction = "escalate_to_fallback";
      nextModelId = input.fallbackModelIds![0];
    } else {
      recommendedAction = "trigger_harness2_evolve";
      nextModelId = input.fallbackModelIds?.[0] ?? input.modelId;
    }
  }

  return {
    passed,
    score,
    issues,
    stubDetected,
    recommendedAction,
    nextModelId,
  };
}
