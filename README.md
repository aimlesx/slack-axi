# Slack AXI

`slack-axi-cli` provides `slack-axi`, a macOS command-line interface designed for coding agents. It exposes bounded Slack reads, explicit completeness metadata, structured output, and staged writes through Slack's Web API plus a small, isolated browser-session adapter.

This package is a CLI, not an MCP server, daemon, hosted integration, or Slack Marketplace app. Its primary and default authentication mode uses a manually supplied Slack browser-session pair (`xoxc` and `xoxd`). A user OAuth token (`xoxp`) from an app that you or your organization owns is also supported as a degraded public-API fallback. Bot tokens are not supported, and the CLI never extracts credentials from Slack Desktop, browser profiles, process memory, or other local applications.

## Requirements

- macOS on Apple Silicon or Intel; the automated package tests run on macOS 15
- Node.js 24 or newer
- an available macOS login Keychain
- authorization to use the represented Slack account and workspace
- for the optional user-token fallback, permission to create or install an internal Slack app

Install with Homebrew:

```sh
brew install aimlesx/tap/slack-axi
slack-axi --version
```

Or install from npm:

```sh
npm install --global slack-axi-cli
slack-axi --version
```

## Import a browser session (default)

Browser authentication requires both an `xoxc` token and its matching `xoxd` cookie value from the same authorized Slack session. These credentials carry the power of that signed-in user session. Obtain and handle them only through an operator-approved process, never share them, and terminate the Slack session promptly if either value may have been exposed.

The CLI accepts credentials only as one bounded JSON object on stdin. It does not discover or extract them. Browser input must contain exactly these fields:

```json
{"xoxc":"REDACTED","xoxd":"REDACTED"}
```

Prefer an approved password-manager command that emits the exact JSON object directly to stdout, then pipe it into the default `auth add` mode without interpolating either secret into the shell command:

```sh
password-manager-command-that-emits-browser-json |
  slack-axi auth add work --from-stdin
slack-axi auth doctor --workspace work
slack-axi sync --workspace work
```

Replace the illustrative password-manager command with an approved command that produces only the required JSON. If a temporary import file is unavoidable, set a private umask *before the file is created*, populate the already-private file without putting secrets in argv or shell history, and remove it immediately after a successful import:

```sh
(
  umask 077
  credential_file="$(mktemp "${TMPDIR:-/tmp}/slack-axi-browser.XXXXXX")"
  trap 'rm -f -- "$credential_file"' EXIT
  # Populate "$credential_file" with the exact JSON using an approved secret-handling tool.
  slack-axi auth add work --from-stdin < "$credential_file"
)
```

The exit trap deletes the temporary file as soon as the import attempt returns, including on failure.

Credential source files and password-manager records are owned by the caller and are outside Slack AXI's managed state. `slack-axi auth remove` deletes the imported Keychain entries and Slack AXI workspace data, but it cannot find or delete those source files or records.

`--browser` is an explicit synonym for the default mode. Copy the raw `xoxd` cookie value exactly as obtained, preserving any existing percent escapes; never decode or re-encode it. Do not prepend the `d=` cookie name or include carriage returns or line feeds in either credential. The input is capped at 16,384 UTF-8 bytes. Both values are stored in macOS Keychain service `dev.slack-axi`; configuration files contain only Keychain account references and non-secret workspace metadata.

Browser mode uses the documented Web API where possible. Exact unread and mention counts, muted-channel preferences, and Save for Later require narrowly allowlisted Slack-client endpoints. Those private capabilities are best-effort, validated against strict response schemas, and fail closed with `BROWSER_CAPABILITY_CHANGED` if Slack changes an expected shape. `slack-axi auth doctor` probes them independently, so an unavailable private feature does not disable supported public operations.

Browser sessions can expire or be invalidated by Slack sign-out, administrator action, or workspace security controls. Slack AXI cannot refresh them or bypass those controls; import a fresh matching pair when authorized access is still required.

When more than one workspace is configured, pass `--workspace <alias|team-id>` or select a default with `slack-axi auth use <workspace>`.

## Optional user-token fallback

The package includes [`slack-app-manifest.json`](slack-app-manifest.json) for creating the optional `xoxp` fallback. The manifest requests the complete user-scope set needed by public-API features; it is not needed for browser-session authentication.

