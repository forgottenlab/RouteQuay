export type SensitivePatternKind =
  | "uuid"
  | "private-key-field"
  | "short-id-field"
  | "token-field"
  | "bearer-token"
  | "vless-link"
  | "pem-private-key";

type SensitivePattern = {
  kind: SensitivePatternKind;
  pattern: RegExp;
  replacement: string;
};

const sensitivePatterns: SensitivePattern[] = [
  {
    kind: "pem-private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PEM_PRIVATE_KEY]"
  },
  {
    kind: "vless-link",
    pattern: /vless:\/\/[^\s"'<>]+/gi,
    replacement: "[REDACTED_VLESS_URI]"
  },
  {
    kind: "private-key-field",
    pattern: /((?:^|[{\s,])["']?privateKey["']?\s*[:=]\s*)(?!["']?\[REDACTED_)["']?[^"',\s}\]\[]+["']?/gi,
    replacement: "$1[REDACTED_PRIVATE_KEY]"
  },
  {
    kind: "short-id-field",
    pattern: /((?:^|[{\s,])["']?shortIds?["']?\s*[:=]\s*)(?!\[REDACTED_)(\[(?!REDACTED_)[^\]]*\]|["']?[^"',\s}\]\[]+["']?)/gi,
    replacement: "$1[REDACTED_SHORT_IDS]"
  },
  {
    kind: "token-field",
    pattern: /((?:^|[{\s,])["']?token["']?\s*[:=]\s*)(?!["']?\[REDACTED_)["']?[^"',\s}\]\[]+["']?/gi,
    replacement: "$1[REDACTED_TOKEN]"
  },
  {
    kind: "bearer-token",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
    replacement: "Bearer [REDACTED_TOKEN]"
  },
  {
    kind: "uuid",
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
    replacement: "[REDACTED_UUID]"
  }
];

export function redactSensitiveText(input: string): string {
  return sensitivePatterns.reduce(
    (value, sensitivePattern) => value.replace(sensitivePattern.pattern, sensitivePattern.replacement),
    input
  );
}

export function findSensitivePatterns(input: string): SensitivePatternKind[] {
  const found = new Set<SensitivePatternKind>();

  for (const sensitivePattern of sensitivePatterns) {
    sensitivePattern.pattern.lastIndex = 0;
    if (sensitivePattern.pattern.test(input)) {
      found.add(sensitivePattern.kind);
    }
  }

  return [...found];
}

export function containsSensitivePattern(input: string): boolean {
  return findSensitivePatterns(input).length > 0;
}
