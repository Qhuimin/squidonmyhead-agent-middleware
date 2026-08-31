export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "pending_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "denied";

export type ApprovalStatus = "pending" | "approved" | "denied";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  ownerId?: string;
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

export interface ApprovalRequest {
  id: string;
  runId: string;
  agentId: string;
  ownerId: string;
  prompt: string;          // stored for reviewer context; truncate if you redact
  reason: string;           // which rule matched, human-readable
  matchedRuleId: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  approvals: ApprovalRequest[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  ownerId?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
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

export type AuditEventType =
  | "secret_detected_blocked"
  | "run_stopped_timeout"
  | "run_stopped_token_budget"
  | "run_stopped_manual"
  | "run_stop_unconfirmed";

export interface AuditEvent {
  type: AuditEventType;
  agentId: string | null;
  timestamp: string;
  detail: Record<string, string | number | boolean | null>;
}
