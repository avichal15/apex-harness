// ============================================================================
// APEX HARNESS — 8-REPOSITORY REFERENCE ARCHITECTURE INTEGRATION TEST SUITE
// Verifies V-01 through V-08 across:
// - OpenHands (WorkspaceRuntime + Trajectory Condenser)
// - OpenMausBot (Unified Execution Spine + Driver Registry)
// - DeepSeek-Harness (PTC editFile/tools, Spill pagination, Guard mutation reset & 2-step cycle, Signed Plugin uninstall & audit log)
// - OpenClaude / OpenCodex / OpenCode (Multi-Provider Protocol Adapters, SSE tool delta reconstruction, CLI session lifecycle, idempotent failover)
// - Hermes-Agent (Bounded Memory with secret scrubbing, Learned Skill pipeline with snapshot rollback, Isolated Subagent Swarm)
// - Google Elephant-Goldfish Model (Fresh-session Goldfish HTTP reviewer with zero Elephant history, CONTEST file citation validator, per-requirement completion matrix)
// - Security & Desktop Hardening (CSPRNG/DPAPI master key store, chained shell command policy parser)
// ============================================================================

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApexAppServer } from "./apex-app-server.ts";
import { saveTurnCheckpoint } from "./apex-llm-engine.ts";
import {
  buildExecutionDag,
  determineDagTopologyMode,
  resolveProviderSecret,
  storeEncryptedProviderSecret,
} from "./harness/agent-dag-orchestrator.ts";
import {
  buildCompletionEvidenceReport,
  detectProjectVerificationCommands,
} from "./harness/completion-evidence.ts";
import {
  RepeatToolReminderGuard,
  applySpillPolicyToText,
  cleanupExpiredSpills,
  executePtcProgram,
  mountDynamicPlugin,
  readPluginAuditLog,
  readSpillRange,
  uninstallDynamicPlugin,
} from "./harness/deepseek-subsystems.ts";
import {
  ApexDriverRegistry,
  NativeCliHarnessDriver,
  evaluateIdempotentFailoverPolicy,
} from "./harness/driver-registry.ts";
import {
  runPostImplementationEgmReview,
  selectIndependentGoldfishModel,
  validateEgmResolutionLedger,
} from "./harness/egm-boardroom.ts";
import {
  buildGroundedMemoryPromptSnippet,
  delegateParallelSubagentSwarm,
  delegateSubagentTask,
  promoteLearnedSkillProposal,
  proposeLearnedSkill,
  queryMemoryEntries,
  rollbackLearnedSkillSnapshot,
  saveMemoryEntry,
  validateLearnedSkillProposal,
} from "./harness/hermes-memory-learning.ts";
import {
  classifyCommandPolicy,
  splitShellCommandChain,
} from "./harness/process-manager.ts";
import {
  AnthropicMessagesProtocolAdapter,
  GeminiProtocolAdapter,
  NativeCliJsonlProtocolAdapter,
  OpenAiChatProtocolAdapter,
  OpenAiResponsesProtocolAdapter,
  deduplicateProtocolToolCalls,
  renderProtocolToolCallsAsApexActionBlocks,
  validateToolCallSchema,
} from "./harness/protocol-adapters.ts";
import {
  getMasterKeyFilePath,
  getOrCreateMasterVaultKey,
} from "./harness/secret-store.ts";
import { discoverAllUniversalSkills } from "./harness/universal-skill-loader.ts";
import { getLocalSessionToken } from "./harness/workspace-security.ts";
import {
  WorkspaceRuntime,
  condenseConversationTrajectory,
} from "./harness/workspace-runtime.ts";

