/**
 * @file user-ownership.ts
 * @author Quek Hui Min
 * @date 2026-08-29
 * @brief User identity extraction and agent ownership authorization middleware.
 */
import { FastifyRequest, FastifyReply } from "fastify";
import { Agent } from "../../types.js";

// define standard header name for mock authentication
export const USER_ID_HEADER = "x-user-id";
export const DEFAULT_USER_ID = "alice";

// interface representing the authenticated human user context
export interface UserContext {
  userId: string;
  roles?: string[];
}

// extract user identifier from incoming request headers or fallback to default user
export function extractUserContext(request: FastifyRequest): UserContext {
  const headerValue = request.headers[USER_ID_HEADER];

  const userId =
    (Array.isArray(headerValue) ? headerValue[0] : headerValue) ||
    DEFAULT_USER_ID;

  return {
    userId: userId.trim().toLowerCase(),
    roles: ["developer"],
  };
}

// check if target agent belongs to the current user
export function isAgentOwner(agent: Agent, userId: string): boolean {
  if (!agent) {
    return false;
  }

  // legacy agents without ownerId default to true
  if (!agent.ownerId) {
    return true;
  }

  return agent.ownerId === userId;
}

// verify ownership and throw 403 forbidden error if check fails
export function assertAgentOwnership(agent: Agent, userId: string): void {
  if (!isAgentOwner(agent, userId)) {
    const error = new Error(
      `Access Denied: User '${userId}' does not own Agent '${agent.id}'`,
    );
    (error as any).statusCode = 403;
    throw error;
  }
}

// filter list of agents so users only see agents they own
export function filterAgentsByOwner(agents: Agent[], userId: string): Agent[] {
  return agents.filter((agent) => isAgentOwner(agent, userId));
}

// attach user context directly to the fastify request object
export async function userContextPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const user = extractUserContext(request);
  (request as any).user = user;
}
