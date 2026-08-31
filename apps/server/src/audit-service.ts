import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const AUDIT_DATA_DIR = path.join(process.cwd(), "src/data");
export const AUDIT_LOG_PATH = path.join(AUDIT_DATA_DIR, "audit.jsonl");

const KNOWN_AUDIT_EVENT_TYPES = [
  "secret_detected_blocked",
  "injection_detected_blocked",
  "output_secret_redacted",
  "run_stopped_timeout",
  "run_stopped_token_budget",
  "run_stopped_manual",
  "run_stop_unconfirmed",
  "file_upload_blocked",
  "file_upload_allowed",
  "global_budget_exceeded_blocked",
  "global_budget_exceeded_override",
  "user_ownership_blocked",
  "agent_revocation_blocked",
  "agent_scope_blocked",
] as const;

export const auditEventBody = z.object({
  type: z.enum(KNOWN_AUDIT_EVENT_TYPES),
  agentId: z.string().nullable(),
  timestamp: z.string(),
  detail: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .default({}),
});

export async function appendAuditLog(event: unknown): Promise<void> {
  const line = JSON.stringify(event) + "\n";
  await appendFile(AUDIT_LOG_PATH, line, "utf8");
}
