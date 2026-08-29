/**
 * @file user-ownership.test.ts
 * @author Quek Hui Min
 * @date 2026-08-29
 * @brief Unit tests for user identity extraction and agent ownership middleware.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createApp } from "./app.js";
import { AgentService } from "./agent-service.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { AppConfig } from "./config.js";
import { AgentRunner, Agent } from "./types.js";
import {
  extractUserContext,
  isAgentOwner,
  assertAgentOwnership,
  filterAgentsByOwner,
  DEFAULT_USER_ID,
  USER_ID_HEADER,
} from "./middleware/identity/user-ownership.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("User Ownership Middleware - Unit Functions", () => {
  const dummyAgent: Agent = {
    id: "test-agent-id",
    name: "Test Agent",
    description: "",
    instructions: "",
    status: "ready",
    ownerId: "alice",
    allowedScopes: ["fs:read", "fs:write", "cmd:exec"],
    workspacePath: "/tmp/test",
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("extracts user id from request headers", () => {
    const reqWithHeader = {
      headers: { [USER_ID_HEADER]: "charlie" },
    } as any;
    expect(extractUserContext(reqWithHeader).userId).toBe("charlie");

    const reqWithoutHeader = {
      headers: {},
    } as any;
    expect(extractUserContext(reqWithoutHeader).userId).toBe(DEFAULT_USER_ID);
  });

  it("validates agent ownership correctly", () => {
    expect(isAgentOwner(dummyAgent, "alice")).toBe(true);
    expect(isAgentOwner(dummyAgent, "bob")).toBe(false);

    // legacy agents without ownerId default to authorized
    const legacyAgent = { ...dummyAgent, ownerId: undefined };
    expect(isAgentOwner(legacyAgent, "bob")).toBe(true);
  });

  it("throws 403 error when assertAgentOwnership fails", () => {
    expect(() => assertAgentOwnership(dummyAgent, "alice")).not.toThrow();

    expect(() => assertAgentOwnership(dummyAgent, "bob")).toThrowError(
      /Access Denied: User 'bob' does not own Agent 'test-agent-id'/,
    );
  });

  it("filters collections by active user", () => {
    const agentsList: Agent[] = [
      dummyAgent,
      { ...dummyAgent, id: "agent-2", ownerId: "bob" },
      { ...dummyAgent, id: "agent-3", ownerId: "alice" },
    ];

    const aliceAgents = filterAgentsByOwner(agentsList, "alice");
    expect(aliceAgents).toHaveLength(2);
    expect(aliceAgents.map((a) => a.id)).toEqual(["test-agent-id", "agent-3"]);

    const bobAgents = filterAgentsByOwner(agentsList, "bob");
    expect(bobAgents).toHaveLength(1);
    expect(bobAgents[0].id).toBe("agent-2");
  });
});

// Added { timeout: 30000 } to avoid WSL filesystem initialization timeouts
describe(
  "User Ownership Middleware - HTTP Integration",
  { timeout: 30000 },
  () => {
    let tempDir: string;
    let app: any;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "identity-ownership-test-"));
      const config: AppConfig = {
        port: 3000,
        host: "127.0.0.1",
        nodeEnv: "development",
        logLevel: "silent",
        dataDir: tempDir,
        workspaceDir: join(tempDir, "workspaces"),
        authToken: "",
        arkBaseUrl: "",
        arkApiKey: "",
        arkModel: "",
        runtimeProvider: "process",
        containerEngine: "docker",
        containerImage: "",
        codexSandboxMode: "workspace-only",
      };

      const store = new JsonStore(join(tempDir, "db.json"));
      const workspaces = new WorkspaceManager(config.workspaceDir);
      const mockRunner: AgentRunner = {
        run: async () => ({ output: "ok", threadId: null, usage: null }),
        cancel: async () => true,
        isAvailable: async () => true,
      };

      const service = new AgentService(config, store, workspaces, mockRunner);
      await service.initialize();
      app = await createApp(config, service);
    }, 30000);

    it("creates agent with correct owner and isolates listing", async () => {
      // alice creates an agent
      const aliceCreateRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-user-id": "alice" },
        payload: { name: "Alice Project" },
      });
      expect(aliceCreateRes.statusCode).toBe(201);
      const aliceAgent = JSON.parse(aliceCreateRes.body).agent;
      expect(aliceAgent.ownerId).toBe("alice");

      // bob creates an agent
      const bobCreateRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-user-id": "bob" },
        payload: { name: "Bob Project" },
      });
      expect(bobCreateRes.statusCode).toBe(201);
      const bobAgent = JSON.parse(bobCreateRes.body).agent;
      expect(bobAgent.ownerId).toBe("bob");

      // alice lists agents -> sees only alice's agent
      const aliceListRes = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { "x-user-id": "alice" },
      });
      const aliceList = JSON.parse(aliceListRes.body).agents;
      expect(aliceList).toHaveLength(1);
      expect(aliceList[0].id).toBe(aliceAgent.id);

      // bob lists agents -> sees only bob's agent
      const bobListRes = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { "x-user-id": "bob" },
      });
      const bobList = JSON.parse(bobListRes.body).agents;
      expect(bobList).toHaveLength(1);
      expect(bobList[0].id).toBe(bobAgent.id);
    });

    it("blocks unauthorized access and modifications with 403", async () => {
      // alice creates an agent
      const aliceCreateRes = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-user-id": "alice" },
        payload: { name: "Alice Secret Agent" },
      });
      const aliceAgent = JSON.parse(aliceCreateRes.body).agent;

      // bob attempts to read alice's agent
      const bobGetRes = await app.inject({
        method: "GET",
        url: `/api/agents/${aliceAgent.id}`,
        headers: { "x-user-id": "bob" },
      });
      expect(bobGetRes.statusCode).toBe(403);

      // bob attempts to update alice's agent
      const bobPatchRes = await app.inject({
        method: "PATCH",
        url: `/api/agents/${aliceAgent.id}`,
        headers: { "x-user-id": "bob" },
        payload: { name: "Hacked Agent Name" },
      });
      expect(bobPatchRes.statusCode).toBe(403);

      // bob attempts to trigger execution on alice's agent
      const bobPostMessageRes = await app.inject({
        method: "POST",
        url: `/api/agents/${aliceAgent.id}/messages`,
        headers: { "x-user-id": "bob" },
        payload: { content: "Run unauthorized task" },
      });
      expect(bobPostMessageRes.statusCode).toBe(403);

      // bob attempts to delete alice's agent
      const bobDeleteRes = await app.inject({
        method: "DELETE",
        url: `/api/agents/${aliceAgent.id}`,
        headers: { "x-user-id": "bob" },
      });
      expect(bobDeleteRes.statusCode).toBe(403);
    });
  },
);
