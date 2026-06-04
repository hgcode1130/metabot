#!/usr/bin/env bash
set -euo pipefail

app_name="${1:-metabot}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
ecosystem_file="$repo_root/ecosystem.config.cjs"

if [[ "$app_name" == "metabot" && -f "$ecosystem_file" ]]; then
  pm2 startOrRestart "$ecosystem_file" --only "$app_name"
else
  pm2 restart "$app_name"
fi

pm2 save --force >/dev/null
