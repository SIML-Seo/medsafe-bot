import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface ConfirmationPayload {
  itemSeq: string | null;
  ingrCode: string | null;
  status?: string | null;
}

export class ConfirmationTokenService {
  private readonly secret: string;

  constructor(secret?: string | null) {
    this.secret = secret?.trim() || randomBytes(32).toString("base64url");
  }

  sign(payload: ConfirmationPayload): string {
    const body = Buffer.from(JSON.stringify(canonicalPayload(payload))).toString("base64url");
    const signature = this.signature(body);
    return `v1.${body}.${signature}`;
  }

  verify(token: string | null | undefined, payload: ConfirmationPayload): boolean {
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return false;

    const expectedBody = Buffer.from(JSON.stringify(canonicalPayload(payload))).toString("base64url");
    if (parts[1] !== expectedBody) return false;

    const expected = Buffer.from(this.signature(expectedBody));
    const actual = Buffer.from(parts[2] ?? "");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
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

function nonEmptyOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
