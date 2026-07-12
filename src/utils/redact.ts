const CONFIRMATION_TOKEN_PATTERN = /\bv2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function omitConfirmationTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitConfirmationTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "confirmationToken")
        .map(([key, nested]) => [key, omitConfirmationTokens(nested)])
    );
  }
  return value;
}

export function redactConfirmationTokensInText(value: string): string {
  return value.replace(CONFIRMATION_TOKEN_PATTERN, "v2.[redacted]");
}
