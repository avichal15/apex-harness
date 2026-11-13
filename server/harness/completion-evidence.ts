// P0 Evidence-Based Completion & Reporting Engine for Apex Harness.
// Replaces superficial length/regex-only completion checks with a structured
// `CompletionEvidenceReport` constructed from actual execution evidence:
// - Original user requirement & execution plan
// - Subtask DAG states, agents & models actually involved
// - Skills mounted & tools invoked
// - Files inspected, created, and modified + real `git diff --stat` summary
// - Commands executed with exit codes, timeouts, and cancellation flags
// - Test / build / lint verification outcomes
// - Post-implementation independent EGM reviewer verdict (`approve | request_changes | escalate | decline | unavailable`)
// - Honest completion status (`implemented_and_verified`, `implemented_not_verified`, `partially_completed`, `blocked`, `failed`, `skipped`)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentExecutionNode,
  AgentOfficeRole,
  CompletionEvidenceReport,
  CompletionStatus,
  ExecutedCommandEvidence,
  PostImplReviewReport,
} from "../../shared/apex-contracts.ts";

const STUB_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "Unfinished TODO placeholder", regex: /\/\/\s*TODO\b|#\s*TODO\b/i },
  { label: "NotImplementedError stub", regex: /\bNotImplementedError\b/ },
  { label: "Placeholder ellipsis implementation", regex: /\/\/\s*\.\.\.\s*(?:rest of|existing|implementation)\s+code/i },
];

export function captureWorkspaceGitDiffSummary(workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) return "Workspace directory does not exist.";
  try {
    const statRes = spawnSync("git", ["diff", "--stat", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
    });
    const statusRes = spawnSync("git", ["status", "--short"], {
      cwd: root,
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
    });
    const parts: string[] = [];
    if (statusRes.status === 0 && statusRes.stdout.trim()) {
      parts.push(`Git Status:\n${statusRes.stdout.trim().slice(0, 1200)}`);
    }
    if (statRes.status === 0 && statRes.stdout.trim()) {
      parts.push(`Git Diff Stat:\n${statRes.stdout.trim().slice(0, 1200)}`);
    }
    return parts.length > 0 ? parts.join("\n\n") : "Clean working tree (no uncommitted tracked changes).";
  } catch {
    return "Not a git repository or git binary unavailable.";
  }
}

export function classifyVerificationFromCommands(commands: readonly ExecutedCommandEvidence[]): {
  ranVerificationCommands: boolean;
  testsPassed: boolean | null;
  buildPassed: boolean | null;
  lintPassed: boolean | null;
  details: string[];
} {
  let ranVerificationCommands = false;
  let testsPassed: boolean | null = null;
  let buildPassed: boolean | null = null;
  let lintPassed: boolean | null = null;
  const details: string[] = [];

  for (const cmd of commands) {
    const c = cmd.command.toLowerCase();
    const isTest = /\b(test|vitest|pytest|jest|cargo\s+test|go\s+test|node\s+--test)\b/.test(c);
    const isBuild = /\b(build|tsc|vite\s+build|cargo\s+build|go\s+build)\b/.test(c);
    const isLint = /\b(lint|oxlint|eslint|ruff|pyright|typecheck)\b/.test(c);

    if (isTest || isBuild || isLint) {
      ranVerificationCommands = true;
      const passed = cmd.exitCode === 0 && !cmd.timedOut && !cmd.cancelled;
      details.push(
        `[${passed ? "PASS" : "FAIL"}] \`${cmd.command}\` (exit=${cmd.exitCode ?? "null"}, ${cmd.durationMs}ms)`,
      );
      if (isTest) testsPassed = testsPassed === null ? passed : testsPassed && passed;
      if (isBuild) buildPassed = buildPassed === null ? passed : buildPassed && passed;
      if (isLint) lintPassed = lintPassed === null ? passed : lintPassed && passed;
    }
  }

  return {
    ranVerificationCommands,
    testsPassed,
    buildPassed,
    lintPassed,
    details,
  };
}

/**
 * Builds the structured `CompletionEvidenceReport` from actual execution artifacts and determines
 * the honest `CompletionStatus` without relying solely on response length or regexes.
 */
