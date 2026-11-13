// End-to-End Automated Verification Suite for Apex-Harness (Phases 1-8).
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APEX_DATA_DIR, APEX_PROJECT_ROOT } from "./apex-cli.ts";
import {
  executeAgentToolBlocksAsync,
  revertTurnCheckpoint,
} from "./apex-llm-engine.ts";
import {
  callMcpServerTool,
  listMcpServerTools,
} from "./harness/mcp-client-bridge.ts";
import {
  buildOrchestrationPlan,
  classifyTaskPrompt,
  evaluateCompletedTurn,
} from "./decider/apex-orchestrator-router.ts";
import { safeLinkOrCopySync, safeSymlinkOrCopySync } from "./drivefs-compat.ts";
import {
  ensureCleanCarbonHome,
  loadUnifiedModelFleet,
  sanitizeForStrictModel,
  syncUnifiedModelRegistryToDisk,
} from "./harness/apex-fleet-sync.ts";
import {
  ensureHarness2TreeInitialized,
  validateHarness2TreeViaPython,
} from "./harness/harness2-bridge.ts";
import { runEgmBoardroomConference } from "./harness/egm-boardroom.ts";
import {
  appendSessionGenerationEvent,
  applySpillPolicyToText,
  executePtcProgram,
  inspectCordisRuntime,
  mountDynamicPlugin,
  querySessionCorpus,
  RepeatToolReminderGuard,
  runDynamicPlugin,
  runWithToolTimeout,
  TOOL_TIMEOUT,
} from "./harness/deepseek-subsystems.ts";
import {
  discoverAllUniversalMcpServers,
  discoverAllUniversalSkills,
  selectTopKSkillsForTurn,
  transpileSkillForDriver,
} from "./harness/universal-skill-loader.ts";
import { parseAndScrubModelResponse } from "./harness/universal-tool-parser.ts";

test("DriveFS Compatibility: safeSymlinkOrCopySync and safeLinkOrCopySync succeed safely across filesystems", () => {
  const srcFile = join(APEX_DATA_DIR, "_test_drivefs_src.txt");
  const linkFile = join(APEX_DATA_DIR, "_test_drivefs_link.txt");
  const hardFile = join(APEX_DATA_DIR, "_test_drivefs_hard.txt");
  writeFileSync(srcFile, "drivefs-ok", "utf8");
  try {
    const symResult = safeSymlinkOrCopySync(srcFile, linkFile, "file");
    assert.ok(symResult === "symlink" || symResult === "copied");
    assert.ok(existsSync(linkFile));

    const hardResult = safeLinkOrCopySync(srcFile, hardFile);
    assert.ok(hardResult === "linked" || hardResult === "copied");
    assert.ok(existsSync(hardFile));
  } finally {
    rmSync(srcFile, { force: true });
    rmSync(linkFile, { force: true });
    rmSync(hardFile, { force: true });
  }
});

test("Phase 1: Unified Model Fleet loads models, redacts API keys on disk, and builds Carbon Clean-Room Home", () => {
  const fleet = loadUnifiedModelFleet();
  assert.ok(fleet.length >= 3, `Expected >= 3 core/fleet models, got ${fleet.length}`);
  const synced = syncUnifiedModelRegistryToDisk(APEX_DATA_DIR);
  assert.equal(synced.count, fleet.length);
  assert.ok(existsSync(synced.path));
  const rawDisk = readFileSync(synced.path, "utf8");
  assert.ok(!rawDisk.includes("\"apiKey\""), "Serialized registry on disk must never contain raw apiKey fields");

  const cleanHome = ensureCleanCarbonHome(APEX_DATA_DIR);
  assert.ok(existsSync(join(cleanHome, ".gemini", "GEMINI.md")));

  const sanitized = sanitizeForStrictModel("Audit CVE-2026-21858 with aircrack-ng and red-team exploit");
  assert.ok(!sanitized.sanitizedText.includes("CVE-2026-21858"));
  assert.ok(!sanitized.sanitizedText.includes("aircrack-ng"));
  assert.ok(sanitized.redactionsCount >= 3);
});

