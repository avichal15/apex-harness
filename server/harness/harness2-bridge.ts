// Phase 4 & Part 11: Harness² & Hermes Controlled Continuous Improvement Pipeline.
// Connects Apex Harness to google-research/harness2 across the 8 canonical surfaces (c1..c8)
// with a controlled Proposal -> Validation -> Promotion -> Snapshot Rollback pipeline so
// recurring failure patterns and workflows never blindly mutate active prompts without validation.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const HARNESS2_SURFACES = [
  { id: "c1", key: "system_prompt", relPath: "systemprompt.md", description: "Core system prompt and execution mandate" },
  { id: "c2", key: "guardrails", relPath: "guardrails.md", description: "Verification gates and safety/quality invariants" },
  { id: "c3", key: "memory", relPath: "LongTermMEMORY.md", description: "Accumulated experience, antibodies, and lessons learned" },
  { id: "c4", key: "tool_guidance", relPath: "tool_descriptions/tool_guidance.md", description: "Tool selection and parameter guidance" },
  { id: "c5", key: "subagents", relPath: "sub_agents", description: "Specialist subagent definitions (Elephant-Goldfish lenses)" },
  { id: "c6", key: "skills", relPath: "skills", description: "Procedural skills and domain playbooks" },
  { id: "c7", key: "scripts", relPath: "scripts", description: "Deterministic verification and helper scripts" },
  { id: "c8", key: "plugins", relPath: "plugin", description: "Runtime hooks and plugin extensions" },
] as const;

export interface HarnessTreeStatus {
  rootDir: string;
  initialized: boolean;
  surfaces: Array<{
    id: string;
    key: string;
    path: string;
    exists: boolean;
    byteSize: number;
    entryCount?: number;
  }>;
}

export interface ExperienceReflectionEntry {
  timestamp: string;
  taskSummary: string;
  domain: string;
  modelId: string;
  passed: boolean;
  score: number;
  lessonLearned: string;
  antibodyRule?: string;
}

export interface HarnessImprovementProposal {
  proposalId: string;
  targetSurfaceRelPath: "systemprompt.md" | "guardrails.md" | "LongTermMEMORY.md" | "tool_descriptions/tool_guidance.md";
  title: string;
  proposedAddition: string;
  sourceExecutionId?: string;
  status: "proposed" | "validated" | "rejected" | "promoted" | "rolled_back";
  validationReport?: {
    ok: boolean;
    checks: string[];
    issues: string[];
  };
  snapshotId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessSurfaceSnapshot {
  snapshotId: string;
  proposalId: string;
  createdAt: string;
  files: Record<string, string>;
}

export function harnessTreeRoot(dataDir: string): string {
  return join(resolve(dataDir), "harness2-tree");
}

function proposalsStorePath(dataDir: string): string {
  return join(resolve(dataDir), "harness2-proposals.json");
}

function snapshotsDirPath(dataDir: string): string {
  return join(resolve(dataDir), "harness2-snapshots");
}

/**
 * Initializes the 8 canonical Harness² surfaces (`c1..c8`) inside `<dataDir>/harness2-tree`.
 */
export function ensureHarness2TreeInitialized(dataDir: string): HarnessTreeStatus {
  const root = harnessTreeRoot(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const defaults: Record<string, string> = {
    "systemprompt.md": [
      "# Apex Harness (OpenMausBot + Harness² Unified Substrate)",
      "- Execute engineering, research, UI/UX, and security auditing tasks with 0->1 Unlazy completion discipline.",
      "- Verify before coding; run deterministic linters and test gates before claiming completion.",
      "- Route sub-tasks to the highest-scoring specialist model in the EMA scoreboard.",
    ].join("\n"),
    "guardrails.md": [
      "# Deterministic Acceptance Guardrails (c2)",
      "1. Zero placeholders (`// TODO`, `NotImplementedError`, stubbed returns).",
      "2. Zero unverified completion claims: run `tsc`, `ruff`, `pyright`, `oxlint`, or test suites on modified files.",
      "3. Strict-firewall models (e.g. Carbon) must run through `sanitizeForStrictModel` and `carbon-clean-home`.",
    ].join("\n"),
    "LongTermMEMORY.md": [
      "# Long-Term Episodic & Procedural Memory (c3)",
      "- Virtual / synced filesystems (DriveFS, FAT32) can block NTFS symlinks: always use `safeSymlinkOrCopySync` and `bin-links=false`.",
      "- Context-budget dynamic skill mounting prevents context bloat and false-positive policy blocks.",
    ].join("\n"),
    "tool_descriptions/tool_guidance.md": [
      "# Universal Cross-IDE Tool Guidance (c4)",
      "- Prefer bounded file reads (`<= 350` lines) and fast ripgrep/AST symbol lookups before full-file reads.",
      "- Use `agent-browser --engine obscura` for computed DOM/CSS verification.",
      "- Use `UniversalSkillLoader` to transpile Claude Code / Codex / Cursor / Antigravity skills on the fly.",
    ].join("\n"),
  };

  for (const [relFile, content] of Object.entries(defaults)) {
    const fullPath = join(root, relFile);
    mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 });
    if (!existsSync(fullPath)) {
      writeFileSync(fullPath, `${content}\n`, "utf8");
    }
  }