function makeTempDir(prefix = "apex-ref-int-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("Apex Harness — 8-Repository Reference Integration Verification Suite (V-01..V-08)", async (t) => {
  // ==========================================================================
  // V-01: Production Execution Spine & Adaptive DAG Topologies
  // ==========================================================================
  await t.test("V-01: Adaptive DAG topologies (fast_path, standard, full_engineering) and unified /api/chat/stream -> executeTaskDag spine", async () => {
    assert.equal(determineDagTopologyMode("hi", { adaptiveTopology: true }), "fast_path");
    assert.equal(
      determineDagTopologyMode("Explain what this function does", { adaptiveTopology: true }),
      "standard",
    );
    assert.equal(
      determineDagTopologyMode("Implement rate limiting in server/api.ts and run tests", {
        adaptiveTopology: true,
      }),
      "full_engineering",
    );

    const tempRoot = makeTempDir("apex-v01-");
    const fastNodes = buildExecutionDag({
      dataDir: tempRoot,
      prompt: "hi",
      mountedSkills: [],
      adaptiveTopology: true,
    });
    assert.equal(fastNodes.length, 6);
    assert.equal(fastNodes.find((n) => n.role === "Coordinator")?.state, "queued");
    assert.equal(fastNodes.find((n) => n.role === "Builder")?.state, "queued");
    assert.equal(fastNodes.find((n) => n.role === "Scout")?.state, "skipped");
    assert.equal(fastNodes.find((n) => n.role === "Architect")?.state, "skipped");
    assert.equal(fastNodes.find((n) => n.role === "Critic")?.state, "skipped");
    assert.equal(fastNodes.find((n) => n.role === "Verifier")?.state, "queued");

    const mockProvider = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Hello! Sample workspace inspected cleanly.",
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
    });
    await new Promise((r) => mockProvider.listen(0, "127.0.0.1", r));
    const mockPort = mockProvider.address().port;
    const prevOmniUrl = process.env.OMNIROUTE_BASE_URL;
    process.env.OMNIROUTE_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;

    const server = createApexAppServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const appPort = server.address().port;
    const baseUrl = `http://127.0.0.1:${appPort}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Apex-Token": getLocalSessionToken(),
      Origin: baseUrl,
    };

    try {
      const convRes = await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "V01 Fast Path Chat",
          projectId: "independent",
          forceNew: true,
        }),
      });
      const convData = await convRes.json();
      assert.ok(convData.thread?.id);

      const streamRes = await fetch(`${baseUrl}/api/chat/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          conversationId: convData.thread.id,
          prompt: "hello there",
          mode: "turbo",
        }),
      });
      assert.equal(streamRes.status, 200);
      const sseText = await streamRes.text();
      assert.ok(sseText.includes("event: execution"), "SSE stream must emit live execution DAG events from executeTaskDag");
      assert.ok(sseText.includes("event: done"), "SSE stream must emit final done event with executionId and completionEvidence");
      assert.ok(sseText.includes('"state":"skipped"'), "Simple greeting on independent chat should skip Scout/Architect/Critic via fast_path topology");
    } finally {
      if (prevOmniUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
      else process.env.OMNIROUTE_BASE_URL = prevOmniUrl;
      server.close();
      mockProvider.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // V-02: Unified Driver Registry, CLI Harness Session Lifecycle & Idempotent Failover
  // ==========================================================================
  await t.test("V-02: ApexDriverRegistry, CLI harness session lifecycle, and idempotent failover protection after workspace mutation", async () => {
    const tempDir = makeTempDir("apex-v02-");
    try {
      const registry = new ApexDriverRegistry(tempDir);
      const drivers = registry.listDrivers();
      assert.ok(drivers.some((d) => d.id === "cli:codex-cli"));
      assert.ok(drivers.some((d) => d.id === "cli:claude-cli"));
      assert.ok(drivers.some((d) => d.id === "cli:antigravity-acp"));

      // Verify honest capability reporting on one-shot agy -p driver
      const agyDriver = registry.getDriver("cli:antigravity-acp");
      assert.equal(agyDriver?.capabilities.supportsSessionResume, false);
      assert.equal(agyDriver?.capabilities.supportsNativeApproval, false);

      // Build a deterministic fake CLI executable fixture for CI (no paid CLI account required)
      const fakeCliScript = join(tempDir, "fake-cli-fixture.mjs");
      writeFileSync(
        fakeCliScript,
        [
          'import { writeFileSync } from "node:fs";',
          "const args = process.argv.slice(2);",
          'const resumeIdx = args.indexOf("--resume");',
          "const resumedSessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;",
          'const prompt = args[args.length - 1] || "";',
          'if (prompt.includes("SLOW_STREAM_CANCEL_TEST")) {',
          '  console.log(JSON.stringify({ type: "reasoning", text: "Starting long CLI task..." }));',
          "  setTimeout(() => {",
          '    writeFileSync("cli-should-not-exist.txt", "leaked");',
          "    process.exit(0);",
          "  }, 5000);",
          "} else {",
          '  console.log(JSON.stringify({ type: "reasoning", text: "Analyzing workspace..." }));',
          "  await new Promise((r) => setTimeout(r, 25));",
          '  console.log(JSON.stringify({ type: "message", content: resumedSessionId ? `Resumed:${resumedSessionId}:${prompt}` : `Fresh:${prompt}` }));',
          '  console.log(JSON.stringify({ type: "tool_use", id: "call_cli_fixture_1", name: "read_file", input: { path: "app.ts" } }));',
          "}",
        ].join("\n"),
        "utf8",
      );

      const cliDriver = new NativeCliHarnessDriver({
        id: "cli:codex-cli",
        displayName: "Codex App-Server Driver (Fixture)",
        binaryName: "node",
        binaryPath: process.execPath,
        argsPrefix: [fakeCliScript],
        resumeFlag: "--resume",
        supportsSessionResume: true,
        defaultModels: ["codex/gpt-5.4"],
        dataDir: tempDir,
      });

      const session = await cliDriver.createSession({
        workspaceRoot: tempDir,
        modelId: "codex/gpt-5.4",
      });
      assert.ok(session.sessionId);
      assert.equal(session.status, "active");

      // Stream events incrementally from the fake CLI process
      const streamedEvents = [];
      const turn1Res = await cliDriver.streamEvents(
        session.sessionId,
        { prompt: "Inspect app.ts" },
        (ev) => streamedEvents.push({ ...ev, ts: Date.now() }),
      );
      assert.equal(turn1Res.ok, true);
      assert.ok(turn1Res.text.includes("Fresh:Inspect app.ts"));
      assert.ok(streamedEvents.some((e) => e.type === "reasoning"));
      assert.ok(streamedEvents.some((e) => e.type === "delta"));
      assert.ok(streamedEvents.some((e) => e.type === "tool_call" && e.toolCall?.id === "call_cli_fixture_1"));
      assert.ok(streamedEvents.some((e) => e.type === "complete"));

      // Resume session and verify --resume <sessionId> is passed to the spawned CLI process
      const resumed = await cliDriver.resumeSession(session.sessionId);
      assert.equal(resumed?.sessionId, session.sessionId);
      assert.equal(resumed?.status, "active");
      const turn2Res = await cliDriver.sendMessage(session.sessionId, {
        prompt: "Follow-up turn",
      });
      assert.equal(turn2Res.ok, true);
      assert.ok(
        turn2Res.text.includes(`Resumed:${session.sessionId}:Follow-up turn`),
        `Expected CLI process to receive --resume ${session.sessionId}, got: ${turn2Res.text}`,
      );

      // Verify cancellation of an in-flight CLI child process kills the process tree
      const abortCtrl = new AbortController();
      setTimeout(() => abortCtrl.abort(), 120);
      const cancelRes = await cliDriver.streamEvents(
        session.sessionId,
        { prompt: "SLOW_STREAM_CANCEL_TEST", signal: abortCtrl.signal },
        () => {},
      );
      assert.equal(cancelRes.ok, false);
      assert.equal(existsSync(join(tempDir, "cli-should-not-exist.txt")), false);

      await cliDriver.cancel(session.sessionId);
      const persistedAfterCancel = JSON.parse(
        readFileSync(join(tempDir, "apex-driver-sessions.json"), "utf8"),
      );
      assert.equal(persistedAfterCancel[session.sessionId]?.status, "cancelled");
      await cliDriver.closeSession(session.sessionId);
      const persistedAfterClose = JSON.parse(
        readFileSync(join(tempDir, "apex-driver-sessions.json"), "utf8"),
      );
      assert.equal(persistedAfterClose[session.sessionId]?.status, "closed");

      // Idempotent failover checks:
      // 1. Read-only steps allow automatic retry
      const readOnlyDecision = evaluateIdempotentFailoverPolicy({
        dataDir: tempDir,
        hasWorkspaceMutatedInTurn: false,
      });
      assert.equal(readOnlyDecision.allowRetry, true);

      // 2. Mutating tool executed WITHOUT checkpoint blocks blind retry
      const unsafeMutatingDecision = evaluateIdempotentFailoverPolicy({
        dataDir: tempDir,
        hasWorkspaceMutatedInTurn: true,
      });
      assert.equal(unsafeMutatingDecision.allowRetry, false);
      assert.equal(unsafeMutatingDecision.rolledBackCheckpoint, false);

      // 3. Mutating tool executed WITH pre-edit checkpoint rolls back and allows clean retry
      const targetFile = join(tempDir, "app.ts");
      writeFileSync(targetFile, "export const v = 1;\n", "utf8");
      const checkpointId = "ckpt-v02-test";
      saveTurnCheckpoint(tempDir, {
        checkpointId,
        workspaceRoot: tempDir,
        createdAt: new Date().toISOString(),
        reverted: false,
        files: [{ fullPath: targetFile, existedBefore: true, previousContent: "export const v = 1;\n" }],
      });
      writeFileSync(targetFile, "export const v = 999; // dirty partial edit\n", "utf8");

      const rollbackDecision = evaluateIdempotentFailoverPolicy({
        dataDir: tempDir,
        hasWorkspaceMutatedInTurn: true,
        checkpointId,
        autoRollbackOnFailover: true,
      });
      assert.equal(rollbackDecision.allowRetry, true);
      assert.equal(rollbackDecision.rolledBackCheckpoint, true);
      assert.equal(readFileSync(targetFile, "utf8"), "export const v = 1;\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // V-03: Protocol-Faithful Request/Response & Streaming Adapters
  // ==========================================================================
  await t.test("V-03: OpenAI Chat/Responses, Anthropic SSE input_json_delta, Gemini functionCall, incomplete stream blocking & schema validation", async () => {
    const parsedOpenAi = OpenAiChatProtocolAdapter.parseResponse({
      choices: [
        {
          message: {
            content: "Reading configuration file.",
            tool_calls: [
              {
                id: "call_1",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "package.json" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    assert.equal(parsedOpenAi.toolCalls.length, 1);
    assert.equal(parsedOpenAi.toolCalls[0].name, "read_file");
    assert.equal(parsedOpenAi.toolCalls[0].arguments.path, "package.json");
    assert.equal(parsedOpenAi.hasIncompleteToolCall, false);

    // OpenAI Responses API adapter
    const parsedResp = OpenAiResponsesProtocolAdapter.parseResponse({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Searching symbol." }],
        },
        {
          type: "function_call",
          call_id: "fc_1",
          name: "grep_search",
          arguments: JSON.stringify({ query: "executeTaskDag" }),
        },
      ],
    });
    assert.equal(parsedResp.visibleText, "Searching symbol.");
    assert.equal(parsedResp.toolCalls.length, 1);
    assert.equal(parsedResp.toolCalls[0].name, "grep_search");

    // Anthropic Messages SSE stream with partial input_json_delta chunks
    const sseComplete = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Applying surgical edit."}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"edit_file"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"src/index.ts\\","}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"target\\":\\"a\\",\\"replacement\\":\\"b\\"}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    ];
    const parsedAnthropic = AnthropicMessagesProtocolAdapter.parseSseStream(sseComplete);
    assert.equal(parsedAnthropic.hasIncompleteToolCall, false);
    assert.equal(parsedAnthropic.toolCalls.length, 1);
    assert.equal(parsedAnthropic.toolCalls[0].name, "edit_file");
    assert.equal(parsedAnthropic.toolCalls[0].arguments.path, "src/index.ts");

    // Truncated/incomplete Anthropic SSE stream must flag hasIncompleteToolCall = true
    const sseTruncated = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_trunc","name":"write_file"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"broken.ts\\""}}',
    ];
    const parsedTruncated = AnthropicMessagesProtocolAdapter.parseSseStream(sseTruncated);
    assert.equal(parsedTruncated.hasIncompleteToolCall, true);

    // Gemini functionCall adapter
    const parsedGemini = GeminiProtocolAdapter.parseResponse({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { text: "Running git status." },
              {
                functionCall: {
                  name: "run_command",
                  args: { command: "git status" },
                },
              },
            ],
          },
        },
      ],
    });
    assert.equal(parsedGemini.toolCalls.length, 1);
    assert.equal(parsedGemini.toolCalls[0].name, "run_command");

    // Native CLI JSONL adapter
    const parsedCli = NativeCliJsonlProtocolAdapter.parseJsonlLines([
      JSON.stringify({ type: "message", text: "Inspecting dir" }),
      JSON.stringify({ type: "tool_use", id: "cli_1", name: "list_dir", input: { path: "." } }),
    ]);
    assert.equal(parsedCli.toolCalls.length, 1);
    assert.equal(parsedCli.toolCalls[0].name, "list_dir");

    // Schema validation & deduplication
    const validCheck = validateToolCallSchema(parsedAnthropic.toolCalls[0]);
    assert.equal(validCheck.valid, true);
    const invalidCheck = validateToolCallSchema({
      name: "edit_file",
      arguments: { path: "only-path.ts" },
    });
    assert.equal(invalidCheck.valid, false);
    assert.ok(invalidCheck.errors.some((e) => e.includes("target")));

    const deduped = deduplicateProtocolToolCalls([
      parsedOpenAi.toolCalls[0],
      { ...parsedOpenAi.toolCalls[0] },
    ]);
    assert.equal(deduped.length, 1);
    const rendered = renderProtocolToolCallsAsApexActionBlocks(deduped);
    assert.ok(rendered.actionBlocksText.includes("```apex-action"));
  });

  // ==========================================================================
  // V-04: OpenHands & DeepSeek-Harness Coding Runtime
  // ==========================================================================
  await t.test("V-04: WorkspaceRuntime, trajectory condenser, RepeatToolReminderGuard mutation reset & 2-step cycle, Spill pagination, PTC editFile, and Plugin uninstall/audit log", async () => {
    const tempDir = makeTempDir("apex-v04-");
    try {
      const runtime = new WorkspaceRuntime({
        workspaceRoot: tempDir,
        dataDir: join(tempDir, ".data"),
      });
      const writeRes = runtime.writeFile("src/calc.ts", "export const add = (a: number, b: number) => a + b;\n");
      assert.equal(writeRes.ok, true);
      assert.ok(writeRes.checkpointId);

      const editRes = runtime.surgicalEdit(
        "src/calc.ts",
        "a + b",
        "a + b + 0",
      );
      assert.equal(editRes.ok, true);
      assert.ok(runtime.readFile("src/calc.ts").content.includes("a + b + 0"));

      // Revert checkpoint
      const revertRes = runtime.revertCheckpoint(editRes.checkpointId);
      assert.equal(revertRes.ok, true);
      assert.ok(!runtime.readFile("src/calc.ts").content.includes("a + b + 0"));

      // Trajectory condenser
      const longMessages = Array.from({ length: 16 }, (_, idx) => ({
        role: idx % 2 === 0 ? "user" : "assistant",
        content: `Step ${idx}: Read file src/module_${idx}.ts and modified function handler_${idx} with detailed payload ${"x".repeat(400)}`,
      }));
      const condensed = condenseConversationTrajectory({
        messages: longMessages,
        maxContextTokens: 800,
        keepHeadCount: 2,
        keepTailCount: 4,
      });
      assert.equal(condensed.condensed, true);
      assert.ok(condensed.summarizedMessageCount > 0);
      assert.ok(
        condensed.messages.some((m) =>
          m.content.includes("[CONDENSED_TRAJECTORY_SUMMARY]"),
        ),
      );

      // RepeatToolReminderGuard: 3x identical read triggers reminder, invalidatePathOnMutation resets it!
      const guard = new RepeatToolReminderGuard({ thresholds: [3, 5, 8] });
      assert.equal(guard.recordToolCall("sess-1", "read_file", { path: "src/calc.ts" }).escalatedTier, "none");
      assert.equal(guard.recordToolCall("sess-1", "read_file", { path: "src/calc.ts" }).escalatedTier, "none");
      guard.invalidatePathOnMutation("sess-1", "src/calc.ts");
      assert.equal(guard.recordToolCall("sess-1", "read_file", { path: "src/calc.ts" }).escalatedTier, "none");

      // 2-step alternating loop detection (A -> B -> A -> B)
      const cycleGuard = new RepeatToolReminderGuard({ thresholds: [3, 5, 8] });
      cycleGuard.recordToolCall("sess-2", "read_file", { path: "a.ts" });
      cycleGuard.recordToolCall("sess-2", "search_project", { query: "foo" });
      cycleGuard.recordToolCall("sess-2", "read_file", { path: "a.ts" });
      const fourthStep = cycleGuard.recordToolCall("sess-2", "search_project", { query: "foo" });
      assert.equal(fourthStep.repeated, true);
      assert.equal(fourthStep.alternatingCycleDetected, true);
      assert.ok(fourthStep.reminderMessage?.includes("Alternating 2-step tool cycle"));

      // Spill pagination & cleanup
      const bigOutput = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: ${"ABCD".repeat(30)}`).join("\n");
      const spill = applySpillPolicyToText({
        dataDir: tempDir,
        sessionId: "v04-sess",
        toolName: "test_cmd",
        content: bigOutput,
        maxInlineTokens: 250,
      });
      assert.equal(spill.spilled, true);
      const page = readSpillRange(tempDir, spill.spillRef.spillId, 10, 25);
      assert.equal(page.ok, true);
      assert.equal(page.startLine, 10);
      assert.equal(page.endLine, 25);
      assert.ok(page.content.includes("Line 10:"));
      const cleaned = cleanupExpiredSpills(tempDir, -1000);
      assert.ok(cleaned.removedCount >= 1);

      // PTC sandbox with editFile and tools.* alias
      const ptcRes = await executePtcProgram({
        code: `
          const files = await tools.listFiles("src");
          const edited = await apex.editFile("src/calc.ts", "a + b", "a + b /* ptc */");
          return { files, edited };
        `,
        workspacePath: tempDir,
        dataDir: tempDir,
        allowWrite: true,
      });
      assert.equal(ptcRes.ok, true);
      assert.ok(runtime.readFile("src/calc.ts").content.includes("/* ptc */"));

      // Signed dynamic plugin registration, uninstall, and audit log
      const mounted = mountDynamicPlugin(tempDir, {
        id: "v04-signed-plugin",
        name: "V04 Signed Plugin",
        description: "Test dynamic plugin",
        version: "1.0.0",
        code: `return { transformed: String(input.text || "").toUpperCase() };`,
        permissions: ["pure_transform"],
      });
      assert.equal(mounted.id, "v04-signed-plugin");
      const uninst = uninstallDynamicPlugin(tempDir, "v04-signed-plugin");
      assert.equal(uninst.ok, true);
      assert.equal(uninst.removed, true);
      const auditEvents = readPluginAuditLog(tempDir);
      assert.ok(auditEvents.some((e) => e.action === "mount" && e.pluginId === "v04-signed-plugin"));
      assert.ok(auditEvents.some((e) => e.action === "uninstall" && e.pluginId === "v04-signed-plugin"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // V-05: Independent EGM Review & Completion Evidence
  // ==========================================================================
  await t.test("V-05: Fresh-session Goldfish HTTP reviewer (zero Elephant history), CONTEST citation validator, and auto-detected verification matrix", async () => {
    const tempDir = makeTempDir("apex-v05-");
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "v05-proj",
        scripts: {
          test: 'node -e "process.exit(0)"',
          typecheck: 'node -e "process.exit(0)"',
        },
      }),
      "utf8",
    );
    writeFileSync(join(tempDir, "feature.ts"), "export function computeTotal(x: number): number { return x * 2; }\n", "utf8");

    let capturedGoldfishRequestBody = null;
    const mockGoldfishServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        capturedGoldfishRequestBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    outcome: "approve",
                    score: 96,
                    summary: "Fresh-session Goldfish verified feature.ts against task spec.",
                    findings: [],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise((r) => mockGoldfishServer.listen(0, "127.0.0.1", r));
    const gfPort = mockGoldfishServer.address().port;

    try {
      const selectedReviewer = selectIndependentGoldfishModel(
        "agy-acp/gemini-4-argon-high",
        ["agy-acp/gemini-4-argon-high", "agy-acp/claude-opus-4-6-thinking"],
      );
      assert.equal(selectedReviewer, "agy-acp/claude-opus-4-6-thinking");

      const review = await runPostImplementationEgmReview({
        originalRequirement: "Implement computeTotal in feature.ts",
        workspacePath: tempDir,
        filesCreated: [],
        filesModified: ["feature.ts"],
        commandsExecuted: [],
        responseText: "Implemented computeTotal in feature.ts.",
        builderModelId: "agy-acp/gemini-4-argon-high",
        candidateReviewerModels: ["agy-acp/claude-opus-4-6-thinking"],
        reviewerEndpointUrl: `http://127.0.0.1:${gfPort}/v1/chat/completions`,
        requireLiveGoldfishModel: true,
      });

      assert.equal(review.outcome, "approve");
      assert.equal(review.reviewerAvailable, true);
      assert.equal(review.source, "goldfish_fresh_session");
      assert.equal(review.independentContextVerified, true);
      assert.ok(Array.isArray(review.deterministicChecks));
      assert.ok(capturedGoldfishRequestBody, "Goldfish HTTP endpoint must be called");
      const sentMessages = JSON.stringify(capturedGoldfishRequestBody.messages);
      assert.ok(
        sentMessages.includes("Goldfish"),
        "Goldfish system prompt must enforce zero-context independence",
      );

      // Verify requireLiveGoldfishModel: true returns unavailable when endpoint is down
      const unavailReview = await runPostImplementationEgmReview({
        originalRequirement: "Implement computeTotal in feature.ts",
        workspacePath: tempDir,
        filesCreated: [],
        filesModified: ["feature.ts"],
        commandsExecuted: [],
        responseText: "Implemented computeTotal.",
        reviewerEndpointUrl: "http://127.0.0.1:1/v1/chat/completions",
        requireLiveGoldfishModel: true,
      });
      assert.equal(unavailReview.outcome, "unavailable");
      assert.equal(unavailReview.reviewerAvailable, false);
      assert.equal(unavailReview.source, "unavailable");

      // Verify EGM Resolution Protocol validator (CONTEST rules)
      const ledgerCheck = validateEgmResolutionLedger(tempDir, [
        {
          findingId: "F-1",
          lens: "comprehension",
          action: "CONTEST",
          rationale: "This was intentional",
        },
        {
          findingId: "F-2",
          lens: "codebase_details",
          action: "CONTEST",
          rationale: "No file citation provided",
        },
      ]);
      assert.equal(ledgerCheck.valid, false);
      assert.ok(ledgerCheck.violations.length >= 2);

      // Valid CONTEST citing existing feature.ts#L1 passes
      const validContest = validateEgmResolutionLedger(tempDir, [
        {
          findingId: "F-3",
          lens: "codebase_details",
          action: "CONTEST",
          rationale: "Verified on disk in feature.ts#L1",
          citedFile: "feature.ts",
        },
      ]);
      assert.equal(validContest.valid, true);

      // Auto-detected verification commands & requirement matrix
      const detectedCmds = detectProjectVerificationCommands(tempDir);
      assert.ok(detectedCmds.testCommands.includes("npm test"));
      const evidence = buildCompletionEvidenceReport({
        executionId: "exec-v05",
        originalRequirement: "Implement computeTotal in feature.ts and ensure tests pass",
        executionPlanSummary: "Full engineering DAG",
        workspaceRoot: tempDir,
        subtasks: [],
        skillsMounted: [],
        toolsInvoked: [],
        filesInspected: ["feature.ts"],
        filesCreated: [],
        filesModified: ["feature.ts"],
        commandsExecuted: [
          {
            command: "npm test",
            cwd: tempDir,
            exitCode: 0,
            durationMs: 25,
            timedOut: false,
            cancelled: false,
            stdoutSnippet: "PASS",
            stderrSnippet: "",
          },
        ],
        egmReview: review,
        responseText: "Implemented computeTotal in feature.ts and verified with npm test.",
      });
      assert.equal(evidence.status, "implemented_and_verified");
      assert.ok(Array.isArray(evidence.requirementMatrix));
      assert.ok(evidence.requirementMatrix.length >= 1);
      assert.ok(evidence.requirementMatrix.every((r) => r.status === "implemented_and_verified"));

      // End-to-End Production /api/chat/stream -> Critic -> Independent Goldfish HTTP Endpoint Test
      capturedGoldfishRequestBody = null;
      let capturedBuilderMessages = "";
      const mockBuilderServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const isBuilderCall = body.includes("You are the Apex Harness Builder Agent.");
          if (isBuilderCall) {
            capturedBuilderMessages += body;
          }
          const shouldEmitEditTool =
            isBuilderCall &&
            body.includes("Implement computeTotal multiplier update") &&
            !body.includes("Tool results:");
          const reply = shouldEmitEditTool
            ? [
                "Updating feature.ts now:",
                "```apex-action",
                JSON.stringify({
                  tool: "edit_file",
                  path: "feature.ts",
                  target: "return x * 2;",
                  replacement: "return x * 3;",
                }),
                "```",
              ].join("\n")
            : "Updated computeTotal in feature.ts to multiply by 3.";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content: reply },
                  finish_reason: "stop",
                },
              ],
            }),
          );
        });
      });
      await new Promise((r) => mockBuilderServer.listen(0, "127.0.0.1", r));
      const builderPort = mockBuilderServer.address().port;
      const prevOmni = process.env.OMNIROUTE_BASE_URL;
      process.env.OMNIROUTE_BASE_URL = `http://127.0.0.1:${builderPort}/v1`;

      const appServer = createApexAppServer();
      await new Promise((r) => appServer.listen(0, "127.0.0.1", r));
      const appPort = appServer.address().port;
      const baseUrl = `http://127.0.0.1:${appPort}`;
      const headers = {
        "Content-Type": "application/json",
        "X-Apex-Token": getLocalSessionToken(),
        Origin: baseUrl,
      };

      try {
        // Register tempDir as a project and create a conversation
        const projRes = await fetch(`${baseUrl}/api/projects`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "v05-live-critic-proj", path: tempDir }),
        });
        const projData = await projRes.json();
        const projectId = projData.project.id;

        const convRes = await fetch(`${baseUrl}/api/conversations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "V05 Production Goldfish Critic Test",
            projectId,
            forceNew: true,
          }),
        });
        const convData = await convRes.json();
        const convId = convData.thread.id;

        // Turn 1: Seed private Elephant conversation history
        const turn1Res = await fetch(`${baseUrl}/api/chat/stream`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            conversationId: convId,
            prompt: "hi — PRIVATE_ELEPHANT_HISTORY_MARKER_99182",
            mode: "turbo",
            adaptiveTopology: true,
          }),
        });
        await turn1Res.text();

        // Turn 2: Code modification turn that triggers full_engineering DAG + live Goldfish HTTP Critic
        capturedGoldfishRequestBody = null;
        const turn2Res = await fetch(`${baseUrl}/api/chat/stream`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            conversationId: convId,
            prompt: "Implement computeTotal multiplier update in feature.ts",
            mode: "turbo",
            effort: "medium",
            reviewerEndpointUrl: `http://127.0.0.1:${gfPort}/v1`,
            reviewerProviderId: "mock-goldfish-provider",
            reviewerModelId: "agy-acp/claude-opus-4-6-thinking",
            requireLiveGoldfishModel: true,
          }),
        });
        assert.equal(turn2Res.status, 200);
        const turn2Sse = await turn2Res.text();
        assert.ok(turn2Sse.includes("event: done"));

        // Verify Builder received the private history marker, while Goldfish NEVER received it!
        assert.ok(
          capturedBuilderMessages.includes("PRIVATE_ELEPHANT_HISTORY_MARKER_99182"),
          "Builder must receive conversation history",
        );
        assert.ok(
          capturedGoldfishRequestBody,
          "Production Critic node must invoke the configured Goldfish HTTP endpoint during /api/chat/stream",
        );
        const goldfishRawPayload = JSON.stringify(capturedGoldfishRequestBody);
        assert.equal(
          goldfishRawPayload.includes("PRIVATE_ELEPHANT_HISTORY_MARKER_99182"),
          false,
          "Goldfish reviewer must NEVER receive Builder's private conversation history",
        );
        assert.ok(
          goldfishRawPayload.includes("return x * 3;"),
          "Goldfish reviewer must receive actual modified file content from disk",
        );
        assert.ok(
          goldfishRawPayload.includes("changed_files_exist_and_non_empty"),
          "Goldfish reviewer payload must preserve deterministicChecks",
        );

        // Verify execution record persisted reviewer identity, endpoint, model, session, and outcome
        const execsRes = await fetch(`${baseUrl}/api/executions?conversationId=${convId}`, {
          headers,
        });
        const execsData = await execsRes.json();
        const latestExec = execsData.executions[0];
        assert.ok(latestExec, "Execution record must be persisted");
        const criticNode = latestExec.subtasks.find((s) => s.role === "Critic");
        assert.equal(criticNode?.actualModelUsed, "agy-acp/claude-opus-4-6-thinking");
        assert.equal(criticNode?.driverId, "mock-goldfish-provider");
        assert.ok(criticNode?.sessionId?.includes("_c0"));
        assert.equal(
          latestExec.completionReport?.egmReview?.reviewerEndpointUrl,
          `http://127.0.0.1:${gfPort}/v1`,
        );
        assert.equal(latestExec.completionReport?.egmReview?.outcome, "approve");
      } finally {
        if (prevOmni === undefined) delete process.env.OMNIROUTE_BASE_URL;
        else process.env.OMNIROUTE_BASE_URL = prevOmni;
        appServer.close();
        mockBuilderServer.close();
      }
    } finally {
      mockGoldfishServer.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // V-06: Hermes Bounded Memory, Skill Learning & Isolated Subagents
  // ==========================================================================
  await t.test("V-06: Hermes secret-scrubbed bounded memory, validated skill learning with snapshot rollback, and isolated subagent delegation", async () => {
    const tempDir = makeTempDir("apex-v06-");
    try {
      // 1. Secret-scrubbed bounded memory
      const saved = saveMemoryEntry(tempDir, {
        scope: "project",
        workspaceRoot: tempDir,
        category: "architecture",
        title: "Deploy Credentials & Architecture",
        content: "Use canonical paths. Secret token sk-1234567890abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 must never be stored raw.",
        tags: ["security", "paths"],
      });
      assert.ok(saved.redactedSecrets >= 2);
      assert.ok(!saved.entry.content.includes("sk-1234567890abcdefghijklmnop"));
      assert.ok(saved.entry.content.includes("[REDACTED_API_KEY]"));
      assert.ok(saved.entry.content.includes("[REDACTED_GITHUB_TOKEN]"));

      const queried = queryMemoryEntries(tempDir, {
        workspaceRoot: tempDir,
        query: "canonical paths",
      });
      assert.equal(queried.length, 1);
      const snippet = buildGroundedMemoryPromptSnippet(tempDir, {
        prompt: "canonical paths",
        workspaceRoot: tempDir,
      });
      assert.ok(snippet.includes("HERMES PERSISTENT"));

      // 2. Learned skill creation -> validation -> promotion -> universal discovery -> rollback
      const badProposal = proposeLearnedSkill(tempDir, {
        skillName: "unsafe-wiper",
        description: "Bad skill that runs destructive commands",
        instructions: "Run `rm -rf /` to clean up.",
      });
      const validatedBad = validateLearnedSkillProposal(tempDir, badProposal.proposalId, tempDir);
      assert.equal(validatedBad.status, "rejected");

      const goodProposal = proposeLearnedSkill(tempDir, {
        skillName: "canonical-path-enforcer",
        description: "Enforces canonical path validation before file edits in Apex Harness.",
        triggers: ["canonical path", "workspace boundary"],
        instructions: "## Workflow\n1. Always call `assertCanonicalWorkspacePath` before mutating files.\n2. Create a checkpoint before applying surgical edits.",
      });
      const validatedGood = validateLearnedSkillProposal(tempDir, goodProposal.proposalId, tempDir);
      assert.equal(validatedGood.status, "validated");
      assert.equal(validatedGood.validationReport?.passed, true);

      const promoted = promoteLearnedSkillProposal(tempDir, goodProposal.proposalId);
      assert.ok(existsSync(promoted.skillFilePath));

      const discovered = discoverAllUniversalSkills({
        workspaceRoot: tempDir,
        dataDir: tempDir,
      });
      assert.ok(discovered.some((s) => s.name === "canonical-path-enforcer"));

      const rolledBack = rollbackLearnedSkillSnapshot(tempDir, promoted.snapshotId);
      assert.equal(rolledBack.ok, true);
      assert.ok(!existsSync(promoted.skillFilePath));

      // 3. Isolated subagent delegation
      writeFileSync(join(tempDir, "target.ts"), "export function alpha() { return 42; }\n", "utf8");
      const subRes = await delegateSubagentTask({
        dataDir: tempDir,
        workspaceRoot: tempDir,
        role: "Scout",
        task: "Find alpha in target.ts",
        customExecutorFn: async (ctx) => ({
          summary: `Inspected ${ctx.workspaceRoot} with ${ctx.assignedModelId}`,
          filesInspected: ["target.ts"],
        }),
      });
      assert.equal(subRes.status, "completed");
      assert.equal(subRes.isolatedContextVerified, true);
      assert.deepEqual(subRes.filesInspected, ["target.ts"]);

      const swarmRes = await delegateParallelSubagentSwarm(
        [
          {
            dataDir: tempDir,
            workspaceRoot: tempDir,
            role: "Scout",
            task: "Inspect target.ts",
            customExecutorFn: async () => ({ summary: "Scout done", filesInspected: ["target.ts"] }),
          },
          {
            dataDir: tempDir,
            workspaceRoot: tempDir,
            role: "Architect",
            task: "Review architecture of target.ts",
            customExecutorFn: async () => ({ summary: "Architect done", filesInspected: ["target.ts"] }),
          },
        ],
        2,
      );
      assert.equal(swarmRes.length, 2);
      assert.ok(swarmRes.every((r) => r.isolatedContextVerified && r.status === "completed"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // V-07: Agent Office Live Telemetry & New API Routes
  // ==========================================================================
  await t.test("V-07: /api/memory, /api/skills/learned, /api/subagents/delegate, /api/drivers routes and Agent Office UI telemetry wiring", async () => {
    const server = createApexAppServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Apex-Token": getLocalSessionToken(),
      Origin: baseUrl,
    };

    try {
      const drvRes = await fetch(`${baseUrl}/api/drivers`, { headers });
      const drvData = await drvRes.json();
      assert.ok(Array.isArray(drvData.drivers));
      assert.ok(drvData.drivers.length >= 5);

      const memPost = await fetch(`${baseUrl}/api/memory`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          scope: "project",
          title: "UI Route Test Memory",
          content: "Remember to run tests with sk-abcdef1234567890abcdef123456",
        }),
      });
      const memData = await memPost.json();
      assert.equal(memData.ok, true);
      assert.ok(memData.redactedSecrets >= 1);

      // Verify ui/agent-office.js includes driverId, currentTool, retryCount, and approval bar hooks
      const officeJs = readFileSync(join(process.cwd(), "ui", "agent-office.js"), "utf8");
      assert.ok(officeJs.includes("st.driverId"));
      assert.ok(officeJs.includes("st.currentTool"));
      assert.ok(officeJs.includes("window.resolveActiveApproval"));
    } finally {
      server.close();
    }
  });

  // ==========================================================================
  // V-08: OS/CSPRNG Master Key Store & Chained Shell Command Policy
  // ==========================================================================
  await t.test("V-08: CSPRNG master key store (no predictable hostname/username key derivation) and chained shell command policy enforcement", async () => {
    const tempDir = makeTempDir("apex-v08-");
    try {
      const keyInfo = getOrCreateMasterVaultKey(tempDir);
      assert.equal(keyInfo.key.length, 32);
      assert.ok(
        keyInfo.source === "csprng_master_key_file" ||
          keyInfo.source === "windows_dpapi" ||
          keyInfo.source === "env_override",
      );
      assert.ok(existsSync(getMasterKeyFilePath(tempDir)));

      storeEncryptedProviderSecret(tempDir, "openai-direct", "sk-live-super-secret-999");
      const decrypted = resolveProviderSecret(tempDir, {
        id: "openai-direct",
        name: "OpenAI",
        protocol: "openai-compat",
        baseUrl: "https://api.openai.com/v1",
        hasStoredSecret: true,
        enabled: true,
        priority: 1,
        timeoutMs: 10000,
        defaultModels: [],
        updatedAt: new Date().toISOString(),
      });
      assert.equal(decrypted, "sk-live-super-secret-999");

      // Chained shell command policy parser tests
      const chain1 = splitShellCommandChain("echo hello && rm -rf /");
      assert.deepEqual(chain1.segments, ["echo hello", "rm -rf /"]);
      const policy1 = classifyCommandPolicy("echo hello && rm -rf /", "turbo");
      assert.equal(policy1.decision, "deny");
      assert.equal(policy1.tier, "blocked");

      // Subshell expansion hiding destructive command
      const policySubshell = classifyCommandPolicy("echo $(rm -rf /)", "turbo");
      assert.equal(policySubshell.decision, "deny");
      assert.equal(policySubshell.tier, "blocked");

      // Chained read-only prefix + mutating command in auto_edit mode must require approval
      const policyAutoEditChain = classifyCommandPolicy("git status && rm temp.txt", "auto_edit");
      assert.equal(policyAutoEditChain.decision, "require_approval");
      assert.equal(policyAutoEditChain.tier, "sensitive_mutating");

      // Output redirection in auto_edit mode must require approval
      const policyRedirect = classifyCommandPolicy("echo pwned > config.json", "auto_edit");
      assert.equal(policyRedirect.decision, "require_approval");
      assert.equal(policyRedirect.tier, "sensitive_mutating");

      // Pure read-only chain in auto_edit mode is allowed
      const policyReadOnlyChain = classifyCommandPolicy("git status && git diff", "auto_edit");
      assert.equal(policyReadOnlyChain.decision, "allow");
      assert.equal(policyReadOnlyChain.tier, "readonly");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
