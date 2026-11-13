// P0 Unified Task Execution Lifecycle Manager for Apex Harness.
// Assigns every user request a persistent execution ID, tracks explicit execution states
// (`queued`, `planning`, `running`, `waiting_for_approval`, `paused`, `cancelling`,
// `cancelled`, `completed`, `failed`, `blocked`), manages live AbortControllers and pause/approval
// gates, and persists complete execution history to `<dataDir>/apex-executions.json`.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  AgentExecutionNode,
  CompletionEvidenceReport,
  ExecutionRecord,
  ExecutionState,
  PendingApprovalRequest,
} from "../../shared/apex-contracts.ts";

interface LiveExecutionHandle {
  executionId: string;
  controller: AbortController;
  subtaskControllers: Map<string, AbortController>;
  paused: boolean;
  pauseResolvers: Array<() => void>;
  approvalResolvers: Map<string, (approved: boolean) => void>;
}

const VALID_STATE_TRANSITIONS: Record<ExecutionState, ReadonlyArray<ExecutionState>> = {
  queued: ["planning", "running", "cancelling", "cancelled", "failed", "blocked"],
  planning: ["running", "waiting_for_approval", "paused", "cancelling", "cancelled", "failed", "blocked"],
  running: [
    "waiting_for_approval",
    "paused",
    "cancelling",
    "cancelled",
    "completed",
    "failed",
    "blocked",
  ],
  waiting_for_approval: ["running", "cancelling", "cancelled", "failed", "blocked"],
  paused: ["running", "cancelling", "cancelled", "failed"],
  cancelling: ["cancelled", "failed"],
  cancelled: ["queued", "running"], // Allows explicit retry/re-run
  completed: ["queued", "running"], // Allows explicit re-run
  failed: ["queued", "running"], // Allows explicit retry
  blocked: ["queued", "running", "cancelled"],
};

