export const MAX_RUN_DURATION_MS = 5 * 60 * 1000;
export const MAX_TOKEN_BUDGET = 50_000;
export const GLOBAL_TOKEN_BUDGET = 500_000;
export const WARNING_THRESHOLD_RATIO = 0.8;

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export function totalTokens(usage: RunUsage | null | undefined): number {
  if (!usage) return 0;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function isOverDurationLimit(elapsedMs: number): boolean {
  return elapsedMs >= MAX_RUN_DURATION_MS;
}

export function isOverTokenBudget(usage: RunUsage | null | undefined): boolean {
  return totalTokens(usage) >= MAX_TOKEN_BUDGET;
}

export function isNearingLimit(elapsedMs: number, usage: RunUsage | null | undefined): boolean {
  const durationRatio = elapsedMs / MAX_RUN_DURATION_MS;
  const tokenRatio = totalTokens(usage) / MAX_TOKEN_BUDGET;
  return durationRatio >= WARNING_THRESHOLD_RATIO || tokenRatio >= WARNING_THRESHOLD_RATIO;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

export function isOverGlobalBudget(globalTokensUsed: number): boolean {
  return globalTokensUsed >= GLOBAL_TOKEN_BUDGET;
}
