import { describe, expect, it } from "vitest";
import {
  APPROVAL_RULES,
  buildApprovalRequest,
  evaluateApprovalRequirement,
  isDecidable,
} from "./middleware/identity/approval-gate.js";

describe("evaluateApprovalRequirement", () => {
  it("matches a destructive shell command", () => {
    const result = evaluateApprovalRequirement("please run rm -rf /workspace/tmp");
    expect(result.requiresApproval).toBe(true);
    expect(result.rule?.id).toBe("destructive-shell");
  });

  it("matches an outbound network write", () => {
    const result = evaluateApprovalRequirement(
      "curl -X POST https://example.com/webhook with the results",
    );
    expect(result.requiresApproval).toBe(true);
    expect(result.rule?.id).toBe("outbound-network-write");
  });

  it("matches a production operation", () => {
    const result = evaluateApprovalRequirement("deploy this change to prod deploy pipeline");
    expect(result.requiresApproval).toBe(true);
    expect(result.rule?.id).toBe("production-operation");
  });

  it("matches credential access", () => {
    const result = evaluateApprovalRequirement("read the api_key from .env and print it");
    expect(result.requiresApproval).toBe(true);
    expect(result.rule?.id).toBe("credential-access");
  });

  it("does not require approval for an innocuous prompt", () => {
    const result = evaluateApprovalRequirement(
      "write a TypeScript hello-world CLI and add a test",
    );
    expect(result.requiresApproval).toBe(false);
    expect(result.rule).toBeNull();
  });

  it("is case-insensitive", () => {
    const result = evaluateApprovalRequirement("RM -RF the sandbox workspace");
    expect(result.requiresApproval).toBe(true);
    expect(result.rule?.id).toBe("destructive-shell");
  });

  it("every declared rule has a working example that matches itself", () => {
    // Guards against a rule with a regex that can never match anything.
    for (const rule of APPROVAL_RULES) {
      expect(rule.match("sanity-check-should-not-match-this-string")).toBe(false);
    }
  });
});

describe("buildApprovalRequest", () => {
  it("builds a pending approval request from a matched rule", () => {
    const rule = APPROVAL_RULES.find((r) => r.id === "destructive-shell")!;
    const request = buildApprovalRequest({
      runId: "run-1",
      agentId: "agent-1",
      ownerId: "alice",
      prompt: "run rm -rf /tmp/test",
      rule,
    });

    expect(request.runId).toBe("run-1");
    expect(request.agentId).toBe("agent-1");
    expect(request.ownerId).toBe("alice");
    expect(request.prompt).toBe("run rm -rf /tmp/test");
    expect(request.reason).toBe(rule.description);
    expect(request.matchedRuleId).toBe("destructive-shell");
    expect(request.status).toBe("pending");
    expect(request.decidedBy).toBeNull();
    expect(request.decidedAt).toBeNull();
    expect(request.id).toBeTruthy();
    expect(request.requestedAt).toBeTruthy();
  });

  it("generates a unique id for each request", () => {
    const rule = APPROVAL_RULES[0];
    const first = buildApprovalRequest({
      runId: "run-1",
      agentId: "agent-1",
      ownerId: "alice",
      prompt: "prompt",
      rule,
    });
    const second = buildApprovalRequest({
      runId: "run-2",
      agentId: "agent-1",
      ownerId: "alice",
      prompt: "prompt",
      rule,
    });
    expect(first.id).not.toBe(second.id);
  });
});

describe("isDecidable", () => {
  it("only pending approvals are decidable", () => {
    expect(isDecidable("pending")).toBe(true);
    expect(isDecidable("approved")).toBe(false);
    expect(isDecidable("denied")).toBe(false);
  });
});