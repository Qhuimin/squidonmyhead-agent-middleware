import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import {
  extractUserContext,
  filterAgentsByOwner,
  assertAgentOwnership,
} from "./middleware/identity/index.js";
import {
  appendAuditLog,
  AUDIT_DATA_DIR,
  auditEventBody,
} from "./audit-service.js";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const approvalIdParams = z.object({ id: z.string().uuid() });
const approvalDecisionBody = z.object({
  decision: z.enum(["approved", "denied"]),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  // extract current user from incoming req header using extractUserContext(request).
  // filtered list using filterAgentsByOwner(...) so users only see agents they own.
  app.get("/api/agents", async (request) => {
    const user = extractUserContext(request);
    const allAgents = service.listAgents();
    return { agents: filterAgentsByOwner(allAgents, user.userId) };
  });

  // injected ownerId: user:userId into the payload sent to service.createAgent(...) so new agents are linked to their creator.
  app.post("/api/agents", async (request, reply) => {
    const user = extractUserContext(request);
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent({
      ...body,
      ownerId: user.userId,
    });
    return reply.code(201).send({ agent });
  });

  // when interacting with a specific agent by id, check if current user is the owner.
  // if false, assertAgentOwnership throws a 403 Forbidden error and halts the request.

  app.get("/api/agents/:id", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    return { agent };
  });

  app.patch("/api/agents/:id", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const user = extractUserContext(request);
    const { id } = runIdParams.parse(request.params);
    const run = service.getRun(id);
    const agent = service.getAgent(run.agentId);
    assertAgentOwnership(agent, user.userId);
    return { run };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  app.post("/api/audit", async (request, reply) => {
    const parseResult = auditEventBody.safeParse(request.body);
    if (!parseResult.success) {
      return reply
        .status(400)
        .send({ ok: false, error: "Invalid audit event shape" });
    }
    try {
      await appendAuditLog(parseResult.data);
      return reply.send({ ok: true });
    } catch (reason) {
      return reply
        .status(500)
        .send({ ok: false, error: "Failed to record audit event" });
    }
  });

  app.addHook("onReady", async () => {
    await mkdir(AUDIT_DATA_DIR, { recursive: true });
  });

  app.get("/api/approvals", async (request) => {
    const status = (request.query as any)?.status;
    return { approvals: service.listApprovals(status) };
  });

  app.post("/api/approvals/:id/decision", async (request) => {
    const user = extractUserContext(request);
    const { id } = approvalIdParams.parse(request.params);

    // Enforce: only the Agent's owner may decide its approvals.
    const approval = service.listApprovals().find((a) => a.id === id);
    if (!approval) throw new HttpError(404, "Approval request not found");
    const agent = service.getAgent(approval.agentId);
    assertAgentOwnership(agent, user.userId);

    const body = approvalDecisionBody.parse(request.body);
    return service.decideApproval(id, body.decision, user.userId);
  });

  return app;
}