test("Phase 2: Universal Skill & MCP Loader discovers cross-IDE skills and transpiles tool aliases", () => {
  const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
  assert.ok(skills.length >= 10, `Expected >= 10 universal skills, got ${skills.length}`);

  const mcpServers = discoverAllUniversalMcpServers();
  assert.ok(Array.isArray(mcpServers), "MCP server list must be an array");

  const dummyClaudeSkill = {
    id: "claude-code:skill:demo",
    name: "demo-skill",
    description: "Run Bash and Edit on $ARGUMENTS",
    ecosystem: "claude-code",
    kind: "skill",
    sourcePath: join(APEX_PROJECT_ROOT, "SKILL.md"),
    sensitiveDualUse: false,
    sha256: "0".repeat(64),
    rawBody: "Use `Bash` and `Edit` to inspect $ARGUMENTS.",
  };

  const forAntigravity = transpileSkillForDriver(dummyClaudeSkill, "antigravity", "src/index.ts");
  assert.ok(forAntigravity.includes("`run_command`"));
  assert.ok(forAntigravity.includes("`edit_file`"));
  assert.ok(forAntigravity.includes("src/index.ts"));

  const forCodex = transpileSkillForDriver(dummyClaudeSkill, "codex", "src/index.ts");
  assert.ok(forCodex.includes("`exec_command`"));
  assert.ok(forCodex.includes("`apply_patch`"));

  const topK = selectTopKSkillsForTurn("Build a React Vite dashboard with Stitch design tokens", skills, {
    topK: 4,
    strictFirewall: true,
    targetDriver: "antigravity",
  });
  assert.ok(topK.length > 0 && topK.length <= 4);
  for (const item of topK) {
    assert.equal(item.skill.sensitiveDualUse, false);
  }
});

test("Phase 3: Task Classifier, Orchestration Planner & Self-Judging Gate", () => {
  const secClass = classifyTaskPrompt("Perform a wireless penetration test and security audit");
  assert.equal(secClass.primaryDomain, "security_audit");
  assert.equal(secClass.requiresUnfiltered, true);

  const secPlan = buildOrchestrationPlan("Perform a wireless penetration test and security audit", {
    dataDir: APEX_DATA_DIR,
    workspaceRoot: APEX_PROJECT_ROOT,
  });
  assert.equal(secPlan.primaryModel.strictFirewall, false);

  const carbonPlan = buildOrchestrationPlan("Complete the website UI and fix CVE-2026-21858", {
    dataDir: APEX_DATA_DIR,
    workspaceRoot: APEX_PROJECT_ROOT,
    preferredModelId: "agy-acp/gemini-4-carbon-high",
  });
  assert.equal(carbonPlan.primaryModel.id, "agy-acp/gemini-4-carbon-high");
  assert.equal(carbonPlan.strictSanitized, true);
  assert.ok(!carbonPlan.effectivePrompt.includes("CVE-2026-21858"));

  const passVerdict = evaluateCompletedTurn({
    dataDir: APEX_DATA_DIR,
    modelId: "codex/gpt-5.6-luna-max",
    domain: "surgical_code",
    responseText: "export const add = (a: number, b: number) => a + b;",
  });
  assert.equal(passVerdict.passed, true);
  assert.equal(passVerdict.recommendedAction, "accept");

  const failVerdict = evaluateCompletedTurn({
    dataDir: APEX_DATA_DIR,
    modelId: "codex/gpt-5.6-luna-max",
    domain: "surgical_code",
    responseText: "export const add = () => { // TODO: implement };",
  });
  assert.equal(failVerdict.passed, false);
  assert.equal(failVerdict.stubDetected, true);
});

