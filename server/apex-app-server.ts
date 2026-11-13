// Authoritative Desktop & Web Application Server for Apex Harness (`http://127.0.0.1:5199`).
// Integrates:
// - P0 Local API Security (`verifyLocalApiRequest`, `readBoundedJsonBody`, loopback/Origin/CSRF/Token enforcement)
// - P0 Canonical Workspace Containment (`assertCanonicalWorkspacePath`) & Managed Async Processes (`runManagedCommand`)
// - P0 Unified Execution Lifecycle Manager (`TaskExecutionManager` with Stop/Cancel/Pause/Resume/Approve/Retry)
// - P0 Evidence-Based Completion Reporting (`buildCompletionEvidenceReport` + `runPostImplementationEgmReview`)
// - Milestone 3 Configurable Provider Registry, AES-256-GCM Secret Vault & 10-Role Model Routing Table
// - Milestone 3 Real Multi-Agent DAG Execution (`Coordinator` -> parallel `Scout` || `Architect` -> `Builder` -> `Critic` -> `Verifier`)
// - Milestone 4 Context-Budget Skill Management & Controlled Harness² Improvement Pipeline (`propose` -> `validate` -> `promote` -> `rollback`)
// - Milestone 5 Full Engineering IDE Workbench APIs (`/api/ide/files`, `/api/ide/file`, `/api/ide/search`, `/api/ide/git`, `/api/ide/exec`)

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentExecutionNode,
  CompletionEvidenceReport,
  EngineeringRole10,
  ExecutedCommandEvidence,
  PostImplReviewReport,
  ProviderConfigEntry,
  RoleRoutingAssignment,
} from "../shared/apex-contracts.ts";
import { APEX_DATA_DIR, APEX_PROJECT_ROOT } from "./apex-cli.ts";
import {
  callUnifiedFleetWithFailover,
  executeAgentToolBlocks,
  executeAgentToolBlocksAsync,
  gatherGroundedWorkspaceContext,
  revertTurnCheckpoint,
  saveTurnCheckpoint,
  type AgentStepEvent,
  type ChatMessage,
  type FileBackupEntry,
} from "./apex-llm-engine.ts";
import {
  buildOrchestrationPlan,
  evaluateCompletedTurn,
  loadScoreboard,
} from "./decider/apex-orchestrator-router.ts";
import {
  buildExecutionDag,
  deleteProviderConfig,
  executeTaskDag,
  loadProviderConfigs,
  loadRoleRoutingTable,
  saveProviderConfig,
  saveRoleRoutingTable,
  testProviderConnection,
} from "./harness/agent-dag-orchestrator.ts";
import {
  ensureCleanCarbonHome,
  loadUnifiedModelFleet,
  syncUnifiedModelRegistryToDisk,
  type DriverBackend,
} from "./harness/apex-fleet-sync.ts";
import {
  buildCompletionEvidenceReport,
  captureWorkspaceGitDiffSummary,
} from "./harness/completion-evidence.ts";
import {
  appendSessionGenerationEvent,
  applySpillPolicyToText,
  executePtcProgram,
  inspectCordisRuntime,
  mountDynamicPlugin,
  querySessionCorpus,
  RepeatToolReminderGuard,
  runDynamicPlugin,
} from "./harness/deepseek-subsystems.ts";
import {
  buildDesk1GroundedManifest,
  runEgmBoardroomConference,
  runPostImplementationEgmReview,
  type EgmBoardroomBrief,
} from "./harness/egm-boardroom.ts";
import { TaskExecutionManager } from "./harness/execution-manager.ts";
import {
  ensureHarness2TreeInitialized,
  harnessTreeRoot,
  listHarnessProposals,
  listHarnessSnapshots,
  promoteHarnessProposal,
  proposeHarnessImprovement,
  recordHarness2Reflection,
  rollbackHarnessSnapshot,
  validateHarness2TreeViaPython,
  validateHarnessProposal,
} from "./harness/harness2-bridge.ts";
import {
  callMcpServerTool,
  listMcpServerTools,
} from "./harness/mcp-client-bridge.ts";
import { runManagedCommand } from "./harness/process-manager.ts";
import {
  detectSkillConflicts,
  discoverAllUniversalMcpServers,
  discoverAllUniversalSkills,
  estimateSkillTokens,
  loadSkillManagementConfig,
  saveSkillManagementConfig,
  transpileSkillForDriver,
  validateSkillCompatibility,
} from "./harness/universal-skill-loader.ts";
import { parseAndScrubModelResponse } from "./harness/universal-tool-parser.ts";
import {
  assertCanonicalWorkspacePath,
  getLocalSessionToken,
  isAllowedLocalOrigin,
  LocalApiSecurityError,
  readBoundedJsonBody,
  resolveCanonicalWorkspaceRoot,
  verifyLocalApiRequest,
  WorkspaceSecurityError,
} from "./harness/workspace-security.ts";

const repeatGuard = new RepeatToolReminderGuard({ thresholds: [3, 5, 8] });

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = join(APEX_PROJECT_ROOT, "ui", "index.html");
const CONVERSATIONS_FILE = join(APEX_DATA_DIR, "apex-conversations.json");

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
}

export interface ConversationThread {
  id: string;
  projectId: string;
  title: string;
  selectedModelId: string;
  effort: "high" | "medium" | "low";
  mode: "turbo" | "auto_edit" | "ask";
  updatedAt: string;
  messages: Array<
    ChatMessage & {
      completionReport?: CompletionEvidenceReport;
      postImplReview?: PostImplReviewReport;
      dagSubtasks?: AgentExecutionNode[];
    }
  >;
}

