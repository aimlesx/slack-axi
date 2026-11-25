import { SlkyError } from "./errors.js";

export const SLACK_MESSAGE_MAX_CHARACTERS = 40_000;
export const SLACK_MESSAGE_MAX_UTF8_BYTES = SLACK_MESSAGE_MAX_CHARACTERS * 4;

export function validateSlackMessageText(text: string, label = "Message text"): string {
  const characters = Array.from(text).length;
  if (characters > SLACK_MESSAGE_MAX_CHARACTERS) {
    throw new SlkyError({
      code: "MESSAGE_TOO_LONG",
      message: `${label} contains ${characters} Unicode characters; Slack messages are limited to ${SLACK_MESSAGE_MAX_CHARACTERS}.`,
      exitCode: 2,
      details: { characters, maximum_characters: SLACK_MESSAGE_MAX_CHARACTERS },
    });
  }
  return text;
}
