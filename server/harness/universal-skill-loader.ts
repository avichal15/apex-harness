// Phase 2 & Part 9: Universal Multi-IDE Skill, Command, Rule, Hook & MCP Transpiler
// with Context-Budget-Aware Dynamic Selection, Conflict Detection, Compatibility Validation,
// and Per-Project / Per-Agent Role Assignment.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { AgentOfficeRole } from "../../shared/apex-contracts.ts";
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

export type SkillSecurityClassification = "standard" | "elevated_shell" | "dual_use_restricted";

export interface UniversalSkillItem {
  id: string;
  name: string;
  version: string;
  description: string;
  ecosystem: SkillEcosystem;
  kind: UniversalArtifactKind;
  sourcePath: string;
  capabilityCluster?: string;
  mergedFrom?: string[];
  allowedTools?: string[];
  assignedRoles?: AgentOfficeRole[];
  globs?: string[];
  alwaysApply?: boolean;
  preferredModel?: string;
  sensitiveDualUse: boolean;
  securityClass: SkillSecurityClassification;
  estimatedTokens: number;
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

export interface SkillManagementConfig {
  disabledSkillIds: string[];
  projectSkillOverrides: Record<string, string[]>;
  roleSkillAssignments: Partial<Record<AgentOfficeRole, string[]>>;
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

const CANONICAL_CAPABILITY_CLUSTERS: ReadonlyArray<{
  cluster: string;
  winner: string;
  suppressed: readonly string[];
  assignedRoles: AgentOfficeRole[];
  fusedAddendum: string;
}> = [
  {
    cluster: "anti-slop-prose",
    winner: "no-ai-slop",
    suppressed: ["dsh-prose-standard", "dsh-trim-cot-leakage"],
    assignedRoles: ["Builder", "Verifier"],
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
    assignedRoles: ["Architect", "Builder"],
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
    assignedRoles: ["Critic", "Verifier"],
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
    assignedRoles: ["Architect", "Builder"],
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
    assignedRoles: ["Verifier", "Builder"],
    fusedAddendum: [
      "",
      "## Fused DeepSeek-Harness Test Reliability & Negative Control Rules (from `dsh-ci-test-reliability` + `evidence-and-claims`)",
      "- **Negative Controls**: Prove that each changed acceptance check fails when given a deliberately invalid input.",
      "- **Quiescent Teardown**: Tests that allocate processes, ports, or timers must clean up deterministically before exit without relying on wall-clock sleeps.",
    ].join("\n"),
  },
];

export function estimateSkillTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text || "", "utf8") / 4));
}

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

function classifySkillSecurity(name: string, body: string): {
  sensitiveDualUse: boolean;
  securityClass: SkillSecurityClassification;
} {
  const lower = name.toLowerCase();
  if (
    DUAL_USE_SENSITIVE_SKILL_NAMES.has(lower) ||
    /\b(aircrack-ng|reaver|pentagi|red-teaming|parseltongue|l1b3rt4s|exploit)\b/i.test(body.slice(0, 4000))
  ) {
    return { sensitiveDualUse: true, securityClass: "dual_use_restricted" };
  }
  if (/\b(run_command|exec_command|Bash|sudo|systemctl|docker)\b/.test(body.slice(0, 4000))) {
    return { sensitiveDualUse: false, securityClass: "elevated_shell" };
  }
  return { sensitiveDualUse: false, securityClass: "standard" };
}

