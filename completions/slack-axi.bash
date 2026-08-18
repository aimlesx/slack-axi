_slack_axi_complete() {
  local candidates="auth sync conversation user usergroup emoji read thread search inbox catchup message reaction file mark-read later policy action --workspace --output --fields --limit --cursor --full --verbose --help --version -v -V"
  if [[ $COMP_CWORD -eq 2 ]]; then
    case "${COMP_WORDS[1]}" in
      auth) candidates="add list use revoke remove doctor" ;;
      conversation) candidates="list get resolve members" ;;
      user) candidates="search get" ;;
      usergroup) candidates="list members" ;;
      emoji) candidates="search" ;;
      search) candidates="messages files" ;;
      message) candidates="get cite send reply" ;;
      reaction) candidates="list add remove" ;;
      file) candidates="info get upload" ;;
      later) candidates="list complete snooze" ;;
      policy) candidates="init show validate apply" ;;
      action) candidates="list show apply reconcile abandon delete gc" ;;
      *) candidates="--workspace --output --fields --limit --cursor --full --verbose --help --version -v -V" ;;
    esac
  elif [[ $COMP_CWORD -gt 2 ]]; then
    candidates="--workspace --output --fields --limit --cursor --full --verbose --help --version -v -V"
  fi
  COMPREPLY=($(compgen -W "$candidates" -- "${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _slack_axi_complete slack-axi
