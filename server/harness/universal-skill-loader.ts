// Phase 2: Universal Multi-IDE Skill, Command, Rule, Hook & MCP Transpiler.
// Auto-discovers skills, slash commands, subagent definitions, rules (.mdc, CLAUDE.md, AGENTS.md),
// and MCP servers across Antigravity, Claude Code, Codex, Cursor, Gemini CLI, Hermes, and OpenMausBot.
// Transpiles tool names and placeholders at runtime for whichever engine driver executes the turn,
// and performs Top-K semantic skill selection so context never bloats.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { DriverBackend } from "./apex-fleet-sync.ts";

export type SkillEcosystem =
  | "antigravity"
  | "claude-code"
  | "codex"
  | "cursor"
  | "gemini-cli"
  | "hermes"
  | "openmausbot"
  | "deepseek-harness";

export type UniversalArtifactKind = "skill" | "command" | "subagent" | "rule" | "mcp";

export interface UniversalSkillItem {
  id: string;
  name: string;
  description: string;
  ecosystem: SkillEcosystem;
  kind: UniversalArtifactKind;
  sourcePath: string;
  capabilityCluster?: string;
  mergedFrom?: string[];
  allowedTools?: string[];
  globs?: string[];
  alwaysApply?: boolean;
  preferredModel?: string;
  sensitiveDualUse: boolean;
  sha256: string;
  rawBody: string;
}

export interface UniversalMcpServerEntry {
  name: string;
  ecosystem: SkillEcosystem;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  sourcePath: string;
}

const TOOL_ALIAS_TABLE: Record<DriverBackend, Record<string, string>> = {
  antigravity: {
    Bash: "run_command",
    exec_command: "run_command",
    Read: "read_file",
    Edit: "edit_file",
    apply_patch: "edit_file",
    Write: "write_file",
    Glob: "find_by_name",
    Grep: "grep_search",
    Task: "invoke_subagent",
    WebSearch: "search_web",
  },
  claude: {
    run_command: "Bash",
    exec_command: "Bash",
    read_file: "Read",
    edit_file: "Edit",
    apply_patch: "Edit",
    write_file: "Write",
    find_by_name: "Glob",
    grep_search: "Grep",
    invoke_subagent: "Task",
    search_web: "WebSearch",
  },
  codex: {
    Bash: "exec_command",
    run_command: "exec_command",
    Edit: "apply_patch",
    edit_file: "apply_patch",
    Read: "read_file",
    Write: "write_file",
    Task: "spawn_agent",
    invoke_subagent: "spawn_agent",
  },
  opencode: {
    run_command: "bash",
    Bash: "bash",
    read_file: "read",
    edit_file: "edit",
    write_file: "write",
  },
  "openai-compat": {
    Bash: "run_command",
    exec_command: "run_command",
    Read: "read_file",
    Edit: "edit_file",
    Write: "write_file",
  },
  "local-inject": {
    Bash: "run_command",
    exec_command: "run_command",
    Read: "read_file",
    Edit: "edit_file",
    Write: "write_file",
  },
};

const DUAL_USE_SENSITIVE_SKILL_NAMES = new Set([
  "cybersecurity-skills",
  "mythos-unfiltered-execution",
  "mythos_unfiltered",
  "godmode",
  "signal-interpreter",
  "signal_interpreter",
  "camofox-browser",
  "obscura",
]);

/**
 * Repo-locked internal maintenance skills that only apply to upstream monorepo CI
 * and should be excluded from the universal general-purpose skill registry.
 */
const REPO_LOCKED_EXCLUDED_SKILLS = new Set([
  "dsh-archive-agent-notes",
  "dsh-create-upgrade-guide",
  "dsh-cua-macos-signing",
  "dsh-merging-stacked-prs",
  "dsh-official-plugin-artwork",
  "dsh-pr-description",
  "dsh-pre-push-checks",
  "dsh-translate-docs",
  "cordis-styling-nitpicking",
  "dsh-doc-writing",
]);

/**
 * Maps overlapping cross-IDE skills into canonical capability clusters.
 * Each cluster has a single Best-of-Breed `winner`; runner-up skills (`suppressed`)
 * have their unique high-value rules fused into the winner so only ONE authoritative
 * skill per capability domain is ever loaded.
 */
