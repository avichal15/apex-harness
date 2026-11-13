# Production Execution Map — Baseline (`66bc80f`)

## 1. Entry Points & Startup Paths

| Entry Mode | File / Command | Actual Startup Behavior |
| :--- | :--- | :--- |
| **Web / Daemon Server** | `server/apex-app-server.ts` (`npm start` / `npm run apex:app`) | Starts HTTP/SSE server bound to `127.0.0.1:5199`, initializes `TaskExecutionManager`, `RepeatToolReminderGuard`, Harness² `c1..c8` surfaces, and serves `ui/index.html`. |
| **Electron Desktop Studio** | `electron/apex-main.mjs` + `electron/apex-preload.cjs` (`npm run apex:desktop`) | Generates per-session `APEX_SESSION_TOKEN`, spawns `server/apex-app-server.ts`, waits for `/api/bootstrap`, opens `BrowserWindow` with `contextIsolation: true`, and kills child process tree on exit. |
| **Windows Native Launcher** | `ApexHarness.exe` (C# / .NET native executable) | Ensures `server/apex-app-server.ts` is listening on `127.0.0.1:5199` and opens a dedicated native app window (`1440×920`). |
| **CLI Utility** | `server/apex-cli.ts` (`npm run apex`) | Runs `status`, `route`, `skills`, `judge`, and `evolve` subcommands from the terminal. |

---

## 2. Production HTTP/SSE Routes (`server/apex-app-server.ts`)

| Method & Route | Handler Function(s) Called | Security & Validation Applied |
| :--- | :--- | :--- |
| `GET /` & `GET /styles.css`, `/agent-office.js` | Static asset server (`ui/index.html`, `ui/styles.css`, `ui/agent-office.js`) | Loopback check (`verifyLocalApiRequest`), injects `window.__APEX_SESSION_TOKEN__` into `index.html`. |
| `GET /api/bootstrap` | `loadUnifiedModelFleet`, `discoverAllUniversalSkills`, `discoverAllUniversalMcpServers`, `loadProviderConfigs`, `loadRoleRoutingTable`, `executionManager.listExecutions` | Loopback + Origin check. |
| `GET /api/executions`, `GET /api/executions/:id` | `executionManager.listExecutions`, `executionManager.getExecution` | Loopback + Origin check. |
| `POST /api/executions/:id/cancel\|pause\|resume\|approve` | `executionManager.cancelExecution`, `pauseExecution`, `resumeExecution`, `resolveApproval` | Loopback + Origin + CSRF `application/json` + `X-Apex-Token` + 1 MiB body limit. |
| `GET/POST/DELETE /api/providers`, `POST /api/providers/test` | `loadProviderConfigs`, `saveProviderConfig`, `deleteProviderConfig`, `testProviderConnection` | Loopback + Origin + CSRF + Token + AES-256-GCM vault. |
| `GET/POST /api/routing/roles` | `loadRoleRoutingTable`, `saveRoleRoutingTable` | Loopback + Origin + CSRF + Token. |
| `GET/POST /api/skills/config`, `POST /api/skills/transpile` | `loadSkillManagementConfig`, `saveSkillManagementConfig`, `transpileSkillForDriver`, `validateSkillCompatibility` | Loopback + Origin + CSRF + Token. |
| `GET/POST /api/harness2/proposals`, `promote`, `rollback`, `surface` | `proposeHarnessImprovement`, `validateHarnessProposal`, `promoteHarnessProposal`, `rollbackHarnessSnapshot` | Loopback + Origin + CSRF + Token + Python `validateHarness2TreeViaPython`. |
| `GET /api/ide/files`, `GET/POST /api/ide/file`, `GET /api/ide/search`, `GET /api/ide/git`, `POST /api/ide/exec` | `listWorkspaceFilesTree`, `assertCanonicalWorkspacePath`, `saveTurnCheckpoint`, `searchWorkspaceText`, `runManagedCommand` | Canonical workspace jail (`realpathSync`/`lstatSync`) + `runManagedCommand` policy gate. |
| `POST /api/turn/revert` | `revertTurnCheckpoint` (`server/apex-llm-engine.ts`) | Restores pre-edit file backups inside canonical workspace root. |
| `POST /api/mcp/tools`, `POST /api/mcp/call` | `listMcpServerTools`, `callMcpServerTool` (`server/harness/mcp-client-bridge.ts`) | JSON-RPC 2.0 stdio transport with `AbortSignal` and `killProcessTree`. |
| `POST /api/chat/stream` | Inline orchestration in `server/apex-app-server.ts:1339-2095` (**Duplicate path — see Section 3**) | SSE stream emitting `execution`, `plan`, `egm`, `step`, `office`, `delta`, `done`, `error`. |

---

## 3. Baseline End-to-End Trace & Architectural Duplication Identified

Tracing a user prompt from `ui/index.html` (`sendPrompt()`) through `POST /api/chat/stream` revealed a critical split between the test orchestration path and the live server route:

1. **Test Path (`server/apex-master-verification.node-test.mjs`)**: Calls `executeTaskDag()` in `server/harness/agent-dag-orchestrator.ts:1143`, which uses topological layer scheduling (`Promise.all(readyNodes.map(runNode))`), bounded Critic correction loops (`while (postImplReview.outcome === "request_changes" && cycle < maxCycles)`), and per-node `AbortSignal` propagation.
2. **Production Live Chat Path (`server/apex-app-server.ts:1339-2095`)**: Calls `buildExecutionDag()` to create the initial `subtasks` array, **but then executes a hardcoded inline sequence** (`node-coordinator` -> `Promise.all([scout, egm])` -> `node-builder` -> `node-critic` -> `node-verifier`) directly inside `apex-app-server.ts` without calling `executeTaskDag()` and without running the Critic->Builder correction loop!

**Phase 1 Resolution**: Eliminate the inline duplicate orchestration inside `server/apex-app-server.ts` so `POST /api/chat/stream` delegates 100% of its execution lifecycle to the single authoritative `executeTaskDag()` runtime engine.