test("Phase 4: Harness² c1..c8 Tree & Python ApexMausSubstrate Validation", () => {
  const status = ensureHarness2TreeInitialized(APEX_DATA_DIR);
  assert.equal(status.initialized, true);
  assert.equal(status.surfaces.length, 8);

  const pyValid = validateHarness2TreeViaPython(APEX_PROJECT_ROOT, APEX_DATA_DIR);
  assert.equal(pyValid.ok, true, pyValid.details);
  assert.equal(pyValid.surfacesValidated, 8);
});

test("Phase 5: Elephant-Goldfish Model (EGM v5.1) Boardroom + Standalone Desktop Executable & Neo-Brutalist UI", async () => {
  const report = await runEgmBoardroomConference({
    prompt: "Verify standalone desktop architecture and Neo-Brutalist UI compliance",
    workspacePath: APEX_PROJECT_ROOT,
    fastMode: true,
  });

  assert.ok(report.formattedBriefForElephant.includes("EGM v5.1"));
  assert.ok(report.desk1GroundedManifest.scannedFiles.length >= 1);
  assert.equal(report.desk2GoldfishLenses.length, 4);
  assert.ok(report.desk3Auditor.comprehensionParaphrase.length > 20);
  assert.equal(report.desk3Auditor.verdict, "READY_TO_EXECUTE");
  assert.ok(report.desk3Auditor.findings.length >= 3);
  for (const finding of report.desk3Auditor.findings) {
    assert.ok(["PROPOSE_FIX", "CONTEST", "ESCALATE", "DECLINE"].includes(finding.resolution));
  }

  assert.ok(
    existsSync(join(APEX_PROJECT_ROOT, "Launch-Apex-App.cmd")) || existsSync(join(APEX_PROJECT_ROOT, "ApexHarness.exe")),
    "Desktop launcher (Launch-Apex-App.cmd or ApexHarness.exe) must exist",
  );
  assert.ok(existsSync(join(APEX_PROJECT_ROOT, "electron", "apex-main.mjs")), "electron/apex-main.mjs must exist");
  assert.ok(existsSync(join(APEX_PROJECT_ROOT, "electron", "apex-preload.cjs")), "electron/apex-preload.cjs must exist");
  assert.ok(existsSync(join(APEX_PROJECT_ROOT, "ui", "styles.css")), "ui/styles.css must exist");
});

