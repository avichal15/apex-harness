// P0 Asynchronous, Observable Process-Management Layer for Apex Harness.
// Replaces unbounded synchronous `execSync` with:
// - Execution deadlines (timeoutMs)
// - AbortSignal cancellation
// - Full process-tree termination (`taskkill /PID <pid> /T /F` on Windows; `-pid` group kill on POSIX)
// - Output-size limits (stdout/stderr byte caps)
// - Controlled canonical working directories
// - Environment isolation (redacting secret keys from child environments)
// - Exit-code capture and permission policy gates (`turbo`, `auto_edit`, `ask`)

import { spawn, spawnSync } from "node:child_process";
import { assertCanonicalWorkspacePath } from "./workspace-security.ts";

export interface ManagedCommandOptions {
  command: string;
  cwd?: string;
  workspaceRoot: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  mode?: "turbo" | "auto_edit" | "ask";
  extraEnv?: Record<string, string>;
  onApprovalRequired?: (command: string, reason: string) => Promise<boolean>;
  onOutputChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface ManagedCommandResult {
  ok: boolean;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  blockedByPolicy?: boolean;
  policyReason?: string;
  pid?: number;
}

const NEVER_ALLOWED_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "Root filesystem recursive deletion", regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$)/i },
  { label: "Disk format command", regex: /\b(?:format\s+[a-zA-Z]:|mkfs\.[a-z0-9]+)\b/i },
  { label: "Windows drive root wipe", regex: /\b(?:del|rd|rmdir)\s+\/[sq]+\s+[a-zA-Z]:\\\s*$/i },
  { label: "Fork bomb", regex: /:\(\)\s*\{\s*:\|:&\s*\};:/ },
];

const SENSITIVE_COMMAND_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "File deletion or move", regex: /\b(?:rm|del|rmdir|Remove-Item|mv|Move-Item)\b/i },
  { label: "Git history or remote mutation", regex: /\bgit\s+(?:push|reset|clean|rebase|checkout\s+--|branch\s+-D)\b/i },
  { label: "Package installation or script execution", regex: /\b(?:npm|pnpm|yarn|pip|cargo)\s+(?:install|add|remove|publish)\b/i },
  { label: "Network transfer or external process", regex: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|powershell|pwsh)\b/i },
];

const SECRET_ENV_KEY_PATTERNS = [
  /API_KEY$/i,
  /SECRET/i,
  /TOKEN$/i,
  /PASSWORD/i,
  /^AWS_/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^GEMINI_API_KEY$/i,
  /^OPENROUTER_/i,
  /^APEX_SESSION_TOKEN$/i,
];

/**
 * Builds a sanitized environment dictionary for child processes so host secrets
 * are not leaked to arbitrary shell commands.
 */
export function buildIsolatedEnvironment(
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SECRET_ENV_KEY_PATTERNS.some((rx) => rx.test(k))) {
      continue;
    }
    clean[k] = v;
  }
  clean.CI = "true";
  clean.NO_COLOR = "1";
  for (const [k, v] of Object.entries(extraEnv)) {
    clean[k] = v;
  }
  return clean;
}

/**
 * Terminates a process and all of its descendant child processes across Windows and POSIX.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 4_000,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // Process already exited
  }
}

export function classifyCommandPolicy(
  command: string,
  mode: "turbo" | "auto_edit" | "ask" = "turbo",
): {
  decision: "allow" | "require_approval" | "deny";
  reason?: string;
} {
  const trimmed = command.trim();
  if (!trimmed) {
    return { decision: "deny", reason: "Empty command" };
  }

  for (const rule of NEVER_ALLOWED_PATTERNS) {
    if (rule.regex.test(trimmed)) {
      return {
        decision: "deny",
        reason: `Blocked by safety floor: ${rule.label}`,
      };
    }
  }

  if (mode === "ask") {
    return {
      decision: "require_approval",
      reason: "Execution mode is set to 'ask' (requires explicit approval before running commands).",
    };
  }

  if (mode === "auto_edit") {
    for (const sens of SENSITIVE_COMMAND_PATTERNS) {
      if (sens.regex.test(trimmed)) {
        return {
          decision: "require_approval",
          reason: `Command matches sensitive operation policy (${sens.label}) in 'auto_edit' mode.`,
        };
      }
    }
  }

  return { decision: "allow" };
}

/**
 * Executes a shell command asynchronously inside a canonical workspace boundary
 * with timeout, AbortSignal cancellation, process-tree termination, output caps,
 * and permission policy enforcement.
 */
