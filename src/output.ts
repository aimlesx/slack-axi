import { encode } from "@toon-format/toon";
import type { OutputFormat } from "./types.js";

function projectData(value: unknown, fields: string[], targetFields: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => projectData(item, fields, targetFields));
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  const childContainsTarget = Object.values(record).some((child) => containsTargetRecord(child, targetFields));
  if (!childContainsTarget && targetFields.some((field) => field in record)) {
    const selected: Record<string, unknown> = {};
    for (const field of fields) if (field in record) selected[field] = record[field];
    return selected;
  }

  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, projectData(child, fields, targetFields)]));
}

function containsTargetRecord(value: unknown, targetFields: string[]): boolean {
  if (Array.isArray(value)) return value.some((item) => containsTargetRecord(item, targetFields));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return targetFields.some((field) => field in record)
    || Object.values(record).some((child) => containsTargetRecord(child, targetFields));
}

function selectFields(value: unknown, fields?: string[], targetFields = fields): unknown {
  if (!fields?.length || !targetFields?.length) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return projectData(value, fields, targetFields);

  const record = value as Record<string, unknown>;
  if (record.schema === "slack-axi/v1" && "data" in record) {
    return { ...record, data: projectData(record.data, fields, targetFields) };
  }
  return projectData(value, fields, targetFields);
}

/**
 * Convert the projected envelope to the same JSON-compatible value before it
 * reaches either encoder. JSON.stringify omits undefined object properties but
 * TOON encodes them as null, which otherwise makes the two public formats
 * disagree. Array positions are significant, so undefined array entries retain
 * their position as null, matching JSON.stringify's behavior.
 */
export function normalizeOutput(value: unknown, arrayElement = false): unknown {
  if (value === undefined) return arrayElement ? null : undefined;
  // Array.from visits sparse slots too, so holes become null instead of being
  // decoded by TOON as empty strings while JSON decodes them as null.
  if (Array.isArray(value)) return Array.from(value, (item) => normalizeOutput(item, true));
  if (typeof value !== "object" || value === null) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) normalized[key] = normalizeOutput(child);
  }
  return normalized;
}

export function serialize(value: unknown, format: OutputFormat, fields?: string[], targetFields?: string[]): string {
  const projected = normalizeOutput(selectFields(value, fields, targetFields));
  // Public stdout paths always pass an envelope, but keep the standalone
  // serializer deterministic for an accidental undefined root as well.
  const normalized = projected === undefined ? null : projected;
  if (format === "json") return `${JSON.stringify(normalized, null, 2)}\n`;
  if (format === "jsonl") {
    if (Array.isArray(normalized)) return `${normalized.map((row) => JSON.stringify(row)).join("\n")}\n`;
    return `${JSON.stringify(normalized)}\n`;
  }
  return `${encode(normalized)}\n`;
}
