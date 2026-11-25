import { encode } from "@toon-format/toon";
import type { OutputFormat } from "./types.js";

function projectRow(value: unknown, fields: string[]): unknown {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field))
    .map((field) => [field, (value as Record<string, unknown>)[field]]));
}

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

function projectCatchup(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  if (!Array.isArray(data.conversations)) return data;
  const onlyOrigins = fields.includes("author_origin") && !fields.includes("messages");
  const conversations = data.conversations.map((row: Record<string, unknown>) => {
    const conversation = row.conversation as Record<string, unknown>;
    const conversationFields = fields.filter((field) => Object.hasOwn(conversation, field));
    return {
      ...projectRow(row, fields) as Record<string, unknown>,
      conversation: conversationFields.length ? projectRow(conversation, conversationFields) : conversation,
      ...(onlyOrigins && Array.isArray(row.messages)
        ? { messages: row.messages.map((message) => projectRow(message, ["author_origin"])) }
        : {}),
    };
  });
  return { ...data, conversations };
}

function selectFields(value: unknown, fields?: string[], targetFields = fields): unknown {
  if (!fields?.length || !targetFields?.length) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return projectData(value, fields, targetFields);

  const record = value as Record<string, unknown>;
  if (record.schema === "slack-axi/v1" && "data" in record) {
    const command = (record.scope as { command?: string } | undefined)?.command;
    const data = record.data as Record<string, unknown> | undefined;
    if (data && (command === "read" || command === "thread" || command === "search.messages") && Array.isArray(data.messages)) {
      return { ...record, data: { ...data, messages: data.messages.map((item) => projectRow(item, fields)) } };
    }
    if (data && command === "message.get") {
      return { ...record, data: { ...data, message: projectRow(data.message, fields) } };
    }
    if (data && command === "catchup") {
      return { ...record, data: projectCatchup(data, fields) };
    }
    if (data && command === "message.cite" && Array.isArray(data.citations)) {
      return { ...record, data: { ...data, citations: data.citations.map((row) => projectRow(row, fields)) } };
    }
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
