export interface SecretPattern {
  id: string;
  label: string;
  pattern: RegExp;
}

const TEST_PASSWORD_PATTERN = /PASSWORD/gi;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;
const AWS_SECRET_KEY_PATTERN = /\b(?:aws_secret_access_key|secretAccessKey)\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/gi;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9]{20,}\b/g;
const GENERIC_BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const JWT_PATTERN = /\bey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const GENERIC_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{12,}['"]?/gi;

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: "test-password", label: "Test: password", pattern: TEST_PASSWORD_PATTERN },
  { id: "aws-access-key-id", label: "AWS access key ID", pattern: AWS_ACCESS_KEY_ID_PATTERN },
  { id: "aws-secret-key", label: "AWS secret access key", pattern: AWS_SECRET_KEY_PATTERN },
  { id: "github-token", label: "GitHub token", pattern: GITHUB_TOKEN_PATTERN },
  { id: "slack-token", label: "Slack token", pattern: SLACK_TOKEN_PATTERN },
  { id: "openai-key", label: "OpenAI-style API key", pattern: OPENAI_KEY_PATTERN },
  { id: "bearer-token", label: "Bearer token", pattern: GENERIC_BEARER_PATTERN },
  { id: "private-key-block", label: "Private key block", pattern: PRIVATE_KEY_BLOCK_PATTERN },
  { id: "jwt", label: "JWT", pattern: JWT_PATTERN },
  { id: "generic-assignment", label: "Generic secret assignment", pattern: GENERIC_ASSIGNMENT_PATTERN },
];

export const REDACTION_MASK = "[REDACTED]";
