// OpenHands & OpenCode Coding Runtime & Trajectory Condenser for Apex Harness (Section 7).
// Provides:
// 1. `WorkspaceRuntime`: project-bound file operations, surgical edits, patch diffing, checkpointing,
//    git inspection (`status`, `diff`, `branch`, `log`), and managed terminal execution.
// 2. `condenseConversationTrajectory`: OpenHands (`LLMSummarizingCondenser`) + Hermes (`ContextCompressor`)
//    head + structured summary + tail context condensation with token-watermark trigger and cooldown.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { revertTurnCheckpoint, saveTurnCheckpoint } from "../apex-llm-engine.ts";
import { runManagedCommand, type ManagedCommandResult } from "./process-manager.ts";
import { assertCanonicalWorkspacePath, resolveCanonicalWorkspaceRoot } from "./workspace-security.ts";

export interface WorkspacePatchResult {
  ok: boolean;
  path: string;
  checkpointId?: string;
  diffPreview: string;
  error?: string;
}

export interface GitWorkspaceStatus {
  branch: string;
  clean: boolean;
  changedFiles: Array<{ status: string; path: string }>;
  diffStat: string;
  recentCommits: string[];
}

export class WorkspaceRuntime {
  readonly workspaceRoot: string;
  readonly dataDir: string;

  constructor(options: { workspaceRoot: string; dataDir: string }) {
    this.workspaceRoot = resolveCanonicalWorkspaceRoot(options.workspaceRoot);
    this.dataDir = options.dataDir;
  }

  resolveSafePath(targetPath: string, allowNonExistentLeaf = false): string {
    return assertCanonicalWorkspacePath(this.workspaceRoot, targetPath, {
      allowNonExistentLeaf,
    });
  }

  readFile(
    relPath: string,
    startLine = 1,
    endLine = 250,
  ): { ok: boolean; content: string; totalLines: number; lineRange: string } {
    const abs = this.resolveSafePath(relPath, false);
    const raw = readFileSync(abs, "utf8");
    const lines = raw.split(/\r?\n/);
    const s = Math.max(1, startLine);
    const e = Math.min(lines.length, Math.max(s, endLine));
    return {
      ok: true,
      content: lines
        .slice(s - 1, e)
        .map((line, i) => `${s + i}: ${line}`)
        .join("\n"),
      totalLines: lines.length,
      lineRange: `L${s}-L${e}`,
    };
  }

  writeFile(
    relPath: string,
    content: string,
    options?: { conversationId?: string; checkpointId?: string },
  ): WorkspacePatchResult {
    const abs = this.resolveSafePath(relPath, true);
    const existed = existsSync(abs);
    const prevContent = existed ? readFileSync(abs, "utf8") : undefined;
    const checkpointId =
      options?.checkpointId || `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    saveTurnCheckpoint(this.dataDir, {
      checkpointId,
      workspaceRoot: this.workspaceRoot,
      createdAt: new Date().toISOString(),
      reverted: false,
      files: [{ fullPath: abs, existedBefore: existed, previousContent: prevContent }],
    });
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return {
      ok: true,
      path: relative(this.workspaceRoot, abs).replace(/\\/g, "/"),
      checkpointId,
      diffPreview: `+++ b/${relPath} (${content.split(/\r?\n/).length} lines)`,
    };
  }

  surgicalEdit(
    relPath: string,
    target: string,
    replacement: string,
    options?: { conversationId?: string; checkpointId?: string },
  ): WorkspacePatchResult {
    const abs = this.resolveSafePath(relPath, false);
    const raw = readFileSync(abs, "utf8");
    let updated: string | null = null;
    if (raw.includes(target)) {
      updated = raw.replace(target, replacement);
    } else {
      const normRaw = raw.replace(/\r\n/g, "\n");
      const normTarget = target.replace(/\r\n/g, "\n");
      if (normRaw.includes(normTarget)) {
        updated = normRaw.replace(normTarget, replacement.replace(/\r\n/g, "\n"));
      }
    }
    if (updated === null) {
      return {
        ok: false,
        path: relPath,
        diffPreview: "",
        error: `Target snippet not found in ${relPath}.`,
      };
    }

    const checkpointId =
      options?.checkpointId || `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    saveTurnCheckpoint(this.dataDir, {
      checkpointId,
      workspaceRoot: this.workspaceRoot,
      createdAt: new Date().toISOString(),
      reverted: false,
      files: [{ fullPath: abs, existedBefore: true, previousContent: raw }],
    });
    writeFileSync(abs, updated, "utf8");
    return {
      ok: true,
      path: relative(this.workspaceRoot, abs).replace(/\\/g, "/"),
      checkpointId,
      diffPreview: `--- a/${relPath}\n+++ b/${relPath}\n@@ replaced ${target.split(/\r?\n/).length} line(s) @@`,
    };
  }

  revertCheckpoint(checkpointId: string): { ok: boolean; restoredFiles: string[]; error?: string } {
    return revertTurnCheckpoint(this.dataDir, checkpointId);
  }