test("Phase 6: Canonical Skill Deduplication & All 5 Ported DeepSeek-Harness Subsystems (PTC, Spill, Guard, Cordis Extensions, Session-Query)", async () => {
  // 1. Canonical Skill Cluster Deduplication & Fusion
  const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
  const names = new Set(skills.map((s) => s.name.toLowerCase()));
  assert.ok(names.has("no-ai-slop"), "Canonical anti-slop winner no-ai-slop must be present");
  assert.ok(!names.has("dsh-prose-standard"), "Duplicate dsh-prose-standard must be fused into no-ai-slop");
  assert.ok(!names.has("dsh-trim-cot-leakage"), "Duplicate dsh-trim-cot-leakage must be fused into no-ai-slop");
  assert.ok(!names.has("dsh-archive-agent-notes"), "Repo-locked dsh-archive-agent-notes must be excluded");

  const noAiSlop = skills.find((s) => s.name.toLowerCase() === "no-ai-slop");
  assert.equal(noAiSlop?.capabilityCluster, "anti-slop-prose");
  assert.ok(noAiSlop?.rawBody.includes("Zero Chain-of-Thought Leakage"));

  const frontendCraft = skills.find((s) => s.name.toLowerCase() === "frontend-craft");
  assert.equal(frontendCraft?.capabilityCluster, "ui-ux-craft");
  assert.ok(frontendCraft?.rawBody.includes("Concentric Geometry"));

  // 2. Guard Subsystem (RepeatToolReminderGuard + runWithToolTimeout)
  const guard = new RepeatToolReminderGuard({ thresholds: [3, 5] });
  assert.equal(guard.recordToolCall("s1", "read_file", { b: 1, a: 2 }).escalatedTier, "none");
  assert.equal(guard.recordToolCall("s1", "read_file", { a: 2, b: 1 }).escalatedTier, "none");
  const third = guard.recordToolCall("s1", "read_file", { a: 2, b: 1 });
  assert.equal(third.escalatedTier, "gentle");
  assert.ok(third.reminderMessage?.includes("repeating the exact same tool call"));

  const timeoutRes = await runWithToolTimeout(
    () => new Promise((resolvePromise) => setTimeout(() => resolvePromise("late"), 200)),
    30,
  );
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.isTimeout, true);
  assert.equal(timeoutRes.error?.info.code, TOOL_TIMEOUT);

  // 3. Spill Subsystem (Head/Tail UTF-16 binary-search retention)
  const bigText = "HEAD_MARKER\n" + "x".repeat(16000) + "\nTAIL_MARKER";
  const spilled = applySpillPolicyToText({
    dataDir: APEX_DATA_DIR,
    sessionId: "test-session",
    toolName: "grep_output",
    content: bigText,
    maxInlineTokens: 300,
  });
  assert.equal(spilled.spilled, true);
  assert.ok(spilled.text.includes("HEAD_MARKER"));
  assert.ok(spilled.text.includes("TAIL_MARKER"));
  assert.ok(spilled.text.includes("Full formatted result stored at:"));
  assert.ok(spilled.spillRef && existsSync(spilled.spillRef.locator));

  // 4. PTC-Runtime Subsystem (Sandboxed Programmatic Tool Calling)
  const ptcRes = await executePtcProgram({
    code: `
      const files = await host.listFiles("server");
      const matches = await host.grep("runEgmBoardroomConference", "server");
      return { serverFilesCount: files.length, matchesCount: matches.length };
    `,
    workspacePath: APEX_PROJECT_ROOT,
    dataDir: APEX_DATA_DIR,
    sessionId: "test-ptc",
  });
  assert.equal(ptcRes.ok, true, ptcRes.error);
  assert.equal(ptcRes.toolCallsCount, 2);
  assert.ok(ptcRes.returnValue.serverFilesCount >= 3);
  assert.ok(ptcRes.returnValue.matchesCount >= 1);

  // 5. Cordis Dynamic Extensions & Session-Query Subsystem
  mountDynamicPlugin(APEX_DATA_DIR, {
    id: "test-dyn-plugin",
    name: "Test Dynamic Plugin",
    description: "Doubles a numeric input",
    version: "1.0.0",
    code: "return { doubled: Number(input.val || 0) * 2 };",
  });
  const dynRun = await runDynamicPlugin(APEX_DATA_DIR, "test-dyn-plugin", { val: 21 });
  assert.equal(dynRun.ok, true);
  assert.equal(dynRun.output.doubled, 42);
  const runtimeInfo = inspectCordisRuntime(APEX_DATA_DIR);
  assert.equal(runtimeInfo.capabilities.length, 5);

  appendSessionGenerationEvent(APEX_DATA_DIR, {
    sessionId: "test-fts-session",
    type: "assistant/message",
    modelId: "agy-acp/gemini-4-argon-high",
    domain: "architecture",
    content: "DeepSeek Cordis Spatiotemporal Composability verified.",
  });
  const hits = querySessionCorpus(APEX_DATA_DIR, "Spatiotemporal Composability");
  assert.ok(hits.length >= 1);
});

