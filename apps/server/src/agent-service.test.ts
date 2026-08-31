import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Approval gate", () => {
  it("parks a risky prompt as pending_approval without dispatching to the runner", async () => {
    let runCalled = false;
    const runner: AgentRunner = {
      run: async () => {
        runCalled = true;
        return { output: "should not run", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Gated" });

    const { run, approval } = await service.sendMessage(
      agent.id,
      "run rm -rf /workspace/tmp",
    );

    expect(run.status).toBe("pending_approval");
    expect(approval).toBeDefined();
    expect(approval?.status).toBe("pending");
    expect(approval?.matchedRuleId).toBe("destructive-shell");
    expect(runCalled).toBe(false);
    // Agent must not be marked busy while waiting on a human decision.
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("does not gate an ordinary prompt", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Ungated" });

    const { run, approval } = await service.sendMessage(agent.id, "write hello world");

    expect(run.status).toBe("queued");
    expect(approval).toBeUndefined();
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("denying an approval stops the run without ever dispatching to the runner", async () => {
    let runCalled = false;
    const runner: AgentRunner = {
      run: async () => {
        runCalled = true;
        return { output: "should not run", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Denied" });
    const { run, approval } = await service.sendMessage(agent.id, "run rm -rf /tmp");

    const { approval: decided } = await service.decideApproval(
      approval!.id,
      "denied",
      "alice",
    );

    expect(decided.status).toBe("denied");
    expect(decided.decidedBy).toBe("alice");
    expect(service.getRun(run.id).status).toBe("denied");
    expect(service.getRun(run.id).error).toContain("alice");
    expect(runCalled).toBe(false);
  });

  it("approving an approval dispatches to the runner and completes normally", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Approved" });
    const { run, approval } = await service.sendMessage(agent.id, "run rm -rf /tmp");

    expect(run.status).toBe("pending_approval");
    const { approval: decided } = await service.decideApproval(
      approval!.id,
      "approved",
      "alice",
    );

    expect(decided.status).toBe("approved");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toContain("run rm -rf /tmp");
  });

  it("rejects deciding an approval twice", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "DoubleDecision" });
    const { approval } = await service.sendMessage(agent.id, "run rm -rf /tmp");

    await service.decideApproval(approval!.id, "denied", "alice");
    await expect(
      service.decideApproval(approval!.id, "approved", "alice"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects deciding an unknown approval id", async () => {
    const service = await makeService();
    await expect(
      service.decideApproval("does-not-exist", "approved", "alice"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("listApprovals filters by status", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Lister" });
    const { approval: first } = await service.sendMessage(agent.id, "run rm -rf /a");
    await service.decideApproval(first!.id, "denied", "alice");
    const { approval: second } = await service.sendMessage(agent.id, "run rm -rf /b");

    const pending = service.listApprovals("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(second!.id);

    const denied = service.listApprovals("denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].id).toBe(first!.id);
  });
});