export async function runManagedCommand(
  options: ManagedCommandOptions,
): Promise<ManagedCommandResult> {
  const t0 = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? 262_144; // 256 KiB default cap
  const timeoutMs = options.timeoutMs ?? 20_000;
  const mode = options.mode ?? "turbo";

  const rootForCwd = options.workspaceRoot || options.cwd || process.cwd();
  const canonicalCwd = assertCanonicalWorkspacePath(
    rootForCwd,
    options.cwd ?? ".",
    { operation: "run_command_cwd" },
  );

  if (options.signal?.aborted) {
    return {
      ok: false,
      command: options.command,
      cwd: canonicalCwd,
      exitCode: null,
      stdout: "",
      stderr: "Command cancelled before start.",
      combinedOutput: "Command cancelled before start.",
      durationMs: 0,
      timedOut: false,
      cancelled: true,
      outputTruncated: false,
    };
  }

  const policy = classifyCommandPolicy(options.command, mode);
  if (policy.decision === "deny") {
    return {
      ok: false,
      command: options.command,
      cwd: canonicalCwd,
      exitCode: 126,
      stdout: "",
      stderr: policy.reason ?? "Command denied by security policy.",
      combinedOutput: policy.reason ?? "Command denied by security policy.",
      durationMs: Date.now() - t0,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      blockedByPolicy: true,
      policyReason: policy.reason,
    };
  }

  if (policy.decision === "require_approval") {
    if (!options.onApprovalRequired) {
      return {
        ok: false,
        command: options.command,
        cwd: canonicalCwd,
        exitCode: 126,
        stdout: "",
        stderr: policy.reason ?? "Approval required to execute command.",
        combinedOutput: policy.reason ?? "Approval required to execute command.",
        durationMs: Date.now() - t0,
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        blockedByPolicy: true,
        policyReason: policy.reason,
      };
    }
    const approved = await options.onApprovalRequired(
      options.command,
      policy.reason ?? "Approval required",
    );
    if (!approved) {
      return {
        ok: false,
        command: options.command,
        cwd: canonicalCwd,
        exitCode: 126,
        stdout: "",
        stderr: "Command rejected by user approval gate.",
        combinedOutput: "Command rejected by user approval gate.",
        durationMs: Date.now() - t0,
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        blockedByPolicy: true,
        policyReason: "User rejected command approval.",
      };
    }
  }

  return new Promise<ManagedCommandResult>((resolvePromise) => {
    const isWin = process.platform === "win32";
    const shellBin = isWin ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", options.command] : ["-c", options.command];

    const child = spawn(shellBin, shellArgs, {
      cwd: canonicalCwd,
      env: buildIsolatedEnvironment(options.extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWin,
    });

    const pid = child.pid;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (exitCode: number | null, errorMsg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");
      const stderr = errorMsg ? `${stderrRaw}\n${errorMsg}`.trim() : stderrRaw;
      const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();

      resolvePromise({
        ok: exitCode === 0 && !timedOut && !cancelled,
        command: options.command,
        cwd: canonicalCwd,
        exitCode,
        stdout,
        stderr,
        combinedOutput,
        durationMs: Date.now() - t0,
        timedOut,
        cancelled,
        outputTruncated,
        pid,
      });
    };

    const onAbort = () => {
      cancelled = true;
      killProcessTree(pid);
      finish(null, "Command cancelled via AbortSignal.");
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(pid);
      finish(null, `Command timed out after ${timeoutMs}ms.`);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stdoutBytes;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
        if (chunk.length > remaining) outputTruncated = true;
        if (options.onOutputChunk) {
          options.onOutputChunk("stdout", slice.toString("utf8"));
        }
      } else {
        outputTruncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stderrBytes;
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stderrChunks.push(slice);
        stderrBytes += slice.length;
        if (chunk.length > remaining) outputTruncated = true;
        if (options.onOutputChunk) {
          options.onOutputChunk("stderr", slice.toString("utf8"));
        }
      } else {
        outputTruncated = true;
      }
    });

    child.on("error", (err) => {
      finish(1, err.message);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
