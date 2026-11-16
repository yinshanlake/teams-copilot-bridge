import { createHash } from "node:crypto";

const protectedSecrets = new Set<string>();

export function protectSecrets(values: Array<string | undefined>): void {
  for (const value of values) if (value) protectedSecrets.add(value);
}

export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UserError";
  }
}

export class DeliveryError extends UserError {
  constructor(
    readonly outcome: "rejected" | "uncertain" | "not-sent",
    readonly code: string,
    status = 400,
  ) {
    super(`Delivery ${outcome}: ${code}. The operation was not automatically replayed.`, status);
    this.name = "DeliveryError";
  }
}

export class UncertainOperationError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "UncertainOperationError";
  }
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function string(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function canonicalId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeText(value: string, limit = 12_000): string {
  let protectedText = value;
  for (const secret of protectedSecrets) protectedText = protectedText.replaceAll(secret, "[REDACTED]");
  const text = protectedText
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
    .replace(/\b(?:AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
    .replace(/((?:api[_-]?key|client[_-]?secret|password|access[_-]?token|authorization|connection[_-]?token|AccountKey|SharedAccessKey|SharedAccessSignature)\s*["']?\s*[:=]\s*["']?)[^\s"',;&<]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:token|key|sig|code|secret)=)[^&\s)]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return [...text].length > limit ? [...text].slice(0, limit).join("") + "\n[truncated]" : text;
}

export function chunkText(text: string, byteLimit = 12_000): string[] {
  if (byteLimit < 4) throw new Error("Chunk byte limit must be at least four");
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > byteLimit) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function publicError(error: unknown): string {
  return error instanceof UserError ? error.message : "Operation failed. Check the local backend log; no automatic retry was made.";
}

export function logError(area: string, error: unknown): void {
  // SDK exceptions can embed requests, tokens and tool arguments.
  console.error(JSON.stringify({ level: "error", area, kind: error instanceof Error ? error.name : "UnknownError" }));
}

export function assertFields(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new UserError("Malformed card submission: unexpected field.");
  }
}

export function sessionName(value: unknown): string {
  if (!string(value, 100) || value !== value.trim() || /[\u0000-\u001f\u007f"]/.test(value)) {
    throw new UserError("Session name must be 1-100 characters, without quotes or control characters.");
  }
  return value;
}
