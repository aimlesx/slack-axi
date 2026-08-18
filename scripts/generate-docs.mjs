import { writeFile } from "node:fs/promises";
import { COMMAND_METADATA } from "../dist/metadata.js";
import { VERSION } from "../dist/version.js";

const keys = Object.keys(COMMAND_METADATA).filter(Boolean);
const roots = [...new Set(keys.map((key) => key.split(" ")[0]))];
const children = Object.fromEntries(roots.map((root) => [root, keys
  .filter((key) => key.startsWith(`${root} `) && key.split(" ").length === 2)
  .map((key) => key.split(" ")[1])]));
const globalFlags = "--workspace --output --fields --limit --cursor --full --verbose --help --version -v -V";

const zshChildren = Object.entries(children)
  .filter(([, commands]) => commands.length)
  .map(([root, commands]) => `      ${root}) _values 'subcommand' ${commands.join(" ")} ;;`)
  .join("\n");

const zsh = `#compdef slack-axi

local -a roots
roots=(${roots.join(" ")})

_arguments -C \\
  '--workspace[workspace alias or team ID]:workspace:' \\
  '--output[structured output format]:format:(toon json jsonl)' \\
  '--fields[validated comma-separated result fields]:fields:' \\
  '--limit[collection bound]:number:' \\
  '--cursor[stable continuation cursor]:cursor:' \\
  '--full[return complete long-text fields]' \\
  '--verbose[emit redacted diagnostics]' \\
  '1:command:(${roots.join(" ")})' \\
  '*::argument:->args'

case $state in
  args)
    case $words[2] in
${zshChildren}
    esac
  ;;
esac
`;

const bashChildren = Object.entries(children)
  .filter(([, commands]) => commands.length)
  .map(([root, commands]) => `      ${root}) candidates="${commands.join(" ")}" ;;`)
  .join("\n");

const bash = `_slack_axi_complete() {
  local candidates="${roots.join(" ")} ${globalFlags}"
  if [[ $COMP_CWORD -eq 2 ]]; then
    case "${"${COMP_WORDS[1]}"}" in
${bashChildren}
      *) candidates="${globalFlags}" ;;
    esac
  elif [[ $COMP_CWORD -gt 2 ]]; then
    candidates="${globalFlags}"
  fi
  COMPREPLY=($(compgen -W "$candidates" -- "${"${COMP_WORDS[COMP_CWORD]}"}"))
}
complete -F _slack_axi_complete slack-axi
`;

const commandSections = keys.map((key) => {
  const metadata = COMMAND_METADATA[key];
  const examples = metadata.examples.map((example) => `.nf\n${example}\n.fi`).join("\n");
  const defaults = metadata.defaults?.length ? metadata.defaults.join("; ") : "Global --output toon; no command-specific defaults.";
  const incompatibilities = metadata.incompatibilities?.length ? metadata.incompatibilities.join(" ") : "None.";
  return `.SS ${key.toUpperCase()}\n${metadata.description}\n.PP\nDefaults: ${defaults}\n.br\nIncompatible combinations: ${incompatibilities}\n${examples}`;
}).join("\n");

const man = `.TH SLACK-AXI 1 "August 19, 2026" "slack-axi-cli ${VERSION}" "User Commands"
.SH NAME
slack-axi \- agent-facing Slack CLI with bounded reads and signed staged writes
.SH SYNOPSIS
.B slack-axi
[global options] command [command options]
.SH DESCRIPTION
Every stdout path is one slack-axi/v1 envelope encoded as strict TOON by default, or JSON/JSONL when requested. Operational failures exit 1 and invalid usage exits 2. Diagnostics appear on stderr only with --verbose.
.SH GLOBAL OPTIONS
--workspace selects a configured alias or team ID. --output defaults to toon. --fields validates command-specific field names. --limit bounds collections. --cursor continues stable pages. --full expands long text. --verbose enables redacted diagnostics.
.SH COMMANDS
${commandSections}
.SH ACTION SAFETY
Staged actions expire after 15 minutes and are approved with --approval BASE64URL-HMAC. Unknown commits are never replayed. Use action reconcile when a remote identity exists or action abandon to acknowledge unresolved uncertainty.
.SH FILES
~/Library/Application Support/slack-axi/config.json
.br
~/Library/Application Support/slack-axi/policy.json
.br
~/Library/Application Support/slack-axi/actions/
.br
~/Library/Caches/slack-axi/
.SH KEYCHAIN
Service dev.slack-axi. The local action signing account is local:action-signing:v1.
.SH SEE ALSO
README.md, PRIVACY.md, SECURITY.md, slack-app-manifest.json
`;

await Promise.all([
  writeFile("completions/_slack-axi", zsh),
  writeFile("completions/slack-axi.bash", bash),
  writeFile("docs/slack-axi.1", man),
]);
