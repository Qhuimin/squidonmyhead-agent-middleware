export type AgentScope = "fs:read" | "fs:write" | "cmd:exec" | "net:outbound";

export const DEFAULT_AGENT_SCOPES: AgentScope[] = [
  "fs:read",
  "fs:write",
  "cmd:exec",
];

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "pending_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "denied";
export type MessageRole = "user" | "assistant";
export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  ownerId?: string;
  allowedScopes: AgentScope[];
  isRevoked?: boolean;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  ownerId?: string | undefined;
  allowedScopes?: AgentScope[] | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  allowedScopes?: AgentScope[] | undefined;
  isRevoked?: boolean | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container" | string;
  containerEngine: string | null;
  runtime: string;
}

export type AuditEventType =
  | "secret_detected_blocked"
  | "output_secret_redacted"
  | "run_stopped_timeout"
  | "run_stopped_token_budget"
  | "run_stopped_manual"
  | "run_stop_unconfirmed"
  | "file_upload_blocked"
  | "file_upload_allowed"
  | "global_budget_exceeded_blocked"
  | "global_budget_exceeded_override";

export interface AuditEvent {
  type: AuditEventType;
  agentId: string | null;
  timestamp: string;
  detail: Record<string, string | number | boolean | null>;
}
export interface ApprovalRequest {
  id: string;
  runId: string;
  agentId: string;
  ownerId: string;
  prompt: string;
  reason: string;
  matchedRuleId: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}
