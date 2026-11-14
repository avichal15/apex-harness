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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  AgentExecutionNode,
  AgentOfficeRole,
  CompletionEvidenceReport,
  CompletionStatus,
  ExecutedCommandEvidence,
  PostImplReviewReport,
  RequirementEvidenceItem,
} from "../../shared/apex-contracts.ts";

/**
 * Inspects project manifest files (`package.json`, `pnpm-workspace.yaml`, `pyproject.toml`, `Cargo.toml`, `go.mod`)
 * in `workspaceRoot` and discovers the repository's native verification commands across `npm`, `pnpm`, `yarn`, `bun`, and monorepos.
 */
export function detectProjectVerificationCommands(workspaceRoot: string): {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  isMonorepo: boolean;
  testCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  buildCommands: string[];
} {
  const root = resolve(workspaceRoot);
  const testCommands: string[] = [];
  const lintCommands: string[] = [];
  const typecheckCommands: string[] = [];
  const buildCommands: string[] = [];

  let packageManager: "npm" | "pnpm" | "yarn" | "bun" = "npm";
  if (
    existsSync(join(root, "pnpm-lock.yaml")) ||
    existsSync(join(root, "pnpm-workspace.yaml"))
  ) {
    packageManager = "pnpm";
  } else if (existsSync(join(root, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) {
    packageManager = "bun";
  }

  const isPlaceholderScript = (scriptVal?: string): boolean => {
    if (!scriptVal || !scriptVal.trim()) return true;
    return /no test specified/i.test(scriptVal);
  };

  const formatRunCmd = (pm: "npm" | "pnpm" | "yarn" | "bun", scriptName: string): string => {
    if (scriptName === "test" && pm === "npm") return "npm test";
    return `${pm} run ${scriptName}`;
  };

  let isMonorepo = existsSync(join(root, "pnpm-workspace.yaml"));
  const workspacePatterns: string[] = [];

  if (existsSync(join(root, "pnpm-workspace.yaml"))) {
    try {
      const rawYaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
      for (const line of rawYaml.split(/\r?\n/)) {
        const m = line.match(/^\s*-\s*["']?([^"'\r\n#]+)["']?/);
        if (m?.[1]?.trim()) {
          workspacePatterns.push(m[1].trim());
        }
      }
    } catch {
      // Ignore malformed pnpm-workspace.yaml
    }
  }

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        packageManager?: string;
        workspaces?: string[] | { packages?: string[] };
        scripts?: Record<string, string>;
      };
      if (typeof pkg.packageManager === "string") {
        const pmLower = pkg.packageManager.toLowerCase();
        if (pmLower.startsWith("pnpm")) packageManager = "pnpm";
        else if (pmLower.startsWith("yarn")) packageManager = "yarn";
        else if (pmLower.startsWith("bun")) packageManager = "bun";
        else if (pmLower.startsWith("npm")) packageManager = "npm";
      }

      if (Array.isArray(pkg.workspaces)) {
        isMonorepo = true;
        workspacePatterns.push(...pkg.workspaces);
      } else if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
        isMonorepo = true;
        workspacePatterns.push(...pkg.workspaces.packages);
      }

      const scripts = pkg.scripts ?? {};
      if (!isPlaceholderScript(scripts["test:apex"])) {
        testCommands.push(formatRunCmd(packageManager, "test:apex"));
      } else if (!isPlaceholderScript(scripts.test)) {
        testCommands.push(formatRunCmd(packageManager, "test"));
      }
      if (!isPlaceholderScript(scripts.lint)) {
        lintCommands.push(formatRunCmd(packageManager, "lint"));
      }
      if (!isPlaceholderScript(scripts.typecheck)) {
        typecheckCommands.push(formatRunCmd(packageManager, "typecheck"));
      }
      if (!isPlaceholderScript(scripts.build)) {
        buildCommands.push(formatRunCmd(packageManager, "build"));
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  // Discover monorepo workspace package scripts if root does not define them directly
  if (isMonorepo && workspacePatterns.length > 0) {
    const workspaceDirs: string[] = [];
    for (const pattern of workspacePatterns) {
      const clean = pattern.replace(/\/+$/, "");
      if (clean.endsWith("/*")) {
        const parentRel = clean.slice(0, -2);
        const parentAbs = join(root, parentRel);
        if (existsSync(parentAbs)) {
          try {
            for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                workspaceDirs.push(`${parentRel}/${entry.name}`);
              }
            }
          } catch {
            // Ignore unreadable directory
          }
        }
      } else if (existsSync(join(root, clean))) {
        workspaceDirs.push(clean);
      }
    }

    const formatWorkspaceRunCmd = (
      pm: "npm" | "pnpm" | "yarn" | "bun",
      wsRelDir: string,
      wsPkgName: string | undefined,
      scriptName: string,
    ): string => {
      if (pm === "pnpm") {
        return wsPkgName
          ? `pnpm --filter ${wsPkgName} run ${scriptName}`
          : `pnpm -C ${wsRelDir} run ${scriptName}`;
      }
      if (pm === "yarn") {
        return wsPkgName
          ? `yarn workspace ${wsPkgName} run ${scriptName}`
          : `yarn --cwd ${wsRelDir} run ${scriptName}`;
      }
      if (pm === "bun") {
        return `bun --cwd ${wsRelDir} run ${scriptName}`;
      }
      return `npm --prefix ${wsRelDir} run ${scriptName}`;
    };

    for (const wsRel of workspaceDirs) {
      const wsPkgPath = join(root, wsRel, "package.json");
      if (!existsSync(wsPkgPath)) continue;
      try {
        const wsPkg = JSON.parse(readFileSync(wsPkgPath, "utf8")) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        const wsScripts = wsPkg.scripts ?? {};
        if (testCommands.length === 0 && !isPlaceholderScript(wsScripts.test)) {
          testCommands.push(formatWorkspaceRunCmd(packageManager, wsRel, wsPkg.name, "test"));
        }
        if (lintCommands.length === 0 && !isPlaceholderScript(wsScripts.lint)) {
          lintCommands.push(formatWorkspaceRunCmd(packageManager, wsRel, wsPkg.name, "lint"));
        }
        if (typecheckCommands.length === 0 && !isPlaceholderScript(wsScripts.typecheck)) {
          typecheckCommands.push(
            formatWorkspaceRunCmd(packageManager, wsRel, wsPkg.name, "typecheck"),
          );
        }
        if (buildCommands.length === 0 && !isPlaceholderScript(wsScripts.build)) {
          buildCommands.push(formatWorkspaceRunCmd(packageManager, wsRel, wsPkg.name, "build"));
        }
      } catch {
        // Ignore malformed workspace package.json
      }
    }
  }

  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) {
    testCommands.push("pytest");
    lintCommands.push("ruff check .");
    typecheckCommands.push("pyright");
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    testCommands.push("cargo test");
    buildCommands.push("cargo check");
  }
  if (existsSync(join(root, "go.mod"))) {
    testCommands.push("go test ./...");
    buildCommands.push("go build ./...");
  }

  return {
    packageManager,
    isMonorepo,
    testCommands,
    lintCommands,
    typecheckCommands,
    buildCommands,
  };
}

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

  // Track latest outcome per normalized command string so a successful retry/repair
  // pass supersedes an earlier failed attempt of the same verification command.
  const latestByCommand = new Map<
    string,
    {
      cmd: ExecutedCommandEvidence;
      isTest: boolean;
      isBuild: boolean;
      isLint: boolean;
      passed: boolean;
    }
  >();

  for (const cmd of commands) {
    const c = cmd.command.trim().toLowerCase();
    // Never classify a pure echo/printf/write-host output command as a real verification run
    if (/^(?:echo|printf|write-host|write-output)\b/i.test(c)) {
      continue;
    }
    const isTest = /\b(test|vitest|pytest|jest|cargo\s+test|go\s+test|node\s+--test)\b/.test(c);
    const isBuild = /\b(build|tsc|vite\s+build|cargo\s+build|cargo\s+check|go\s+build)\b/.test(c);
    const isLint = /\b(lint|oxlint|eslint|ruff|pyright|typecheck)\b/.test(c);

    if (isTest || isBuild || isLint) {
      ranVerificationCommands = true;
      const passed = cmd.exitCode === 0 && !cmd.timedOut && !cmd.cancelled;
      details.push(
        `[${passed ? "PASS" : "FAIL"}] \`${cmd.command}\` (exit=${cmd.exitCode ?? "null"}, ${cmd.durationMs}ms)`,
      );
      latestByCommand.set(c, { cmd, isTest, isBuild, isLint, passed });
    }
  }

  for (const entry of latestByCommand.values()) {
    if (entry.isTest) {
      testsPassed = testsPassed === null ? entry.passed : testsPassed && entry.passed;
    }
    if (entry.isBuild) {
      buildPassed = buildPassed === null ? entry.passed : buildPassed && entry.passed;
    }
    if (entry.isLint) {
      lintPassed = lintPassed === null ? entry.passed : lintPassed && entry.passed;
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

function mapCompletionStatusToRequirementStatus(
  status: CompletionStatus,
): RequirementEvidenceItem["status"] {
  switch (status) {
    case "implemented_and_verified":
      return "implemented_and_verified";
    case "implemented_not_verified":
      return "implemented_not_verified";
    case "partially_completed":
      return "partially_implemented";
    case "blocked":
      return "blocked";
    case "skipped":
      return "not_applicable";
    case "failed":
    default:
      return "not_implemented";
  }
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
  delegatedSubagents?: CompletionEvidenceReport["delegatedSubagents"];
  hermesLearning?: CompletionEvidenceReport["hermesLearning"];
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

  // Only flag a command as a remaining issue if its LATEST execution failed or aborted
  const latestCmdRuns = new Map<string, ExecutedCommandEvidence>();
  for (const cmd of input.commandsExecuted) {
    latestCmdRuns.set(cmd.command.trim().toLowerCase(), cmd);
  }
  for (const cmd of latestCmdRuns.values()) {
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

  if (input.egmReview.cancelled) {
    remainingIssues.push(
      "Independent EGM review was cancelled by caller signal; task cannot be marked verified by reviewer.",
    );
  } else if (input.egmReview.timedOut) {
    remainingIssues.push(
      "Independent EGM reviewer timed out; task cannot be marked verified by reviewer.",
    );
  } else if (!input.egmReview.reviewerAvailable || input.egmReview.outcome === "unavailable") {
    remainingIssues.push(
      "Independent EGM reviewer was unavailable; task cannot be marked verified by reviewer.",
    );
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

  const requirementClauses = input.originalRequirement
    .split(/(?:\r?\n|;\s+|\.\s+)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6)
    .slice(0, 8);

  const reqItemStatus = mapCompletionStatusToRequirementStatus(status);
  const changedFilesList = [...new Set([...input.filesCreated, ...input.filesModified])];
  const normalizedChangedSet = new Set(
    changedFilesList.flatMap((f) => [
      f.replace(/\\/g, "/").toLowerCase(),
      basename(f.replace(/\\/g, "/")).toLowerCase(),
    ]),
  );
  const executedCommandsSummary = input.commandsExecuted.map(
    (c) => `${c.command} (exit=${c.exitCode ?? "null"})`,
  );

  let hasUnmetRequirementClause = false;
  const clausesToEvaluate =
    requirementClauses.length > 0 ? requirementClauses : [input.originalRequirement];

  const requirementMatrix: RequirementEvidenceItem[] = clausesToEvaluate.map((clause, idx) => {
    const fileTokens = [
      ...clause.matchAll(
        /\b([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|md|json|yaml|yml|css|html))\b/g,
      ),
    ].map((m) => m[1]);
    const hasMutatingActionVerb =
      /\b(?:create|write|add|implement|update|modify|edit|generate|fix)\b/i.test(clause);

    let clauseStatus = reqItemStatus;
    let clauseFiles =
      changedFilesList.length > 0 ? changedFilesList : [...input.filesInspected];
    let evidenceSummary =
      changedFilesList.length > 0
        ? `Files changed: ${changedFilesList.join(", ")}${executedCommandsSummary.length > 0 ? ` · Commands: ${executedCommandsSummary.join(", ")}` : ""}`
        : input.filesInspected.length > 0
          ? `Files inspected: ${input.filesInspected.slice(0, 5).join(", ")}`
          : `EGM outcome: ${input.egmReview.outcome}`;

    if (
      clausesToEvaluate.length > 1 &&
      hasMutatingActionVerb &&
      fileTokens.length > 0 &&
      changedFilesList.length > 0
    ) {
      const matchedClauseFiles = fileTokens.filter((ft) => {
        const norm = ft.replace(/\\/g, "/").toLowerCase();
        return (
          normalizedChangedSet.has(norm) ||
          normalizedChangedSet.has(basename(norm).toLowerCase())
        );
      });
      if (matchedClauseFiles.length === 0) {
        clauseStatus = "not_implemented";
        clauseFiles = [];
        evidenceSummary = `Target file(s) referenced in clause (${fileTokens.join(", ")}) were not created or modified.`;
        hasUnmetRequirementClause = true;
      } else {
        clauseFiles = changedFilesList.filter((cf) => {
          const normCf = cf.replace(/\\/g, "/").toLowerCase();
          return matchedClauseFiles.some((mf) => {
            const normMf = mf.replace(/\\/g, "/").toLowerCase();
            return normCf === normMf || basename(normCf) === basename(normMf);
          });
        });
      }
    }

    return {
      requirementId: `REQ-${idx + 1}`,
      description: clause,
      requirement: clause,
      status: clauseStatus,
      evidenceFiles: clauseFiles,
      evidenceCommands: executedCommandsSummary,
      evidence: evidenceSummary,
      justification: evidenceSummary,
    };
  });

  if (
    hasUnmetRequirementClause &&
    (status === "implemented_and_verified" || status === "implemented_not_verified")
  ) {
    status = "partially_completed";
    remainingIssues.push(
      "One or more multi-part requirement clauses named target files that were not created or modified.",
    );
  }

  return {
    executionId: input.executionId,
    status,
    originalRequirement: input.originalRequirement,
    executionPlanSummary: input.executionPlanSummary,
    requirementMatrix,
    requirements: requirementMatrix,
    delegatedSubagents: input.delegatedSubagents,
    hermesLearning: input.hermesLearning,
    subtasks: input.subtasks.map((s) => ({
      id: s.id,
      role: s.role,
      engineeringRole: s.engineeringRole,
      task: s.assignedTask,
      state: s.state,
      modelUsed: s.actualModelUsed || s.assignedModelId,
      driverId: s.driverId,
      sessionId: s.sessionId,
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
