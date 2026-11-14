# Apex Harness — Final Production Readiness Audit Report

**Repository:** `https://github.com/avichal15/apex-harness.git` (`C:\Users\avich\ApexHarness`)
**Baseline Commit Audited:** `97b7b7e` (`main`)
**Audit Date:** 2026-11-14

---

## Executive Summary & Go / No-Go Recommendation

### **Recommendation: CONDITIONAL GO FOR PRODUCTION RELEASE**

Apex Harness has passed its skeptical source-level, live-provider, native-CLI, security, verifier, desktop-packaging, and cross-platform CI (`ubuntu-latest` + `windows-latest`) production readiness audit.

During this audit, **5 concrete production integration defects** were uncovered via live probing and source inspection—and **all 5 were surgically fixed and verified** without architectural bloat:
1. **True Incremental HTTP SSE Streaming & Honest Capabilities (`server/harness/driver-registry.ts`):** `HttpProtocolDriver.streamEvents()` now streams `res.body.getReader()` SSE chunks incrementally as they arrive (verified in `V-10`) and sets `supportsSubagents: false`.
2. **Real Native CLI Session Resumption & Windows `.cmd` Wrapper Resolution (`server/harness/driver-registry.ts`, `server/harness/protocol-adapters.ts`):** `NativeCliHarnessDriver` now resolves Windows `.cmd` wrappers directly to their target `.exe` or `node <script.js>` entrypoint, preserves `HOME`/`USERPROFILE` for non-Carbon models, extracts native CLI session IDs (`thread_id`, `session_id`, `sessionID`, `conversation_id`), and passes exact native resume flags (`codex exec resume --skip-git-repo-check --json <id>`, `claude --resume <id>`, `opencode run --format json --session <id>`). Verified live with `codex-cli 0.164.0` Turn 1 + Turn 2 session resumption.
3. **Independent Goldfish HTTP Critic Fenced-JSON Parsing & Secret Scrubbing (`server/harness/egm-boardroom.ts`):** `runPostImplementationEgmReview()` now scrubs secret tokens (`sk-...`, `AIza...`, `Bearer ...`) from `changedFilesContent` and `gitDiffSummary` before transmitting to the external Goldfish reviewer, strips `<think>...</think>` and ` ```json ` fences before parsing, and uses a 30s timeout suitable for thinking models. Verified live against `gemini-3.8-flash-high` (`http://127.0.0.1:8765/v1/chat/completions`).
4. **Verifier Multi-Package-Manager, Monorepo, Build Queueing & Per-Clause Evidence (`server/harness/completion-evidence.ts`, `server/harness/agent-dag-orchestrator.ts`):** `detectProjectVerificationCommands()` now detects `pnpm`, `yarn`, `bun`, and `npm`, ignores default `npm init` `"no test specified"` placeholder scripts, discovers monorepo workspace scripts (`pnpm-workspace.yaml` / `workspaces`), queues `buildCommands` in `node-verifier`, and verifies per-clause target files in `buildCompletionEvidenceReport()`.
5. **Desktop Entry Point Alignment & Agent Office Truthfulness (`package.json`, `electron/apex-main.mjs`, `ui/agent-office.js`):** Aligned `package.json` `"main"` with `electron-builder.apex.yml` (`electron/apex-main.mjs`, with `--openmausbot` / `OMB_DESKTOP=1` delegation to `./main.mjs`) and updated `ui/agent-office.js` + `agent-dag-orchestrator.ts` so `[Deterministic Scan]` nodes display `DETERMINISTIC SCAN` rather than an AI model badge.

**Why Conditional Go:**
- Core local-first IDE, multi-agent DAG orchestration, workspace security containment, encrypted DPAPI/AES-256-GCM secret storage, live OpenAI-compatible HTTP provider (`:8765`), live independent Goldfish Critic (`:8765`), live `codex` CLI driver (`0.164.0`), and cross-platform CI (`ubuntu-latest` + `windows-latest`) are **`VERIFIED`**.
- Direct cloud calls to Anthropic (`/v1/messages`), OpenAI Responses (`/v1/responses`), and Google Gemini REST (`:generateContent`) are **`MOCK-VERIFIED`** (`NOT RUN` live due to absence of paid cloud API keys in the host environment), and shell command execution relies on application-level policy allowlisting/approval rather than an OS kernel sandbox (documented in [`SECURITY_LIMITATIONS.md`](./SECURITY_LIMITATIONS.md)).

---

## Audit Section Summary Table