test("Phase 7: Surgical edit_file, Pre-Edit Checkpoint Undo/Revert, Multi-Step Tool Observations & JSON-RPC 2.0 MCP Client Bridge", async () => {
  const scratchRel = "data/_phase7_edit_test.ts";
  const scratchFull = join(APEX_PROJECT_ROOT, scratchRel);
  const steps = [];

  try {
    // 1. Write file + Surgical edit_file + read_file + grep_search in a single multi-tool turn
    const sampleTurnText = [
      "Creating and patching test module:",
      "```apex-action",
      JSON.stringify({
        tool: "write_file",
        path: scratchRel,
        content: "export const VERSION = 1;\nexport const LABEL = 'initial';\n",
      }),
      "```",
    ].join("\n");

    const step1 = await executeAgentToolBlocksAsync(
      sampleTurnText,
      APEX_PROJECT_ROOT,
      (s) => steps.push(s),
      { dataDir: APEX_DATA_DIR, conversationId: "test-conv-phase7" },
    );
    assert.ok(step1.checkpointId, "First write must produce a pre-edit checkpointId");
    assert.equal(existsSync(scratchFull), true);
    assert.ok(readFileSync(scratchFull, "utf8").includes("VERSION = 1"));

    // 2. Surgical edit_file + read_file + grep_search
    const editTurnText = [
      "Applying surgical edit and reading back:",
      "```apex-action",
      JSON.stringify({
        tool: "edit_file",
        path: scratchRel,
        target: "export const VERSION = 1;",
        replacement: "export const VERSION = 2;",
      }),
      "```",
      "```apex-action",
      JSON.stringify({
        tool: "read_file",
        path: scratchRel,
        startLine: 1,
        endLine: 2,
      }),
      "```",
      "```apex-action",
      JSON.stringify({
        tool: "grep_search",
        query: "VERSION = 2",
        relDir: "data",
      }),
      "```",
    ].join("\n");

    const step2 = await executeAgentToolBlocksAsync(
      editTurnText,
      APEX_PROJECT_ROOT,
      (s) => steps.push(s),
      { dataDir: APEX_DATA_DIR, conversationId: "test-conv-phase7" },
    );
    assert.ok(step2.checkpointId, "Surgical edit_file must produce a checkpointId");
    assert.ok(readFileSync(scratchFull, "utf8").includes("VERSION = 2"));
    assert.equal(step2.toolObservations.length, 3, "edit_file, read_file, and grep_search must return observations for the ReAct loop");
    assert.ok(step2.toolObservations[1].includes("VERSION = 2"));

    // 3. Revert step2 checkpoint -> restores VERSION = 1 byte-for-byte
    const revert2 = revertTurnCheckpoint(APEX_DATA_DIR, step2.checkpointId);
    assert.equal(revert2.ok, true);
    assert.ok(readFileSync(scratchFull, "utf8").includes("VERSION = 1"), "Reverting step2 must restore VERSION = 1");

    // 4. Revert step1 checkpoint -> deletes the newly created file
    const revert1 = revertTurnCheckpoint(APEX_DATA_DIR, step1.checkpointId);
    assert.equal(revert1.ok, true);
    assert.equal(existsSync(scratchFull), false, "Reverting step1 must remove the file that did not exist before");

    // 5. Verify Live JSON-RPC 2.0 stdio MCP Client Bridge using a mock inline node stdio MCP responder
    const mockMcpScript = `
      import readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo_ping", description: "Echoes input" }] } }) + "\\n");
        } else if (msg.method === "tools/call") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "PONG:" + (msg.params?.arguments?.msg || "") }] } }) + "\\n");
        }
      });
    `;
    const mockMcpServer = {
      name: "mock-stdio-mcp",
      ecosystem: "antigravity",
      transport: "stdio",
      command: process.execPath,
      args: ["--input-type=module", "-e", mockMcpScript],
      sourceConfigPath: "inline-test",
    };

    const listed = await listMcpServerTools(mockMcpServer, 5000);
    assert.equal(listed.ok, true, listed.error);
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0].name, "echo_ping");

    const called = await callMcpServerTool(mockMcpServer, "echo_ping", { msg: "APEX_HARNESS" }, 5000);
    assert.equal(called.ok, true, called.error);
    assert.equal(called.content, "PONG:APEX_HARNESS");
  } finally {
    if (existsSync(scratchFull)) rmSync(scratchFull, { force: true });
  }
});

