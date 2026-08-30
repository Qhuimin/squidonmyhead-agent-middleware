export const SENSITIVITY_LEVELS = [
  "Personal",
  "Public",
  "General",
  "Confidential",
  "Highly Confidential",
] as const;

export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

export const DEFAULT_BLOCKED_LEVELS: SensitivityLevel[] = ["Confidential", "Highly Confidential"];

export function normalizeLabel(rawLabel: string): SensitivityLevel | null {
  const trimmed = rawLabel.trim().toLowerCase();
  const match = SENSITIVITY_LEVELS.find((level) => level.toLowerCase() === trimmed);
  return match ?? null;
}

export function isBlockedLevel(level: SensitivityLevel | null, blockedLevels: SensitivityLevel[]): boolean {
  if (!level) return false;
  return blockedLevels.includes(level);
}