const CANONICAL_CAPABILITY_CLUSTERS: ReadonlyArray<{
  cluster: string;
  winner: string;
  suppressed: readonly string[];
  fusedAddendum: string;
}> = [
  {
    cluster: "anti-slop-prose",
    winner: "no-ai-slop",
    suppressed: ["dsh-prose-standard", "dsh-trim-cot-leakage"],
    fusedAddendum: [
      "",
      "## Fused DeepSeek-Harness CoT Leakage & Proposition Rules (from `dsh-trim-cot-leakage` + `dsh-prose-standard`)",
      "- **Zero Chain-of-Thought Leakage**: Never leave authoring-session citations (`decision 7`, `audit C2`, `this cut`, `used to`, `no longer`) in code comments, JSDoc, or UI strings. Every comment and doc must stand at HEAD without access to session transcripts.",
      "- **Complete-Proposition Preservation**: When trimming prose, preserve every actor, condition, modality (`must`/`never`), negative guarantee, and failure mode.",
    ].join("\n"),
  },
  {
    cluster: "ui-ux-craft",
    winner: "frontend-craft",
    suppressed: ["dsh-client-ui-ux", "dsh-responsive-ui", "taste-design"],
    fusedAddendum: [
      "",
      "## Fused DeepSeek-Harness Precision UI Geometry & Anti-Slop Rules (from `dsh-client-ui-ux` + `dsh-responsive-ui`)",
      "- **Typography & Contrast**: Keep UI control font-weight <= 500; establish hierarchy through ink contrast and spacing rather than oversized bold headers or emojis.",
      "- **Concentric Geometry**: Coordinate inner and outer border-radii (`outerRadius - padding = innerRadius`); keep internal joins flush (`0px`) and avoid doubling neutral hairline borders.",
      "- **Feedback Lifetime**: Use transient toasts only for completed actions that outlive their panel; use compact in-place notices with Retry for query/surface errors. Never toast pending states.",
      "- **Minimum Rendered Check**: Always inspect the live rendered page (light/dark contrast, narrow container truncation, focus/disabled/error states) before claiming UI completion.",
    ].join("\n"),
  },
  {
    cluster: "code-review",
    winner: "adversarial-review",
    suppressed: ["dsh-code-review", "reviewer"],
    fusedAddendum: [
      "",
      "## Fused DeepSeek-Harness Lifecycle & Error-Containment Audit Rules (from `dsh-code-review`)",
      "- **Lifecycle & Concurrency**: Audit async setup races before publication, cancellation during `await`, callback containment, and quiescent disposal/teardown.",
      "- **State Guarantees on Failure**: Reject catch-and-continue patterns unless the state owner proves preconditions still hold.",
    ].join("\n"),
  },
  {
    cluster: "code-simplification",
    winner: "karpathy-guidelines",
    suppressed: ["dsh-find-simplifications"],
    fusedAddendum: [
      "",
      "## Fused DeepSeek-Harness Simplification & Reachability Rules (from `dsh-find-simplifications`)",
      "- **Prove Reachability**: Trace producers, transformations, and consumers before adding or retaining a field, adapter, or abstraction. Delete distinctions that do not change any consumer's action.",
      "- **Net-Reduction Dependency Rule**: Replace hand-rolled code or add a dependency only when it yields a net reduction in maintained code and surface area.",
    ].join("\n"),
  },
  {
    cluster: "testing-verification",
    winner: "exhaustive-testing-architecture",
    suppressed: ["evidence-and-claims", "dsh-ci-test-reliability"],
    fusedAddendum: [
      "",
      "## Fused DeepSeek-Harness Test Reliability & Negative Control Rules (from `dsh-ci-test-reliability` + `evidence-and-claims`)",
      "- **Negative Controls**: Prove that each changed acceptance check fails when given a deliberately invalid input.",
      "- **Quiescent Teardown**: Tests that allocate processes, ports, or timers must clean up deterministically before exit without relying on wall-clock sleeps.",
    ].join("\n"),
  },
];

