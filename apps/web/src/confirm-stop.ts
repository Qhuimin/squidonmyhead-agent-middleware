import { api } from "./api.js";
import type { Agent } from "./types.js";

export interface ConfirmStopResult {
  confirmed: boolean;
  attempts: number;
  lastError: string | null;
}

export async function confirmStop(
  agentId: string,
  maxAttempts = 2
): Promise<ConfirmStopResult> {
  let attempts = 0;
  let lastError: string | null = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const response = await api.stopAgent(agentId);
      const status = response.agent.status;

      if (status === "stopped") {
        return {
          confirmed: true,
          attempts,
          lastError: null,
        };
      } else {
        lastError = `Agent status is '${status}'`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    confirmed: false,
    attempts,
    lastError,
  };
}

export async function confirmStopAll(
  agentIds: string[]
): Promise<ConfirmStopResult[]> {
  const results: ConfirmStopResult[] = [];
  
  // Process sequentially to keep mock queues predictable and isolated per agent
  for (const id of agentIds) {
    results.push(await confirmStop(id));
  }
  
  return results;
}