  listTree(relDir = ".", maxDepth = 3): Array<{ path: string; type: "file" | "dir"; size: number }> {
    const startAbs = this.resolveSafePath(relDir, false);
    const entries: Array<{ path: string; type: "file" | "dir"; size: number }> = [];
    const ignore = new Set([".git", "node_modules", "dist", "release", "__pycache__", ".venv"]);

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || entries.length >= 300) return;
      let items: string[] = [];
      try {
        items = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of items) {
        if (ignore.has(name)) continue;
        const full = `${dir}/${name}`;
        try {
          const st = statSync(full);
          const rel = relative(this.workspaceRoot, full).replace(/\\/g, "/");
          if (st.isDirectory()) {
            entries.push({ path: rel, type: "dir", size: 0 });
            walk(full, depth + 1);
          } else if (st.isFile()) {
            entries.push({ path: rel, type: "file", size: st.size });
          }
        } catch {
          // Ignore unreadable
        }
      }
    };
    walk(startAbs, 1);
    return entries;
  }

  async execCommand(
    command: string,
    options?: {
      mode?: "ask" | "auto" | "turbo";
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ManagedCommandResult> {
    return runManagedCommand({
      command,
      cwd: this.workspaceRoot,
      workspaceRoot: this.workspaceRoot,
      mode: options?.mode ?? "turbo",
      timeoutMs: options?.timeoutMs ?? 20_000,
      signal: options?.signal,
    });
  }

  async gitStatus(): Promise<GitWorkspaceStatus> {
    const [branchRes, statusRes, diffRes, logRes] = await Promise.all([
      this.execCommand("git rev-parse --abbrev-ref HEAD", { timeoutMs: 5000 }),
      this.execCommand("git status --porcelain", { timeoutMs: 5000 }),
      this.execCommand("git diff --stat", { timeoutMs: 5000 }),
      this.execCommand("git log --oneline -n 5", { timeoutMs: 5000 }),
    ]);

    const changedFiles = statusRes.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2).trim(),
        path: line.slice(3).trim(),
      }));

    return {
      branch: branchRes.stdout.trim() || "unknown",
      clean: changedFiles.length === 0,
      changedFiles,
      diffStat: diffRes.stdout.trim(),
      recentCommits: logRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    };
  }
}

export interface CondenseTrajectoryInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxContextTokens?: number;
  triggerRatio?: number;
  keepHeadCount?: number;
  keepTailCount?: number;
  lastCondensedAtMessageCount?: number;
  minMessagesBetweenCondensations?: number;
}

export interface CondenseTrajectoryResult {
  condensed: boolean;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  summarizedMessageCount: number;
  summaryBlock?: string;
}

export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + 16;
  }
  return Math.ceil(chars / 4);
}

/**
 * OpenHands (`LLMSummarizingCondenser`) + Hermes (`ContextCompressor`) Trajectory Condenser.
 * Preserves head (system + initial user goal), condenses middle tool/assistant turns into a
 * structured summary (preserving file paths, commands, and errors), and keeps the latest tail turns.
 */
export function condenseConversationTrajectory(
  input: CondenseTrajectoryInput,
): CondenseTrajectoryResult {
  const maxTokens = input.maxContextTokens ?? 16_000;
  const triggerRatio = input.triggerRatio ?? 0.75;
  const keepHead = input.keepHeadCount ?? 2;
  const keepTail = input.keepTailCount ?? 4;
  const cooldown = input.minMessagesBetweenCondensations ?? 4;

  const tokensBefore = estimateMessagesTokens(input.messages);
  const threshold = Math.floor(maxTokens * triggerRatio);

  if (
    tokensBefore <= threshold ||
    input.messages.length <= keepHead + keepTail ||
    (input.lastCondensedAtMessageCount !== undefined &&
      input.messages.length - input.lastCondensedAtMessageCount < cooldown)
  ) {
    return {
      condensed: false,
      messages: input.messages,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensBefore,
      summarizedMessageCount: 0,
    };
  }

  const head = input.messages.slice(0, keepHead);
  const middle = input.messages.slice(keepHead, input.messages.length - keepTail);
  const tail = input.messages.slice(input.messages.length - keepTail);

  const mentionedFiles = new Set<string>();
  const mentionedTools = new Set<string>();
  const keyDecisions: string[] = [];

  for (const msg of middle) {
    const fileMatches =
      msg.content.match(/\b[\w./-]+\.(?:ts|tsx|js|mjs|py|json|md|css|html)\b/g) ?? [];
    for (const f of fileMatches.slice(0, 12)) mentionedFiles.add(f);

    const toolMatches = msg.content.match(/"tool"\s*:\s*"([^"]+)"/g) ?? [];
    for (const tm of toolMatches) {
      const m = /"tool"\s*:\s*"([^"]+)"/.exec(tm);
      if (m?.[1]) mentionedTools.add(m[1]);
    }

    const firstLine = msg.content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 15 && !l.startsWith("{") && !l.startsWith("```"));
    if (firstLine && keyDecisions.length < 8) {
      keyDecisions.push(`[${msg.role}] ${firstLine.slice(0, 140)}`);
    }
  }

  const summaryBlock = [
    "[CONDENSED_TRAJECTORY_SUMMARY]",
    `- Condensed ${middle.length} earlier turn(s) to preserve context budget.`,
    `- Files touched/inspected in condensed turns: ${[...mentionedFiles].slice(0, 20).join(", ") || "none"}`,
    `- Tools invoked in condensed turns: ${[...mentionedTools].join(", ") || "none"}`,
    "- Key progress & observations:",
    ...keyDecisions.map((d) => `  • ${d}`),
  ].join("\n");

  const condensedMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    ...head,
    {
      role: "system",
      content: summaryBlock,
    },
    ...tail,
  ];

  return {
    condensed: true,
    messages: condensedMessages,
    estimatedTokensBefore: tokensBefore,
    estimatedTokensAfter: estimateMessagesTokens(condensedMessages),
    summarizedMessageCount: middle.length,
    summaryBlock,
  };
}
