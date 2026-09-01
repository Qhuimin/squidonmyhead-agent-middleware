import { describe, it, expect } from "vitest";
import {
  SENSITIVITY_LEVELS,
  DEFAULT_BLOCKED_LEVELS,
  normalizeLabel,
  isBlockedLevel,
} from "../src/safety/sensitivity-levels"

describe("normalizeLabel", () => {
  it("matches an exact known level", () => {
    expect(normalizeLabel("Confidential")).toBe("Confidential");
  });

  it("is case-insensitive", () => {
    expect(normalizeLabel("confidential")).toBe("Confidential");
    expect(normalizeLabel("CONFIDENTIAL")).toBe("Confidential");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeLabel("  Public  ")).toBe("Public");
  });

  it("returns null for an unrecognized label", () => {
    expect(normalizeLabel("Top Secret")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeLabel("")).toBeNull();
  });

  it("recognizes every defined level", () => {
    for (const level of SENSITIVITY_LEVELS) {
      expect(normalizeLabel(level)).toBe(level);
    }
  });
});

describe("isBlockedLevel", () => {
  it("blocks a level in the blocklist", () => {
    expect(isBlockedLevel("Confidential", DEFAULT_BLOCKED_LEVELS)).toBe(true);
    expect(isBlockedLevel("Highly Confidential", DEFAULT_BLOCKED_LEVELS)).toBe(true);
  });

  it("allows a level not in the blocklist", () => {
    expect(isBlockedLevel("Public", DEFAULT_BLOCKED_LEVELS)).toBe(false);
    expect(isBlockedLevel("Personal", DEFAULT_BLOCKED_LEVELS)).toBe(false);
    expect(isBlockedLevel("General", DEFAULT_BLOCKED_LEVELS)).toBe(false);
  });

  it("allows a null level (unlabeled file)", () => {
    expect(isBlockedLevel(null, DEFAULT_BLOCKED_LEVELS)).toBe(false);
  });

  it("respects a custom blocklist, not just the default", () => {
    expect(isBlockedLevel("Public", ["Public"])).toBe(true);
    expect(isBlockedLevel("Confidential", ["Public"])).toBe(false);
  });

  it("blocks nothing when the blocklist is empty", () => {
    expect(isBlockedLevel("Highly Confidential", [])).toBe(false);
  });
});
