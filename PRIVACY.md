# Privacy and local data

This document describes the data behavior of `slack-axi-cli` 0.1.0. The CLI runs locally on your Mac. There is no project-operated service, account system, analytics endpoint, or telemetry collector.

The CLI sends authenticated requests directly to Slack only when a command requires them. Common operations use Slack's documented Web API and Slack file hosts. Browser profiles additionally use a small allowlist of Slack-client endpoints for unread and mention counts, muted-channel preferences, and Save for Later. Those private calls are best-effort, schema-gated, and fail closed on an unexpected response shape. Redacted `--verbose` diagnostics are written to the invoking process's stderr.

## Authorization and credentials

`slack-axi` uses a manually imported Slack browser-session pair (`xoxc` plus matching `xoxd`) as its primary and default authentication mode. These credentials carry the power of the represented signed-in Slack session. The CLI also supports user OAuth tokens (`xoxp`) issued by a Slack app that the operator or organization owns and authorizes as a degraded public-API fallback. Either mode can access only resources available to the represented user and permitted by Slack and workspace policy.

Credential input is accepted only as one strict JSON object on stdin and is capped at 16,384 UTF-8 bytes. Tokens and cookies are never accepted as command-line arguments. The CLI does not extract credentials from Slack Desktop, browser profiles, process memory, or other local applications. Imported `xoxc`, `xoxd`, and `xoxp` values and the local action-signing key are stored in macOS Keychain service `dev.slack-axi`; configuration and cache files store neither credential values nor authorization headers.

The command or file that supplies stdin is controlled by the caller and is not Slack AXI-managed storage. Prefer piping the exact JSON object from an approved password manager. If a temporary source file is unavoidable, activate `umask 077` before creating it and delete it immediately after a successful import. `slack-axi auth remove` removes imported Keychain entries and Slack AXI workspace state; it cannot discover or delete caller-created credential files, password-manager records, shell logs, or other external copies.

The package does not implement OAuth installation, token refresh, browser-session refresh, automatic session discovery, or Slack app uninstallation. Browser sessions can expire or be invalidated by Slack sign-out, administrator action, or workspace security controls; the CLI does not bypass those controls. The organization operating an internal fallback app is responsible for administrator approval, scope review, and token rotation. `slack-axi auth revoke <workspace>` stages supported `xoxp` revocation through Slack, but does not uninstall the app. Slack provides no supported API for this CLI to revoke an imported browser session; terminate that session in Slack before removing its local profile. `slack-axi auth remove <workspace>` removes local credentials and state without contacting Slack and, by itself, does not terminate remote access.

## Local storage

The CLI creates:

- `~/Library/Application Support/slack-axi/` for workspace configuration, policy, signed actions, and cleanup bookkeeping;
- `~/Library/Caches/slack-axi/` for bounded Slack cache snapshots; and
- Keychain service `dev.slack-axi` for browser-session credentials, user tokens, and the action-signing key.

Application and cache directories use mode `0700`; regular state files use mode `0600`. State updates use private temporary files and atomic replacement. These permissions limit access to the local account but do not separately encrypt cached or staged content. FileVault or equivalent endpoint encryption is recommended when local-at-rest encryption is required.

Configuration can contain workspace aliases, team and actor identifiers and names, timezone, capability results, Keychain account names, and pending-cleanup records. Cache snapshots can contain Slack member profile fields, including email when that optional scope was granted and explicitly returned; conversation names, topics and purposes; custom emoji metadata; and bounded read-state summaries. Cache scopes are separated by team, actor, and credential generation. The entity cache does not store message-history bodies.

Files downloaded by `file get` are written to the destination selected by the caller and are not managed as cache data.

## Staged actions and uploads

A staged action can temporarily store its preview and payload, including message text, target identifiers, and signed integrity metadata. A staged upload stores a private snapshot of the approved file bytes. Plans expire after 15 minutes and cannot be applied after expiry.

Replayable preview, payload, and upload content is removed when an action becomes `applied`, `not_applied`, `abandoned`, or `expired`, and immediately after an uncertain non-idempotent dispatch. Signed plan, state, target, result, error, and reconciliation metadata can remain after content removal. That retained metadata can include Slack identifiers, timestamps, hashes, and non-content recovery details.

There is no background daemon. A forgotten planned action is marked expired and cleaned when it is next read, listed, applied, or processed by `action gc`. `slack-axi action gc` removes terminal action records older than the requested retention period, 30 days by default. `slack-axi action delete <id> --force-unverified` explicitly removes an action directory that cannot be signature-verified. Removing a workspace profile permanently purges all of that workspace's action records, including unresolved records; it does not remove user-selected downloads.

## Retention and removal

Cache snapshots have no automatic time-based deletion. Replacing credentials purges cached actor and credential-generation scopes for the affected Slack team while retaining unrelated teams. Completing `slack-axi auth remove <workspace>` purges that workspace's local credential, caches, and action records through a crash-recoverable removal tombstone. Cleanup that cannot be completed is recorded and reported; `auth doctor` retries pending local cleanup.

Uninstalling the CLI package through Homebrew or npm does not remove Keychain entries, application data, caches, actions, Slack-side authorization, or downloaded files. To remove access and retained data:

1. Resolve or explicitly abandon uncertain actions, and delete downloads you no longer need.
2. End remote access: terminate a browser profile's corresponding session in Slack, or stage and apply `slack-axi auth revoke <workspace>` for an `xoxp` profile (alternatively revoke it through Slack administration). Uninstall the internal app separately if required.
3. Run `slack-axi auth remove <workspace>` for every configured workspace to remove its local credential, caches, and action records.
4. Run `slack-axi action gc` and explicitly delete unwanted records belonging to any other retained workspace.
5. Uninstall the CLI package with the package manager you used.

If CLI cleanup cannot complete, use macOS Keychain Access and Finder to inspect and remove the Keychain service and directories listed above. Deleting local data cannot delete messages, files, reactions, or other changes already committed to Slack.

Report suspected vulnerabilities through the confidential process in [SECURITY.md](SECURITY.md), never through a public issue. Do not include credentials or private Slack content unless a maintainer explicitly requests the minimum evidence needed for investigation.

## Agent and model processing

Slack messages, profiles, links, and files returned by the CLI are untrusted external input. The CLI validates response structure and bounds output; it does not detect prompt injection or determine whether content is safe for an agent to follow.

The package itself does not send Slack data to an AI provider. A calling coding agent, model host, terminal logger, or automation system can separately receive and retain stdout, stderr, and downloaded files. The operator is responsible for that system's data-processing terms, retention, training controls, organization authorization, and access policy. Slack data must not be used to train models or to infer protected or sensitive personal characteristics.

## Independence and trademarks

Slack AXI is an independent project and is not affiliated with, sponsored by, or endorsed by Slack. Slack and related names and marks belong to their respective owners.
