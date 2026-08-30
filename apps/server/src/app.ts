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
import { describeDetectedTypes, detectSecrets } from "./middleware/safety/secret-detector.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });

// define accepted agent permission scopes for validation
const agentScopeEnum = z.enum([
  "fs:read",
  "fs:write",
  "cmd:exec",
  "net:outbound",
]);

const createAgentBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).optional(),
    instructions: z.string().max(10_000).optional(),
    allowedScopes: z.array(agentScopeEnum).optional(),
  })
  .superRefine((value, ctx) => {
    const combined = [value.description, value.instructions].filter(Boolean).join(" ");
    const matches = detectSecrets(combined);
    if (matches.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Instructions/description appear to contain a secret (" + describeDetectedTypes(matches) + ")",
        path: ["instructions"],
      });
    }
  });

const updateAgentBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    instructions: z.string().max(10_000).optional(),
    allowedScopes: z.array(agentScopeEnum).optional(),
    isRevoked: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const combined = [value.description, value.instructions].filter(Boolean).join(" ");
    const matches = detectSecrets(combined);
    if (matches.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Instructions/description appear to contain a secret (" + describeDetectedTypes(matches) + ")",
        path: ["instructions"],
      });
    }
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
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

  // injected ownerId: user.userId into the payload sent to service.createAgent(...) so new agents are linked to their creator.
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

  // emergency revocation endpoint: strip scopes and set isRevoked flag
  app.post("/api/agents/:id/revoke", async (request) => {
    const user = extractUserContext(request);
    const { id } = agentIdParams.parse(request.params);
    const agent = service.getAgent(id);
    assertAgentOwnership(agent, user.userId);
    return {
      agent: await service.updateAgent(id, {
        isRevoked: true,
        allowedScopes: [],
      }),
    };
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

  return app;
}