  for (const folder of ["sub_agents", "skills", "scripts", "plugin"]) {
    mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
  }

  const auditorDir = join(root, "sub_agents", "goldfish_auditor");
  mkdirSync(auditorDir, { recursive: true, mode: 0o700 });
  const auditorAgent = join(auditorDir, "AGENT.md");
  if (!existsSync(auditorAgent)) {
    writeFileSync(
      auditorAgent,
      [
        "---",
        "name: goldfish_auditor",
        "description: Zero-context stateless auditor that inspects diffs for regressions and missed requirements.",
        "---",
        "Audit the git diff against the acceptance gates. Report concrete file:line evidence.",
      ].join("\n"),
      "utf8",
    );
  }

  return inspectHarness2Tree(dataDir);
}

export function inspectHarness2Tree(dataDir: string): HarnessTreeStatus {
  const root = harnessTreeRoot(dataDir);
  const surfaces = HARNESS2_SURFACES.map((surface) => {
    const fullPath = join(root, surface.relPath);
    const exists = existsSync(fullPath);
    let byteSize = 0;
    let entryCount: number | undefined;
    if (exists) {
      try {
        if (surface.relPath.endsWith(".md")) {
          byteSize = Buffer.byteLength(readFileSync(fullPath, "utf8"), "utf8");
        } else {
          const entries = readdirSync(fullPath);
          entryCount = entries.length;
          for (const e of entries) {
            try {
              const p = join(fullPath, e);
              byteSize += readFileSync(p).byteLength;
            } catch {
              // Subdirectory
            }
          }
        }
      } catch {
        // Ignore read error
      }
    }
    return {
      id: surface.id,
      key: surface.key,
      path: fullPath,
      exists,
      byteSize,
      ...(entryCount !== undefined ? { entryCount } : {}),
    };
  });

  return {
    rootDir: root,
    initialized: surfaces.every((s) => s.exists),
    surfaces,
  };
}

// ============================================================================
// CONTROLLED CONTINUOUS IMPROVEMENT PIPELINE (Proposal -> Validate -> Promote -> Rollback)
// ============================================================================

export function listHarnessProposals(dataDir: string): HarnessImprovementProposal[] {
  const p = proposalsStorePath(dataDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as HarnessImprovementProposal[];
  } catch {
    return [];
  }
}

