#!/usr/bin/env bash
set -euo pipefail

app_name="${1:-metabot}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
ecosystem_file="$repo_root/ecosystem.config.cjs"

resolve_node_interpreter() {
  if [[ -n "${METABOT_NODE_INTERPRETER:-}" && -x "${METABOT_NODE_INTERPRETER:-}" ]]; then
    printf '%s\n' "$METABOT_NODE_INTERPRETER"
    return
  fi

  local current_interpreter
  current_interpreter="$(pm2 jlist | node -e "
const fs = require('node:fs');
const app = JSON.parse(fs.readFileSync(0, 'utf8')).find((item) => item.name === process.argv[1]);
const interpreter = app?.pm2_env?.exec_interpreter;
if (interpreter && interpreter.includes('/')) console.log(interpreter);
" "$app_name")"
  if [[ -n "$current_interpreter" && -x "$current_interpreter" ]]; then
    printf '%s\n' "$current_interpreter"
    return
  fi

  local nvm_node
  nvm_node="$(find "$HOME/.nvm/versions/node" -path '*/bin/node' -type f 2>/dev/null | sort -V | tail -n 1)"
  if [[ -n "$nvm_node" && -x "$nvm_node" ]]; then
    printf '%s\n' "$nvm_node"
    return
  fi

  command -v node
}

if [[ "$app_name" == "metabot" && -f "$ecosystem_file" ]]; then
  export METABOT_NODE_INTERPRETER="$(resolve_node_interpreter)"
  pm2 startOrRestart "$ecosystem_file" --only "$app_name"
else
  pm2 restart "$app_name"
fi

pm2 save --force >/dev/null
