# Apex Harness — Complete Setup & Operations Guide

This guide walks you through installing, configuring, verifying, and launching **Apex Harness** cleanly on Windows, macOS, or Linux with **zero hardcoded secrets**.

---

## 1. Prerequisites

| Requirement | Version | Purpose |
| :--- | :--- | :--- |
| **Node.js** | `>= 24.0.0` (native `--experimental-strip-types` support) | Runs `server/apex-app-server.ts`, `apex-cli.ts`, and test suites directly |
| **pnpm** | `>= 10.x` (optional, or `npm`) | Installs dependencies & runs desktop Electron scripts |
| **Python** | `>= 3.10` | Runs `harness2` validation (`validateHarness2TreeViaPython`) |
| **Git** | Any recent version | Project workspace indexing & version control |

Check your versions:

```bash
node -v
python --version   # or python3 --version
```

---

## 2. Clone & Install Dependencies

```bash
git clone https://github.com/Avichal15/apex-harness.git
cd apex-harness

# Install Node dependencies (use pnpm or npm)
pnpm install
# Optional: disable symlinks on Windows Virtual/Drive filesystems
# npm install --no-bin-links
```

Install the `harness2` Python substrate package (editable mode recommended):

```bash
pip install -e ./harness2
# Verify Python substrate bridge:
python -m harness2.cli.check --help
```

---

## 3. Environment Variables & Credential Safety

> **Security Rule:** Never commit `.env`, API keys, OAuth files (`oauth_creds.json`), or local `data/` runtime files. All sensitive runtime paths are explicitly ignored in [`.gitignore`](./.gitignore).

Create your local `.env` from [`.env.example`](./.env.example):

```bash
cp .env.example .env
```

Edit `.env` to configure only the model gateways or workspace folders you want active:

```env
# Web & Desktop server port
APEX_APP_PORT=5199

# Optional comma-separated folders containing local repositories to show in the sidebar
APEX_EXTRA_WORKSPACE_ROOTS=

# Optional OpenAI-compatible gateway (LiteLLM / OmniRoute / OpenRouter / vLLM / Ollama)
APEX_GATEWAY_URL=http://127.0.0.1:4000/v1/chat/completions
APEX_GATEWAY_API_KEY=your-local-or-provider-key
APEX_GATEWAY_MODEL=gpt-4o

# Optional direct provider keys (used only if configured)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
NVIDIA_NIM_API_KEY=
```

### How Keys Are Handled Safely
- `server/harness/apex-fleet-sync.ts` (`syncUnifiedModelRegistryToDisk`) **explicitly strips `apiKey` fields** before writing `data/apex-models.registry.json` so credentials stay in memory and `.env` only.
- Clean-room execution homes (`data/carbon-clean-home`) and conversation stores (`data/apex-conversations.json`, `data/sessions/`, `data/checkpoints/`) are gitignored.

---

## 4. Launching Apex Harness

### Option A: Web Studio Server (Recommended Cross-Platform)

```bash
node --experimental-strip-types server/apex-app-server.ts
```

Then open **http://127.0.0.1:5199** in your browser.

For a clean sandboxed demo without loading local workspace folders:

```bash
APEX_DEMO_ISOLATED=1 node --experimental-strip-types server/apex-app-server.ts
```

### Option B: Electron Desktop Window

```bash
pnpm run apex:desktop
```

### Option C: Windows App-Mode Launcher

Double-click **`Launch-Apex-App.cmd`** in the repository root (starts the background Node server on port `5199` if not already running and opens an isolated Edge `--app` window at `1440×920`).

### Option D: CLI Diagnostics & Routing

```bash
# Inspect synced model fleet, skills, MCP servers, and Harness² c1..c8 health
node --experimental-strip-types server/apex-cli.ts status

# Preview EMA task classification and model routing for a prompt
node --experimental-strip-types server/apex-cli.ts route --prompt "Audit API auth boundaries"
```

---

## 5. Connecting Cross-IDE Skills & MCP Servers

[`server/harness/universal-skill-loader.ts`](./server/harness/universal-skill-loader.ts) automatically scans bundled and user-level skill/MCP directories:

1. **Bundled Skills**: `./skills/` (including fused DeepSeek-Harness engineering workflows)
2. **Global User Configs** *(local machine only — never committed)*:
   - `~/.gemini/config/skills` & `~/.gemini/antigravity/mcp_config.json`
   - `~/.claude/skills`
   - `~/.codex/skills`
   - `~/.cursor/skills`

Skills from Claude Code, Codex, Cursor, and Antigravity are automatically deduplicated by capability cluster (`anti-slop-prose`, `ui-ux-craft`, etc.) and transpiled to the active model driver at runtime.

---

## 6. Running the 29-Test Verification Suite

Run all 29 automated verification tests (9 core architecture phases + 20 master engineering, security, DAG orchestration, and completion-evidence scenarios) before committing or deploying:

```bash
npm run test:apex
# or directly via Node 24:
node --experimental-strip-types --test server/apex-harness.node-test.mjs server/apex-master-verification.node-test.mjs
```

Expected output covers:
1. **Virtual / Drive Filesystem Compatibility**: `safeSymlinkOrCopySync` & `safeLinkOrCopySync`
2. **Phases 1–8 (`server/apex-harness.node-test.mjs`)**: Unified Model Fleet + `apiKey` redaction, Cross-IDE Skill & MCP Loader, EMA Router, Harness² `c1..c8` Python validation, EGM v5.1 Boardroom, DeepSeek-Harness 5 Subsystems, Pre-Edit Checkpoints, and Universal Multi-Protocol Tool Parser.
3. **Scenarios 1–20 (`server/apex-master-verification.node-test.mjs`)**:
   - AES-256-GCM encrypted provider vault & live connection testing
   - 10-role engineering model routing & custom role overrides
   - 6-agent DAG decomposition, cycle detection, and parallel `[Scout || Architect]` execution
   - In-flight execution cancellation (`AbortSignal` propagation) & child process-tree termination (`taskkill /T /F`)
   - Byte-for-byte pre-edit checkpoint creation and restoration
   - Canonical workspace containment blocking `../` traversal, external absolute paths, sibling-prefix (`/workspace-evil`) confusion, and symlink escapes
   - Node `--permission` OS child-process isolation for Programmatic Tool Calling (PTC) & HMAC-SHA256 signed Cordis plugins
   - Local HTTP API security rejecting cross-origin requests, CSRF form content-types, invalid session tokens, and >1 MiB bodies
   - Post-implementation independent EGM code review catching defects, running bounded correction cycles, and never defaulting to approval when unavailable
   - Context-budget-aware skill mounting, conflict resolution, and driver compatibility
   - Crash-safe execution persistence, unreachable provider handling, Harness² proposal validation/rollback, and `implemented_and_verified` `CompletionEvidenceReport` generation.

---

## 7. Troubleshooting

| Issue | Resolution |
| :--- | :--- |
| **`SyntaxError` on `.ts` imports** | Ensure you are using **Node.js `>= 24`** (or pass `--experimental-strip-types` explicitly). |
| **Port `5199` already in use** | Set `APEX_APP_PORT=5200` in `.env` or stop the existing Node process listening on `5199`. |
| **`Phase 4` Python validation fails** | Install the bundled Python package: `pip install -e ./harness2` and verify `python` is on `PATH`. |
| **Missing workspace folders in sidebar** | Click `+ Folder` in the composer footer or set `APEX_EXTRA_WORKSPACE_ROOTS=/path/to/projects` in `.env`. |