function parseFrontmatter(markdown: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = markdown.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  if (!match) {
    return { frontmatter: {}, body: trimmed };
  }
  const rawYaml = match[1] ?? "";
  const body = match[2] ?? "";
  const frontmatter: Record<string, string> = {};
  for (const line of rawYaml.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv && kv[1]) {
      frontmatter[kv[1].toLowerCase()] = (kv[2] ?? "").replace(/^["']|["']$/g, "").trim();
    }
  }
  return { frontmatter, body };
}

function isSensitiveSkill(name: string, body: string): boolean {
  if (DUAL_USE_SENSITIVE_SKILL_NAMES.has(name.toLowerCase())) return true;
  return /\b(aircrack-ng|reaver|pentagi|red-teaming|parseltongue|l1b3rt4s|exploit)\b/i.test(body.slice(0, 4000));
}

function scanSkillFolder(
  folderPath: string,
  ecosystem: SkillEcosystem,
  kind: UniversalArtifactKind = "skill",
): UniversalSkillItem[] {
  const items: UniversalSkillItem[] = [];
  if (!existsSync(folderPath)) return items;

  let entries: string[] = [];
  try {
    entries = readdirSync(folderPath);
  } catch {
    return items;
  }

  for (const entry of entries) {
    const fullPath = join(folderPath, entry);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      const skillMd = join(fullPath, "SKILL.md");
      if (existsSync(skillMd)) {
        try {
          const raw = readFileSync(skillMd, "utf8");
          const { frontmatter, body } = parseFrontmatter(raw);
          const name = frontmatter.name || entry;
          const description =
            frontmatter.description ||
            body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() ||
            `${name} (${ecosystem} skill)`;
          const allowedTools = frontmatter["allowed-tools"]
            ? frontmatter["allowed-tools"].split(/[,\s]+/).filter(Boolean)
            : undefined;
          items.push({
            id: `${ecosystem}:${kind}:${name}`,
            name,
            description,
            ecosystem,
            kind,
            sourcePath: skillMd,
            allowedTools,
            preferredModel: frontmatter.model,
            sensitiveDualUse: isSensitiveSkill(name, raw),
            sha256: createHash("sha256").update(raw).digest("hex"),
            rawBody: body,
          });
        } catch {
          // Ignore unreadable skill files
        }
      }
    } else if (st.isFile() && (entry.endsWith(".md") || entry.endsWith(".mdc") || entry.endsWith(".toml"))) {
      try {
        const raw = readFileSync(fullPath, "utf8");
        const ext = extname(entry).toLowerCase();
        const base = basename(entry, ext);
        const { frontmatter, body } = parseFrontmatter(raw);
        const name = frontmatter.name || base;
        const description =
          frontmatter.description ||
          body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() ||
          `${name} (${ecosystem} ${kind})`;
        const globs = frontmatter.globs
          ? frontmatter.globs.split(",").map((g) => g.trim()).filter(Boolean)
          : undefined;
        items.push({
          id: `${ecosystem}:${kind}:${name}`,
          name,
          description,
          ecosystem,
          kind,
          sourcePath: fullPath,
          globs,
          alwaysApply: frontmatter.alwaysapply === "true",
          preferredModel: frontmatter.model,
          sensitiveDualUse: isSensitiveSkill(name, raw),
          sha256: createHash("sha256").update(raw).digest("hex"),
          rawBody: body,
        });
      } catch {
        // Ignore unreadable files
      }
    }
  }

  return items;
}

/**
 * Discovers all skills, slash commands, subagents, and rules across all 7 IDE/CLI ecosystems on the machine.
 */
