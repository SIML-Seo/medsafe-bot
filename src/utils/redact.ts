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
