# bash completion for the botference launcher.
# Install: source this file from ~/.bashrc, e.g.
#   source "$BOTFERENCE_HOME/completions/botference.bash"
_botference() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "init plan research-plan archive build review help" -- "$cur") )
    return
  fi
  case "${COMP_WORDS[1]}" in
    review)
      case "$cur" in
        -*) COMPREPLY=( $(compgen -W "--share --hosted --port --agents --no-agents --upgrade" -- "$cur") ) ;;
        *)  COMPREPLY=( $(compgen -d -- "$cur") ) ;;
      esac ;;
    plan)
      COMPREPLY=( $(compgen -W "-p --claude --claude-interactive --claude-transport=programmatic --claude-transport=tmux --web --share --no-auth --port=" -- "$cur") ) ;;
    research-plan|build)
      COMPREPLY=( $(compgen -W "-p --claude --claude-interactive --claude-transport=programmatic --claude-transport=tmux" -- "$cur") ) ;;
  esac
}
complete -F _botference botference