export function buildCompletionEvidenceReport(input: {
  executionId: string;
  originalRequirement: string;
  executionPlanSummary: string;
  workspaceRoot: string;
  subtasks: readonly AgentExecutionNode[];
  skillsMounted: Array<{ name: string; ecosystem: string; tokenEstimate: number }>;
  toolsInvoked: Array<{ tool: string; target?: string; status: "done" | "error"; durationMs: number }>;
  filesInspected: readonly string[];
  filesCreated: readonly string[];
  filesModified: readonly string[];
  commandsExecuted: readonly ExecutedCommandEvidence[];
  egmReview: PostImplReviewReport;
  responseText: string;
  wasCancelled?: boolean;
  wasBlocked?: boolean;
  explicitTestFailures?: readonly string[];
  explicitLinterErrors?: readonly string[];
}): CompletionEvidenceReport {
  const remainingIssues: string[] = [];

  for (const { label, regex } of STUB_PATTERNS) {
    if (regex.test(input.responseText)) {
      remainingIssues.push(`Stub/placeholder detected in output: ${label}`);
    }
  }

  for (const fail of input.explicitTestFailures ?? []) {
    if (fail.trim()) remainingIssues.push(`Test failure: ${fail.trim()}`);
  }
  for (const lint of input.explicitLinterErrors ?? []) {
    if (lint.trim()) remainingIssues.push(`Linter/compiler error: ${lint.trim()}`);
  }

  const verificationResults = classifyVerificationFromCommands(input.commandsExecuted);
  if ((input.explicitTestFailures?.length ?? 0) > 0) {
    verificationResults.ranVerificationCommands = true;
    verificationResults.testsPassed = false;
  }
  if ((input.explicitLinterErrors?.length ?? 0) > 0) {
    verificationResults.ranVerificationCommands = true;
    verificationResults.lintPassed = false;
  }

  for (const cmd of input.commandsExecuted) {
    if (cmd.exitCode !== 0 || cmd.timedOut || cmd.cancelled) {
      remainingIssues.push(
        `Command failed or aborted: \`${cmd.command}\` (exit=${cmd.exitCode ?? "null"}, timedOut=${cmd.timedOut}, cancelled=${cmd.cancelled})`,
      );
    }
  }

  for (const finding of input.egmReview.findings) {
    if (finding.severity === "BLOCKER" || (finding.severity === "MAJOR" && input.egmReview.outcome !== "approve")) {
      remainingIssues.push(`[EGM ${finding.severity}] ${finding.description}`);
    }
  }

  if (!input.egmReview.reviewerAvailable || input.egmReview.outcome === "unavailable") {
    remainingIssues.push("Independent EGM reviewer was unavailable; task cannot be marked verified by reviewer.");
  }

  const agentsInvolved = [...new Set(input.subtasks.map((s) => s.role))] as AgentOfficeRole[];
  const modelsInvolved = [
    ...new Set(input.subtasks.map((s) => s.actualModelUsed || s.assignedModelId).filter(Boolean)),
  ];

  const gitDiffSummary = captureWorkspaceGitDiffSummary(input.workspaceRoot);

  // Determine honest CompletionStatus
  let status: CompletionStatus;
  if (input.wasCancelled) {
    status = "skipped";
  } else if (input.wasBlocked) {
    status = "blocked";
  } else if (
    verificationResults.testsPassed === false ||
    verificationResults.buildPassed === false ||
    verificationResults.lintPassed === false ||
    input.egmReview.outcome === "decline" ||
    !input.responseText.trim()
  ) {
    status = "failed";
  } else if (
    input.egmReview.outcome === "request_changes" ||
    input.egmReview.outcome === "escalate" ||
    remainingIssues.some((i) => i.startsWith("Stub/placeholder") || i.startsWith("[EGM BLOCKER]"))
  ) {
    status = "partially_completed";
  } else {
    const codeWasChanged = input.filesCreated.length > 0 || input.filesModified.length > 0;
    const verificationExplicitlyPassed =
      verificationResults.testsPassed === true ||
      verificationResults.buildPassed === true ||
      verificationResults.lintPassed === true;

    if (
      input.egmReview.reviewerAvailable &&
      input.egmReview.outcome === "approve" &&
      remainingIssues.length === 0 &&
      (!codeWasChanged || verificationExplicitlyPassed)
    ) {
      status = "implemented_and_verified";
    } else {
      status = "implemented_not_verified";
    }
  }

  return {
    executionId: input.executionId,
    status,
    originalRequirement: input.originalRequirement,
    executionPlanSummary: input.executionPlanSummary,
    subtasks: input.subtasks.map((s) => ({
      id: s.id,
      role: s.role,
      engineeringRole: s.engineeringRole,
      task: s.assignedTask,
      state: s.state,
      modelUsed: s.actualModelUsed || s.assignedModelId,
      durationMs: s.durationMs ?? 0,
    })),
    agentsInvolved,
    modelsInvolved,
    skillsMounted: input.skillsMounted,
    toolsInvoked: input.toolsInvoked,
    filesInspected: [...new Set(input.filesInspected)],
    filesCreated: [...new Set(input.filesCreated)],
    filesModified: [...new Set(input.filesModified)],
    gitDiffSummary,
    commandsExecuted: [...input.commandsExecuted],
    verificationResults,
    egmReview: input.egmReview,
    remainingIssues,
    generatedAt: new Date().toISOString(),
  };
}
