/**
 * @file agent-policy.ts
 * @author Quek Hui Min
 * @date 2026-08-30
 * @brief Agent capability authorization and dynamic scope evaluation middleware.
 */
import { Agent, AgentScope } from "../../types.js";

// evaluate if a prompt implies terminal/shell execution commands
export function requiresCommandExecution(prompt: string): boolean {
  // matches common build, package management, terminal, or test commands
  return /\b(run|test|exec|execute|npm|pnpm|yarn|node|bash|sh|git|curl|cargo|pip|python)\b/i.test(
    prompt,
  );
}

// check if target agent has required permission scope or is revoked
export function assertAgentPermission(
  agent: Agent,
  requestedScope: AgentScope,
): void {
  if (agent.isRevoked) {
    const error = new Error(
      `Access Denied: All delegated credentials and permissions for Agent '${agent.id}' have been revoked.`,
    );
    (error as any).statusCode = 403;
    throw error;
  }

  const scopes = agent.allowedScopes || [];
  if (!scopes.includes(requestedScope)) {
    const error = new Error(
      `Access Denied: Agent '${agent.id}' lacks required permission scope '${requestedScope}'.`,
    );
    (error as any).statusCode = 403;
    throw error;
  }
}