export function discoverAllUniversalSkills(options: {
  userHome?: string;
  workspaceRoot?: string;
} = {}): UniversalSkillItem[] {
  const home = options.userHome ?? homedir();
  const workspace = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;

  const searchRoots: Array<{ path: string; ecosystem: SkillEcosystem; kind: UniversalArtifactKind }> = [
    // 1. Antigravity Global & Builtin Skills
    { path: join(home, ".gemini", "config", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "antigravity", "builtin", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "gemini-api", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "modern-web-guidance-plugin", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "google-antigravity-sdk", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "google-developer-knowledge", "skills"), ecosystem: "antigravity", kind: "skill" },
    // 2. Claude Code Skills, Commands & Subagents
    { path: join(home, ".claude", "skills"), ecosystem: "claude-code", kind: "skill" },
    { path: join(home, ".claude", "commands"), ecosystem: "claude-code", kind: "command" },
    { path: join(home, ".claude", "agents"), ecosystem: "claude-code", kind: "subagent" },
    // 3. Codex & .agents Skills
    { path: join(home, ".codex", "skills"), ecosystem: "codex", kind: "skill" },
    { path: join(home, ".agents", "skills"), ecosystem: "codex", kind: "skill" },
    // 4. Cursor Skills & Rules
    { path: join(home, ".cursor", "skills"), ecosystem: "cursor", kind: "skill" },
    { path: join(home, ".cursor", "rules"), ecosystem: "cursor", kind: "rule" },
    // 5. Gemini CLI Skills & Commands
    { path: join(home, ".gemini", "skills"), ecosystem: "gemini-cli", kind: "skill" },
    { path: join(home, ".gemini", "commands"), ecosystem: "gemini-cli", kind: "command" },
    // 6. Hermes / OpenCode Skills
    { path: join(home, ".config", "opencode", "skills"), ecosystem: "hermes", kind: "skill" },
  ];

  if (workspace) {
    searchRoots.push(
      { path: join(workspace, ".agents", "skills"), ecosystem: "antigravity", kind: "skill" },
      { path: join(workspace, ".claude", "skills"), ecosystem: "claude-code", kind: "skill" },
      { path: join(workspace, ".claude", "commands"), ecosystem: "claude-code", kind: "command" },
      { path: join(workspace, ".claude", "agents"), ecosystem: "claude-code", kind: "subagent" },
      { path: join(workspace, ".codex", "skills"), ecosystem: "codex", kind: "skill" },
      { path: join(workspace, ".cursor", "rules"), ecosystem: "cursor", kind: "rule" },
      { path: join(workspace, "skills"), ecosystem: "openmausbot", kind: "skill" },
      { path: join(workspace, "skills", "deepseek"), ecosystem: "deepseek-harness", kind: "skill" },
      { path: join(workspace, "deepseek-harness", ".agents", "skills"), ecosystem: "deepseek-harness", kind: "skill" },
    );
  }

  const suppressedToCluster = new Map<string, (typeof CANONICAL_CAPABILITY_CLUSTERS)[number]>();
  const winnerToCluster = new Map<string, (typeof CANONICAL_CAPABILITY_CLUSTERS)[number]>();
  for (const c of CANONICAL_CAPABILITY_CLUSTERS) {
    winnerToCluster.set(c.winner.toLowerCase(), c);
    for (const s of c.suppressed) {
      suppressedToCluster.set(s.toLowerCase(), c);
    }
  }

  const deduplicated = new Map<string, UniversalSkillItem>();
  for (const root of searchRoots) {
    for (const item of scanSkillFolder(root.path, root.ecosystem, root.kind)) {
      const nameLower = item.name.toLowerCase();
      if (REPO_LOCKED_EXCLUDED_SKILLS.has(nameLower)) {
        continue;
      }
      if (suppressedToCluster.has(nameLower)) {
        continue;
      }
      const key = `${item.kind}:${nameLower}`;
      if (!deduplicated.has(key)) {
        const winnerCluster = winnerToCluster.get(nameLower);
        if (winnerCluster) {
          deduplicated.set(key, {
            ...item,
            capabilityCluster: winnerCluster.cluster,
            mergedFrom: [...winnerCluster.suppressed],
            rawBody: `${item.rawBody.trim()}\n${winnerCluster.fusedAddendum}\n`,
          });
        } else {
          const autoCluster = nameLower.startsWith("stitch")
            ? "stitch-workflow"
            : nameLower.includes("browser") || nameLower === "obscura"
              ? "browser-automation"
              : undefined;
          deduplicated.set(key, {
            ...item,
            capabilityCluster: autoCluster,
          });
        }
      }
    }
  }

  return [...deduplicated.values()];
}

/**
 * Discovers MCP server definitions across Antigravity, Claude Code, Cursor, and Gemini CLI.
 */
export function discoverAllUniversalMcpServers(userHome: string = homedir()): UniversalMcpServerEntry[] {
  const candidates: Array<{ path: string; ecosystem: SkillEcosystem }> = [
    { path: join(userHome, ".gemini", "config", "mcp_config.json"), ecosystem: "antigravity" },
    { path: join(userHome, ".gemini", "antigravity-ide", "mcp_config.json"), ecosystem: "antigravity" },
    { path: join(userHome, ".gemini", "antigravity", "mcp_config.json"), ecosystem: "antigravity" },
    { path: join(userHome, ".gemini", "settings.json"), ecosystem: "gemini-cli" },
    { path: join(userHome, ".claude.json"), ecosystem: "claude-code" },
    { path: join(userHome, ".cursor", "mcp.json"), ecosystem: "cursor" },
  ];

  const servers = new Map<string, UniversalMcpServerEntry>();
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate.path, "utf8")) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[]; url?: string; serverUrl?: string; env?: Record<string, string> }
        >;
      };
      for (const [name, cfg] of Object.entries(raw.mcpServers ?? {})) {
        if (servers.has(name)) continue;
        servers.set(name, {
          name,
          ecosystem: candidate.ecosystem,
          command: cfg.command,
          args: cfg.args,
          url: cfg.url ?? cfg.serverUrl,
          env: cfg.env,
          sourcePath: candidate.path,
        });
      }
    } catch {
      // Ignore malformed MCP config files
    }
  }

  return [...servers.values()];
}