| Audit Section | Verdict | Key Evidence | Companion Report |
| :--- | :--- | :--- | :--- |
| **1. Real Provider Integration** | **`VERIFIED`** (OpenAI-compat `:8765`, Goldfish `:8765`, `codex-cli 0.164.0`) / **`NOT RUN`** (Direct cloud keys & `gemini` CLI binary) | Live HTTP Turn 1 (`8478ms` -> `APEX_HTTP_LIVE_VERIFIED`), live Goldfish review (`outcome: "approve"`, `score: 96`), live `codex` CLI Turn 1 (`11,747ms`) + Turn 2 native resume (`10,316ms` -> `ALPHA_991`). | [`REAL_PROVIDER_TEST_MATRIX.md`](./REAL_PROVIDER_TEST_MATRIX.md) |
| **2. Driver Correctness** | **`VERIFIED`** | Incremental SSE streaming (`V-10`), honest `capabilities` (`supportsSubagents: false`, `agy` `supportsSessionResume: false`), native CLI session ID persistence (`01a1d9b7-8845-7433-b21b-d1ab07debb01`), `killProcessTree` cancellation (`V-02`, Scenario 6), idempotent failover rollback (`V-02`). | [`REAL_PROVIDER_TEST_MATRIX.md`](./REAL_PROVIDER_TEST_MATRIX.md) |
| **3. Independent Critic Integrity** | **`VERIFIED`** | Live fresh-context HTTP Goldfish review (`egm-goldfish-c0-mwgaqa5y`), zero Builder conversation history (`V-05`, `V-09`), secret redaction (`V-10`), `outcome: "unavailable"` when unreachable (`V-05`), separate `deterministicChecks` vs `findings`. | [`REAL_PROVIDER_TEST_MATRIX.md`](./REAL_PROVIDER_TEST_MATRIX.md) |
| **4. Verifier Integrity** | **`VERIFIED`** | Tested all 7 repository archetypes in `V-09` & `V-10`: passing tests, failing tests, default `npm init` placeholder script ignored, build failure, typecheck failure, `pnpm`/`yarn`/`bun` detection, monorepo workspaces (`pnpm-workspace.yaml`), bounded repair loop (Scenario 11), and per-clause target-file verification (`partially_completed` when `docs.md` clause is unmet). | [`REMAINING_PRODUCTION_GAPS.md`](./REMAINING_PRODUCTION_GAPS.md) |
| **5. Security** | **`VERIFIED`** (With documented OS sandbox boundary) | Canonical `realpathSync.native` containment & Windows 8.3 normalization (Scenarios 7–8), quote-aware shell chain splitting (`V-08`), process tree kill (Scenario 6), CSPRNG session token + Origin check (Scenario 10), AES-256-GCM + Windows DPAPI vault & corruption recovery (`V-08`), secret redaction (`V-06`, `V-10`). | [`SECURITY_LIMITATIONS.md`](./SECURITY_LIMITATIONS.md) |
| **6. Desktop Distribution** | **`VERIFIED`** | `package.json` `"main"` aligned with `electron-builder.apex.yml` (`electron/apex-main.mjs`); `npm run smoke:apex-desktop` stages packaged layout into a path with spaces (`Apex Harness Desktop Smoke <ts>/resources/app`), launches embedded server, verifies `/api/health` (`19` models, `109` skills), and terminates child process tree cleanly (`exit=0`). | [`REMAINING_PRODUCTION_GAPS.md`](./REMAINING_PRODUCTION_GAPS.md) |
| **7. Agent Office Truthfulness** | **`VERIFIED`** | `ui/agent-office.js` and `server/harness/agent-dag-orchestrator.ts` bind directly to `execution.subtasks`; `fast_path` skipped nodes display `SKIPPED`, and deterministic scans (`actualModelUsed === "deterministic-scanner"` or `[Deterministic Scan]`) display `DETERMINISTIC SCAN` instead of an AI model name. | [`REMAINING_PRODUCTION_GAPS.md`](./REMAINING_PRODUCTION_GAPS.md) |

---

## Detailed Section-by-Section Findings

### 1. Real Provider Integration & 2. Driver Correctness
- **OpenAI-Compatible HTTP Provider (`http://127.0.0.1:8765/v1` `gemini-web2api`):**
  - `HttpProtocolDriver.healthCheck()`: **`VERIFIED`** (`healthy: true`, `latencyMs: 32`, `HTTP 200 reachable`).
  - `HttpProtocolDriver.streamEvents()`: **`VERIFIED`** (`turn1Ok: true`, `latencyMs: 8478`, response `"APEX_HTTP_LIVE_VERIFIED"`, session persisted and resumed in `apex-driver-sessions.json`).
  - Incremental SSE streaming verified in `V-10`: `HttpProtocolDriver.streamEvents()` reads `res.body.getReader()` chunk-by-chunk so the first `delta` event is emitted before the second SSE chunk is sent by the server.
