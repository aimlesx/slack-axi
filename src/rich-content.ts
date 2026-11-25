export interface RichContent {
  text: string;
  truncated: boolean;
  unsupported_types: string[];
}

const MAX_CHARS = 4096;
const PREVIEW_CHARS = 220;
const MAX_NODES = 256;
const MAX_DEPTH = 12;

type Node = Record<string, unknown>;

// Traverse Slack's display fields only. URL strings and button labels are text.
function extractRichContent(raw: Node, maxChars: number): RichContent {
  let text = "";
  let chars = 0;
  let nodes = 0;
  let truncated = false;
  let exhausted = false;
  let newLine = false;
  const unsupported = new Set<string>();

  function append(value: unknown): void {
    if (typeof value !== "string" || value.length === 0 || exhausted) return;
    if (newLine && text && !text.endsWith("\n")) {
      if (chars === maxChars) {
        truncated = true;
        exhausted = true;
        return;
      }
      text += "\n";
      chars++;
    }
    newLine = false;
    for (const char of value) {
      if (chars === maxChars) {
        truncated = true;
        exhausted = true;
        break;
      }
      text += char;
      chars++;
    }
  }

  function skip(type: string): void {
    const name = type.slice(0, 64);
    if (name.length !== type.length || (unsupported.size === 16 && !unsupported.has(name))) truncated = true;
    if (unsupported.size < 16) unsupported.add(name);
  }

  function visit(value: unknown, depth: number, kind?: "attachment" | "field"): void {
    if (++nodes > MAX_NODES) {
      truncated = true;
      exhausted = true;
      return;
    }
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      skip("invalid_element");
      return;
    }
    const node = value as Node;

    function children(items: unknown, separate: boolean, childKind?: "attachment" | "field"): void {
      if (items === undefined) return;
      if (!Array.isArray(items)) {
        skip("invalid_elements");
        return;
      }
      for (const item of items) {
        if (exhausted) break;
        if (separate) newLine = true;
        visit(item, depth + 1, childKind);
      }
    }

    if (kind === "attachment") {
      const start = chars;
      for (const field of ["pretext", "author_name", "title", "title_link", "text"]) {
        newLine = true;
        append(node[field]);
      }
      children(node.fields, true, "field");
      children(node.blocks, true);
      newLine = true;
      append(node.footer);
      if (chars === start) append(node.fallback);
      if (chars === start && !exhausted) skip("unreadable_attachment");
      return;
    }
    if (kind === "field") {
      append(node.title);
      if (node.title && node.value) append(": ");
      append(node.value);
      return;
    }

    switch (node.type) {
      case "section":
      case "header":
        if (node.text) visit(node.text, depth + 1);
        children(node.fields, true);
        if (node.accessory) {
          newLine = true;
          visit(node.accessory, depth + 1);
        }
        break;
      case "rich_text":
      case "rich_text_list":
      case "actions":
      case "context":
        children(node.elements, true);
        break;
      case "rich_text_section":
      case "rich_text_preformatted":
      case "rich_text_quote":
        children(node.elements, false);
        break;
      case "plain_text":
      case "mrkdwn":
      case "markdown":
      case "text":
        append(node.text);
        break;
      case "link":
        append(node.text);
        if (node.text && node.url) append(" ");
        append(node.url);
        break;
      case "button":
        if (node.text) visit(node.text, depth + 1);
        if (node.text && node.url) append(" ");
        append(node.url);
        break;
      case "image":
        append(node.alt_text);
        break;
      case "user":
        append("<@");
        append(node.user_id);
        append(">");
        break;
      case "channel":
        append("<#");
        append(node.channel_id);
        append(">");
        break;
      case "emoji":
        append(":");
        append(node.name);
        append(":");
        break;
      case "divider":
        newLine = true;
        break;
      default: skip(typeof node.type === "string" ? node.type : "invalid_element");
    }
  }

  for (const source of ["blocks", "attachments"] as const) {
    const items = raw[source];
    if (items === undefined) continue;
    if (!Array.isArray(items)) {
      skip("invalid_" + source);
      continue;
    }
    for (const item of items) {
      if (exhausted) break;
      newLine = true;
      visit(item, 1, source === "attachments" ? "attachment" : undefined);
    }
  }
  return { text, truncated, unsupported_types: [...unsupported] };
}

export function messageRichFields(raw: Node, expand: boolean): {
  has_rich_content?: true;
  rich_preview?: string;
  rich_content?: RichContent;
} {
  if (!["blocks", "attachments"].some((key) => Array.isArray(raw[key]) && raw[key].length > 0)) return {};
  const needsPreview = typeof raw.text !== "string" || raw.text.trim() === "";
  if (!expand && !needsPreview) return { has_rich_content: true };
  const rich = extractRichContent(raw, expand ? MAX_CHARS : PREVIEW_CHARS);
  const preview = needsPreview ? Array.from(rich.text).slice(0, PREVIEW_CHARS).join("") : "";
  return {
    has_rich_content: true,
    ...(preview ? { rich_preview: preview + (preview !== rich.text || rich.truncated ? "…" : "") } : {}),
    ...(expand ? { rich_content: rich } : {}),
  };
}
