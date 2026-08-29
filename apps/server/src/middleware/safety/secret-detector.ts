import { REDACTION_MASK, SECRET_PATTERNS } from "./secret-patterns.js";

export interface SecretMatch {
  patternId: string;
  label: string;
  startIndex: number;
  endIndex: number;
}

function cloneWithGlobalFlag(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  return new RegExp(pattern.source, flags);
}

export function detectSecrets(text: string): SecretMatch[] {
  if (!text) return [];
  const matches: SecretMatch[] = [];
  for (const secretPattern of SECRET_PATTERNS) {
    const pattern = cloneWithGlobalFlag(secretPattern.pattern);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      matches.push({
        patternId: secretPattern.id,
        label: secretPattern.label,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return matches.sort((a, b) => a.startIndex - b.startIndex);
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  const matches = detectSecrets(text);
  if (matches.length === 0) return text;

  let result = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.startIndex < cursor) continue;
    result += text.slice(cursor, match.startIndex) + REDACTION_MASK;
    cursor = match.endIndex;
  }
  result += text.slice(cursor);
  return result;
}

export function hasSecrets(text: string): boolean {
  return detectSecrets(text).length > 0;
}

export function describeDetectedTypes(matches: SecretMatch[]): string {
  const uniqueLabels = Array.from(new Set(matches.map((match) => match.label)));
  return uniqueLabels.join(", ");
}
