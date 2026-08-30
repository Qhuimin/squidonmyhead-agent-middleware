/**
 * @file agent-policy.test.ts
 * @author Quek Hui Min
 * @date 2026-08-30
 * @brief Test suite for agent capability scoping and revocation checks.
 */
import { describe, expect, it } from "vitest";
import {
  assertAgentPermission,
  requiresCommandExecution,
} from "./middleware/identity/agent-policy.js";
import type { Agent } from "./types.js";

describe("Agent Policy & Revocation Middleware", () => {
  const mockAgent: Agent = {
    id: "77777777-7777-7777-7777-777777777777",
    name: "Scoped Agent",
    description: "Scope testing",
    instructions: "Help me write code",
    status: "ready",
    ownerId: "alice",
    allowedScopes: ["fs:read", "fs:write"],
    isRevoked: false,
    workspacePath: "/tmp/mock",
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("permits allowed scopes", () => {
    expect(() => assertAgentPermission(mockAgent, "fs:read")).not.toThrow();
    expect(() => assertAgentPermission(mockAgent, "fs:write")).not.toThrow();
  });

  it("throws 403 for ungranted scopes", () => {
    try {
      assertAgentPermission(mockAgent, "cmd:exec");
      expect.fail("Expected permission check to throw");
    } catch (error: any) {
      expect(error.statusCode).toBe(403);
      expect(error.message).toContain("cmd:exec");
    }
  });

  it("throws 403 when agent is revoked regardless of scopes", () => {
    const revokedAgent: Agent = { ...mockAgent, isRevoked: true };
    try {
      assertAgentPermission(revokedAgent, "fs:read");
      expect.fail("Expected permission check to throw");
    } catch (error: any) {
      expect(error.statusCode).toBe(403);
      expect(error.message).toContain("revoked");
    }
  });

  it("accurately detects command execution prompts", () => {
    expect(requiresCommandExecution("Please run npm test")).toBe(true);
    expect(requiresCommandExecution("Execute the bash build script")).toBe(
      true,
    );
    expect(requiresCommandExecution("Summarize what this document says")).toBe(
      false,
    );
  });
});
