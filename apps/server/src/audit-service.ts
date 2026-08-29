import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const AUDIT_DATA_DIR = path.join(process.cwd(), "src/data");
export const AUDIT_LOG_PATH = path.join(AUDIT_DATA_DIR, "audit.jsonl");

export const auditEventBody = z.object({
  type: z.literal("secret_detected_blocked"),
  field: z.enum(["instructions", "description", "message"]),
  agentId: z.string().nullable(),
  detectedTypes: z.array(z.string()),
  timestamp: z.string(),
});

export async function appendAuditLog(event: unknown): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  await appendFile(AUDIT_LOG_PATH, line, "utf8");
}