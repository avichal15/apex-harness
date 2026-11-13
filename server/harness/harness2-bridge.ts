// Phase 4: Harness² Recursive Self-Improvement Bridge (Propose -> Probe -> Compose across c1..c8).
// Connects OpenMausBot's execution bus to google-research/harness2 so the harness can inspect,
// validate, and recursively evolve its 8 canonical surfaces:
// c1: system_prompt | c2: guardrails | c3: memory | c4: tool_guidance | c5: subagents | c6: skills | c7: scripts | c8: plugins

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

export function harnessTreeRoot(dataDir: string): string {
  return join(resolve(dataDir), "harness2-tree");
}

/**
 * Initializes the 8 canonical Harness² surfaces (`c1..c8`) inside `<dataDir>/harness2-tree`
 * pre-seeded with the Mythos 5 / Apex Orchestrator defaults.
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
      "- Top-K semantic skill mounting (`K=4`) prevents context bloat and false-positive policy blocks.",
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

/**
 * Appends a structured lesson/reflection into `c3: LongTermMEMORY.md` and `c2: guardrails.md`
 * after a turn completes or recovers from a failure (Harness² Experience Reflection).
 */
export function recordHarness2Reflection(dataDir: string, entry: ExperienceReflectionEntry): {
  memoryPath: string;
  guardrailsUpdated: boolean;
} {
  ensureHarness2TreeInitialized(dataDir);
  const root = harnessTreeRoot(dataDir);
  const memoryPath = join(root, "LongTermMEMORY.md");
  const line = `- [${entry.timestamp}] (${entry.domain} | ${entry.modelId} | score=${entry.score}): ${entry.lessonLearned}\n`;
  const currentMemory = existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "";
  writeFileSync(memoryPath, `${currentMemory.trimEnd()}\n${line}`, "utf8");

  let guardrailsUpdated = false;
  if (entry.antibodyRule) {
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

  return { memoryPath, guardrailsUpdated };
}

/**
 * Invokes the Python `harness2` validator & recursive Proposer/Selector bridge against the active `c1..c8` tree.
 */
export function validateHarness2TreeViaPython(projectRoot: string, dataDir: string): {
  ok: boolean;
  surfacesValidated: number;
  details: string;
} {
  ensureHarness2TreeInitialized(dataDir);
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

  return {
    ok: false,
    surfacesValidated: 0,
    details: (res.stderr || res.stdout || "Python harness2 check failed").trim(),
  };
}
