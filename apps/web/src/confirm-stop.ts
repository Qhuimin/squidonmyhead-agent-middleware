import { Agent } from "../../server/src/types.js";
import { api } from "./api.js";

export interface StopResult {
  agentId: string;
  confirmed: boolean;
  attempts: number;
  lastError: string | null;
}

const MAX_STOP_ATTEMPTS = 2;

function isStoppedStatus(agent: Agent | null | undefined): boolean {
  return agent?.status === "stopped";
}

export async function confirmStop(agentId: string): Promise<StopResult> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_STOP_ATTEMPTS; attempt += 1) {
    try {
      const result = await api.stopAgent(agentId);
      if (isStoppedStatus(result.agent)) {
        return { agentId, confirmed: true, attempts: attempt, lastError: null };
      }
      lastError = "Stop call succeeded but agent status is still " + result.agent.status;
    } catch (reason) {
      lastError = reason instanceof Error ? reason.message : String(reason);
    }
  }

  return { agentId, confirmed: false, attempts: MAX_STOP_ATTEMPTS, lastError };
}

export async function confirmStopAll(agentIds: string[]): Promise<StopResult[]> {
  return Promise.all(agentIds.map((agentId) => confirmStop(agentId)));
}
