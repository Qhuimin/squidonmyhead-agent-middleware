import { describe, it, expect, vi, beforeEach } from "vitest";
import { confirmStop, confirmStopAll } from "./confirm-stop.js";
import { api } from "./api.js";
import type { Agent } from "./types.js";

vi.mock("./api.js", () => ({
  api: {
    stopAgent: vi.fn(),
  },
}));

function makeAgent(status: Agent["status"]): { agent: Agent } {
  return {
    agent: {
      id: "agent-1",
      name: "Test Agent",
      description: "",
      instructions: "",
      status,
      workspacePath: "/workspace/agent-1",
      codexThreadId: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Agent,
  };
}

describe("confirmStop", () => {
  beforeEach(() => {
    vi.mocked(api.stopAgent).mockReset();
  });

  it("confirms on the first attempt when the agent reports stopped", async () => {
    vi.mocked(api.stopAgent).mockResolvedValueOnce(makeAgent("stopped"));

    const result = await confirmStop("agent-1");

    expect(result.confirmed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBeNull();
    expect(api.stopAgent).toHaveBeenCalledTimes(1);
  });

  it("retries once if the first call succeeds but status is not yet stopped", async () => {
    vi.mocked(api.stopAgent)
      .mockResolvedValueOnce(makeAgent("busy"))
      .mockResolvedValueOnce(makeAgent("stopped"));

    const result = await confirmStop("agent-1");

    expect(result.confirmed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(api.stopAgent).toHaveBeenCalledTimes(2);
  });

  it("retries once on a thrown error, then succeeds", async () => {
    vi.mocked(api.stopAgent)
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(makeAgent("stopped"));

    const result = await confirmStop("agent-1");

    expect(result.confirmed).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("gives up after the max attempts and reports unconfirmed", async () => {
    vi.mocked(api.stopAgent)
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("still failing"));

    const result = await confirmStop("agent-1");

    expect(result.confirmed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.lastError).toBe("still failing");
  });

  it("reports unconfirmed if status never becomes stopped, with no thrown error", async () => {
    vi.mocked(api.stopAgent)
      .mockResolvedValueOnce(makeAgent("busy"))
      .mockResolvedValueOnce(makeAgent("error"));

    const result = await confirmStop("agent-1");

    expect(result.confirmed).toBe(false);
    expect(result.lastError).toContain("error");
  });
});

describe("confirmStopAll", () => {
  beforeEach(() => {
    vi.mocked(api.stopAgent).mockReset();
  });

  it("runs confirmStop independently for each agent id", async () => {
    vi.mocked(api.stopAgent)
      .mockResolvedValueOnce(makeAgent("stopped"))
      .mockResolvedValueOnce(makeAgent("stopped"));

    const results = await confirmStopAll(["agent-1", "agent-2"]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.confirmed)).toBe(true);
  });

  it("does not let one agent's failure block another's success", async () => {
    vi.mocked(api.stopAgent)
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail again"))
      .mockResolvedValueOnce(makeAgent("stopped"));

    const results = await confirmStopAll(["agent-1", "agent-2"]);

    expect(results[0].confirmed).toBe(false);
    expect(results[1].confirmed).toBe(true);
  });
});
