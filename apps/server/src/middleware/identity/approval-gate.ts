/**
 * @file approval-gate.ts
 * @author Jeanette Ong
 * @date 2026-08-31
 * @brief Policy checks that require human approval before a Run is
 * dispatched to the Agent Runtime. Enforced in AgentService.sendMessage,
 * not in the UI.
 */
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalStatus } from "../../types.js";

export interface ApprovalRule {
  id: string;
  description: string;
  match: (prompt: string) => boolean;
}

// Keyword/pattern heuristics standing in for a real risk classifier.
// Each rule should be specific enough to demo both a hit and a miss.
export const APPROVAL_RULES: ApprovalRule[] = [
  {
    id: "destructive-shell",
    description: "Prompt requests a destructive shell command",
    match: (p) => /\brm\s+-rf\b|\bDROP\s+TABLE\b|\bdel\s+\/[sf]\b/i.test(p),
  },
  {
    id: "outbound-network-write",
    description: "Prompt requests an outbound network write (curl/POST/webhook)",
    match: (p) => /\bcurl\b.*(-X\s*POST|--data)|\bwebhook\b/i.test(p),
  },
  {
    id: "production-operation",
    description: "Prompt references a production environment or deployment",
    match: (p) => /\bproduction\b|\bprod\b\s+(deploy|release|migrate)/i.test(p),
  },
  {
    id: "credential-access",
    description: "Prompt references credentials or secret material",
    match: (p) => /\bapi[_\s-]?key\b|\bpassword\b|\bsecret\b|\.env\b/i.test(p),
  },
];

export interface GateDecision {
  requiresApproval: boolean;
  rule: ApprovalRule | null;
}

// Evaluate a prompt against the rule set. First match wins.
export function evaluateApprovalRequirement(prompt: string): GateDecision {
  const rule = APPROVAL_RULES.find((r) => r.match(prompt)) ?? null;
  return { requiresApproval: rule !== null, rule };
}

export function buildApprovalRequest(params: {
  runId: string;
  agentId: string;
  ownerId: string;
  prompt: string;
  rule: ApprovalRule;
}): ApprovalRequest {
  return {
    id: randomUUID(),
    runId: params.runId,
    agentId: params.agentId,
    ownerId: params.ownerId,
    prompt: params.prompt,
    reason: params.rule.description,
    matchedRuleId: params.rule.id,
    status: "pending",
    requestedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
  };
}

export function isDecidable(status: ApprovalStatus): boolean {
  return status === "pending";
}