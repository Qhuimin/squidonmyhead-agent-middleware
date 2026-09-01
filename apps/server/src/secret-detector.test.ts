import { describe, it, expect } from "vitest";
import { detectSecrets, redactSecrets, hasSecrets } from "../src/middleware/safety/secret-detector";

describe("detectSecrets", () => {
  it("detects an AWS access key", () => {
    const matches = detectSecrets("key: AKIAABCDEFGHIJKLMNOP");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].label).toBe("AWS access key ID");
  });

  it("detects a GitHub token", () => {
    const matches = detectSecrets("token=ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
    expect(matches.some((m) => m.patternId === "github-token")).toBe(true);
  });

  it("returns no matches on plain text", () => {
    const matches = detectSecrets("Help me build and test the app. Keep changes small.");
    expect(matches).toHaveLength(0);
  });

  it("returns no matches on an empty string", () => {
    expect(detectSecrets("")).toHaveLength(0);
  });

  it("does not match a broken/tampered token (known limitation)", () => {
    // A single non-alphanumeric character breaks the pattern —
    // documented limitation, not a bug. See write-up.
    const matches = detectSecrets("ghp_*234567890abcdefghijklmnopqrstuvwxyz12");
    expect(matches).toHaveLength(0);
  });
});

describe("redactSecrets", () => {
  it("replaces a detected secret with the redaction mask", () => {
    const result = redactSecrets("Here is the key: AKIAABCDEFGHIJKLMNOP for deploy");
    expect(result).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result).toContain("[REDACTED]");
  });

  it("leaves text with no secrets unchanged", () => {
    const input = "No secrets in this one at all";
    expect(redactSecrets(input)).toBe(input);
  });

  it("redacts multiple distinct secrets in one string", () => {
    const input =
      "AWS: AKIAABCDEFGHIJKLMNOP and GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyz12";
    const result = redactSecrets(input);
    expect(result).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
  });
});

describe("hasSecrets", () => {
  it("returns true when a secret is present", () => {
    expect(hasSecrets("password: supersecretvalue123")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(hasSecrets("just a normal sentence")).toBe(false);
  });
});