function inferSkillRoles(name: string, description: string): AgentOfficeRole[] {
  const text = `${name} ${description}`.toLowerCase();
  const roles = new Set<AgentOfficeRole>();
  if (/\b(review|audit|critic|adversarial|security)\b/.test(text)) roles.add("Critic");
  if (/\b(test|verify|check|evidence|qa)\b/.test(text)) roles.add("Verifier");
  if (/\b(search|discover|research|explore|graphify|scout)\b/.test(text)) roles.add("Scout");
  if (/\b(architect|plan|design|orchestrat|boardroom)\b/.test(text)) {
    roles.add("Coordinator");
    roles.add("Architect");
  }
  if (roles.size === 0 || /\b(build|implement|code|frontend|react|ui)\b/.test(text)) {
    roles.add("Builder");
  }
  return [...roles];
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
    let lst;
    try {
      lst = lstatSync(fullPath);
      if (lst.isSymbolicLink()) continue; // Guard against symlink loops
    } catch {
      continue;
    }

    if (lst.isDirectory()) {
      const skillMd = join(fullPath, "SKILL.md");
      if (existsSync(skillMd)) {
        try {
          const raw = readFileSync(skillMd, "utf8");
          const { frontmatter, body } = parseFrontmatter(raw);
          const name = frontmatter.name || entry;
          const version = frontmatter.version || "1.0.0";
          const description =
            frontmatter.description ||
            body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() ||
            `${name} (${ecosystem} skill)`;
          const allowedTools = frontmatter["allowed-tools"]
            ? frontmatter["allowed-tools"].split(/[,\s]+/).filter(Boolean)
            : undefined;
          const sec = classifySkillSecurity(name, raw);
          items.push({
            id: `${ecosystem}:${kind}:${name}`,
            name,
            version,
            description,
            ecosystem,
            kind,
            sourcePath: skillMd,
            allowedTools,
            assignedRoles: inferSkillRoles(name, description),
            preferredModel: frontmatter.model,
            sensitiveDualUse: sec.sensitiveDualUse,
            securityClass: sec.securityClass,
            estimatedTokens: estimateSkillTokens(body),
            sha256: createHash("sha256").update(raw).digest("hex"),
            rawBody: body,
          });
        } catch {
          // Ignore unreadable skill files
        }
      }
    } else if (lst.isFile() && (entry.endsWith(".md") || entry.endsWith(".mdc") || entry.endsWith(".toml"))) {
      try {
        const raw = readFileSync(fullPath, "utf8");
        const ext = extname(entry).toLowerCase();
        const base = basename(entry, ext);
        const { frontmatter, body } = parseFrontmatter(raw);
        const name = frontmatter.name || base;
        const version = frontmatter.version || "1.0.0";
        const description =
          frontmatter.description ||
          body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() ||
          `${name} (${ecosystem} ${kind})`;
        const globs = frontmatter.globs
          ? frontmatter.globs.split(",").map((g) => g.trim()).filter(Boolean)
          : undefined;
        const sec = classifySkillSecurity(name, raw);
        items.push({
          id: `${ecosystem}:${kind}:${name}`,
          name,
          version,
          description,
          ecosystem,
          kind,
          sourcePath: fullPath,
          globs,
          assignedRoles: inferSkillRoles(name, description),
          alwaysApply: frontmatter.alwaysapply === "true",
          preferredModel: frontmatter.model,
          sensitiveDualUse: sec.sensitiveDualUse,
          securityClass: sec.securityClass,
          estimatedTokens: estimateSkillTokens(body),
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
 * Discovers all skills, slash commands, subagents, and rules across all 8 IDE/CLI ecosystems.
 */
export function discoverAllUniversalSkills(options: {
  userHome?: string;
  workspaceRoot?: string;
  dataDir?: string;
} = {}): UniversalSkillItem[] {
  const home = options.userHome ?? homedir();
  const workspace = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined;

  const searchRoots: Array<{ path: string; ecosystem: SkillEcosystem; kind: UniversalArtifactKind }> = [
    ...(options.dataDir
      ? [{ path: join(resolve(options.dataDir), "learned-skills"), ecosystem: "hermes" as const, kind: "skill" as const }]
      : []),
    { path: join(home, ".gemini", "config", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "antigravity", "builtin", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "gemini-api", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "modern-web-guidance-plugin", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "google-antigravity-sdk", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".gemini", "config", "plugins", "google-developer-knowledge", "skills"), ecosystem: "antigravity", kind: "skill" },
    { path: join(home, ".claude", "skills"), ecosystem: "claude-code", kind: "skill" },
    { path: join(home, ".claude", "commands"), ecosystem: "claude-code", kind: "command" },
    { path: join(home, ".claude", "agents"), ecosystem: "claude-code", kind: "subagent" },
    { path: join(home, ".codex", "skills"), ecosystem: "codex", kind: "skill" },
    { path: join(home, ".agents", "skills"), ecosystem: "codex", kind: "skill" },
    { path: join(home, ".cursor", "skills"), ecosystem: "cursor", kind: "skill" },
    { path: join(home, ".cursor", "rules"), ecosystem: "cursor", kind: "rule" },
    { path: join(home, ".gemini", "skills"), ecosystem: "gemini-cli", kind: "skill" },
    { path: join(home, ".gemini", "commands"), ecosystem: "gemini-cli", kind: "command" },
    { path: join(home, ".config", "opencode", "skills"), ecosystem: "hermes", kind: "skill" },
  ];

  if (workspace) {
    searchRoots.push(
      { path: join(workspace, "skills", "canonical"), ecosystem: "antigravity", kind: "skill" },
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

  const rawItems: UniversalSkillItem[] = [];
  const presentWinners = new Set<string>();
  for (const root of searchRoots) {
    for (const item of scanSkillFolder(root.path, root.ecosystem, root.kind)) {
      const nameLower = item.name.toLowerCase();
      if (REPO_LOCKED_EXCLUDED_SKILLS.has(nameLower)) {
        continue;
      }
      if (winnerToCluster.has(nameLower)) {
        presentWinners.add(nameLower);
      }
      rawItems.push(item);
    }
  }

  const deduplicated = new Map<string, UniversalSkillItem>();
  for (const item of rawItems) {
    const nameLower = item.name.toLowerCase();
    const suppressedCluster = suppressedToCluster.get(nameLower);
    if (suppressedCluster && presentWinners.has(suppressedCluster.winner.toLowerCase())) {
      continue;
    }
    const key = `${item.kind}:${nameLower}`;
    if (!deduplicated.has(key)) {
      const winnerCluster = winnerToCluster.get(nameLower);
      if (winnerCluster) {
        const fusedBody = `${item.rawBody.trim()}\n${winnerCluster.fusedAddendum}\n`;
        deduplicated.set(key, {
          ...item,
          capabilityCluster: winnerCluster.cluster,
          mergedFrom: [...winnerCluster.suppressed],
          assignedRoles: winnerCluster.assignedRoles,
          rawBody: fusedBody,
          estimatedTokens: estimateSkillTokens(fusedBody),
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

  return [...deduplicated.values()];
}

export function detectSkillConflicts(skills: readonly UniversalSkillItem[]): Array<{
  clusterOrName: string;
  conflictingSkillIds: string[];
  resolution: string;
}> {
  const byCluster = new Map<string, UniversalSkillItem[]>();
  for (const s of skills) {
    if (s.capabilityCluster) {
      const list = byCluster.get(s.capabilityCluster) ?? [];
      list.push(s);
      byCluster.set(s.capabilityCluster, list);
    }
  }
  const conflicts: Array<{ clusterOrName: string; conflictingSkillIds: string[]; resolution: string }> = [];
  for (const [cluster, members] of byCluster.entries()) {
    if (members.length > 1) {
      conflicts.push({
        clusterOrName: cluster,
        conflictingSkillIds: members.map((m) => m.id),
        resolution: `Retain highest-scoring skill in cluster '${cluster}' per turn`,
      });
    }
  }
  return conflicts;
}

export function validateSkillCompatibility(
  skill: UniversalSkillItem,
  targetDriver: DriverBackend,
  strictFirewall = false,
): { compatible: boolean; reason?: string } {
  if (strictFirewall && (skill.sensitiveDualUse || skill.securityClass === "dual_use_restricted")) {
    return {
      compatible: false,
      reason: `Skill '${skill.name}' is restricted on strict-firewall models`,
    };
  }
  if (!TOOL_ALIAS_TABLE[targetDriver]) {
    return {
      compatible: false,
      reason: `Unsupported target driver '${targetDriver}'`,
    };
  }
  return { compatible: true };
}

export function loadSkillManagementConfig(dataDir: string): SkillManagementConfig {
  const p = join(resolve(dataDir), "apex-skills-config.json");
  if (!existsSync(p)) {
    return {
      disabledSkillIds: [],
      projectSkillOverrides: {},
      roleSkillAssignments: {},
    };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SkillManagementConfig;
  } catch {
    return {
      disabledSkillIds: [],
      projectSkillOverrides: {},
      roleSkillAssignments: {},
    };
  }
}

export function saveSkillManagementConfig(dataDir: string, config: SkillManagementConfig): void {
  const p = join(resolve(dataDir), "apex-skills-config.json");
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Discovers MCP server definitions across Antigravity, Claude Code, Cursor, Gemini CLI, and project `.mcp.json`.
 */
export function discoverAllUniversalMcpServers(
  userHomeOrOptions: string | { userHome?: string; workspaceRoot?: string } = homedir(),
): UniversalMcpServerEntry[] {
  const userHome =
    typeof userHomeOrOptions === "string"
      ? userHomeOrOptions
      : (userHomeOrOptions.userHome ?? homedir());
  const workspaceRoot =
    typeof userHomeOrOptions === "object" && userHomeOrOptions !== null
      ? userHomeOrOptions.workspaceRoot
      : undefined;

  const candidates: Array<{ path: string; ecosystem: SkillEcosystem }> = [
    ...(workspaceRoot
      ? [{ path: join(resolve(workspaceRoot), ".mcp.json"), ecosystem: "claude-code" as const }]
      : []),
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
 * Transpiles a skill/command/subagent from ANY IDE into the target execution driver's native tool names.
 */
export function transpileSkillForDriver(
  skill: UniversalSkillItem,
  targetDriver: DriverBackend,
  argsText = "",
): string {
  const aliasMap = TOOL_ALIAS_TABLE[targetDriver] ?? {};
  let transpiled = skill.rawBody;

  if (argsText) {
    transpiled = transpiled.replace(/\$ARGUMENTS\b/g, argsText).replace(/\{\{\s*args\s*\}\}/g, argsText);
    const positional = argsText.split(/\s+/);
    transpiled = transpiled.replace(/\$(\d)\b/g, (_m, idx) => positional[Number(idx) - 1] ?? "");
  }

  for (const [fromTool, toTool] of Object.entries(aliasMap)) {
    const backtickPattern = new RegExp(`\`${fromTool}\``, "g");
    transpiled = transpiled.replace(backtickPattern, `\`${toTool}\``);
  }

  const header = [
    `### [Universal ${(skill.kind || "skill").toUpperCase()}: ${skill.name}] (Source: ${skill.ecosystem} | Path: ${dirname(skill.sourcePath)})`,
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
 * Context-Budget-Aware Dynamic Skill Selector (Part 9):
 * Selects relevant skills ranked by semantic/lexical score and agent-role affinity while
 * strictly enforcing `maxContextBudgetTokens` (and optional `topK` ceiling) so skill loading
 * never overflows the model's context budget.
 */
export function selectTopKSkillsForTurn(
  prompt: string,
  skills: readonly UniversalSkillItem[],
  options: {
    topK?: number;
    maxContextBudgetTokens?: number;
    modelContextWindow?: number;
    strictFirewall?: boolean;
    targetDriver?: DriverBackend;
    agentRole?: AgentOfficeRole;
    disabledSkillIds?: ReadonlySet<string>;
  } = {},
): Array<{
  skill: UniversalSkillItem;
  score: number;
  estimatedTokens: number;
  transpiledPromptBlock: string;
}> {
  const strictFirewall = options.strictFirewall ?? false;
  const targetDriver = options.targetDriver ?? "antigravity";
  const maxContextBudgetTokens =
    options.maxContextBudgetTokens ??
    Math.min(6000, Math.max(800, Math.floor((options.modelContextWindow ?? 128_000) * 0.04)));
  const maxCount = options.topK ?? 8;

  const promptTokens = new Set(tokenize(prompt));
  const promptLower = prompt.toLowerCase();

  const scored: Array<{ skill: UniversalSkillItem; score: number }> = [];

  for (const skill of skills) {
    if (options.disabledSkillIds?.has(skill.id) || options.disabledSkillIds?.has(skill.name)) {
      continue;
    }
    const compat = validateSkillCompatibility(skill, targetDriver, strictFirewall);
    if (!compat.compatible) {
      continue;
    }

    let score = 0;
    const nameLower = skill.name.toLowerCase();
    if (
      promptLower.includes(nameLower) ||
      promptLower.includes(`/${nameLower}`) ||
      promptLower.includes(`$${nameLower}`)
    ) {
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
    if (options.agentRole && skill.assignedRoles?.includes(options.agentRole)) {
      score += 1.2;
    }
    if (score >= 1.2) {
      scored.push({ skill, score: Number(score.toFixed(3)) });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const selected: Array<{
    skill: UniversalSkillItem;
    score: number;
    estimatedTokens: number;
    transpiledPromptBlock: string;
  }> = [];
  const usedClusters = new Set<string>();
  let consumedTokens = 0;

  for (const { skill, score } of scored) {
    if (selected.length >= maxCount) break;
    if (skill.capabilityCluster) {
      if (usedClusters.has(skill.capabilityCluster)) {
        continue;
      }
    }

    const transpiledPromptBlock = transpileSkillForDriver(skill, targetDriver, prompt);
    const tokenCost = skill.estimatedTokens || estimateSkillTokens(transpiledPromptBlock);

    // Enforce dynamic context budget: if adding this skill exceeds maxContextBudgetTokens,
    // either truncate its body to fit (if selected.length === 0) or skip to a smaller skill
    if (consumedTokens + tokenCost > maxContextBudgetTokens) {
      if (selected.length === 0 && maxContextBudgetTokens >= 150) {
        const suffix = `\n...[truncated to fit ${maxContextBudgetTokens}-token skill budget]`;
        const maxBytes = Math.max(64, maxContextBudgetTokens * 4 - suffix.length - 16);
        const truncatedBlock = `${transpiledPromptBlock.slice(0, maxBytes)}${suffix}`;
        const truncTokens = Math.min(maxContextBudgetTokens, estimateSkillTokens(truncatedBlock));
        selected.push({
          skill,
          score,
          estimatedTokens: truncTokens,
          transpiledPromptBlock: truncatedBlock,
        });
        consumedTokens += truncTokens;
        break;
      }
      continue;
    }

    if (skill.capabilityCluster) {
      usedClusters.add(skill.capabilityCluster);
    }
    consumedTokens += tokenCost;
    selected.push({
      skill,
      score,
      estimatedTokens: tokenCost,
      transpiledPromptBlock,
    });
  }

  return selected;
}
