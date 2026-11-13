# Authoritative Execution Runtime Architecture

## 1. Single Production Execution Spine

Apex Harness enforces a single authoritative execution engine (`executeTaskDag` in `server/harness/agent-dag-orchestrator.ts`) invoked by both the production SSE endpoint (`POST /api/chat/stream` in `server/apex-app-server.ts`) and integration test suites.

```mermaid
flowchart TD
    UI["UI Composer / Electron Desktop (ui/index.html)"] -->|"POST /api/chat/stream (X-Apex-Token)"| API["App Server (server/apex-app-server.ts)"]
    API -->|"verifyLocalApiRequest + readBoundedJsonBody"| SEC["Workspace & Local API Security (workspace-security.ts)"]
    SEC -->|"createExecution(executionId)"| EXECMGR["TaskExecutionManager (execution-manager.ts)"]
    EXECMGR -->|"executeTaskDag(options)"| DAG["Authoritative DAG Engine (agent-dag-orchestrator.ts)"]

    subgraph "Adaptive Topological DAG Scheduler (Bounded Concurrency)"
        COORD["1. Coordinator (Task Classification, Adaptive Graph, Skill Budgeting)"]
        SCOUT["2a. Scout (WorkspaceRuntime AST & Symbol Indexer)"]
        ARCH["2b. Architect (Pre-Exec EGM Desk 1-3 & Boundary Spec)"]
        BUILD["3. Builder (Multi-Protocol ReAct Loop, PTC, Checkpoints, Subagents)"]
        CRITIC["4. Critic (Fresh-Context Goldfish Reviewer + Static Linter Checks)"]
        VERIFY["5. Verifier (Auto-Detected Verification Commands & Evidence Gate)"]

        COORD --> SCOUT
        COORD --> ARCH
        SCOUT --> BUILD
        ARCH --> BUILD
        BUILD --> CRITIC
        CRITIC -->|"request_changes (bounded retry)"| BUILD
        CRITIC -->|"approve / escalate / unavailable"| VERIFY
    end

    DAG --> COORD
    BUILD -->|"ApexDriver Contract"| DRIVERS["Driver Registry & Protocol Adapters (driver-registry.ts / protocol-adapters.ts)"]
    CRITIC -->|"Isolated Reviewer Session"| DRIVERS
    VERIFY -->|"CompletionEvidenceReport"| EVIDENCE["Evidence & Requirement Gate (completion-evidence.ts)"]
    EVIDENCE -->|"Append-Only Journal & Memory"| MEM["Session Query & Hermes Memory (deepseek-subsystems.ts / hermes-memory-learning.ts)"]
```

---

## 2. Core Architectural Invariants

1. **No Duplicate Orchestration Paths**: `POST /api/chat/stream` delegates directly to `executeTaskDag()`. Every SSE event (`execution`, `plan`, `egm`, `step`, `office`, `delta`, `done`, `error`) is emitted from callbacks driven by `executeTaskDag()`.
2. **Adaptive Graph Complexity**:
   - `fast_path` (trivial Q&A or independent chat): `Coordinator -> Builder -> Verifier` (skips unnecessary repository-wide Scout/Architect/Critic overhead by marking them `skipped` with explicit rationale).
   - `standard` (targeted single-file edit/debug): `Coordinator -> Scout -> Builder -> Critic -> Verifier`.
   - `full_engineering` (multi-file feature, architecture, or security task): Full 6-agent parallel DAG (`Coordinator -> [Scout || Architect] -> Builder -> Critic -> Verifier`).
3. **Genuine Agent Session Independence**: Every active DAG node receives its own `sessionId` (`sess_${executionId}_${node.id}`), assigned driver (`driverId`), model (`assignedModelId`), and scoped context window.
4. **Honest Fresh-Context EGM Review**:
   - Deterministic static checks (`TODO`/`FIXME` stubs, empty files, command exit codes) are explicitly labelled `deterministic_static_check`.
   - Independent Goldfish review invokes a fresh driver session containing **only** the task requirement, changed file contents, git diff, and executed command outputs—never the Elephant's conversation history.
   - If no live reviewer model is reachable, the reviewer returns `outcome: "unavailable"`, `reviewerAvailable: false`, and completion is capped at `implemented_not_verified` (never `implemented_and_verified`).
5. **Idempotency-Aware Failover**: If a provider fails *before* any workspace mutation (`write_file`, `edit_file`, mutating `run_command`), the driver router transparently fails over to the next candidate model. If a failure occurs *after* workspace mutation, automatic blind retry is blocked unless the turn checkpoint is rolled back first.
6. **OS-Backed Secret Storage**: Provider API keys are encrypted via Windows DPAPI (`ProtectedData` on `win32`), macOS Keychain (`security` on `darwin`), Linux `secret-tool`, or a CSPRNG 256-bit `.master-key` (`0o600`) fallback—never derived from `hostname` or `username`.
