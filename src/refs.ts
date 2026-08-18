import { AxiError } from "./errors.js";
import type { MessageRef } from "./types.js";

const refPattern = /^(T[A-Z0-9]+)\/([CDG][A-Z0-9]+)\/(\d{10,}\.\d{6})$/;
const permalinkPattern = /^https:\/\/[^/]+\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?.*)?$/;
const legacyPattern = /^([CDG][A-Z0-9]+)\/(\d{10,}\.\d{6})$/;

export function createMessageRef(teamId: string, conversationId: string, ts: string): MessageRef {
  const value = `${teamId}/${conversationId}/${ts}`;
  if (!refPattern.test(value)) throw new AxiError({ code: "MESSAGE_REF_INVALID", message: `Cannot construct a message reference from '${value}'.` });
  return value as MessageRef;
}

export function parseMessageRef(input: string, expectedTeamId?: string): { teamId?: string; conversationId: string; ts: string } {
  const ref = input.match(refPattern);
  if (ref) {
    if (expectedTeamId && ref[1] !== expectedTeamId) {
      throw new AxiError({ code: "WORKSPACE_MISMATCH", message: `Message reference belongs to ${ref[1]}, not ${expectedTeamId}.`, exitCode: 2 });
    }
    return { teamId: ref[1]!, conversationId: ref[2]!, ts: ref[3]! };
  }
  const permalink = input.match(permalinkPattern);
  if (permalink) return { conversationId: permalink[1]!, ts: `${permalink[2]}.${permalink[3]}` };
  const legacy = input.match(legacyPattern);
  if (legacy) return { conversationId: legacy[1]!, ts: legacy[2]! };
  throw new AxiError({ code: "MESSAGE_REF_INVALID", message: "Expected TEAM/CONVERSATION/TIMESTAMP, CONVERSATION/TIMESTAMP, or a Slack message permalink.", exitCode: 2 });
}
