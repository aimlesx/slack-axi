import type { Command } from "commander";

export interface CommandMetadata {
  description: string;
  examples: string[];
  fields?: string[];
  cursor?: boolean;
  /** Maximum accepted value for the inherited --limit option. */
  limitMaximum?: number;
  defaults?: string[];
  incompatibilities?: string[];
}

export const COMMAND_METADATA: Record<string, CommandMetadata> = {
  "": { description: "Read and safely act on Slack from coding agents.", examples: ["slack-axi", "slack-axi --workspace work", "slack-axi --output json"], defaults: ["--output toon", "--fields uses each command's compact default schema"] },
  auth: { description: "Manage Slack workspace authentication.", examples: ["slack-axi auth list", "slack-axi auth doctor --workspace work"] },
  "auth add": { description: "Import one bounded browser-session or user-token JSON object from stdin into macOS Keychain.", examples: ["slack-axi auth add work --from-stdin < /secure/path/browser-session.json", "slack-axi auth add work --user-token --from-stdin < /secure/path/user-token.json"], defaults: ["browser mode with exact xoxc and xoxd fields", "stdin is capped at 16,384 UTF-8 bytes"], incompatibilities: ["--browser is an explicit synonym for the default and conflicts with --user-token; credentials are accepted only through --from-stdin and never through argv."] },
  "auth list": { description: "List configured workspaces without reading credentials.", examples: ["slack-axi auth list", "slack-axi auth list --output json"], fields: ["alias", "team_id", "team_name", "kind", "default", "capabilities", "capability_probed_at"] },
  "auth use": { description: "Select the default workspace.", examples: ["slack-axi auth use work", "slack-axi auth use T012ABC"] },
  "auth revoke": { description: "Stage revocation of one imported xoxp user token.", examples: ["slack-axi auth revoke work", "slack-axi auth revoke T012ABC --workspace T012ABC"], defaults: ["staged only", "browser sessions must be terminated in Slack before local removal", "does not uninstall the Slack app or remove local data"] },
  "auth remove": { description: "Remove a local workspace, its Keychain credentials, caches, and action records.", examples: ["slack-axi auth remove work", "slack-axi auth remove T012ABC"], defaults: ["does not terminate a browser session, revoke a user token, or uninstall an app at Slack", "failed local cleanup remains pending for auth doctor"] },
  "auth doctor": { description: "Independently probe and persist public and browser-private Slack capabilities.", examples: ["slack-axi auth doctor", "slack-axi auth doctor --workspace work"] },
  sync: { description: "Refresh bounded workspace entity and inbox caches.", examples: ["slack-axi sync --workspace work", "slack-axi sync --all --max-pages 20 --workspace work"], defaults: ["two pages per paged source"], incompatibilities: ["--all requires --max-pages <1..100>; --max-pages is invalid without --all."] },
  conversation: { description: "Discover and inspect channels and DMs.", examples: ["slack-axi conversation list", "slack-axi conversation get '#eng'"] },
  "conversation list": { description: "List cached conversations with authoritative coverage.", examples: ["slack-axi conversation list", "slack-axi conversation list --type channel --query eng --limit 20"], fields: ["id", "name", "type", "is_private", "is_archived", "is_external", "topic", "purpose"], cursor: true, limitMaximum: 1000, defaults: ["--limit 20", "archived conversations excluded"] },
  "conversation get": { description: "Fetch one conversation detail record.", examples: ["slack-axi conversation get C012ABC", "slack-axi conversation get '#eng' --fields id,name,topic"] , fields: ["id", "name", "type", "is_private", "is_member", "is_archived", "is_external", "topic", "purpose", "member_ids"] },
  "conversation resolve": { description: "Resolve a conversation selector to a stable ID.", examples: ["slack-axi conversation resolve '#eng'", "slack-axi conversation resolve C012ABC"], fields: ["id", "name", "type"] },
  "conversation members": { description: "List a bounded page of conversation members with cumulative scan accounting.", examples: ["slack-axi conversation members '#eng'", "slack-axi conversation members C012ABC --limit 100 --fields id,display_name,email,timezone"], fields: ["id", "name", "display_name", "real_name", "email", "timezone", "is_bot", "deleted"], cursor: true, limitMaximum: 200, defaults: ["--limit 100", "continuation cursors carry the cumulative scanned count"] },
  user: { description: "Discover Slack users.", examples: ["slack-axi user search alice", "slack-axi user get U012ABC"] },
  "user search": { description: "Search cached users with explicit source coverage.", examples: ["slack-axi user search alice", "slack-axi user search alice --fields id,name,display_name"], fields: ["id", "name", "display_name", "real_name", "email", "is_bot", "deleted"], cursor: true, limitMaximum: 1000, defaults: ["--limit 20"] },
  "user get": { description: "Fetch one user detail record.", examples: ["slack-axi user get U012ABC", "slack-axi user get @alice --fields id,display_name,timezone"], fields: ["id", "name", "display_name", "real_name", "email", "timezone", "is_bot", "deleted"] },
  usergroup: { description: "Inspect Slack user groups.", examples: ["slack-axi usergroup list", "slack-axi usergroup members S012ABC"] },
  "usergroup list": { description: "List a bounded page of normalized active user groups.", examples: ["slack-axi usergroup list", "slack-axi usergroup list --limit 50 --fields id,handle,name"], fields: ["id", "handle", "name", "description", "date_update"], cursor: true, limitMaximum: 1000, defaults: ["--limit 20", "continuation cursors are bound to the exact returned user-group snapshot"] },
  "usergroup members": { description: "List a bounded page of one user group's members.", examples: ["slack-axi usergroup members S012ABC", "slack-axi usergroup members S012ABC --limit 100 --fields id,display_name,email,timezone"], fields: ["id", "name", "display_name", "real_name", "email", "timezone", "is_bot", "deleted"], cursor: true, limitMaximum: 1000, defaults: ["--limit 20", "continuation cursors are bound to the exact returned membership snapshot"] },
  emoji: { description: "Search workspace emoji.", examples: ["slack-axi emoji search party", "slack-axi emoji search deploy --limit 10"] },
  "emoji search": { description: "Search cached workspace emoji.", examples: ["slack-axi emoji search party", "slack-axi emoji search party --limit 10"], fields: ["name", "url"], cursor: true, limitMaximum: 1000, defaults: ["--limit 20"] },
  read: { description: "Read a bounded conversation timeline with thread summaries.", examples: ["slack-axi read '#eng' --since 24h", "slack-axi read C012ABC --on 2026-08-15", "slack-axi read C012ABC --from 2026-08-15T09:00:00+02:00 --to 2026-08-15T17:00:00+02:00"], fields: ["ref", "time", "author_id", "author", "text", "text_chars", "text_truncated", "thread", "files", "reactions", "permalink"], cursor: true, limitMaximum: 100, defaults: ["--limit 50", "rolling 24-hour range ending now when no time flag is supplied", "continuation cursors carry the cumulative scanned count"], incompatibilities: ["Use only one of --since, --from, or --on; --on also conflicts with --to."] },
  thread: { description: "Read a bounded page of one Slack thread.", examples: ["slack-axi thread T012ABC/C034DEF/1786712345.001200", "slack-axi thread T012ABC/C034DEF/1786712345.001200 --full"], fields: ["ref", "time", "author_id", "author", "text", "text_chars", "text_truncated", "files", "reactions", "permalink"], cursor: true, limitMaximum: 100, defaults: ["--limit 50", "message text previews are capped at 600 Unicode characters", "continuation cursors carry the cumulative scanned count"] },
  search: { description: "Search Slack messages or files with bounded results.", examples: ["slack-axi search messages incident", "slack-axi search files roadmap"] },
  "search messages": { description: "Search messages with optional Slack-native filters.", examples: ["slack-axi search messages regression --in '#eng'", "slack-axi search messages incident --all --max-results 250 --sort timestamp"], fields: ["ref", "time", "author", "text", "text_chars", "text_truncated", "permalink"], limitMaximum: 1000, defaults: ["--limit 20", "--sort score", "one result page"], incompatibilities: ["--all requires --max-results; --max-results is invalid without --all; --limit conflicts with --all; --after must be earlier than --before."] },
  "search files": { description: "Search files with normalized bounded rows.", examples: ["slack-axi search files roadmap", "slack-axi search files report --all --max-results 100"], fields: ["id", "name", "mimetype", "size", "timestamp", "user_id", "permalink"], limitMaximum: 1000, defaults: ["--limit 20", "--sort score", "one result page"], incompatibilities: ["--all requires --max-results; --max-results is invalid without --all; --limit conflicts with --all; --after must be earlier than --before."] },
  inbox: { description: "Summarize unread activity with browser-session counts or a bounded user-token fallback.", examples: ["slack-axi inbox --mentions-only", "slack-axi inbox --partner-only --limit 20", "slack-axi inbox --dm-only --include-muted"] , fields: ["conversation_id", "type", "unread", "unread_count", "mentions", "muted", "classification", "last_read", "latest"], limitMaximum: 1000, defaults: ["--limit 20", "muted conversations excluded in browser mode", "user-token mode probes at most 50 conversations and cannot prove mention or mute state"] , incompatibilities: ["--partner-only conflicts with --internal-only; --dm-only conflicts with a non-DM --type."] },
  catchup: { description: "Summarize recent activity across bounded conversations.", examples: ["slack-axi catchup --since 24h", "slack-axi catchup --max-conversations 12 --per-conversation 5"], fields: ["id", "name", "type", "message_count_shown", "messages", "complete"], defaults: ["--since 24h", "--max-conversations 20 (maximum 50)", "--per-conversation 5 (maximum 20)", "omitted conversations are represented by a count and at most five sample rows"] },
  message: { description: "Inspect, cite, stage, and send messages.", examples: ["slack-axi message get T012ABC/C034DEF/1786712345.001200", "slack-axi message send --to '#eng' --text 'Ready'"] },
  "message get": { description: "Fetch a root message or thread reply by stable reference.", examples: ["slack-axi message get T012ABC/C034DEF/1786712345.001200", "slack-axi message get T012ABC/C034DEF/1786712345.001200 --full"], fields: ["ref", "time", "author_id", "author", "text", "text_chars", "text_truncated", "files", "reactions", "permalink"] },
  "message cite": { description: "Build citations for up to 50 message references.", examples: ["slack-axi message cite T012ABC/C034DEF/1786712345.001200", "slack-axi message cite T012ABC/C034DEF/1786712345.001200 T012ABC/C034DEF/1786712350.001201 --full"], fields: ["ref", "author", "conversation_id", "time", "permalink", "text", "text_chars", "text_truncated", "markdown"], defaults: ["message text previews are capped at 600 Unicode characters"] },
  "message send": { description: "Stage or directly apply one message send.", examples: ["slack-axi message send --to '#eng' --text 'Ready'", "slack-axi message send --to @alice --text-file ./note.txt", "slack-axi message send --to C034DEF --text '<!here> deploy paused' --allow-broadcast"], defaults: ["staged only; unfurls disabled", "message text is limited to 40,000 Unicode characters", "broadcast mentions require --allow-broadcast; direct apply also requires a separate policy grant"], incompatibilities: ["Choose exactly one of --text or --text-file."] },
  "message reply": { description: "Stage or directly apply one thread reply.", examples: ["slack-axi message reply --to C034DEF --thread T012ABC/C034DEF/1786712345.001200 --text 'Fixed'", "slack-axi message reply --to C034DEF --thread T012ABC/C034DEF/1786712345.001200 --text-file -", "slack-axi message reply --to C034DEF --thread T012ABC/C034DEF/1786712345.001200 --text '<!subteam^S012ABC> please review' --allow-broadcast"], defaults: ["staged only; unfurls disabled", "message text is limited to 40,000 Unicode characters", "broadcast mentions require --allow-broadcast; direct apply also requires a separate policy grant"], incompatibilities: ["Choose exactly one of --text or --text-file; --to and --thread must name the same conversation."] },
  reaction: { description: "Inspect or safely mutate message reactions.", examples: ["slack-axi reaction list T012ABC/C034DEF/1786712345.001200", "slack-axi reaction add T012ABC/C034DEF/1786712345.001200 eyes"] },
  "reaction list": { description: "List normalized reactions on one message.", examples: ["slack-axi reaction list T012ABC/C034DEF/1786712345.001200", "slack-axi reaction list T012ABC/C034DEF/1786712345.001200 --output json"], fields: ["name", "count", "mine"] },
  "reaction add": { description: "Stage or apply adding one reaction.", examples: ["slack-axi reaction add T012ABC/C034DEF/1786712345.001200 eyes", "slack-axi reaction add T012ABC/C034DEF/1786712345.001200 white_check_mark --apply"] },
  "reaction remove": { description: "Stage or apply removing one reaction.", examples: ["slack-axi reaction remove T012ABC/C034DEF/1786712345.001200 eyes", "slack-axi reaction remove T012ABC/C034DEF/1786712345.001200 eyes --apply"] },
  file: { description: "Inspect, download, or safely upload Slack files.", examples: ["slack-axi file info F012ABC", "slack-axi file get F012ABC --out ./report.pdf"] },
  "file info": { description: "Fetch normalized Slack file metadata.", examples: ["slack-axi file info F012ABC", "slack-axi file info F012ABC --fields id,name,size,mimetype"], fields: ["id", "name", "title", "mimetype", "size", "timestamp", "user_id", "url_private_download", "permalink"] },
  "file get": { description: "Download one Slack file with streaming byte limits and atomic no-clobber semantics.", examples: ["slack-axi file get F012ABC --out ./report.pdf", "slack-axi file get F012ABC --out ./report.pdf --max-bytes 2147483648 --overwrite"], defaults: ["existing destinations are preserved unless --overwrite is supplied"] },
  "file upload": { description: "Stage a bounded immutable snapshot for upload.", examples: ["slack-axi file upload ./report.pdf --to '#eng'", "slack-axi file upload ./report.pdf --to C034DEF --thread T012ABC/C034DEF/1786712345.001200", "slack-axi file upload ./report.pdf --to C034DEF --max-bytes 2147483648"], defaults: ["staged only", "--max-bytes 1073741824 (maximum 5368709120)", "comments are limited to 40,000 Unicode characters and cannot contain URL-like constructs", "broadcast mentions require --allow-broadcast; direct apply also requires a separate policy grant"] },
  "mark-read": { description: "Stage or apply a conversation read marker.", examples: ["slack-axi mark-read '#eng'", "slack-axi mark-read C034DEF --through T012ABC/C034DEF/1786712345.001200"] },
  later: { description: "Use browser-only, private, best-effort Slack Later workflows.", examples: ["slack-axi later list", "slack-axi later complete T012ABC/C034DEF/1786712345.001200"] },
  "later list": { description: "List a bounded, schema-gated page of saved Slack Later items.", examples: ["slack-axi later list", "slack-axi later list --limit 50"], fields: ["ref", "item_id", "item_type", "ts", "state", "date_due", "date_completed", "is_archived"], cursor: true, limitMaximum: 50, defaults: ["--limit 20", "browser authentication required", "continuation cursors carry the cumulative scanned count"] },
  "later complete": { description: "Stage or apply completion of one browser-only Later item.", examples: ["slack-axi later complete T012ABC/C034DEF/1786712345.001200", "slack-axi later complete T012ABC/C034DEF/1786712345.001200 --apply"] },
  "later snooze": { description: "Stage or apply snoozing one browser-only Later item.", examples: ["slack-axi later snooze T012ABC/C034DEF/1786712345.001200 --until 2026-08-21T09:00:00+02:00", "slack-axi later snooze T012ABC/C034DEF/1786712345.001200 --until 2026-08-21T09:00:00+02:00 --apply"] },
  policy: { description: "Manage direct-apply policy.", examples: ["slack-axi policy init", "slack-axi policy validate ./policy.json", "slack-axi policy apply ./policy.json"] },
  "policy init": { description: "Create the conservative global policy.", examples: ["slack-axi policy init", "slack-axi policy show"] },
  "policy show": { description: "Show the effective global policy file.", examples: ["slack-axi policy show", "slack-axi policy show --output json"] },
  "policy validate": { description: "Validate policy JSON without contacting Slack.", examples: ["slack-axi policy validate ./policy.json", "slack-axi policy validate"] },
  "policy apply": { description: "Atomically replace direct-apply policy through the dispatch authorization lock.", examples: ["slack-axi policy apply ./policy.json", "slack-axi policy apply ./.slack-axi-policy.json --project"], defaults: ["replaces global policy; --project replaces the current-directory narrowing policy"] },
  action: { description: "Inspect and process signed staged mutations.", examples: ["slack-axi action list", "slack-axi action show 0198cafe-0000-7000-8000-000000000000"] },
  "action list": { description: "List signed actions and cheap state totals.", examples: ["slack-axi action list", "slack-axi action list --limit 50"], fields: ["id", "operation", "state", "created_at", "expires_at", "revision", "target_ids"], limitMaximum: 1000, defaults: ["--limit 20"] },
  "action show": { description: "Verify and show one signed action.", examples: ["slack-axi action show 0198cafe-0000-7000-8000-000000000000", "slack-axi action show 0198cafe-0000-7000-8000-000000000000 --output json"] },
  "action apply": { description: "Apply one signed action exactly once.", examples: ["slack-axi action apply 0198cafe-0000-7000-8000-000000000000 --approval <base64url-hmac>", "slack-axi action apply 0198cafe-0000-7000-8000-000000000000 --approval <base64url-hmac> --workspace work"] },
  "action reconcile": { description: "Reconcile an unknown remote commit without replaying it.", examples: ["slack-axi action reconcile 0198cafe-0000-7000-8000-000000000000", "slack-axi action reconcile 0198cafe-0000-7000-8000-000000000000 --workspace work"] },
  "action abandon": { description: "Acknowledge and close an unrecoverable unknown action.", examples: ["slack-axi action abandon 0198cafe-0000-7000-8000-000000000000 --approval <base64url-hmac>", "slack-axi action show 0198cafe-0000-7000-8000-000000000000"] },
  "action delete": { description: "Explicitly delete an unverifiable local action directory.", examples: ["slack-axi action delete 0198cafe-0000-7000-8000-000000000000 --force-unverified", "slack-axi action list"] },
  "action gc": { description: "Delete old terminal records and expired creation remnants.", examples: ["slack-axi action gc", "slack-axi action gc --retention-days 7"] },
};