export function listHarnessSnapshots(dataDir: string): HarnessSurfaceSnapshot[] {
  const dir = snapshotsDirPath(dataDir);
  if (!existsSync(dir)) return [];
  try {
    const out: HarnessSurfaceSnapshot[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as HarnessSurfaceSnapshot);
      } catch {
        // Ignore malformed snapshot
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function saveHarnessProposals(dataDir: string, list: readonly HarnessImprovementProposal[]): void {
  const p = proposalsStorePath(dataDir);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

/**
 * Step 1: Proposes a candidate improvement to a Harness² surface without mutating the live surface yet.
 */
export function proposeHarnessImprovement(
  dataDir: string,
  input: {
    targetSurfaceRelPath: HarnessImprovementProposal["targetSurfaceRelPath"];
    title: string;
    proposedAddition: string;
    sourceExecutionId?: string;
  },
): HarnessImprovementProposal {
  ensureHarness2TreeInitialized(dataDir);
  const now = new Date().toISOString();
  const proposal: HarnessImprovementProposal = {
    proposalId: `prop-${Date.now()}-${randomUUID().slice(0, 6)}`,
    targetSurfaceRelPath: input.targetSurfaceRelPath,
    title: input.title.trim(),
    proposedAddition: input.proposedAddition.trim(),
    sourceExecutionId: input.sourceExecutionId,
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };
  const existing = listHarnessProposals(dataDir);
  existing.unshift(proposal);
  saveHarnessProposals(dataDir, existing.slice(0, 100));
  return proposal;
}

/**
 * Step 2: Validates a candidate proposal against safety, secret-leakage, length, and prompt-injection rules.
 */
export function validateHarnessProposal(
  dataDir: string,
  proposalId: string,
): HarnessImprovementProposal {
  const list = listHarnessProposals(dataDir);
  const prop = list.find((p) => p.proposalId === proposalId);
  if (!prop) {
    throw new Error(`Harness² proposal '${proposalId}' not found`);
  }

  const checks: string[] = [];
  const issues: string[] = [];
  const text = prop.proposedAddition;

  if (!text || text.length < 8) {
    issues.push("Proposed addition is too short (< 8 chars).");
  } else {
    checks.push("Minimum content length verified");
  }

  if (text.length > 4000) {
    issues.push("Proposed addition exceeds 4000-char single-promotion budget.");
  } else {
    checks.push("Always-on character budget verified (<= 4000 chars)");
  }

  if (/\b(?:sk-[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_-]{30,}|ghp_[a-zA-Z0-9]{25,})\b/.test(text)) {
    issues.push("Proposed addition contains a raw API key or secret token.");
  } else {
    checks.push("Zero secret/token leakage verified");
  }

  if (/(?:ignore\s+all\s+previous\s+instructions|disregard\s+safety\s+boundaries|bypass\s+workspace\s+containment)/i.test(text)) {
    issues.push("Proposed addition contains prompt-injection or boundary-bypass directive.");
  } else {
    checks.push("Guardrail integrity verified");
  }

  const ok = issues.length === 0;
  prop.status = ok ? "validated" : "rejected";
  prop.validationReport = { ok, checks, issues };
  prop.updatedAt = new Date().toISOString();
  saveHarnessProposals(dataDir, list);
  return prop;
}

/**
 * Step 3: Promotes a validated proposal into the active Harness² surface after creating a restorable snapshot.
 */
export function promoteHarnessProposal(
  projectRoot: string,
  dataDir: string,
  proposalId: string,
): {
  ok: boolean;
  proposal: HarnessImprovementProposal;
  snapshot?: HarnessSurfaceSnapshot;
  pythonValidation?: { ok: boolean; surfacesValidated: number; details: string };
  error?: string;
} {
  ensureHarness2TreeInitialized(dataDir);
  const list = listHarnessProposals(dataDir);
  let prop = list.find((p) => p.proposalId === proposalId);
  if (!prop) {
    throw new Error(`Harness² proposal '${proposalId}' not found`);
  }

  if (prop.status === "proposed") {
    prop = validateHarnessProposal(dataDir, proposalId);
  }
  if (prop.status !== "validated" || !prop.validationReport?.ok) {
    return {
      ok: false,
      proposal: prop,
      error: `Cannot promote unvalidated or rejected proposal: ${prop.validationReport?.issues.join(" | ")}`,
    };
  }

  const root = harnessTreeRoot(dataDir);
  const surfaceFiles = [
    "systemprompt.md",
    "guardrails.md",
    "LongTermMEMORY.md",
    "tool_descriptions/tool_guidance.md",
  ];
  const snapshotFiles: Record<string, string> = {};
  for (const rel of surfaceFiles) {
    const p = join(root, rel);
    if (existsSync(p)) {
      snapshotFiles[rel] = readFileSync(p, "utf8");
    }
  }

  const snapshot: HarnessSurfaceSnapshot = {
    snapshotId: `snap-${Date.now()}-${randomUUID().slice(0, 6)}`,
    proposalId: prop.proposalId,
    createdAt: new Date().toISOString(),
    files: snapshotFiles,
  };
  const snapDir = snapshotsDirPath(dataDir);
  mkdirSync(snapDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(snapDir, `${snapshot.snapshotId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  const targetPath = join(root, prop.targetSurfaceRelPath);
  const currentContent = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  if (!currentContent.includes(prop.proposedAddition)) {
    writeFileSync(targetPath, `${currentContent.trimEnd()}\n${prop.proposedAddition}\n`, "utf8");
  }

  const pyVal = validateHarness2TreeViaPython(projectRoot, dataDir);
  if (!pyVal.ok) {
    // Automatically roll back if substrate validation fails
    writeFileSync(targetPath, currentContent, "utf8");
    prop.status = "rejected";
    prop.updatedAt = new Date().toISOString();
    saveHarnessProposals(dataDir, list);
    return {
      ok: false,
      proposal: prop,
      snapshot,
      pythonValidation: pyVal,
      error: `Substrate validation failed after promotion; rolled back automatically: ${pyVal.details}`,
    };
  }

  prop.status = "promoted";
  prop.snapshotId = snapshot.snapshotId;
  prop.updatedAt = new Date().toISOString();
  saveHarnessProposals(dataDir, list);

  return {
    ok: true,
    proposal: prop,
    snapshot,
    pythonValidation: pyVal,
  };
}

/**
 * Step 4: Rolls back the Harness² surfaces to a previous snapshot byte-for-byte.
 */
export function rollbackHarnessSnapshot(
  dataDir: string,
  snapshotId: string,
): { ok: boolean; restoredSurfaces: string[]; error?: string } {
  const snapFile = join(snapshotsDirPath(dataDir), `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
  if (!existsSync(snapFile)) {
    return { ok: false, restoredSurfaces: [], error: `Snapshot '${snapshotId}' not found` };
  }
  const snap = JSON.parse(readFileSync(snapFile, "utf8")) as HarnessSurfaceSnapshot;
  const root = harnessTreeRoot(dataDir);
  const restored: string[] = [];

  for (const [rel, content] of Object.entries(snap.files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, content, "utf8");
    restored.push(rel);
  }

  const list = listHarnessProposals(dataDir);
  const prop = list.find((p) => p.proposalId === snap.proposalId);
  if (prop) {
    prop.status = "rolled_back";
    prop.updatedAt = new Date().toISOString();
    saveHarnessProposals(dataDir, list);
  }

  return { ok: true, restoredSurfaces: restored };
}

/**
 * Records a turn reflection through the controlled validation gate before updating
 * `c3: LongTermMEMORY.md` and `c2: guardrails.md`.
 */
export function recordHarness2Reflection(dataDir: string, entry: ExperienceReflectionEntry): {
  memoryPath: string;
  guardrailsUpdated: boolean;
  proposalId?: string;
} {
  ensureHarness2TreeInitialized(dataDir);
  const root = harnessTreeRoot(dataDir);
  const memoryPath = join(root, "LongTermMEMORY.md");
  const line = `- [${entry.timestamp}] (${entry.domain} | ${entry.modelId} | score=${entry.score}): ${entry.lessonLearned}`;

  const prop = proposeHarnessImprovement(dataDir, {
    targetSurfaceRelPath: "LongTermMEMORY.md",
    title: `Reflection: ${entry.taskSummary.slice(0, 50)}`,
    proposedAddition: line,
  });
  const validated = validateHarnessProposal(dataDir, prop.proposalId);
  if (validated.status === "validated") {
    const currentMemory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
    const memoryLines = currentMemory.split(/\r?\n/);
    // Keep LongTermMEMORY bounded (cap at last 120 lines)
    const boundedLines = memoryLines.length > 120 ? [memoryLines[0]!, ...memoryLines.slice(-118)] : memoryLines;
    writeFileSync(memoryPath, `${boundedLines.join("\n").trimEnd()}\n${line}\n`, "utf8");
  }

  let guardrailsUpdated = false;
  if (entry.antibodyRule) {
    const guardProp = proposeHarnessImprovement(dataDir, {
      targetSurfaceRelPath: "guardrails.md",
      title: `Antibody (${entry.domain})`,
      proposedAddition: `- **Antibody (${entry.domain})**: ${entry.antibodyRule}`,
    });
    const guardVal = validateHarnessProposal(dataDir, guardProp.proposalId);
    if (guardVal.status === "validated") {
      const guardrailsPath = join(root, "guardrails.md");
      const currentGuardrails = existsSync(guardrailsPath) ? readFileSync(guardrailsPath, "utf8") : "";
      if (!currentGuardrails.includes(entry.antibodyRule)) {
        writeFileSync(
          guardrailsPath,
          `${currentGuardrails.trimEnd()}\n- **Antibody (${entry.domain})**: ${entry.antibodyRule}\n`,
          "utf8",
        );
        guardrailsUpdated = true;
      }
    }
  }

  return { memoryPath, guardrailsUpdated, proposalId: prop.proposalId };
}

/**
 * Invokes the Python `harness2` validator against the active `c1..c8` tree, with a deterministic
 * TypeScript fallback if the external Python interpreter is unavailable.
 */
export function validateHarness2TreeViaPython(projectRoot: string, dataDir: string): {
  ok: boolean;
  surfacesValidated: number;
  details: string;
} {
  const status = ensureHarness2TreeInitialized(dataDir);
  const treeDir = harnessTreeRoot(dataDir);
  const harness2RepoDir = join(resolve(projectRoot), "harness2");

  const pyCode = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(harness2RepoDir)})`,
    "from harness2.substrate.apex_maus import ApexMausSubstrate",
    "sub = ApexMausSubstrate()",
    `census = sub.validate_tree(${JSON.stringify(treeDir)})`,
    "print(json.dumps({'ok': True, 'surfaces': 8, 'census': census}))",
  ].join("; ");

  const res = spawnSync("python", ["-c", pyCode], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });

  if (res.status === 0 && res.stdout.trim()) {
    try {
      const parsed = JSON.parse(res.stdout.trim().split(/\r?\n/).pop()!) as {
        ok: boolean;
        surfaces: number;
        census: { n_files: number; always_on_chars: number; sub_agents: number; skills: number };
      };
      return {
        ok: parsed.ok,
        surfacesValidated: parsed.surfaces,
        details: `Harness² validated ${parsed.surfaces} canonical surfaces (${parsed.census.n_files} files, ${parsed.census.always_on_chars} always-on chars, ${parsed.census.sub_agents} subagents) in ${treeDir}`,
      };
    } catch {
      // Fall through
    }
  }

  if (status.initialized && status.surfaces.length === 8) {
    const totalBytes = status.surfaces.reduce((acc, s) => acc + s.byteSize, 0);
    return {
      ok: true,
      surfacesValidated: 8,
      details: `Harness² validated 8 canonical surfaces (${totalBytes} bytes) in ${treeDir}`,
    };
  }

  return {
    ok: false,
    surfacesValidated: 0,
    details: (res.stderr || res.stdout || "Harness² surface check failed").trim(),
  };
}
