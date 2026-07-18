# bash completion for the botference launcher.
# Install: source this file from ~/.bashrc, e.g.
#   source "$BOTFERENCE_HOME/completions/botference.bash"
_botference() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "init plan research-plan archive build review service help" -- "$cur") )
    return
  fi
  case "${COMP_WORDS[1]}" in
    review)
      case "$cur" in
        -*) COMPREPLY=( $(compgen -W "--share --service --hosted --port --agents --no-agents --upgrade" -- "$cur") ) ;;
        *)  COMPREPLY=( $(compgen -d -- "$cur") ) ;;
      esac ;;
    service)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "start stop list logs help" -- "$cur") )
      elif [ "$COMP_CWORD" -eq 3 ]; then
        local names=""
        # service names from the per-workspace ledger (cheap sed, no jq)
        [ -f .botference/services.json ] && \
          names=$(sed -n 's/.*"name":[[:space:]]*"\([^"]*\)".*/\1/p' .botference/services.json 2>/dev/null)
        case "${COMP_WORDS[2]}" in
          stop) COMPREPLY=( $(compgen -W "$names --all" -- "$cur") ) ;;
          logs) COMPREPLY=( $(compgen -W "$names" -- "$cur") ) ;;
        esac
      fi ;;
    plan)
      COMPREPLY=( $(compgen -W "-p --claude --claude-interactive --claude-transport=programmatic --claude-transport=tmux --web --share --service --no-auth --port=" -- "$cur") ) ;;
    research-plan|build)
      COMPREPLY=( $(compgen -W "-p --claude --claude-interactive --claude-transport=programmatic --claude-transport=tmux" -- "$cur") ) ;;
  esac
}
complete -F _botference botference