export function commandKey(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

export function decorateHelp(program: Command): void {
  const visit = (command: Command): void => {
    const key = commandKey(command);
    const metadata = COMMAND_METADATA[key];
    if (metadata) {
      command.description(metadata.description);
      const required = [
        ...command.registeredArguments.filter((argument) => argument.required).map((argument) => argument.name()),
        ...command.options.filter((option) => option.mandatory).map((option) => option.flags),
      ];
      const declaredDefaults = command.options
        .filter((option) => option.defaultValue !== undefined)
        .map((option) => `${option.long ?? option.flags} ${String(option.defaultValueDescription ?? option.defaultValue)}`);
      const defaults = [...new Set([...declaredDefaults, ...(metadata.defaults ?? [])])];
      const contract = [
        `  Required values: ${required.length ? required.join(", ") : "none"}`,
        `  Defaults: ${defaults.length ? defaults.join("; ") : "global --output toon; no command-specific defaults"}`,
        `  Incompatible combinations: ${metadata.incompatibilities?.length ? metadata.incompatibilities.join(" ") : "none"}`,
      ].join("\n");
      command.addHelpText("after", `\nContract:\n${contract}\n\nExamples:\n${metadata.examples.map((example) => `  $ ${example}`).join("\n")}\n`);
    }
    for (const child of command.commands) visit(child);
  };
  visit(program);
}