/**
 * Transpiles a skill/command/subagent from ANY IDE (Claude Code, Codex, Cursor, Antigravity, Gemini CLI, Hermes)
 * into the target execution driver's native tool names and argument conventions.
 */
export function transpileSkillForDriver(
  skill: UniversalSkillItem,
  targetDriver: DriverBackend,
  argsText = "",
): string {
  const aliasMap = TOOL_ALIAS_TABLE[targetDriver] ?? {};
  let transpiled = skill.rawBody;

  // Replace $ARGUMENTS and {{args}} placeholders used by Claude Code & Gemini CLI commands
  if (argsText) {
    transpiled = transpiled.replace(/\$ARGUMENTS\b/g, argsText).replace(/\{\{\s*args\s*\}\}/g, argsText);
    const positional = argsText.split(/\s+/);
    transpiled = transpiled.replace(/\$(\d)\b/g, (_m, idx) => positional[Number(idx) - 1] ?? "");
  }

  // Rewrite inline tool references in backticks (e.g. `Bash` -> `run_command` or `exec_command`)
  for (const [fromTool, toTool] of Object.entries(aliasMap)) {
    const backtickPattern = new RegExp(`\`${fromTool}\``, "g");
    transpiled = transpiled.replace(backtickPattern, `\`${toTool}\``);
  }

  const header = [
    `### [Universal ${skill.kind.toUpperCase()}: ${skill.name}] (Source: ${skill.ecosystem} | Path: ${dirname(skill.sourcePath)})`,
    skill.description ? `> ${skill.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `${header}\n\n${transpiled.trim()}\n`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((tok) => tok.length >= 2);
}

/**
 * Top-K Semantic & Lexical Skill Router:
 * Scores all discovered skills against the user's prompt and returns only the Top-K relevant skills.
 * When `strictFirewall` is true (e.g., Gemini 4 Carbon), sensitive dual-use skills are automatically excluded.
 */
export function selectTopKSkillsForTurn(
  prompt: string,
  skills: readonly UniversalSkillItem[],
  options: {
    topK?: number;
    strictFirewall?: boolean;
    targetDriver?: DriverBackend;
  } = {},
): Array<{ skill: UniversalSkillItem; score: number; transpiledPromptBlock: string }> {
  const topK = options.topK ?? 4;
  const strictFirewall = options.strictFirewall ?? false;
  const targetDriver = options.targetDriver ?? "antigravity";
  const promptTokens = new Set(tokenize(prompt));
  const promptLower = prompt.toLowerCase();

  const scored: Array<{ skill: UniversalSkillItem; score: number }> = [];

  for (const skill of skills) {
    if (strictFirewall && skill.sensitiveDualUse) {
      continue;
    }
    let score = 0;
    const nameLower = skill.name.toLowerCase();
    if (promptLower.includes(nameLower) || promptLower.includes(`/${nameLower}`) || promptLower.includes(`$${nameLower}`)) {
      score += 10.0;
    }
    const descTokens = tokenize(`${skill.name} ${skill.description}`);
    let matches = 0;
    for (const tok of descTokens) {
      if (promptTokens.has(tok)) matches += 1;
    }
    if (descTokens.length > 0) {
      score += (matches / Math.sqrt(descTokens.length)) * 4.0;
    }
    if (skill.alwaysApply) {
      score += 2.5;
    }
    if (score >= 1.2) {
      scored.push({ skill, score: Number(score.toFixed(3)) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const selected: Array<{ skill: UniversalSkillItem; score: number; transpiledPromptBlock: string }> = [];
  const usedClusters = new Set<string>();

  for (const { skill, score } of scored) {
    if (selected.length >= topK) break;
    if (skill.capabilityCluster) {
      if (usedClusters.has(skill.capabilityCluster)) {
        continue;
      }
      usedClusters.add(skill.capabilityCluster);
    }
    selected.push({
      skill,
      score,
      transpiledPromptBlock: transpileSkillForDriver(skill, targetDriver, prompt),
    });
  }

  return selected;
}
