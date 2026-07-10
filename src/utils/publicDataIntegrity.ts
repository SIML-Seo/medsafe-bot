import { createHash } from "node:crypto";

export function publicDataItems(wrapper: unknown): Record<string, unknown>[] {
  const values = Array.isArray(wrapper)
    ? wrapper
    : wrapper && typeof wrapper === "object"
      ? [wrapper]
      : [];
  return values.flatMap((value) => unwrapItemValue(value));
}

export function publicDataRowFingerprint(row: Record<string, unknown>): string {
  const canonical = Object.fromEntries(
    Object.entries(row)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonicalValue(value)])
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function publicDataPageFingerprint(rows: Record<string, unknown>[]): string {
  return createHash("sha256")
    .update(rows.map(publicDataRowFingerprint).join("\n"))
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function unwrapItemValue(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (!("item" in value)) return [value as Record<string, unknown>];
  const nested = (value as Record<string, unknown>).item;
  const nestedValues = Array.isArray(nested) ? nested : [nested];
  return nestedValues.filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object")
  );
}
