import { describe, it, expect } from "vitest";
import {
  MAX_RUN_DURATION_MS,
  MAX_TOKEN_BUDGET,
  GLOBAL_TOKEN_BUDGET,
  WARNING_THRESHOLD_RATIO,
  totalTokens,
  isOverDurationLimit,
  isOverTokenBudget,
  isOverGlobalBudget,
  isNearingLimit,
  formatDuration,
} from "../src/middleware/safety/run-limits";

describe("totalTokens", () => {
  it("sums input and output tokens", () => {
    expect(totalTokens({ inputTokens: 100, outputTokens: 50 })).toBe(150);
  });

  it("returns 0 for null/undefined usage", () => {
    expect(totalTokens(null)).toBe(0);
    expect(totalTokens(undefined)).toBe(0);
  });

  it("treats missing fields as 0", () => {
    expect(totalTokens({ inputTokens: 100 })).toBe(100);
  });
});

describe("isOverDurationLimit", () => {
  it("returns false when under the limit", () => {
    expect(isOverDurationLimit(MAX_RUN_DURATION_MS - 1000)).toBe(false);
  });

  it("returns true exactly at the limit", () => {
    expect(isOverDurationLimit(MAX_RUN_DURATION_MS)).toBe(true);
  });

  it("returns true when over the limit", () => {
    expect(isOverDurationLimit(MAX_RUN_DURATION_MS + 1000)).toBe(true);
  });

  it("returns false at zero elapsed", () => {
    expect(isOverDurationLimit(0)).toBe(false);
  });
});

describe("isOverTokenBudget", () => {
  it("returns false under the per-run budget", () => {
    expect(isOverTokenBudget({ inputTokens: 100, outputTokens: 100 })).toBe(false);
  });

  it("returns true when usage meets the per-run budget", () => {
    expect(isOverTokenBudget({ inputTokens: MAX_TOKEN_BUDGET, outputTokens: 0 })).toBe(true);
  });

  it("returns false for null usage (nothing reported yet)", () => {
    expect(isOverTokenBudget(null)).toBe(false);
  });
});

describe("isOverGlobalBudget", () => {
  it("returns false under the session budget", () => {
    expect(isOverGlobalBudget(GLOBAL_TOKEN_BUDGET - 1)).toBe(false);
  });

  it("returns true at or over the session budget", () => {
    expect(isOverGlobalBudget(GLOBAL_TOKEN_BUDGET)).toBe(true);
    expect(isOverGlobalBudget(GLOBAL_TOKEN_BUDGET + 5000)).toBe(true);
  });
});

describe("isNearingLimit", () => {
  it("returns false well under both thresholds", () => {
    expect(isNearingLimit(0, { inputTokens: 0, outputTokens: 0 })).toBe(false);
  });

  it("returns true once duration crosses the warning ratio", () => {
    const warningElapsed = MAX_RUN_DURATION_MS * WARNING_THRESHOLD_RATIO;
    expect(isNearingLimit(warningElapsed, null)).toBe(true);
  });

  it("returns true once token usage crosses the warning ratio", () => {
    const warningTokens = Math.ceil(MAX_TOKEN_BUDGET * WARNING_THRESHOLD_RATIO);
    expect(isNearingLimit(0, { inputTokens: warningTokens, outputTokens: 0 })).toBe(true);
  });
});

describe("formatDuration", () => {
  it("formats whole minutes and seconds", () => {
    expect(formatDuration(65_000)).toBe("1:05");
  });

  it("pads seconds under 10", () => {
    expect(formatDuration(5_000)).toBe("0:05");
  });

  it("formats zero as 0:00", () => {
    expect(formatDuration(0)).toBe("0:00");
  });
});
