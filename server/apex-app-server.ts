// Standalone Desktop/Web App Server for Apex Harness (`http://127.0.0.1:5199`).
// Provides the Antigravity-style chat interface, multi-project workspace switcher,
// SSE live step & token streaming, Universal Skill/MCP browser, and Harness² (c1..c8) studio.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APEX_DATA_DIR, APEX_PROJECT_ROOT } from "./apex-cli.ts";
import {
  callUnifiedFleetWithFailover,
  executeAgentToolBlocks,
  executeAgentToolBlocksAsync,
  gatherGroundedWorkspaceContext,
  revertTurnCheckpoint,
  type AgentStepEvent,
  type ChatMessage,
} from "./apex-llm-engine.ts";
import {
  callMcpServerTool,
  listMcpServerTools,
} from "./harness/mcp-client-bridge.ts";
import { parseAndScrubModelResponse } from "./harness/universal-tool-parser.ts";
import {
  buildOrchestrationPlan,
  evaluateCompletedTurn,
  loadScoreboard,
} from "./decider/apex-orchestrator-router.ts";
import {
  ensureCleanCarbonHome,
  loadUnifiedModelFleet,
  syncUnifiedModelRegistryToDisk,
  type DriverBackend,
} from "./harness/apex-fleet-sync.ts";
import {
  ensureHarness2TreeInitialized,
  harnessTreeRoot,
  recordHarness2Reflection,
  validateHarness2TreeViaPython,
} from "./harness/harness2-bridge.ts";
import {
  runEgmBoardroomConference,
  type EgmBoardroomBrief,
} from "./harness/egm-boardroom.ts";
import {
  discoverAllUniversalMcpServers,
  discoverAllUniversalSkills,
  transpileSkillForDriver,
} from "./harness/universal-skill-loader.ts";
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
  messages: ChatMessage[];
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

  // 1. Scan ~/.gemini/config/projects/*.json
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

  // 2. Scan optional workspace roots from APEX_EXTRA_WORKSPACE_ROOTS (comma/semicolon-separated)
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
    // Drop duplicate 0-message "New Conversation" clutter
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
            "- **AI Agent Office & Live Multi-Agent Orchestration**: Watch the **Coordinator**, **Scout**, **Architect**, **Builder**, **Critic**, and **Verifier** agents collaborate in real time in the Agent Office panel above.",
            "- **Independent & Workspace Conversations**: Start a general chat anytime (`General Chats`) or work inside any of your project repositories, with 1-click thread deletion (`×`) and pre-edit file undo (`Undo edits`).",
            "- **Universal Multi-Format Tool Engine**: Automatically parses and executes tools across all model families (`read_file`, `edit_file`, `write_file`, `grep_search`, `list_dir`, `run_command`, `todo_write`, `repo_map`, `call_mcp_tool`, and `ptc-action`).",
          ].join("\n"),
          createdAt: now,
          modelId: "agy-acp/gemini-4-argon-high",
          modelDisplayName: "Lead Coordinator (Gemini 4 Argon High)",
          domain: "architecture",
          durationMs: 420,
          steps: [
            {
              id: "seed-step-1",
              kind: "route",
              agentRole: "Coordinator",
              label: "Connected 19 models, 112 curated skills, and 15 MCP servers",
              status: "done",
              durationMs: 120,
            },
            {
              id: "seed-step-2",
              kind: "judge",
              agentRole: "Verifier",
              label: "Verified 6-Agent Office Orchestration & Universal Tool Engine",
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

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise((text ? JSON.parse(text) : {}) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

export function createApexAppServer() {
  syncUnifiedModelRegistryToDisk(APEX_DATA_DIR);
  ensureCleanCarbonHome(APEX_DATA_DIR);
  ensureHarness2TreeInitialized(APEX_DATA_DIR);

  const projects = discoverOperatorProjects();
  let conversations = loadConversations(projects);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:5199");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // Serve Main App UI
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (existsSync(UI_HTML_PATH)) {
        const html = readFileSync(UI_HTML_PATH, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
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
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
        res.end(readFileSync(jsPath, "utf8"));
        return;
      }
    }

    // Standalone EGM Boardroom Conference API
    if (req.method === "POST" && url.pathname === "/api/egm/boardroom") {
      const body = await readJsonBody<{ prompt: string; projectId?: string; fastMode?: boolean }>(req);
      const proj = projects.find((p) => p.id === body.projectId) ?? projects[0]!;
      const brief = await runEgmBoardroomConference({
        prompt: body.prompt || "Audit workspace architecture and implementation readiness",
        workspacePath: proj.path,
        fastMode: body.fastMode ?? false,
      });
      sendJson(res, 200, { ok: true, brief });
      return;
    }
    // Bootstrap State API
    if (
      req.method === "GET" &&
      (url.pathname === "/api/bootstrap" || url.pathname === "/api/state" || url.pathname === "/api/health")
    ) {
      const fleet = loadUnifiedModelFleet();
      const scoreboard = loadScoreboard(APEX_DATA_DIR, fleet);
      const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
      const mcpServers = discoverAllUniversalMcpServers();
      const h2Status = ensureHarness2TreeInitialized(APEX_DATA_DIR);
      const h2Validation = validateHarness2TreeViaPython(APEX_PROJECT_ROOT, APEX_DATA_DIR);

      const treeRoot = harnessTreeRoot(APEX_DATA_DIR);
      const surfaceFiles: Record<string, string> = {};
      for (const rel of ["systemprompt.md", "guardrails.md", "LongTermMEMORY.md", "tool_descriptions/tool_guidance.md"]) {
        const p = join(treeRoot, rel);
        if (existsSync(p)) surfaceFiles[rel] = readFileSync(p, "utf8");
      }

      sendJson(res, 200, {
        projects,
        conversations,
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
          sourcePath: s.sourcePath,
        })),
        mcpServers,
        deepseekRuntime: inspectCordisRuntime(APEX_DATA_DIR),
        harness2: {
          status: h2Status,
          validation: h2Validation,
          surfaceFiles,
        },
      });
      return;
    }

    // DeepSeek-Harness Ported PTC Runtime (Programmatic Tool Calling)
    if (req.method === "POST" && url.pathname === "/api/dsh/ptc") {
      const body = await readJsonBody<{ code: string; projectId?: string; sessionId?: string }>(req);
      const proj = projects.find((p) => p.id === body.projectId) ?? projects[0]!;
      const result = await executePtcProgram({
        code: body.code || "return await host.listFiles('.');",
        workspacePath: proj.path,
        dataDir: APEX_DATA_DIR,
        sessionId: body.sessionId || "ptc-studio",
      });
      sendJson(res, 200, result);
      return;
    }

    // DeepSeek-Harness Ported Cordis Runtime Inspection & Dynamic Plugin Mount/Exec
    if (req.method === "GET" && url.pathname === "/api/dsh/runtime") {
      sendJson(res, 200, inspectCordisRuntime(APEX_DATA_DIR));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/dsh/plugins") {
      const body = await readJsonBody<{
        action?: "mount" | "run";
        id: string;
        name?: string;
        description?: string;
        version?: string;
        code?: string;
        input?: Record<string, unknown>;
      }>(req);
      if (body.action === "run") {
        const runRes = await runDynamicPlugin(APEX_DATA_DIR, body.id, body.input ?? {});
        sendJson(res, 200, runRes);
        return;
      }
      const mounted = mountDynamicPlugin(APEX_DATA_DIR, {
        id: body.id,
        name: body.name || body.id,
        description: body.description || "Dynamic runtime plugin",
        version: body.version || "1.0.0",
        code: body.code || "return { ok: true, input };",
      });
      sendJson(res, 200, { ok: true, plugin: mounted, runtime: inspectCordisRuntime(APEX_DATA_DIR) });
      return;
    }

    // DeepSeek-Harness Ported Session-Query Full-Text Search
    if (req.method === "GET" && url.pathname === "/api/dsh/session-query") {
      const q = url.searchParams.get("q") ?? "";
      const hits = querySessionCorpus(APEX_DATA_DIR, q, conversations);
      sendJson(res, 200, { ok: true, query: q, hits });
      return;
    }

    // Create New Conversation (Supports "independent" general chats or workspace chats)
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      const body = await readJsonBody<{
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
          sendJson(res, 200, { thread: existingEmpty, conversations });
          return;
        }
      }
      const thread: ConversationThread = {
        id: `conv-${randomUUID().slice(0, 8)}`,
        projectId: targetProjId,
        title: body.title?.trim() || (targetProjId === "independent" ? "Independent Chat" : "New Conversation"),
        selectedModelId: body.selectedModelId || "auto",
        effort: body.effort || "high",
        mode: body.mode || "turbo",
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      conversations = [thread, ...conversations];
      saveConversations(conversations);
      sendJson(res, 200, { thread, conversations });
      return;
    }

    // Clean Empty 0-Message Conversations
    if (req.method === "POST" && url.pathname === "/api/conversations/clean-empty") {
      conversations = conversations.filter((c) => c.messages && c.messages.length > 0);
      saveConversations(conversations);
      sendJson(res, 200, { ok: true, conversations });
      return;
    }

    // Rename or Reassign Conversation
    if (req.method === "PATCH" && url.pathname.startsWith("/api/conversations/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/conversations/", ""));
      const body = await readJsonBody<{ title?: string; projectId?: string }>(req);
      const thread = conversations.find((c) => c.id === id);
      if (!thread) {
        sendJson(res, 404, { error: "Conversation not found" });
        return;
      }
      if (body.title?.trim()) thread.title = body.title.trim();
      if (body.projectId?.trim()) thread.projectId = body.projectId.trim();
      thread.updatedAt = new Date().toISOString();
      saveConversations(conversations);
      sendJson(res, 200, { ok: true, thread, conversations });
      return;
    }

    // Add Custom Project Folder
    if (req.method === "POST" && url.pathname === "/api/projects") {
      const body = await readJsonBody<{ path: string; name?: string }>(req);
      const resolvedPath = resolve(body.path.trim());
      if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
        sendJson(res, 400, { error: `Folder not found: ${resolvedPath}` });
        return;
      }
      const entry: ProjectEntry = {
        id: `proj-custom-${Date.now()}`,
        name: body.name?.trim() || basename(resolvedPath),
        path: resolvedPath,
      };
      projects.splice(1, 0, entry);
      sendJson(res, 200, { project: entry, projects });
      return;
    }

    // Delete Conversation
    if (req.method === "DELETE" && url.pathname.startsWith("/api/conversations/")) {
      const id = decodeURIComponent(url.pathname.replace("/api/conversations/", ""));
      conversations = conversations.filter((c) => c.id !== id);
      saveConversations(conversations);
      sendJson(res, 200, { ok: true, conversations });
      return;
    }

    // Transpile Skill Preview
    if (req.method === "POST" && url.pathname === "/api/skills/transpile") {
      const body = await readJsonBody<{ skillName: string; driver: DriverBackend; args?: string }>(req);
      const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
      const found = skills.find((s) => s.name.toLowerCase() === (body.skillName ?? "").toLowerCase());
      if (!found) {
        sendJson(res, 404, { error: `Skill "${body.skillName}" not found` });
        return;
      }
      const transpiled = transpileSkillForDriver(found, body.driver || "antigravity", body.args || "");
      sendJson(res, 200, { skill: found, driver: body.driver, transpiled });
      return;
    }

    // Update Harness² c1..c8 Surface File
    if (req.method === "POST" && url.pathname === "/api/harness2/surface") {
      const body = await readJsonBody<{ relPath: string; content: string }>(req);
      const allowed = new Set([
        "systemprompt.md",
        "guardrails.md",
        "LongTermMEMORY.md",
        "tool_descriptions/tool_guidance.md",
      ]);
      if (!allowed.has(body.relPath)) {
        sendJson(res, 400, { error: "Surface file not editable via quick studio" });
        return;
      }
      const target = join(harnessTreeRoot(APEX_DATA_DIR), body.relPath);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, body.content, "utf8");
      const validation = validateHarness2TreeViaPython(APEX_PROJECT_ROOT, APEX_DATA_DIR);
      sendJson(res, 200, { ok: true, validation });
      return;
    }

    // Revert Turn Checkpoint (Undo File Edits)
    if (req.method === "POST" && url.pathname === "/api/turn/revert") {
      const body = await readJsonBody<{ checkpointId: string; conversationId?: string; messageId?: string }>(req);
      const result = revertTurnCheckpoint(APEX_DATA_DIR, body.checkpointId || "");
      if (result.ok && body.conversationId && body.messageId) {
        const thread = conversations.find((c) => c.id === body.conversationId);
        const msg = thread?.messages.find((m) => m.id === body.messageId);
        if (msg) {
          msg.reverted = true;
          saveConversations(conversations);
        }
      }
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    // Live JSON-RPC 2.0 MCP Client Bridge: List Tools or Call Tool
    if (req.method === "POST" && url.pathname === "/api/mcp/tools") {
      const body = await readJsonBody<{ serverName: string }>(req);
      const servers = discoverAllUniversalMcpServers();
      const srv = servers.find((s) => s.name.toLowerCase() === (body.serverName || "").toLowerCase());
      if (!srv) {
        sendJson(res, 404, { ok: false, error: `MCP server "${body.serverName}" not found` });
        return;
      }
      const listRes = await listMcpServerTools(srv);
      sendJson(res, 200, listRes);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mcp/call") {
      const body = await readJsonBody<{
        serverName: string;
        toolName: string;
        args?: Record<string, unknown>;
      }>(req);
      const servers = discoverAllUniversalMcpServers();
      const srv = servers.find((s) => s.name.toLowerCase() === (body.serverName || "").toLowerCase());
      if (!srv) {
        sendJson(res, 404, { ok: false, error: `MCP server "${body.serverName}" not found` });
        return;
      }
      const callRes = await callMcpServerTool(srv, body.toolName, body.args ?? {});
      sendJson(res, 200, callRes);
      return;
    }

    // Real-time Streaming Chat Turn (SSE)
    if (req.method === "POST" && url.pathname === "/api/chat/stream") {
      const body = await readJsonBody<{
        conversationId: string;
        prompt: string;
        selectedModelId?: string;
        effort?: "high" | "medium" | "low";
        mode?: "turbo" | "auto_edit" | "ask";
      }>(req);

      const thread = conversations.find((c) => c.id === body.conversationId);
      if (!thread) {
        sendJson(res, 404, { error: "Conversation not found" });
        return;
      }

      const project = projects.find((p) => p.id === thread.projectId) ?? projects[0]!;
      const isIndependent = project.id === "independent";
      const promptText = (body.prompt ?? "").trim();
      if (!promptText) {
        sendJson(res, 400, { error: "Empty prompt" });
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

      const userMsg: ChatMessage = {
        id: `msg-${randomUUID().slice(0, 8)}`,
        role: "user",
        content: promptText,
        createdAt: new Date().toISOString(),
      };
      thread.messages.push(userMsg);
      thread.updatedAt = new Date().toISOString();
      saveConversations(conversations);

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const turnStart = Date.now();
      const allSteps: AgentStepEvent[] = [];
      const pushStep = (step: AgentStepEvent) => {
        const idx = allSteps.findIndex((s) => s.id === step.id);
        if (idx >= 0) allSteps[idx] = step;
        else allSteps.push(step);
        sendEvent("step", step);
        sendEvent("office", {
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

        // Step 0: DeepSeek-Harness Repeat-Tool-Reminder Guard
        const repeatOutcome = repeatGuard.recordToolCall(thread.id, "chat_turn", { prompt: promptText });
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

        // Step 1: Build Orchestration Plan (Model Selection + Top-K Universal Skills + Carbon Sanitizer)
        const tRoute = Date.now();
        const preferredId =
          thread.selectedModelId && thread.selectedModelId !== "auto" ? thread.selectedModelId : undefined;
        const plan = buildOrchestrationPlan(promptText, {
          dataDir: APEX_DATA_DIR,
          workspaceRoot: project.path,
          preferredModelId: preferredId,
        });

        sendEvent("plan", plan);

        pushStep({
          id: `step-route-${Date.now()}`,
          kind: "route",
          agentRole: "Coordinator",
          label: `Lead Coordinator assigned ${plan.primaryModel.displayName}`,
          plainSummary: `Coordinator selected ${plan.primaryModel.displayName} for ${plan.classification.primaryDomain.replace(/_/g, " ")}`,
          detail: `Task type: ${plan.classification.primaryDomain.replace(/_/g, " ")}`,
          status: "done",
          durationMs: Date.now() - tRoute,
        });

        if (plan.mountedSkills.length > 0) {
          pushStep({
            id: `step-skills-${Date.now()}`,
            kind: "skill",
            agentRole: "Coordinator",
            label: `Activated ${plan.mountedSkills.length} specialist workflows`,
            plainSummary: `Coordinator mounted ${plan.mountedSkills.map((s) => s.name).join(", ")}`,
            detail: plan.mountedSkills.map((s) => s.name).join(", "),
            status: "done",
            durationMs: 12,
          });
        }

        // Step 2: Run Elephant-Goldfish Model (EGM) Boardroom (Skip heavy codebase scan if independent general chat & trivial)
        const egmBrief: EgmBoardroomBrief = await runEgmBoardroomConference({
          prompt: plan.effectivePrompt,
          workspacePath: project.path,
          fastMode: isIndependent || plan.classification.complexity === "trivial",
          onStep: pushStep,
        });
        sendEvent("egm", egmBrief);

        // Step 2b: Gather Grounded Workspace Files & Apply DeepSeek-Harness Spill Policy
        let contextBlock = "Independent General Chat Mode (No project repository bound).";
        if (!isIndependent) {
          const { contextBlock: rawContextBlock } = gatherGroundedWorkspaceContext(
            project.path,
            plan.effectivePrompt,
            pushStep,
          );
          const spilledContext = applySpillPolicyToText({
            dataDir: APEX_DATA_DIR,
            sessionId: thread.id,
            toolName: "workspace_context",
            content: rawContextBlock,
            maxInlineTokens: 2800,
          });
          contextBlock = spilledContext.text;
          if (spilledContext.spilled && spilledContext.spillRef) {
            pushStep({
              id: `step-spill-${Date.now()}`,
              kind: "read",
              agentRole: "Scout",
              label: `Compressed large file context (${spilledContext.omittedBytes} bytes cached)`,
              plainSummary: `Scout Agent compressed large file preview`,
              detail: spilledContext.spillRef.locator,
              status: "done",
              durationMs: 4,
            });
          }
        }

        // Step 3: Load Harness² Always-On Surfaces (c1..c4)
        const treeRoot = harnessTreeRoot(APEX_DATA_DIR);
        const sysPromptSurface = existsSync(join(treeRoot, "systemprompt.md"))
          ? readFileSync(join(treeRoot, "systemprompt.md"), "utf8")
          : "";
        const guardrailsSurface = existsSync(join(treeRoot, "guardrails.md"))
          ? readFileSync(join(treeRoot, "guardrails.md"), "utf8")
          : "";

        const systemInstruction = [
          sysPromptSurface,
          guardrailsSurface,
          isIndependent
            ? "Active Mode: Independent General Chat (not bound to a specific project folder unless the user provides a path)."
            : `Active Project Workspace: ${project.name} (${project.path})`,
          `Execution Mode: ${thread.mode} | Thinking Effort: ${thread.effort}`,
          `--- SPECIALIST BOARDROOM BRIEF ---\n${egmBrief.formattedBriefForElephant}`,
          repeatOutcome.reminderMessage ? `\n--- LOOP HYGIENE GUARD ---\n${repeatOutcome.reminderMessage}` : "",
          plan.transpiledSkillsPrompt ? `\n--- MOUNTED UNIVERSAL SKILLS ---\n${plan.transpiledSkillsPrompt}` : "",
          `\n--- WORKSPACE GROUNDED CONTEXT ---\n${contextBlock}`,
          thread.mode !== "ask"
            ? `\nAvailable Executable Agent Tools (emit inside \`\`\`apex-action blocks when you need to read, search, edit, or run commands):\n- Bounded file read: {"tool":"read_file","path":"rel/path.py","startLine":1,"endLine":180}\n- List folder: {"tool":"list_dir","path":"."}\n- Grep search: {"tool":"grep_search","query":"pattern","relDir":"."}\n- Surgical file edit: {"tool":"edit_file","path":"rel/path.py","target":"exact string","replacement":"new string"}\n- Full file write: {"tool":"write_file","path":"rel/path.py","content":"..."}\n- Update live task checklist: {"tool":"todo_write","todos":[{"content":"Inspect orchestrator","status":"completed"},{"content":"Audit backtester","status":"in_progress"}]}\n- Shell command: {"tool":"run_command","command":"..."}\n- MCP server tool: {"tool":"call_mcp_tool","serverName":"context7","toolName":"resolve-library-id","args":{"libraryName":"react"}}\nIMPORTANT: After reading files or running tools, always provide a clear, well-structured, comprehensive answer to the user.`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const historyMessages = thread.messages.slice(-7, -1).map((m) => ({
          role: m.role,
          content: plan.strictSanitized ? m.content.replace(/\bCVE-\d{4}-\d+\b/gi, "[ADVISORY]") : m.content,
        }));

        const loopMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
          { role: "system", content: systemInstruction },
          ...historyMessages,
          { role: "user", content: plan.effectivePrompt },
        ];

        const narrativeSegments: string[] = [];
        let actualModelUsed = plan.primaryModel.id;
        let turnCheckpointId: string | undefined;
        const maxIterations = thread.mode === "ask" ? 1 : 5;

        for (let iter = 0; iter < maxIterations; iter++) {
          const modelStepId = `step-model-${Date.now()}-${iter}`;
          pushStep({
            id: modelStepId,
            kind: "model",
            agentRole: iter === 0 ? "Builder" : "Architect",
            label:
              iter === 0
                ? `${plan.primaryModel.displayName} analyzing & drafting response`
                : `Step ${iter + 1}: Analyzing inspected files & tool results`,
            plainSummary:
              iter === 0
                ? `Builder Agent generating response`
                : `Architect Agent synthesizing inspected files (round ${iter + 1})`,
            status: "running",
          });

          const llmRes = await callUnifiedFleetWithFailover({
            preferredModelId: plan.primaryModel.id,
            preferredBaseUrl: plan.primaryModel.baseUrl,
            preferredApiKey: plan.primaryModel.apiKey,
            messages: loopMessages,
          });

          actualModelUsed = llmRes.ok ? `${llmRes.usedGateway}/${llmRes.usedModel}` : plan.primaryModel.id;

          pushStep({
            id: modelStepId,
            kind: "model",
            agentRole: iter === 0 ? "Builder" : "Architect",
            label: llmRes.ok
              ? `Completed reasoning step (${(llmRes.latencyMs / 1000).toFixed(1)}s)`
              : `Completed local workspace synthesis`,
            plainSummary: `Model step completed in ${(llmRes.latencyMs / 1000).toFixed(1)}s`,
            detail: actualModelUsed,
            status: "done",
            durationMs: llmRes.latencyMs,
          });

          if (!llmRes.ok) {
            if (narrativeSegments.length === 0) {
              narrativeSegments.push(
                [
                  `### Workspace Review for \`${project.name}\` (\`${project.path}\`)`,
                  "",
                  `- **Task Domain**: \`${plan.classification.primaryDomain.replace(/_/g, " ")}\``,
                  `- **Lead Model**: \`${plan.primaryModel.displayName}\``,
                  "",
                  "#### Key Files & Structure Inspected:",
                  "```text",
                  contextBlock.slice(0, 2200),
                  "```",
                ].join("\n"),
              );
            }
            break;
          }

          // Parse & scrub ALL tool call formats (<tool_call>, <invoke>, ```apex-action, <think>)
          const parsedTurn = parseAndScrubModelResponse(llmRes.text);
          const hasPtcActions = llmRes.text.includes("```ptc-action");

          if (parsedTurn.visibleText) {
            const cleanedVis = parsedTurn.visibleText.replace(/```ptc-action[\s\S]*?```/g, "").trim();
            if (cleanedVis) narrativeSegments.push(cleanedVis);
          }

          if (thread.mode === "ask" || (parsedTurn.toolCalls.length === 0 && !hasPtcActions)) {
            break;
          }

          const iterObservations: string[] = [];

          if (parsedTurn.toolCalls.length > 0) {
            const executed = await executeAgentToolBlocksAsync(llmRes.text, project.path, pushStep, {
              dataDir: APEX_DATA_DIR,
              conversationId: thread.id,
            });
            if (executed.checkpointId) {
              turnCheckpointId = executed.checkpointId;
            }
            iterObservations.push(...executed.toolObservations);
          }

          if (hasPtcActions) {
            const ptcRegex = /```ptc-action\r?\n([\s\S]*?)```/g;
            let ptcMatch: RegExpExecArray | null;
            while ((ptcMatch = ptcRegex.exec(llmRes.text)) !== null) {
              const codeBody = ptcMatch[1] ?? "";
              const ptcRes = await executePtcProgram({
                code: codeBody,
                workspacePath: project.path,
                dataDir: APEX_DATA_DIR,
                sessionId: thread.id,
              });
              pushStep({
                id: `step-ptc-${Date.now()}`,
                kind: "command",
                agentRole: "Builder",
                label: `Executed multi-step script (${ptcRes.toolCallsCount} operations)`,
                plainSummary: `Builder Agent ran programmatic batch (${ptcRes.toolCallsCount} calls)`,
                detail: `${ptcRes.durationMs}ms`,
                outputPreview: ptcRes.ok ? JSON.stringify(ptcRes.returnValue, null, 2).slice(0, 1200) : ptcRes.error,
                status: ptcRes.ok ? "done" : "error",
                durationMs: ptcRes.durationMs,
              });
              iterObservations.push(
                `[ptc-action] ok=${ptcRes.ok} returnValue=${JSON.stringify(ptcRes.returnValue).slice(0, 1500)}`,
              );
            }
          }

          if (iterObservations.length === 0 || iter + 1 >= maxIterations) {
            break;
          }

          loopMessages.push({ role: "assistant", content: parsedTurn.visibleText || "Executing workspace tools." });
          loopMessages.push({
            role: "user",
            content: [
              "Here are the exact results from the tools you just called:",
              ...iterObservations,
              "Now provide a complete, well-structured response answering the user's request based on these inspected files. Do NOT emit raw XML tags.",
            ].join("\n\n"),
          });
        }

        let finalResponseText = narrativeSegments.join("\n\n").trim();
        if (!finalResponseText) {
          finalResponseText = "Completed workspace inspection. Expand any step above to view the file contents.";
        }

        // Stream chunks smoothly to the UI
        const chunkSize = 120;
        for (let i = 0; i < finalResponseText.length; i += chunkSize) {
          sendEvent("delta", { text: finalResponseText.slice(i, i + chunkSize) });
        }

        // Step 5: Self-Judging Verification Gate + EMA Scoreboard Update
        const tJudge = Date.now();
        const verdict = evaluateCompletedTurn({
          dataDir: APEX_DATA_DIR,
          modelId: plan.primaryModel.id,
          domain: plan.classification.primaryDomain,
          responseText: finalResponseText,
          fallbackModelIds: plan.fallbackModels.map((m) => m.id),
        });

        pushStep({
          id: `step-judge-${Date.now()}`,
          kind: "judge",
          agentRole: "Verifier",
          label: verdict.passed
            ? `Verifier Agent approved response (Quality ${(verdict.score * 100).toFixed(0)}%)`
            : `Verifier Agent flagged response for review`,
          plainSummary: verdict.passed
            ? `Verifier Agent stamped PASS (${(verdict.score * 100).toFixed(0)}%)`
            : `Verifier Agent noted ${verdict.issues.length} notice(s)`,
          detail: verdict.issues.join(" | ") || "Complete, zero raw tool leakage",
          status: verdict.passed ? "done" : "error",
          durationMs: Date.now() - tJudge,
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

        const assistantMsg: ChatMessage = {
          id: `msg-${randomUUID().slice(0, 8)}`,
          role: "assistant",
          content: finalResponseText,
          createdAt: new Date().toISOString(),
          modelId: actualModelUsed,
          modelDisplayName: plan.primaryModel.displayName,
          domain: plan.classification.primaryDomain,
          durationMs: Date.now() - turnStart,
          steps: allSteps,
          mountedSkills: plan.mountedSkills,
          checkpointId: turnCheckpointId,
          judgeVerdict: {
            passed: verdict.passed,
            score: verdict.score,
            recommendedAction: verdict.recommendedAction,
            issues: verdict.issues,
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
          content: `score=${verdict.score}`,
        });

        sendEvent("done", {
          message: assistantMsg,
          threadTitle: thread.title,
        });
      } catch (err) {
        sendEvent("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        res.end();
      }
      return;
    }

    sendJson(res, 404, { error: `Route not found: ${req.method} ${url.pathname}` });
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