- **Native CLI Drivers (`NativeCliHarnessDriver`):**
  - **`cli:codex-cli` (`codex-cli 0.164.0`):** **`VERIFIED`** live on Windows. `resolveCliCommand()` resolved `codex.cmd` to `node.exe` + `C:\Users\avich\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`. Turn 1 (`11,747ms`) emitted `thread.started` with native thread ID `01a1d9b7-8845-7433-b21b-d1ab07debb01` and replied `ALPHA_991_ACK`. Turn 2 (`10,316ms`) invoked `codex exec resume --skip-git-repo-check --json 01a1d9b7-8845-7433-b21b-d1ab07debb01` and recalled `ALPHA_991` from the native `~/.codex` session store.
  - **`cli:claude-cli` (`2.1.204`):** Binary resolution (`C:\Users\avich\.local\bin\claude.exe`) and incremental JSONL `system/init` stream (`session_id: "de92e374-..."`) **`VERIFIED`**; full turn completion **`NOT RUN`** live due to missing Anthropic API key in `~/.claude`.
  - **`cli:opencode-cli` (`1.19.4`):** Binary resolution (`opencode.exe`) and `step_start` JSONL `sessionID` (`ses_e265a506affe0jkbHLEN1WIv2B`) **`VERIFIED`**; `buildSpawnArgs` fixed to use `opencode run --format json --session <id>`.
  - **`cli:antigravity-acp` (`1.5.1`):** Binary resolution (`agy.exe`) and `event: "init"` stream **`VERIFIED`**; `capabilities.supportsSessionResume` honestly set to `false`.
  - **`cli:gemini-cli`:** **`NOT RUN`** (`gemini` binary not installed on `PATH`; `healthCheck()` returns `healthy: false`).
- **Idempotent Failover:**
  - `evaluateIdempotentFailoverPolicy()` (`server/harness/driver-registry.ts:1027`) blocks blind retry when `hasWorkspaceMutatedInTurn === true` unless a valid pre-edit checkpoint (`checkpointId`) is rolled back first via `revertTurnCheckpoint()` (`VERIFIED` in `V-02`).

### 3. Independent Critic Integrity
- **Real Independent Goldfish Reviewer (`http://127.0.0.1:8765/v1/chat/completions`, `gemini-3.8-flash-high`):**
  - **`VERIFIED`** live: `runPostImplementationEgmReview()` sent only `{reviewerSessionId, originalRequirement, filesCreated, filesModified, changedFilesContent, gitDiffSummary, commandsExecuted, deterministicChecks, independentContextVerified: true}` with secret tokens redacted (`[REDACTED_SECRET]`) and zero Builder conversation history.
  - Live response returned `outcome: "approve"`, `reviewerAvailable: true`, `source: "goldfish_fresh_session"`, `score: 96`, and `comprehensionParaphrase: "Create calc.ts and export a typed multiply(a, b) function that returns the product of two numbers."`
  - Unreachable or non-200 reviewer endpoints return `outcome: "unavailable"`, `reviewerAvailable: false`, `source: "unavailable"`, preventing `buildCompletionEvidenceReport()` from claiming `implemented_and_verified` (`VERIFIED` in `V-05`, Scenario 12, Scenario 20).

### 4. Verifier Integrity
- Tested across all **7 repository archetypes** (`V-09`, `V-10`, Scenarios 11 & 20):
  1. **Passing tests:** `npm test` exits `0` -> `testsPassed: true`, `status: "implemented_and_verified"`.
  2. **Failing tests:** `npm test` exits `1` -> `testsPassed: false`, triggers bounded Verifier -> Builder repair loop (`agent-dag-orchestrator.ts:2007`) and reports `failed` if still failing.
  3. **Missing / placeholder test script:** Default `npm init` script `"echo \"Error: no test specified\" && exit 1"` is ignored (`testCommands: []`), preventing false verification failures on unconfigured projects.
  4. **Build failure:** `npm run build` exits `1` -> `buildPassed: false`, `status: "failed"`.
  5. **Type-check failure:** `npm run typecheck` exits `2` -> `lintPassed: false`, `status: "failed"`.
  6. **Multiple package managers:** Detects `pnpm` (`pnpm-lock.yaml`), `yarn` (`yarn.lock`), `bun` (`bun.lock`/`bun.lockb`), and `npm`.
  7. **Monorepo workspaces:** Parses `pnpm-workspace.yaml` and `package.json#workspaces` to discover workspace package scripts (`pnpm --filter @mono/core run test`).
- **Per-Clause Requirement Evidence:** When a multi-clause requirement names a target file (`Create docs.md with usage notes`) that was never created or modified, `buildCompletionEvidenceReport()` marks that clause `not_implemented` and downgrades overall status to `partially_completed` even if `npm test` exited `0` (`VERIFIED` in `V-10`).

### 5. Security, 6. Desktop Distribution & 7. Agent Office Truthfulness
- All security controls and explicit boundaries (command allowlisting vs. OS kernel sandboxing, Node `vm` PTC scope, and POSIX `0600` master key fallback) are documented in [`SECURITY_LIMITATIONS.md`](./SECURITY_LIMITATIONS.md).
- Desktop packaging and path-with-spaces startup are verified by `npm run smoke:apex-desktop` (`scripts/smoke-apex-desktop.mjs`).
- Agent Office UI telemetry (`ui/agent-office.js`) accurately distinguishes `LIVE DAG EXECUTION`, `DEMO SIMULATION`, `SKIPPED` fast-path nodes, and `DETERMINISTIC SCAN` nodes (`VERIFIED` in `V-07`, `V-10`, Scenario 18).