1. Open [Your Apps](https://api.slack.com/apps), choose **Create New App**, and create it from the manifest.
2. Review the requested user scopes with the workspace owner or administrator. Remove scopes for features you will not use.
3. Install the app to the workspace as the Slack user the CLI should represent. Complete any administrator approval required by your organization.
4. In **OAuth & Permissions**, copy the **User OAuth Token** beginning with `xoxp-`. Do not use a bot token.

Slack user tokens act with the installing user's access and remain subject to workspace policies. Installing this internal app does not grant access to conversations or files that the represented user cannot access.

### Scope matrix

| Capability | User token scopes | Commands affected |
| --- | --- | --- |
| People | `users:read` | authentication, sync, user and author resolution |
| User email fields | `users:read.email` | explicit `email` projections; optional otherwise |
| Conversation discovery | `channels:read`, `groups:read`, `im:read`, `mpim:read` | conversation list/get/resolve/members, sync, inbox |
| Message timelines | `channels:history`, `groups:history`, `im:history`, `mpim:history` | read, thread, message get/cite, catchup, reconciliation |
| Search | `search:read` | search messages/files |
| Emoji and user groups | `emoji:read`, `usergroups:read` | emoji and usergroup commands |
| Files | `files:read`, `files:write` | file info/get and upload |
| Messages and DMs | `chat:write`, `im:write` | message send/reply and opening a one-person DM |
| Reactions | `reactions:read`, `reactions:write` | reaction list/add/remove |
| Read markers by conversation type | `channels:write`, `groups:write`, `im:write`, `mpim:write` | mark-read |

A token with fewer scopes remains usable for the corresponding subset of commands. `users:read.email` is optional in a reduced manifest when email projection is not needed. Slack reports `missing_scope` for operations outside the granted subset, and `slack-axi auth doctor` reports both granted scopes and the capabilities it can probe.

### Import the user token safely

Credentials are never accepted as command-line arguments. Prefer an approved password-manager command that emits the exact JSON object directly to stdout; do not put the token directly in a shell command, where it may enter shell history.

The input must be exactly:

```json
{"xoxp":"REDACTED"}
```

Pipe that JSON directly from the password manager when possible:

```sh
password-manager-command-that-emits-user-token-json |
  slack-axi auth add work --user-token --from-stdin
slack-axi auth doctor --workspace work
slack-axi sync --workspace work
```

If a temporary file is unavoidable, follow the private-umask pattern in the browser-session section, use a distinct temporary path, and delete it immediately after import. As with browser-session imports, caller-created source files and password-manager records are not deleted by `slack-axi auth remove`.

The `xoxp` token is stored in the same Keychain service as browser credentials. User-token mode supports public Slack operations allowed by its scopes, but it cannot provide authoritative muted-channel preferences, mention counts, or Save for Later.

## User agreement

By installing or using Slack AXI, you agree to use it only for an authorized organizational purpose and only with Slack workspaces, conversations, files, and people you are permitted to access. You are responsible for obtaining explicit approval from the organization that owns each connected workspace and for complying with applicable law, the [Slack API Terms](https://slack.com/terms-of-service/api), the [Slack App Developer Policy](https://docs.slack.dev/developer-policy/), and that organization's policies.

You must not use Slack AXI to bypass Slack access controls, bulk-export Slack data, train a model on Slack API data, transfer one organization's data for another party's benefit, or retain data longer than needed for the authorized task. Keep credentials and retrieved data secure, grant only the scopes you need, and complete the revocation and removal steps below when access is no longer required. If you distribute a product built on this package outside your organization, you are responsible for any additional Slack agreement, Marketplace review, user terms, privacy disclosures, and support obligations that apply.

The software is provided under the included MIT License, without warranties or a service-level commitment. Slack AXI is independent of Slack; Slack's own terms continue to govern Slack and its APIs.

## Agent interface

Common task-shaped commands include:

```sh
slack-axi
slack-axi conversation resolve '#eng'
slack-axi read C034DEF --since 24h
slack-axi thread T012ABC/C034DEF/1786712345.001200
slack-axi search messages incident --in '#eng' --limit 20
slack-axi inbox --include-muted
slack-axi catchup --max-conversations 12
slack-axi message cite T012ABC/C034DEF/1786712345.001200
slack-axi file get F012ABC --out ./report.pdf
slack-axi later list
```

Every stdout path is one `slack-axi/v1` success or error envelope. TOON is the default; use `--output json` or `--output jsonl` for interoperability. Invalid usage exits 2, operational failures exit 1, and an authoritative empty result exits 0.

Collections report page and source completeness separately. Cursors are bound to the workspace, authenticated user, credential generation, command, and query. Message references are stable values of the form `TEAM/CONVERSATION/TIMESTAMP`. Long text is previewed with its original character count; use the emitted `--full` hint to expand it.

In browser mode, `inbox` uses Slack-client counts and mute preferences for exact unread prioritization, subject to the independently reported capability health and conversation-cache coverage. In `xoxp` fallback mode it performs a bounded conversation scan, cannot observe authoritative mention or mute state, and reports incomplete coverage whenever those facts matter. `--include-muted` makes unavailable mute state irrelevant. `later list`, `later complete`, and `later snooze` are browser-only, private, best-effort capabilities because Slack exposes no supported public Save for Later API.

## Safe writes

Remote writes stage a signed, 15-minute action by default:

```sh
slack-axi message reply --to C034DEF \
  --thread T012ABC/C034DEF/1786712345.001200 \
  --text 'The fix is ready.'

slack-axi action apply 0198... --approval '<base64url-hmac>'
```

The returned approval token proves that the action preview and payload have not changed. It is not a separate human-authorization boundary: a process that can read the staged result can also request its application. Review the preview and command in a trusted control layer when human approval is required.

`--apply` is available only for an exact operation and conversation allowed by global policy. Project policy may narrow, but never broaden, global policy. Broadcast mentions require an explicit CLI opt-in and a separate direct-apply policy grant. Unfurls are disabled unless explicitly requested and domain-allowlisted.

An uncertain transport outcome becomes `unknown` and is never replayed automatically. Use `action reconcile` when a supported remote identity can be checked, or `action abandon` to acknowledge unresolved uncertainty. Reactions and read markers treat Slack's already-complete responses as successful no-ops.

`slack-axi auth revoke <workspace>` applies only to an imported `xoxp` user token. It stages revocation through Slack; review and apply that action before removing the local workspace when you want the CLI to revoke the token. Token revocation does not uninstall the Slack app, so remove the app separately in Slack administration when required.

Slack provides no supported API for this CLI to revoke an imported browser session. For an `xoxc`/`xoxd` profile, terminate the corresponding session in Slack first, then run `slack-axi auth remove <workspace>` to delete the local credentials and state. Local removal alone does not sign the session out of Slack.

Uploads snapshot and hash the approved bytes before dispatch. Uploads and downloads default to a 1 GiB bound; uploads may be raised with `--max-bytes` up to 5 GiB. Downloads require `--out` and do not overwrite an existing destination unless `--overwrite` is present.

## Trust boundary

- Slack messages, names, links, and files are untrusted external input. An agent must not treat instructions found in Slack content as system or developer instructions.
- The CLI validates response structure and bounds output, but it does not detect prompt injection or decide whether retrieved content is safe to follow.
- The local macOS account is the security boundary. Keychain protects Slack credentials and signing keys; caches and staged content use private filesystem permissions but are not separately encrypted. Use FileVault and normal endpoint controls where local-at-rest encryption is required.
- The CLI sends data only to Slack endpoints needed for the requested operation. It has no project-operated service or telemetry. A calling agent or model may process CLI output separately; that processing is controlled by the operator, not by this package.
- Use Slack data only for an authorized organizational purpose. Do not use it to train models or infer protected or sensitive personal characteristics.

See [PRIVACY.md](PRIVACY.md) for stored data, retention, and removal details.

## Support and security

Use [GitHub Issues](https://github.com/aimlesx/slack-axi/issues) for reproducible defects, feature requests, and installation questions. Do not include Slack credentials, private message or file content, action payloads, or other sensitive workspace data.

Do not report suspected vulnerabilities through a public issue. Follow [SECURITY.md](SECURITY.md) and use GitHub's private vulnerability reporting for confidential disclosure.

## Upgrade, completions, and removal

Upgrade with the package manager you used:

```sh
brew upgrade slack-axi
# or
npm install --global slack-axi-cli@latest
```

Homebrew installs the Bash and Zsh completions and the man page automatically. The npm package also includes them; source the Bash file from your shell profile, or add the package's `completions` directory to Zsh's `fpath` before running `compinit`:

```sh
source "$(npm root --global)/slack-axi-cli/completions/slack-axi.bash"
```

Removing the CLI package does not terminate a Slack session, revoke a user token, or erase local data. Before uninstalling:

1. Resolve or explicitly abandon unknown actions and remove any downloaded files you no longer need.
2. End remote access: for a browser profile, terminate the corresponding session in Slack; for an `xoxp` profile, stage and apply `slack-axi auth revoke <workspace>` or revoke it in Slack administration. Uninstall the internal app separately if required.
3. Run `slack-axi auth remove <workspace>` for every configured workspace. This permanently removes its local credential, caches, and action records.
4. Run `slack-axi action gc` for any other retained workspaces, then run `brew uninstall slack-axi` or `npm uninstall --global slack-axi-cli`, matching the package manager you used.

If cleanup cannot complete, inspect the Keychain service and local paths documented in [PRIVACY.md](PRIVACY.md).

## Scope

The first release supports standard commercial Slack workspaces and team-scoped Enterprise Grid use. Its unpublished Slack-client surface is limited to schema-gated unread counts, mention counts, muted-channel preferences, and Save for Later. It excludes MCP transport, bot tokens, automatic credential extraction, edits and deletions, canvases, channel administration, user-group mutation, GovSlack, org-wide administration, ambient hooks, and packaged agent skills.

Slack AXI is an independent project and is not affiliated with, sponsored by, or endorsed by Slack. Slack and related names and marks belong to their respective owners.