test("Phase 8: Universal Multi-Protocol Tool Parser (Poolside/GLM XML, Hermes JSON-in-XML, Claude Invoke, Think Scrubber), TodoWrite/RepoMap & Live Agent Office Floorplan", async () => {
  // 1. Exact regression test from Screenshot 1: Poolside/GLM <tool_call>read_file<arg_key>path</arg_key><arg_value>...</arg_value></tool_call>
  const screenshot1Leak =
    "I'll analyze your trading_swarm project to identify what's needed to make it a profitable trading system. Let me start by examining the codebase structure and current capabilities.<tool_call>read_file<arg_key>path</arg_key><arg_value>package.json</arg_value></tool_call>";
  const parsed = parseAndScrubModelResponse(screenshot1Leak);
  assert.ok(!parsed.cleanText.includes("<tool_call>"), "Clean text must never contain raw <tool_call> XML");
  assert.ok(!parsed.cleanText.includes("<arg_key>"), "Clean text must never contain raw <arg_key> XML");
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].tool, "read_file");
  assert.equal(parsed.toolCalls[0].path, "package.json");

  // 2. Test Hermes JSON-in-XML, Claude <invoke>, and <think> block scrubbing together
  const multiProtocolSample = [
    "<think>Internal reasoning about repository map and task checklist</think>",
    "Here is the plan:",
    '<tool_call>{"name": "TodoWrite", "arguments": {"todos": [{"content": "Inspect orchestrator", "status": "completed"}, {"content": "Wire live feed", "status": "in_progress"}]}}</tool_call>',
    '<function_calls><invoke name="RepoMap"><parameter name="relDir">server</parameter></invoke></function_calls>',
  ].join("\n");
  const parsedMulti = parseAndScrubModelResponse(multiProtocolSample);
  assert.ok(!parsedMulti.cleanText.includes("<think>"));
  assert.ok(!parsedMulti.cleanText.includes("<tool_call>"));
  assert.ok(!parsedMulti.cleanText.includes("<invoke"));
  assert.equal(parsedMulti.extractedThinking.length, 1);
  assert.equal(parsedMulti.toolCalls.length, 2);
  assert.equal(parsedMulti.toolCalls[0].tool, "todo_write");
  assert.equal(parsedMulti.toolCalls[1].tool, "repo_map");

  // 3. Execute Screenshot 1 XML tool call + TodoWrite + RepoMap through executeAgentToolBlocksAsync
  const steps = [];
  const execRes = await executeAgentToolBlocksAsync(
    screenshot1Leak + "\n" + multiProtocolSample,
    APEX_PROJECT_ROOT,
    (s) => steps.push(s),
    { dataDir: APEX_DATA_DIR, conversationId: "test-conv-phase8" },
  );
  assert.ok(!execRes.cleanedResponse.includes("<tool_call>"));
  assert.equal(execRes.toolObservations.length, 3);
  assert.ok(execRes.toolObservations[0].includes("ApexHarness.exe"), "read_file on package.json must return package contents");
  assert.ok(execRes.toolObservations[1].includes("[todo_write]"), "todo_write must format execution checklist");
  assert.ok(execRes.toolObservations[2].includes("[repo_map]"), "repo_map must return symbol map");
  assert.ok(steps.some((s) => s.agentRole === "Scout" && s.plainSummary?.includes("Scout Agent inspected")));
  assert.ok(steps.some((s) => s.agentRole === "Coordinator" && s.kind === "todo"));

  // 4. Verify AI Agent Office Simulation UI files exist locally
  assert.ok(existsSync(join(APEX_PROJECT_ROOT, "ui", "agent-office.js")), "ui/agent-office.js must exist");
  const indexHtml = readFileSync(join(APEX_PROJECT_ROOT, "ui", "index.html"), "utf8");
  assert.ok(indexHtml.includes("agent-office-mount"), "index.html must include AI Agent Office floorplan container");
  assert.ok(indexHtml.includes("New Independent Chat"), "index.html must include New Independent Chat button");
  assert.ok(indexHtml.includes("deleteConversation"), "index.html must include per-thread deleteConversation handler");
});




