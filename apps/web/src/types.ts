export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "pending_approval" | "running" | "completed" | "failed" | "cancelled" | "denied";
export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
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