// Authoritative Shared Contracts for Apex Harness IDE, Multi-Agent DAG Orchestrator,
// Execution Lifecycle Manager, Provider Registry, and Evidence-Based Completion Reporting.

export type ExecutionState =
  | "queued"
  | "planning"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "blocked";

export type CompletionStatus =
  | "implemented_and_verified"
  | "implemented_not_verified"
  | "partially_completed"
  | "blocked"
  | "failed"
  | "skipped";

export type AgentOfficeRole =
  | "Coordinator"
  | "Scout"
  | "Architect"
  | "Builder"
  | "Critic"
  | "Verifier";

export type EngineeringRole10 =
  | "main_planning"
  | "repo_exploration"
  | "architecture"
  | "frontend_impl"
  | "backend_impl"
  | "testing_verification"
  | "code_review"
  | "security_review"
  | "documentation"
  | "final_verification";

export type ProviderProtocol =
  | "omniroute"
  | "freellmapi"
  | "openai-compat"
  | "anthropic-compat"
  | "gemini"
  | "openrouter"
  | "local-ollama"
  | "cli";

export interface ProviderConfigEntry {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeyEnv?: string;
  hasStoredSecret: boolean;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  defaultModels: string[];
  headers?: Record<string, string>;
  updatedAt: string;
}

export interface RoleRoutingAssignment {
  role: EngineeringRole10;
  officeRole: AgentOfficeRole;
  description: string;
  preferredModelId: string;
  fallbackModelIds: string[];
  requiredCapabilities: {
    tools?: boolean;
    vision?: boolean;
    minContextWindow?: number;
    unfiltered?: boolean;
  };
}

export interface AgentExecutionNode {
  id: string;
  role: AgentOfficeRole;
  engineeringRole: EngineeringRole10;
  assignedTask: string;
  assignedModelId: string;
  actualModelUsed?: string;
  capabilities: string[];
  contextBudgetTokens: number;
  mountedSkills: string[];
  toolPermissions: Array<"read" | "write" | "command" | "mcp" | "ptc">;
  state: ExecutionState;
  dependsOn: string[];
  parentTaskId?: string;
  inputSummary?: string;
  outputSummary?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  verificationPassed?: boolean;
}

export interface ExecutedCommandEvidence {
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  stdoutPreview: string;
  stderrPreview: string;
}

export type PostImplReviewOutcome =
  | "approve"
  | "request_changes"
  | "escalate"
  | "decline"
  | "unavailable";

export interface PostImplReviewReport {
  outcome: PostImplReviewOutcome;
  reviewerAvailable: boolean;
  reviewerModel: string;
  comprehensionParaphrase: string;
  score: number;
  correctionCyclesRun: number;
  findings: Array<{
    id: string;
    severity: "BLOCKER" | "MAJOR" | "NIT";
    file?: string;
    description: string;
    resolution: "PROPOSE_FIX" | "CONTEST" | "ESCALATE" | "DECLINE";
  }>;
  summary: string;
}

export interface CompletionEvidenceReport {
  executionId: string;
  status: CompletionStatus;
  originalRequirement: string;
  executionPlanSummary: string;
  subtasks: Array<{
    id: string;
    role: AgentOfficeRole;
    engineeringRole: EngineeringRole10;
    task: string;
    state: ExecutionState;
    modelUsed: string;
    durationMs: number;
  }>;
  agentsInvolved: AgentOfficeRole[];
  modelsInvolved: string[];
  skillsMounted: Array<{ name: string; ecosystem: string; tokenEstimate: number }>;
  toolsInvoked: Array<{ tool: string; target?: string; status: "done" | "error"; durationMs: number }>;
  filesInspected: string[];
  filesCreated: string[];
  filesModified: string[];
  gitDiffSummary: string;
  commandsExecuted: ExecutedCommandEvidence[];
  verificationResults: {
    ranVerificationCommands: boolean;
    testsPassed: boolean | null;
    buildPassed: boolean | null;
    lintPassed: boolean | null;
    details: string[];
  };
  egmReview: PostImplReviewReport;
  remainingIssues: string[];
  generatedAt: string;
}

export interface PendingApprovalRequest {
  approvalId: string;
  executionId: string;
  tool: string;
  commandOrPath: string;
  reason: string;
  requestedAt: string;
}

export interface ExecutionRecord {
  executionId: string;
  conversationId: string;
  projectId: string;
  workspaceRoot: string;
  requirement: string;
  state: ExecutionState;
  mode: "turbo" | "auto_edit" | "ask";
  effort: "high" | "medium" | "low";
  selectedModelId: string;
  subtasks: AgentExecutionNode[];
  checkpointId?: string;
  pendingApproval?: PendingApprovalRequest;
  completionReport?: CompletionEvidenceReport;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
