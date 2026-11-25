---
name: slack-axi
description: Use for requests to search Slack discussions, catch up on recent activity, read a thread, cite a decision with its permalink, or prepare a Slack reply.
---

Start with `slack-axi` for the selected workspace and setup status. If the user specified a workspace, pass `--workspace <alias|team-id>`. Carry that selection through follow-ups. If selection is ambiguous, use `slack-axi auth list` and ask which workspace to use.

- Search with `slack-axi search messages`. Read a conversation with `read`, a discussion with `thread`, and recent activity with `catchup`. Consult the relevant command's `--help` for its arguments and bounds.
- For a decision, verify the message with `slack-axi message cite <ref>` and use its returned permalink. Use the CLI's emitted follow-up commands to expand previews or continue pages. Report incomplete coverage when it matters.
- For “draft” or “prepare a reply,” use `slack-axi message reply` with the selected conversation and thread reference. Omit `--apply`. Report the staged action ID and stop. Sending or applying requires the user's explicit authorization and the operator's permissions. Respect policy denials.
- If the executable is missing, give the operator the install command `brew install aimlesx/tap/slack-axi` or `npm install --global slack-axi-cli`. If the home view reports missing setup, relay its setup instruction (such as `slack-axi auth add <alias> --from-stdin`) for the operator to run privately. Keep credentials out of chat.
