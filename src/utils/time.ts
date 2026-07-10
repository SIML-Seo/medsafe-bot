export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export function timestampIsValidPastOrPresent(
  value: string | null | undefined,
  now = Date.now(),
  futureToleranceMs = CLOCK_SKEW_TOLERANCE_MS
): boolean {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp <= now + futureToleranceMs;
}

export function timestampWithinPastWindow(
  value: string | null | undefined,
  maxAgeMs: number,
  now = Date.now(),
  futureToleranceMs = CLOCK_SKEW_TOLERANCE_MS
): boolean {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= -futureToleranceMs && age <= maxAgeMs;
}
