import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface ConfirmationPayload {
  itemSeq: string | null;
  ingrCode: string | null;
  status?: string | null;
}

interface SignedConfirmationPayload extends ConfirmationPayload {
  iat: number;
  exp: number;
  nonce: string;
}

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

export class ConfirmationTokenService {
  private readonly secret: string;

  constructor(
    secret?: string | null,
    private readonly ttlMs = DEFAULT_TOKEN_TTL_MS,
    private readonly now: () => number = Date.now
  ) {
    this.secret = secret?.trim() || randomBytes(32).toString("base64url");
  }

  sign(payload: ConfirmationPayload): string {
    const issuedAt = this.now();
    const signedPayload: SignedConfirmationPayload = {
      ...canonicalPayload(payload),
      iat: issuedAt,
      exp: issuedAt + this.ttlMs,
      nonce: randomBytes(12).toString("base64url")
    };
    const body = Buffer.from(JSON.stringify(signedPayload)).toString("base64url");
    return `v2.${body}.${this.signature(body)}`;
  }

  verify(token: string | null | undefined, payload: ConfirmationPayload): boolean {
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v2") return false;

    const body = parts[1] ?? "";
    const expectedSignature = Buffer.from(this.signature(body));
    const actualSignature = Buffer.from(parts[2] ?? "");
    if (
      expectedSignature.length !== actualSignature.length ||
      !timingSafeEqual(expectedSignature, actualSignature)
    ) {
      return false;
    }

    const decoded = decodePayload(body);
    if (!decoded) return false;
    const expected = canonicalPayload(payload);
    if (
      decoded.itemSeq !== expected.itemSeq ||
      decoded.ingrCode !== expected.ingrCode ||
      decoded.status !== expected.status
    ) {
      return false;
    }

    const now = this.now();
    return (
      Number.isFinite(decoded.iat) &&
      Number.isFinite(decoded.exp) &&
      decoded.iat <= now + CLOCK_SKEW_MS &&
      decoded.exp > now &&
      decoded.exp - decoded.iat <= this.ttlMs &&
      typeof decoded.nonce === "string" &&
      decoded.nonce.length >= 8
    );
  }

  private signature(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

function canonicalPayload(payload: ConfirmationPayload): ConfirmationPayload {
  return {
    itemSeq: nonEmptyOrNull(payload.itemSeq),
    ingrCode: nonEmptyOrNull(payload.ingrCode),
    status: nonEmptyOrNull(payload.status)
  };
}

function decodePayload(body: string): SignedConfirmationPayload | null {
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SignedConfirmationPayload>;
    if (!value || typeof value !== "object") return null;
    return value as SignedConfirmationPayload;
  } catch {
    return null;
  }
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