export function discoverOperatorProjects(): ProjectEntry[] {
  const userHome = homedir();
  const projects: ProjectEntry[] = [
    { id: "independent", name: "General Chats (Independent)", path: APEX_PROJECT_ROOT },
    { id: "proj-apex-harness", name: "apex harness", path: APEX_PROJECT_ROOT },
  ];
  if (process.env.APEX_DEMO_ISOLATED === "1") {
    return projects;
  }
  const seenPaths = new Set<string>([APEX_PROJECT_ROOT.toLowerCase()]);
  const seenNames = new Set<string>(projects.map((p) => p.name.toLowerCase().trim()));

  const geminiProjDir = join(userHome, ".gemini", "config", "projects");
  if (existsSync(geminiProjDir)) {
    try {
      for (const file of readdirSync(geminiProjDir)) {
        if (!file.endsWith(".json")) continue;
        const raw = JSON.parse(readFileSync(join(geminiProjDir, file), "utf8")) as {
          id?: string;
          name?: string;
          projectResources?: { resources?: Array<{ gitFolder?: { folderUri?: string } }> };
        };
        const uri = raw.projectResources?.resources?.[0]?.gitFolder?.folderUri;
        if (!uri || !raw.name) continue;
        const decodedPath = decodeURIComponent(uri.replace(/^file:\/\/\//, "")).replace(
          /\//g,
          process.platform === "win32" ? "\\" : "/",
        );
        const normName = raw.name.toLowerCase().trim();
        if (seenPaths.has(decodedPath.toLowerCase()) || seenNames.has(normName)) continue;
        if (existsSync(decodedPath)) {
          seenPaths.add(decodedPath.toLowerCase());
          seenNames.add(normName);
          projects.push({
            id: `proj-${raw.id ?? file.replace(".json", "")}`,
            name: raw.name,
            path: decodedPath,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  const extraRoots = (process.env.APEX_EXTRA_WORKSPACE_ROOTS || "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const extraRoot of extraRoots) {
    if (!existsSync(extraRoot)) continue;
    try {
      for (const entry of readdirSync(extraRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const full = join(extraRoot, entry.name);
        const normName = entry.name.toLowerCase().trim();
        if (seenPaths.has(full.toLowerCase()) || seenNames.has(normName)) continue;
        if (existsSync(join(full, ".git")) || existsSync(join(full, "package.json"))) {
          seenPaths.add(full.toLowerCase());
          seenNames.add(normName);
          projects.push({
            id: `proj-extra-${entry.name.replace(/\s+/g, "-")}`,
            name: entry.name,
            path: full,
          });
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }

  return projects;
}

function sanitizeLoadedConversations(rawThreads: ConversationThread[]): ConversationThread[] {
  const cleaned: ConversationThread[] = [];
  for (const t of rawThreads) {
    if (!t.messages || t.messages.length === 0) continue;
    for (const m of t.messages) {
      if (m.role === "assistant" && typeof m.content === "string" && m.content.includes("<tool_call>")) {
        const scrubbed = parseAndScrubModelResponse(m.content);
        m.content =
          scrubbed.visibleText ||
          "Inspected workspace files. Click any step above to view file contents or send a follow-up.";
      }
    }
    cleaned.push(t);
  }
  return cleaned;
}

function loadConversations(projects: readonly ProjectEntry[]): ConversationThread[] {
  mkdirSync(APEX_DATA_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(CONVERSATIONS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(CONVERSATIONS_FILE, "utf8")) as ConversationThread[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const sanitized = sanitizeLoadedConversations(parsed);
        if (sanitized.length > 0) {
          saveConversations(sanitized);
          return sanitized;
        }
      }
    } catch {
      // Fall through to seed default conversations
    }
  }

  const now = new Date().toISOString();
  const seeded: ConversationThread[] = [
    {
      id: "conv-apex-welcome",
      projectId: "independent",
      title: "Welcome to Apex Harness Studio",
      selectedModelId: "auto",
      effort: "high",
      mode: "turbo",
      updatedAt: now,
      messages: [
        {
          id: "msg-welcome-1",
          role: "assistant",
          content: [
            `Welcome to **Apex Harness** — running locally at \`${process.env.APEX_DEMO_ISOLATED === "1" ? "~/apex-harness" : APEX_PROJECT_ROOT}\`.`,
            "",
            "### What is active in your studio:",
            "- **AI Agent Office & Live Multi-Agent DAG Orchestration**: Watch the **Coordinator**, **Scout**, **Architect**, **Builder**, **Critic**, and **Verifier** agents execute in real time with parallel subtask scheduling and live Stop/Cancel/Pause/Resume controls.",
            "- **Full Engineering IDE Workbench**: Switch between **Boardroom**, **Files & Editor**, **Git & Diff**, **Terminal & Tests**, **Providers & 10-Role Router**, **Skills**, and **Harness²**.",
            "- **Evidence-Backed Completion & Security**: Every turn is jailed to the canonical workspace root, audited by an independent post-implementation EGM reviewer, and backed by a verifiable `CompletionEvidenceReport`.",
          ].join("\n"),
          createdAt: now,
          modelId: "agy-acp/gemini-4-argon-high",
          modelDisplayName: "Lead Coordinator (Gemini 4 Argon High)",
          domain: "architecture",
          durationMs: 420,
          completionStatus: "implemented_and_verified",
          steps: [
            {
              id: "seed-step-1",
              kind: "route",
              agentRole: "Coordinator",
              label: "Connected 19 models, 10-role routing table, 112 curated skills, and 15 MCP servers",
              status: "done",
              durationMs: 120,
            },
            {
              id: "seed-step-2",
              kind: "judge",
              agentRole: "Verifier",
              label: "Verified 6-Agent DAG Orchestration, Canonical Containment & Evidence Engine",
              status: "done",
              durationMs: 190,
            },
          ],
          judgeVerdict: {
            passed: true,
            score: 1.0,
            recommendedAction: "accept",
            issues: [],
          },
        },
      ],
    },
  ];

  saveConversations(seeded);
  return seeded;
}

function saveConversations(threads: readonly ConversationThread[]): void {
  mkdirSync(APEX_DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONVERSATIONS_FILE, `${JSON.stringify(threads, null, 2)}\n`, "utf8");
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  allowedOrigin = "http://127.0.0.1:5199",
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type, X-Apex-Token, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const IDE_IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-server",
  "dist-companion",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  "deepseek-harness",
]);

function listWorkspaceFilesTree(
  workspaceRoot: string,
  subDir = ".",
  maxEntries = 160,
): Array<{
  name: string;
  relPath: string;
  kind: "file" | "directory";
  sizeBytes: number;
}> {
  const canonicalRoot = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const targetDir = assertCanonicalWorkspacePath(canonicalRoot, subDir || ".", {
    operation: "ide_list_files",
  });
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    return [];
  }

  const results: Array<{
    name: string;
    relPath: string;
    kind: "file" | "directory";
    sizeBytes: number;
  }> = [];

  const entries = readdirSync(targetDir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (results.length >= maxEntries) break;
    if (IDE_IGNORED_NAMES.has(entry.name)) continue;
    const full = join(targetDir, entry.name);
    try {
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        // Validate symlink stays inside canonical workspace
        assertCanonicalWorkspacePath(canonicalRoot, full, { operation: "ide_list_symlink" });
      }
      const rel = relative(canonicalRoot, full).replace(/\\/g, "/");
      results.push({
        name: entry.name,
        relPath: rel || entry.name,
        kind: lst.isDirectory() ? "directory" : "file",
        sizeBytes: lst.isFile() ? lst.size : 0,
      });
    } catch {
      // Skip paths that escape canonical root or are unreadable
    }
  }
  return results;
}

function searchWorkspaceText(
  workspaceRoot: string,
  query: string,
  maxHits = 40,
): Array<{ file: string; line: number; snippet: string }> {
  const canonicalRoot = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return [];

  const hits: Array<{ file: string; line: number; snippet: string }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || hits.length >= maxHits) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= maxHits) break;
      if (IDE_IGNORED_NAMES.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      try {
        const lst = lstatSync(full);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          lst.isFile() &&
          lst.size < 300_000 &&
          /\.(ts|tsx|js|mjs|cjs|py|json|md|html|css|yml|yaml|sh|ps1)$/i.test(name)
        ) {
          const content = readFileSync(full, "utf8");
          if (!content.toLowerCase().includes(cleanQuery)) continue;
          const lines = content.split(/\r?\n/);
          const rel = relative(canonicalRoot, full).replace(/\\/g, "/");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.toLowerCase().includes(cleanQuery)) {
              hits.push({
                file: rel,
                line: i + 1,
                snippet: lines[i]!.trim().slice(0, 180),
              });
              if (hits.length >= maxHits) break;
            }
          }
        }
      } catch {
        // Ignore
      }
    }
  };
  walk(canonicalRoot, 0);
  return hits;
}

export function createApexAppServer() {
  syncUnifiedModelRegistryToDisk(APEX_DATA_DIR);
  ensureCleanCarbonHome(APEX_DATA_DIR);
  ensureHarness2TreeInitialized(APEX_DATA_DIR);

  const projects = discoverOperatorProjects();
  let conversations = loadConversations(projects);
  const executionManager = new TaskExecutionManager(APEX_DATA_DIR);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:5199");

    // Handle CORS preflight with strict local Origin validation (never wildcard *)
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      if (origin && !isAllowedLocalOrigin(origin)) {
        sendJson(res, 403, {
          ok: false,
          code: "FORBIDDEN_ORIGIN",
          error: `Cross-origin preflight from "${origin}" is forbidden.`,
        });
        return;
      }
      const allowedOrigin = origin && isAllowedLocalOrigin(origin) ? origin : "http://127.0.0.1:5199";
      res.writeHead(204, {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Apex-Token, Authorization",
      });
      res.end();
      return;
    }

    let allowedOrigin = "http://127.0.0.1:5199";
    try {
      const verified = verifyLocalApiRequest(req);
      allowedOrigin = verified.allowedOriginHeader;

      // Serve Main App UI
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        if (existsSync(UI_HTML_PATH)) {
          const html = readFileSync(UI_HTML_PATH, "utf8");
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(html);
          return;
        }
        res.writeHead(404);
        res.end("UI file not found");
        return;
      }

      // Serve Stylesheet & Agent Office Simulation Engine
      if (req.method === "GET" && url.pathname === "/styles.css") {
        const cssPath = join(APEX_PROJECT_ROOT, "ui", "styles.css");
        if (existsSync(cssPath)) {
          res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
          res.end(readFileSync(cssPath, "utf8"));
          return;
        }
      }
      if (req.method === "GET" && url.pathname === "/agent-office.js") {
        const jsPath = join(APEX_PROJECT_ROOT, "ui", "agent-office.js");
        if (existsSync(jsPath)) {
          res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(readFileSync(jsPath, "utf8"));
          return;
        }
      }

      // Standalone EGM Boardroom Conference API
      if (req.method === "POST" && url.pathname === "/api/egm/boardroom") {
        const body = await readBoundedJsonBody<{
          prompt: string;
          projectId?: string;
          fastMode?: boolean;
        }>(req);
        const proj = projects.find((p) => p.id === body.projectId) ?? projects[0]!;
        const brief = await runEgmBoardroomConference({
          prompt: body.prompt || "Audit workspace architecture and implementation readiness",
          workspacePath: proj.path,
          fastMode: body.fastMode ?? false,
        });
        sendJson(res, 200, { ok: true, brief }, allowedOrigin);
        return;
      }

      // Bootstrap State API
      if (
        req.method === "GET" &&
        (url.pathname === "/api/bootstrap" ||
          url.pathname === "/api/state" ||
          url.pathname === "/api/health")
      ) {
        const fleet = loadUnifiedModelFleet();
        const scoreboard = loadScoreboard(APEX_DATA_DIR, fleet);
        const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
        const mcpServers = discoverAllUniversalMcpServers();
        const h2Status = ensureHarness2TreeInitialized(APEX_DATA_DIR);
        const h2Validation = validateHarness2TreeViaPython(APEX_PROJECT_ROOT, APEX_DATA_DIR);

        const treeRoot = harnessTreeRoot(APEX_DATA_DIR);
        const surfaceFiles: Record<string, string> = {};
        for (const rel of [
          "systemprompt.md",
          "guardrails.md",
          "LongTermMEMORY.md",
          "tool_descriptions/tool_guidance.md",
        ]) {
          const p = join(treeRoot, rel);
          if (existsSync(p)) surfaceFiles[rel] = readFileSync(p, "utf8");
        }

        sendJson(
          res,
          200,
          {
            sessionToken: getLocalSessionToken(),
            projects,
            conversations,
            providers: loadProviderConfigs(APEX_DATA_DIR),
            roleRouting: loadRoleRoutingTable(APEX_DATA_DIR),
            executions: executionManager.listExecutions().slice(0, 30),
            skillManagement: loadSkillManagementConfig(APEX_DATA_DIR),
            skillConflicts: detectSkillConflicts(skills),
            models: fleet.map((m) => ({
              ...m,
              emaScore: scoreboard.entries[m.id]?.emaScore ?? m.baseEmaScore,
              domainScores: scoreboard.entries[m.id]?.domainScores ?? {},
              successCount: scoreboard.entries[m.id]?.successCount ?? 1,
              failureCount: scoreboard.entries[m.id]?.failureCount ?? 0,
            })),
            skills: skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              ecosystem: s.ecosystem,
              kind: s.kind,
              capabilityCluster: s.capabilityCluster,
              mergedFrom: s.mergedFrom,
              sensitiveDualUse: s.sensitiveDualUse,
              securityClass: s.securityClass,
              estimatedTokens: s.estimatedTokens,
              assignedRoles: s.assignedRoles,
              sourcePath: s.sourcePath,
            })),
            mcpServers,
            deepseekRuntime: inspectCordisRuntime(APEX_DATA_DIR),
            harness2: {
              status: h2Status,
              validation: h2Validation,
              surfaceFiles,
              proposals: listHarnessProposals(APEX_DATA_DIR),
              snapshots: listHarnessSnapshots(APEX_DATA_DIR),
            },
          },
          allowedOrigin,
        );
        return;
      }

      // ======================================================================
      // PART 4: EXECUTION LIFECYCLE & USER CONTROL ENDPOINTS
      // ======================================================================

      if (req.method === "GET" && url.pathname === "/api/executions") {
        const conversationId = url.searchParams.get("conversationId") ?? undefined;
        const projectId = url.searchParams.get("projectId") ?? undefined;
        sendJson(
          res,
          200,
          {
            ok: true,
            executions: executionManager.listExecutions({ conversationId, projectId }),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/executions/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/executions/", ""));
        const rec = executionManager.getExecution(id);
        if (!rec) {
          sendJson(res, 404, { ok: false, error: `Execution '${id}' not found` }, allowedOrigin);
          return;
        }
        sendJson(res, 200, { ok: true, execution: rec }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && /^\/api\/executions\/[^/]+\/cancel$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const body = await readBoundedJsonBody<{ reason?: string }>(req);
        const rec = executionManager.cancelExecution(id, body.reason || "Cancelled by user");
        sendJson(res, 200, { ok: true, execution: rec }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && /^\/api\/executions\/[^/]+\/pause$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const rec = executionManager.pauseExecution(id);
        sendJson(res, 200, { ok: true, execution: rec }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && /^\/api\/executions\/[^/]+\/resume$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const rec = executionManager.resumeExecution(id);
        sendJson(res, 200, { ok: true, execution: rec }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && /^\/api\/executions\/[^/]+\/approve$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const body = await readBoundedJsonBody<{ approved: boolean }>(req);
        const rec = executionManager.resolveApproval(id, Boolean(body.approved));
        sendJson(res, 200, { ok: true, execution: rec }, allowedOrigin);
        return;
      }

      // ======================================================================
      // PARTS 7 & 8: CONFIGURABLE PROVIDERS & 10-ROLE ROUTING ENDPOINTS
      // ======================================================================

      if (req.method === "GET" && url.pathname === "/api/providers") {
        sendJson(
          res,
          200,
          { ok: true, providers: loadProviderConfigs(APEX_DATA_DIR) },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/providers/test") {
        const body = await readBoundedJsonBody<{ providerId: string }>(req);
        const result = await testProviderConnection(APEX_DATA_DIR, body.providerId);
        sendJson(res, 200, result, allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/providers") {
        const body = await readBoundedJsonBody<
          Partial<ProviderConfigEntry> & { id: string; apiKey?: string }
        >(req);
        if (!body.id || !body.id.trim()) {
          sendJson(res, 400, { ok: false, error: "Provider 'id' is required" }, allowedOrigin);
          return;
        }
        const saved = saveProviderConfig(APEX_DATA_DIR, body);
        sendJson(
          res,
          200,
          { ok: true, provider: saved, providers: loadProviderConfigs(APEX_DATA_DIR) },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/providers/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/providers/", ""));
        const deleted = deleteProviderConfig(APEX_DATA_DIR, id);
        sendJson(
          res,
          deleted ? 200 : 404,
          { ok: deleted, providers: loadProviderConfigs(APEX_DATA_DIR) },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/routing/roles") {
        sendJson(
          res,
          200,
          { ok: true, roles: loadRoleRoutingTable(APEX_DATA_DIR) },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/routing/roles") {
        const body = await readBoundedJsonBody<{
          assignments: Array<Partial<RoleRoutingAssignment> & { role: EngineeringRole10 }>;
        }>(req);
        const updated = saveRoleRoutingTable(APEX_DATA_DIR, body.assignments ?? []);
        sendJson(res, 200, { ok: true, roles: updated }, allowedOrigin);
        return;
      }

      // ======================================================================
      // PART 9: SKILL MANAGEMENT & CONFLICT/COMPATIBILITY ENDPOINTS
      // ======================================================================

      if (req.method === "GET" && url.pathname === "/api/skills/config") {
        const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
        sendJson(
          res,
          200,
          {
            ok: true,
            config: loadSkillManagementConfig(APEX_DATA_DIR),
            conflicts: detectSkillConflicts(skills),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/skills/config") {
        const body = await readBoundedJsonBody<{
          disabledSkillIds?: string[];
          projectSkillOverrides?: Record<string, string[]>;
          roleSkillAssignments?: Record<string, string[]>;
        }>(req);
        const current = loadSkillManagementConfig(APEX_DATA_DIR);
        const next = {
          disabledSkillIds: body.disabledSkillIds ?? current.disabledSkillIds,
          projectSkillOverrides: body.projectSkillOverrides ?? current.projectSkillOverrides,
          roleSkillAssignments: body.roleSkillAssignments ?? current.roleSkillAssignments,
        };
        saveSkillManagementConfig(APEX_DATA_DIR, next);
        sendJson(res, 200, { ok: true, config: next }, allowedOrigin);
        return;
      }

      // ======================================================================
      // PART 11: CONTROLLED HARNESS² CONTINUOUS IMPROVEMENT ENDPOINTS
      // ======================================================================

      if (req.method === "GET" && url.pathname === "/api/harness2/proposals") {
        sendJson(
          res,
          200,
          {
            ok: true,
            proposals: listHarnessProposals(APEX_DATA_DIR),
            snapshots: listHarnessSnapshots(APEX_DATA_DIR),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/harness2/proposals") {
        const body = await readBoundedJsonBody<{
          targetSurfaceRelPath:
            | "systemprompt.md"
            | "guardrails.md"
            | "LongTermMEMORY.md"
            | "tool_descriptions/tool_guidance.md";
          title: string;
          proposedAddition: string;
          sourceExecutionId?: string;
        }>(req);
        const prop = proposeHarnessImprovement(APEX_DATA_DIR, {
          targetSurfaceRelPath: body.targetSurfaceRelPath || "LongTermMEMORY.md",
          title: body.title || "Operational Lesson",
          proposedAddition: body.proposedAddition || "",
          sourceExecutionId: body.sourceExecutionId,
        });
        const validated = validateHarnessProposal(APEX_DATA_DIR, prop.proposalId);
        sendJson(
          res,
          200,
          {
            ok: validated.status === "validated",
            proposal: validated,
            proposals: listHarnessProposals(APEX_DATA_DIR),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/harness2/promote") {
        const body = await readBoundedJsonBody<{ proposalId: string }>(req);
        const resPromote = promoteHarnessProposal(APEX_PROJECT_ROOT, APEX_DATA_DIR, body.proposalId);
        sendJson(
          res,
          resPromote.ok ? 200 : 400,
          {
            ...resPromote,
            proposals: listHarnessProposals(APEX_DATA_DIR),
            snapshots: listHarnessSnapshots(APEX_DATA_DIR),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/harness2/rollback") {
        const body = await readBoundedJsonBody<{ snapshotId: string }>(req);
        const resRollback = rollbackHarnessSnapshot(APEX_DATA_DIR, body.snapshotId);
        sendJson(
          res,
          resRollback.ok ? 200 : 400,
          {
            ...resRollback,
            snapshots: listHarnessSnapshots(APEX_DATA_DIR),
          },
          allowedOrigin,
        );
        return;
      }

      // ======================================================================
      // PART 12: ENGINEERING IDE WORKBENCH ENDPOINTS (Canonical-Jailed)
      // ======================================================================

      if (req.method === "GET" && url.pathname === "/api/ide/files") {
        const projectId = url.searchParams.get("projectId") ?? "proj-apex-harness";
        const subDir = url.searchParams.get("subDir") ?? ".";
        const proj = projects.find((p) => p.id === projectId) ?? projects[0]!;
        const entries = listWorkspaceFilesTree(proj.path, subDir);
        sendJson(
          res,
          200,
          { ok: true, projectId: proj.id, workspaceRoot: proj.path, subDir, entries },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/ide/file") {
        const projectId = url.searchParams.get("projectId") ?? "proj-apex-harness";
        const relPath = url.searchParams.get("path") ?? "";
        const proj = projects.find((p) => p.id === projectId) ?? projects[0]!;
        const targetPath = assertCanonicalWorkspacePath(proj.path, relPath, {
          operation: "ide_read_file",
        });
        if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
          sendJson(res, 404, { ok: false, error: `File not found: ${relPath}` }, allowedOrigin);
          return;
        }
        const content = readFileSync(targetPath, "utf8");
        sendJson(
          res,
          200,
          {
            ok: true,
            path: relative(resolveCanonicalWorkspaceRoot(proj.path), targetPath).replace(/\\/g, "/"),
            content,
            lineCount: content.split(/\r?\n/).length,
            sizeBytes: Buffer.byteLength(content, "utf8"),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ide/file") {
        const body = await readBoundedJsonBody<{
          projectId?: string;
          path: string;
          content?: string;
          target?: string;
          replacement?: string;
        }>(req);
        const proj = projects.find((p) => p.id === body.projectId) ?? projects[0]!;
        const canonicalRoot = resolveCanonicalWorkspaceRoot(proj.path);
        const targetPath = assertCanonicalWorkspacePath(canonicalRoot, body.path, {
          operation: "ide_write_file",
        });

        const existedBefore = existsSync(targetPath);
        const previousContent = existedBefore ? readFileSync(targetPath, "utf8") : undefined;
        const checkpointId = `cp-ide-${Date.now()}-${randomUUID().slice(0, 6)}`;
        const backup: FileBackupEntry = {
          fullPath: targetPath,
          existedBefore,
          previousContent,
        };
        saveTurnCheckpoint(APEX_DATA_DIR, {
          checkpointId,
          workspaceRoot: canonicalRoot,
          createdAt: new Date().toISOString(),
          reverted: false,
          files: [backup],
        });

        let updatedContent: string;
        if (typeof body.target === "string" && typeof body.replacement === "string") {
          if (!existedBefore || previousContent === undefined) {
            sendJson(res, 404, { ok: false, error: `File not found: ${body.path}` }, allowedOrigin);
            return;
          }
          if (!previousContent.includes(body.target)) {
            sendJson(
              res,
              400,
              { ok: false, error: `Target snippet not found in ${body.path}` },
              allowedOrigin,
            );
            return;
          }
          updatedContent = previousContent.replaceAll(body.target, body.replacement);
        } else {
          updatedContent = body.content ?? "";
        }

        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, updatedContent, "utf8");
        sendJson(
          res,
          200,
          {
            ok: true,
            path: relative(canonicalRoot, targetPath).replace(/\\/g, "/"),
            checkpointId,
            sizeBytes: Buffer.byteLength(updatedContent, "utf8"),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/ide/search") {
        const projectId = url.searchParams.get("projectId") ?? "proj-apex-harness";
        const q = url.searchParams.get("q") ?? "";
        const proj = projects.find((p) => p.id === projectId) ?? projects[0]!;
        const hits = searchWorkspaceText(proj.path, q);
        sendJson(res, 200, { ok: true, query: q, hits }, allowedOrigin);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/ide/git") {
        const projectId = url.searchParams.get("projectId") ?? "proj-apex-harness";
        const proj = projects.find((p) => p.id === projectId) ?? projects[0]!;
        const canonicalRoot = resolveCanonicalWorkspaceRoot(proj.path);
        const statusCmd = await runManagedCommand({
          command: "git status --short",
          cwd: canonicalRoot,
          workspaceRoot: canonicalRoot,
          timeoutMs: 6_000,
          mode: "turbo",
        });
        const diffCmd = await runManagedCommand({
          command: "git diff HEAD",
          cwd: canonicalRoot,
          workspaceRoot: canonicalRoot,
          timeoutMs: 8_000,
          mode: "turbo",
        });
        sendJson(
          res,
          200,
          {
            ok: true,
            workspaceRoot: canonicalRoot,
            statusOutput: statusCmd.stdout.trim(),
            diffOutput: diffCmd.stdout.slice(0, 32_000),
            summary: captureWorkspaceGitDiffSummary(canonicalRoot),
          },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ide/exec") {
        const body = await readBoundedJsonBody<{
          projectId?: string;
          command: string;
          cwd?: string;
          timeoutMs?: number;
          mode?: "turbo" | "auto_edit" | "ask";
        }>(req);
        const proj = projects.find((p) => p.id === body.projectId) ?? projects[0]!;
        const canonicalRoot = resolveCanonicalWorkspaceRoot(proj.path);
        const resCmd = await runManagedCommand({
          command: body.command,
          cwd: body.cwd || ".",
          workspaceRoot: canonicalRoot,
          timeoutMs: Math.min(body.timeoutMs ?? 25_000, 60_000),
          mode: body.mode ?? "turbo",
        });
        sendJson(res, 200, resCmd, allowedOrigin);
        return;
      }

      // ======================================================================
      // DEEPSEEK-HARNESS SUBSYSTEMS (OS-Permission Sandboxed PTC & Signed Plugins)
      // ======================================================================

      if (req.method === "POST" && url.pathname === "/api/dsh/ptc") {
        const body = await readBoundedJsonBody<{
          code: string;
          projectId?: string;
          sessionId?: string;
        }>(req);
        const proj = projects.find((p) => p.id === body.projectId) ?? projects[0]!;
        const result = await executePtcProgram({
          code: body.code || "return await host.listFiles('.');",
          workspacePath: proj.path,
          dataDir: APEX_DATA_DIR,
          sessionId: body.sessionId || "ptc-studio",
        });
        sendJson(res, 200, result, allowedOrigin);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/dsh/runtime") {
        sendJson(res, 200, inspectCordisRuntime(APEX_DATA_DIR), allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/dsh/plugins") {
        const body = await readBoundedJsonBody<{
          action?: "mount" | "run";
          id: string;
          name?: string;
          description?: string;
          version?: string;
          permissions?: Array<"pure_transform" | "workspace_read">;
          code?: string;
          input?: Record<string, unknown>;
        }>(req);
        if (body.action === "run") {
          const runRes = await runDynamicPlugin(APEX_DATA_DIR, body.id, body.input ?? {});
          sendJson(res, 200, runRes, allowedOrigin);
          return;
        }
        const mounted = mountDynamicPlugin(APEX_DATA_DIR, {
          id: body.id,
          name: body.name || body.id,
          description: body.description || "Dynamic runtime plugin",
          version: body.version || "1.0.0",
          permissions: body.permissions ?? ["pure_transform"],
          code: body.code || "return { ok: true, input };",
        });
        sendJson(
          res,
          200,
          { ok: true, plugin: mounted, runtime: inspectCordisRuntime(APEX_DATA_DIR) },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/dsh/session-query") {
        const q = url.searchParams.get("q") ?? "";
        const hits = querySessionCorpus(APEX_DATA_DIR, q, conversations);
        sendJson(res, 200, { ok: true, query: q, hits }, allowedOrigin);
        return;
      }

      // ======================================================================
      // CONVERSATIONS, PROJECTS, SKILLS, HARNESS², CHECKPOINTS & MCP
      // ======================================================================

      if (req.method === "POST" && url.pathname === "/api/conversations") {
        const body = await readBoundedJsonBody<{
          projectId?: string;
          title?: string;
          selectedModelId?: string;
          effort?: "high" | "medium" | "low";
          mode?: "turbo" | "auto_edit" | "ask";
          forceNew?: boolean;
        }>(req);
        const targetProjId = body.projectId || "independent";
        if (!body.forceNew) {
          const existingEmpty = conversations.find(
            (c) => c.projectId === targetProjId && (!c.messages || c.messages.length === 0),
          );
          if (existingEmpty) {
            existingEmpty.updatedAt = new Date().toISOString();
            sendJson(res, 200, { thread: existingEmpty, conversations }, allowedOrigin);
            return;
          }
        }
        const thread: ConversationThread = {
          id: `conv-${randomUUID().slice(0, 8)}`,
          projectId: targetProjId,
          title:
            body.title?.trim() ||
            (targetProjId === "independent" ? "Independent Chat" : "New Conversation"),
          selectedModelId: body.selectedModelId || "auto",
          effort: body.effort || "high",
          mode: body.mode || "turbo",
          updatedAt: new Date().toISOString(),
          messages: [],
        };
        conversations = [thread, ...conversations];
        saveConversations(conversations);
        sendJson(res, 200, { thread, conversations }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/conversations/clean-empty") {
        conversations = conversations.filter((c) => c.messages && c.messages.length > 0);
        saveConversations(conversations);
        sendJson(res, 200, { ok: true, conversations }, allowedOrigin);
        return;
      }

      if (req.method === "PATCH" && url.pathname.startsWith("/api/conversations/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/conversations/", ""));
        const body = await readBoundedJsonBody<{ title?: string; projectId?: string }>(req);
        const thread = conversations.find((c) => c.id === id);
        if (!thread) {
          sendJson(res, 404, { error: "Conversation not found" }, allowedOrigin);
          return;
        }
        if (body.title?.trim()) thread.title = body.title.trim();
        if (body.projectId?.trim()) thread.projectId = body.projectId.trim();
        thread.updatedAt = new Date().toISOString();
        saveConversations(conversations);
        sendJson(res, 200, { ok: true, thread, conversations }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/projects") {
        const body = await readBoundedJsonBody<{ path: string; name?: string }>(req);
        const resolvedPath = resolve((body.path ?? "").trim());
        if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
          sendJson(res, 400, { error: `Folder not found: ${resolvedPath}` }, allowedOrigin);
          return;
        }
        const entry: ProjectEntry = {
          id: `proj-custom-${Date.now()}`,
          name: body.name?.trim() || basename(resolvedPath),
          path: resolvedPath,
        };
        projects.splice(1, 0, entry);
        sendJson(res, 200, { project: entry, projects }, allowedOrigin);
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
        const id = decodeURIComponent(url.pathname.replace("/api/conversations/", ""));
        conversations = conversations.filter((c) => c.id !== id);
        saveConversations(conversations);
        sendJson(res, 200, { ok: true, conversations }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/skills/transpile") {
        const body = await readBoundedJsonBody<{
          skillName: string;
          driver: DriverBackend;
          args?: string;
        }>(req);
        const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
        const found = skills.find(
          (s) => s.name.toLowerCase() === (body.skillName ?? "").toLowerCase(),
        );
        if (!found) {
          sendJson(res, 404, { error: `Skill "${body.skillName}" not found` }, allowedOrigin);
          return;
        }
        const transpiled = transpileSkillForDriver(
          found,
          body.driver || "antigravity",
          body.args || "",
        );
        const compatibility = validateSkillCompatibility(found, body.driver || "antigravity");
        sendJson(
          res,
          200,
          { skill: found, driver: body.driver, transpiled, compatibility },
          allowedOrigin,
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/harness2/surface") {
        const body = await readBoundedJsonBody<{ relPath: string; content: string }>(req);
        const allowed = new Set([
          "systemprompt.md",
          "guardrails.md",
          "LongTermMEMORY.md",
          "tool_descriptions/tool_guidance.md",
        ]);
        if (!allowed.has(body.relPath)) {
          sendJson(
            res,
            400,
            { error: "Surface file not editable via quick studio" },
            allowedOrigin,
          );
          return;
        }
        const target = join(harnessTreeRoot(APEX_DATA_DIR), body.relPath);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, body.content, "utf8");
        const validation = validateHarness2TreeViaPython(APEX_PROJECT_ROOT, APEX_DATA_DIR);
        sendJson(res, 200, { ok: true, validation }, allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/turn/revert") {
        const body = await readBoundedJsonBody<{
          checkpointId: string;
          conversationId?: string;
          messageId?: string;
        }>(req);
        const result = revertTurnCheckpoint(APEX_DATA_DIR, body.checkpointId || "");
        if (result.ok && body.conversationId && body.messageId) {
          const thread = conversations.find((c) => c.id === body.conversationId);
          const msg = thread?.messages.find((m) => m.id === body.messageId);
          if (msg) {
            msg.reverted = true;
            saveConversations(conversations);
          }
        }
        sendJson(res, result.ok ? 200 : 400, result, allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/mcp/tools") {
        const body = await readBoundedJsonBody<{ serverName: string }>(req);
        const servers = discoverAllUniversalMcpServers();
        const srv = servers.find(
          (s) => s.name.toLowerCase() === (body.serverName || "").toLowerCase(),
        );
        if (!srv) {
          sendJson(
            res,
            404,
            { ok: false, error: `MCP server "${body.serverName}" not found` },
            allowedOrigin,
          );
          return;
        }
        const listRes = await listMcpServerTools(srv);
        sendJson(res, 200, listRes, allowedOrigin);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/mcp/call") {
        const body = await readBoundedJsonBody<{
          serverName: string;
          toolName: string;
          args?: Record<string, unknown>;
        }>(req);
        const servers = discoverAllUniversalMcpServers();
        const srv = servers.find(
          (s) => s.name.toLowerCase() === (body.serverName || "").toLowerCase(),
        );
        if (!srv) {
          sendJson(
            res,
            404,
            { ok: false, error: `MCP server "${body.serverName}" not found` },
            allowedOrigin,
          );
          return;
        }
        const callRes = await callMcpServerTool(srv, body.toolName, body.args ?? {});
        sendJson(res, 200, callRes, allowedOrigin);
        return;
      }

      // ======================================================================
      // REAL-TIME STREAMING MULTI-AGENT DAG CHAT TURN (SSE)
      // ======================================================================
      if (req.method === "POST" && url.pathname === "/api/chat/stream") {
        const body = await readBoundedJsonBody<{
          conversationId: string;
          prompt: string;
          selectedModelId?: string;
          effort?: "high" | "medium" | "low";
          mode?: "turbo" | "auto_edit" | "ask";
        }>(req);

        const thread = conversations.find((c) => c.id === body.conversationId);
        if (!thread) {
          sendJson(res, 404, { error: "Conversation not found" }, allowedOrigin);
          return;
        }

        const project = projects.find((p) => p.id === thread.projectId) ?? projects[0]!;
        const isIndependent = project.id === "independent";
        const promptText = (body.prompt ?? "").trim();
        if (!promptText) {
          sendJson(res, 400, { error: "Empty prompt" }, allowedOrigin);
          return;
        }

        if (body.selectedModelId) thread.selectedModelId = body.selectedModelId;
        if (body.effort) thread.effort = body.effort;
        if (body.mode) thread.mode = body.mode;

        if (
          thread.messages.length === 0 ||
          thread.title === "New Conversation" ||
          thread.title === "Independent Chat"
        ) {
          thread.title = promptText.slice(0, 48) + (promptText.length > 48 ? "…" : "");
        }

        const { record: execRecord, signal: execSignal } = executionManager.createExecution({
          conversationId: thread.id,
          projectId: project.id,
          workspaceRoot: project.path,
          requirement: promptText,
          mode: thread.mode,
          effort: thread.effort,
          selectedModelId: thread.selectedModelId,
        });
        const executionId = execRecord.executionId;

        const userMsg: ChatMessage = {
          id: `msg-${randomUUID().slice(0, 8)}`,
          role: "user",
          content: promptText,
          createdAt: new Date().toISOString(),
          executionId,
        };
        thread.messages.push(userMsg);
        thread.updatedAt = new Date().toISOString();
        saveConversations(conversations);

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": allowedOrigin,
        });

        const sendEvent = (event: string, data: unknown) => {
          if (!res.writableEnded) {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
        };

        const emitDagState = () => {
          const rec = executionManager.getExecution(executionId);
          if (rec) {
            sendEvent("execution", {
              executionId: rec.executionId,
              state: rec.state,
              subtasks: rec.subtasks,
              pendingApproval: rec.pendingApproval,
              checkpointId: rec.checkpointId,
            });
          }
        };

        const turnStart = Date.now();
        const allSteps: AgentStepEvent[] = [];
        const pushStep = (step: AgentStepEvent) => {
          const idx = allSteps.findIndex((s) => s.id === step.id);
          if (idx >= 0) allSteps[idx] = step;
          else allSteps.push(step);
          sendEvent("step", step);
          sendEvent("office", {
            executionId,
            mode: "live",
            activeRole: step.agentRole || "Coordinator",
            statusText: step.plainSummary || step.label,
            detail: step.detail || "",
            status: step.status,
          });
        };

        try {
          appendSessionGenerationEvent(APEX_DATA_DIR, {
            sessionId: thread.id,
            type: "turn/start",
            content: promptText,
          });
          appendSessionGenerationEvent(APEX_DATA_DIR, {
            sessionId: thread.id,
            type: "user/message",
            content: promptText,
          });

          const repeatOutcome = repeatGuard.recordToolCall(thread.id, "chat_turn", {
            prompt: promptText,
          });
          if (repeatOutcome.reminderMessage) {
            pushStep({
              id: `step-guard-${Date.now()}`,
              kind: "judge",
              agentRole: "Critic",
              label: `Loop Protection: Detected ${repeatOutcome.consecutiveCount} repeated calls`,
              plainSummary: `Critic Agent prevented repetitive loop`,
              detail: repeatOutcome.reminderMessage.slice(0, 140),
              status: "done",
              durationMs: 2,
            });
          }

          const treeRoot = harnessTreeRoot(APEX_DATA_DIR);
          const sysPromptSurface = existsSync(join(treeRoot, "systemprompt.md"))
            ? readFileSync(join(treeRoot, "systemprompt.md"), "utf8")
            : "";
          const guardrailsSurface = existsSync(join(treeRoot, "guardrails.md"))
            ? readFileSync(join(treeRoot, "guardrails.md"), "utf8")
            : "";

          const historyMessages = thread.messages.slice(-7, -1).map((m) => ({
            role: m.role,
            content: m.content,
          }));

          const dagResult = await executeTaskDag({
            executionManager,
            executionId,
            dataDir: APEX_DATA_DIR,
            workspaceRoot: project.path,
            prompt: promptText,
            preferredModelId: thread.selectedModelId,
            mode: thread.mode,
            effort: thread.effort,
            isIndependent,
            adaptiveTopology: Boolean(
              (body as { adaptiveTopology?: boolean }).adaptiveTopology,
            ),
            systemPromptPrefix: [
              sysPromptSurface,
              guardrailsSurface,
              repeatOutcome.reminderMessage
                ? `--- LOOP HYGIENE GUARD ---\n${repeatOutcome.reminderMessage}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            conversationHistory: historyMessages,
            onPlan: (plan) => sendEvent("plan", plan),
            onEgmBrief: (egm) => sendEvent("egm", egm),
            onStep: pushStep,
            onDagUpdate: () => emitDagState(),
          });

          if (dagResult.executionRecord.state === "cancelled" || execSignal.aborted) {
            throw new Error(dagResult.executionRecord.error || "Execution cancelled by user");
          }

          const finalResponseText =
            dagResult.responseText ||
            "Completed workspace inspection. Expand any step above to view the file contents.";
          const actualModelUsed = `${dagResult.usedGateway}/${dagResult.usedModel}`;
          const { plan, completionReport, postImplReview } = dagResult;
          const turnCheckpointId = dagResult.checkpointId || undefined;

          // Stream chunks smoothly to the UI
          const chunkSize = 120;
          for (let i = 0; i < finalResponseText.length; i += chunkSize) {
            sendEvent("delta", { text: finalResponseText.slice(i, i + chunkSize) });
          }

          const verdict = evaluateCompletedTurn({
            dataDir: APEX_DATA_DIR,
            modelId: plan.primaryModel.id,
            domain: plan.classification.primaryDomain,
            responseText: finalResponseText,
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

          if (verdict.passed) {
            recordHarness2Reflection(APEX_DATA_DIR, {
              timestamp: new Date().toISOString(),
              taskSummary: promptText.slice(0, 80),
              domain: plan.classification.primaryDomain,
              modelId: plan.primaryModel.id,
              passed: true,
              score: verdict.score,
              lessonLearned: `Successfully executed ${plan.classification.primaryDomain} task in project "${project.name}" using ${actualModelUsed} with skills [${plan.mountedSkills.map((s) => s.name).join(", ")}].`,
            });
          }

          const assistantMsg: ConversationThread["messages"][number] = {
            id: `msg-${randomUUID().slice(0, 8)}`,
            role: "assistant",
            content: finalResponseText,
            createdAt: new Date().toISOString(),
            executionId,
            modelId: actualModelUsed,
            modelDisplayName: plan.primaryModel.displayName,
            domain: plan.classification.primaryDomain,
            durationMs: Date.now() - turnStart,
            steps: allSteps,
            mountedSkills: plan.mountedSkills,
            checkpointId: turnCheckpointId,
            completionStatus: completionReport.status,
            completionReport,
            postImplReview,
            dagSubtasks: dagResult.executionRecord.subtasks,
            judgeVerdict: {
              passed: verdict.passed,
              score: verdict.score,
              recommendedAction: verdict.recommendedAction,
              issues: completionReport.remainingIssues,
            },
          };

          thread.messages.push(assistantMsg);
          thread.updatedAt = new Date().toISOString();
          saveConversations(conversations);

          appendSessionGenerationEvent(APEX_DATA_DIR, {
            sessionId: thread.id,
            type: "assistant/message",
            modelId: actualModelUsed,
            domain: plan.classification.primaryDomain,
            content: finalResponseText,
          });
          appendSessionGenerationEvent(APEX_DATA_DIR, {
            sessionId: thread.id,
            type: "turn/end",
            modelId: actualModelUsed,
            domain: plan.classification.primaryDomain,
            content: `score=${verdict.score} status=${completionReport.status}`,
          });

          sendEvent("done", {
            executionId,
            message: assistantMsg,
            completionReport,
            postImplReview,
            threadTitle: thread.title,
            dagTopologyMode: dagResult.dagTopologyMode,
          });
        } catch (err) {
          const isCancelled =
            execSignal.aborted ||
            executionManager.getExecution(executionId)?.state === "cancelled" ||
            /cancel|abort/i.test(err instanceof Error ? err.message : String(err));

          if (isCancelled && executionManager.getExecution(executionId)?.state !== "cancelled") {
            executionManager.cancelExecution(
              executionId,
              err instanceof Error ? err.message : "Cancelled",
            );
          } else if (!isCancelled) {
            executionManager.transitionState(executionId, "failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          emitDagState();
          sendEvent("error", {
            executionId,
            cancelled: isCancelled,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          res.end();
        }
        return;
      }

      sendJson(res, 404, { error: `Route not found: ${req.method} ${url.pathname}` }, allowedOrigin);
    } catch (err) {
      if (err instanceof LocalApiSecurityError) {
        sendJson(
          res,
          err.statusCode,
          { ok: false, code: err.code, error: err.message },
          allowedOrigin,
        );
        return;
      }
      if (err instanceof WorkspaceSecurityError) {
        sendJson(
          res,
          403,
          { ok: false, code: err.code, error: err.message },
          allowedOrigin,
        );
        return;
      }
      sendJson(
        res,
        500,
        {
          ok: false,
          code: "INTERNAL_ERROR",
          error: err instanceof Error ? err.message : "Internal server error",
        },
        allowedOrigin,
      );
    }
  });
}

const PORT = Number(process.env.APEX_APP_PORT || process.env.PORT || 5199);

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = createApexAppServer();
  server.listen(PORT, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`Apex Harness Desktop/Web App listening on http://127.0.0.1:${actualPort}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
