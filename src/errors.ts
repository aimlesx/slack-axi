import type { ErrorEnvelope } from "./types.js";

export class AxiError extends Error {
  readonly code: string;
  readonly exitCode: 1 | 2;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly candidates: unknown[] | undefined;
  readonly suggestedCommand: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: {
    code: string;
    message: string;
    exitCode?: 1 | 2;
    retryable?: boolean;
    details?: Record<string, unknown>;
    candidates?: unknown[];
    suggestedCommand?: string;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "AxiError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? 1;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.candidates = options.candidates;
    this.suggestedCommand = options.suggestedCommand;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

// Slack-shaped credentials use the token68 punctuation alphabet in addition
// to percent escapes. Keep delimiters (commas,
// quotes, semicolons, and whitespace) out of the match so adjacent diagnostic
// prose remains useful.
const SECRET_PATTERNS = [
  /\bBearer[ \t]+[A-Za-z0-9._~+/%=-]*[A-Za-z0-9_~+/%=-]/gi,
  /\b(?:d|xoxd)=xoxd-[A-Za-z0-9._~+/%=-]*[A-Za-z0-9_~+/%=-]/gi,
  /\bxox[acdoprsbo]-[A-Za-z0-9._~+/%=-]*[A-Za-z0-9_~+/%=-]/gi,
];

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [redact(key), redactUnknown(child)]));
  return value;
}

export function toErrorEnvelope(error: unknown): { envelope: ErrorEnvelope; exitCode: 1 | 2 } {
  const normalized = error instanceof AxiError
    ? error
    : new AxiError({
        code: "INTERNAL_ERROR",
        message: "Slack AXI encountered an unexpected internal error.",
        cause: error,
      });

  return {
    exitCode: normalized.exitCode,
    envelope: {
      schema: "slack-axi/v1",
      ok: false,
      error: {
        code: normalized.code,
        message: redact(normalized.message),
        retryable: normalized.retryable,
        ...(normalized.retryAfterSeconds === undefined
          ? {}
          : { retry_after_seconds: normalized.retryAfterSeconds }),
        ...(normalized.candidates === undefined ? {} : { candidates: redactUnknown(normalized.candidates) as unknown[] }),
        ...(normalized.suggestedCommand === undefined
          ? {}
          : { suggested_command: redact(normalized.suggestedCommand) }),
        ...(normalized.details === undefined ? {} : { details: redactUnknown(normalized.details) as Record<string, unknown> }),
      },
    },
  };
}