export class TaskExecutionManager {
  private readonly dataDir: string;
  private readonly storePath: string;
  private records = new Map<string, ExecutionRecord>();
  private liveHandles = new Map<string, LiveExecutionHandle>();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.storePath = join(this.dataDir, "apex-executions.json");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8")) as ExecutionRecord[];
      if (Array.isArray(raw)) {
        for (const rec of raw) {
          // Any execution left in a transient state from a previous process crash is marked failed/interrupted
          if (
            rec.state === "queued" ||
            rec.state === "planning" ||
            rec.state === "running" ||
            rec.state === "cancelling"
          ) {
            rec.state = "failed";
            rec.error = "Execution interrupted by server restart";
          }
          this.records.set(rec.executionId, rec);
        }
      }
    } catch {
      // Ignore corrupted store
    }
  }

  private saveToDisk(): void {
    mkdirSync(dirname(this.storePath), { recursive: true, mode: 0o700 });
    const all = [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
    writeFileSync(this.storePath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  }

  public createExecution(input: {
    conversationId: string;
    projectId: string;
    workspaceRoot: string;
    requirement: string;
    mode?: "turbo" | "auto_edit" | "ask";
    effort?: "high" | "medium" | "low";
    selectedModelId?: string;
    subtasks?: AgentExecutionNode[];
  }): { record: ExecutionRecord; signal: AbortSignal } {
    const now = new Date().toISOString();
    const executionId = `exec-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const record: ExecutionRecord = {
      executionId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      workspaceRoot: resolve(input.workspaceRoot),
      requirement: input.requirement,
      state: "queued",
      mode: input.mode ?? "turbo",
      effort: input.effort ?? "high",
      selectedModelId: input.selectedModelId ?? "auto",
      subtasks: input.subtasks ?? [],
      createdAt: now,
      updatedAt: now,
    };

    const controller = new AbortController();
    this.liveHandles.set(executionId, {
      executionId,
      controller,
      subtaskControllers: new Map(),
      paused: false,
      pauseResolvers: [],
      approvalResolvers: new Map(),
    });

    this.records.set(executionId, record);
    this.saveToDisk();
    return { record, signal: controller.signal };
  }

  public getSignal(executionId: string): AbortSignal | undefined {
    return this.liveHandles.get(executionId)?.controller.signal;
  }

  public createSubtaskSignal(executionId: string, subtaskId: string): AbortSignal {
    const handle = this.liveHandles.get(executionId);
    const subController = new AbortController();
    if (!handle) return subController.signal;

    if (handle.controller.signal.aborted) {
      subController.abort();
    } else {
      handle.controller.signal.addEventListener("abort", () => subController.abort(), { once: true });
    }
    handle.subtaskControllers.set(subtaskId, subController);
    return subController.signal;
  }

  public transitionState(
    executionId: string,
    nextState: ExecutionState,
    patch: Partial<Pick<ExecutionRecord, "subtasks" | "checkpointId" | "completionReport" | "error" | "pendingApproval">> = {},
  ): ExecutionRecord {
    const rec = this.records.get(executionId);
    if (!rec) {
      throw new Error(`Execution '${executionId}' not found`);
    }

    const allowed = VALID_STATE_TRANSITIONS[rec.state] ?? [];
    if (rec.state !== nextState && !allowed.includes(nextState)) {
      throw new Error(`Invalid execution state transition: ${rec.state} -> ${nextState}`);
    }

    rec.state = nextState;
    rec.updatedAt = new Date().toISOString();
    if (patch.subtasks !== undefined) rec.subtasks = patch.subtasks;
    if (patch.checkpointId !== undefined) rec.checkpointId = patch.checkpointId;
    if (patch.completionReport !== undefined) rec.completionReport = patch.completionReport;
    if (patch.error !== undefined) rec.error = patch.error;
    if (patch.pendingApproval !== undefined) rec.pendingApproval = patch.pendingApproval;

    if (nextState === "completed" || nextState === "cancelled" || nextState === "failed") {
      rec.completedAt = rec.updatedAt;
      rec.pendingApproval = undefined;
    }

    this.records.set(executionId, rec);
    this.saveToDisk();
    return rec;
  }

  public updateSubtask(
    executionId: string,
    subtaskId: string,
    patch: Partial<AgentExecutionNode>,
  ): AgentExecutionNode | undefined {
    const rec = this.records.get(executionId);
    if (!rec) return undefined;
    const node = rec.subtasks.find((s) => s.id === subtaskId);
    if (!node) return undefined;
    Object.assign(node, patch);
    rec.updatedAt = new Date().toISOString();
    this.saveToDisk();
    return node;
  }

  /**
   * Cancels an active execution and propagates AbortSignal to all in-flight provider HTTP calls,
   * agent subtasks, child processes/shell commands, MCP calls, and PTC workers.
   */
  public cancelExecution(executionId: string, reason = "Cancelled by user"): ExecutionRecord {
    const rec = this.records.get(executionId);
    if (!rec) {
      throw new Error(`Execution '${executionId}' not found`);
    }

    if (rec.state === "completed" || rec.state === "cancelled") {
      return rec;
    }

    this.transitionState(executionId, "cancelling", { error: reason });

    const handle = this.liveHandles.get(executionId);
    if (handle) {
      handle.controller.abort(new Error(reason));
      for (const subCtrl of handle.subtaskControllers.values()) {
        subCtrl.abort(new Error(reason));
      }
      // Unblock any paused or waiting-for-approval promises so the execution loop exits immediately
      handle.paused = false;
      for (const resolvePause of handle.pauseResolvers.splice(0)) {
        resolvePause();
      }
      for (const resolveApproval of handle.approvalResolvers.values()) {
        resolveApproval(false);
      }
      handle.approvalResolvers.clear();
    }

    for (const sub of rec.subtasks) {
      if (sub.state === "running" || sub.state === "queued" || sub.state === "planning" || sub.state === "paused") {
        sub.state = "cancelled";
        sub.completedAt = new Date().toISOString();
      }
    }

    return this.transitionState(executionId, "cancelled", { error: reason });
  }

  public pauseExecution(executionId: string): ExecutionRecord {
    const rec = this.records.get(executionId);
    if (!rec) throw new Error(`Execution '${executionId}' not found`);
    const handle = this.liveHandles.get(executionId);
    if (handle) {
      handle.paused = true;
    }
    return this.transitionState(executionId, "paused");
  }

  public resumeExecution(executionId: string): ExecutionRecord {
    const rec = this.records.get(executionId);
    if (!rec) throw new Error(`Execution '${executionId}' not found`);
    const handle = this.liveHandles.get(executionId);
    if (handle) {
      handle.paused = false;
      for (const resolvePause of handle.pauseResolvers.splice(0)) {
        resolvePause();
      }
    }
    return this.transitionState(executionId, "running");
  }

  /**
   * Awaits if the execution is currently paused, or resolves immediately if running/aborted.
   */
  public async waitIfPaused(executionId: string): Promise<void> {
    const handle = this.liveHandles.get(executionId);
    if (!handle || !handle.paused) return;
    await new Promise<void>((resolvePromise) => {
      handle.pauseResolvers.push(resolvePromise);
    });
  }

  /**
   * Pauses the execution in `waiting_for_approval` state until the user approves or denies.
   */
  public async requestUserApproval(
    executionId: string,
    info: { tool: string; commandOrPath: string; reason: string },
  ): Promise<boolean> {
    const rec = this.records.get(executionId);
    const handle = this.liveHandles.get(executionId);
    if (!rec || !handle) return false;
    if (handle.controller.signal.aborted) return false;

    const approvalId = `appr-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const pending: PendingApprovalRequest = {
      approvalId,
      executionId,
      tool: info.tool,
      commandOrPath: info.commandOrPath,
      reason: info.reason,
      requestedAt: new Date().toISOString(),
    };

    this.transitionState(executionId, "waiting_for_approval", { pendingApproval: pending });

    return new Promise<boolean>((resolvePromise) => {
      handle.approvalResolvers.set(approvalId, (approved: boolean) => {
        const currentRec = this.records.get(executionId);
        if (currentRec && currentRec.state === "waiting_for_approval") {
          this.transitionState(executionId, approved ? "running" : "blocked", {
            pendingApproval: undefined,
            ...(approved ? {} : { error: `Approval denied for ${info.tool}: ${info.commandOrPath}` }),
          });
        }
        resolvePromise(approved);
      });
    });
  }

  public resolveApproval(executionId: string, approved: boolean): ExecutionRecord {
    const rec = this.records.get(executionId);
    if (!rec) throw new Error(`Execution '${executionId}' not found`);
    const handle = this.liveHandles.get(executionId);
    if (handle && rec.pendingApproval) {
      const resolver = handle.approvalResolvers.get(rec.pendingApproval.approvalId);
      if (resolver) {
        handle.approvalResolvers.delete(rec.pendingApproval.approvalId);
        resolver(approved);
      }
    }
    return this.records.get(executionId)!;
  }

  public getExecution(executionId: string): ExecutionRecord | undefined {
    return this.records.get(executionId);
  }

  public listExecutions(filter?: { conversationId?: string; projectId?: string }): ExecutionRecord[] {
    let list = [...this.records.values()];
    if (filter?.conversationId) {
      list = list.filter((r) => r.conversationId === filter.conversationId);
    }
    if (filter?.projectId) {
      list = list.filter((r) => r.projectId === filter.projectId);
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
