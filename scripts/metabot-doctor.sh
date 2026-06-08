#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
fi

env_file=""
if [[ -n "${METABOT_HOME:-}" && -f "$METABOT_HOME/.env" ]]; then
  env_file="$METABOT_HOME/.env"
elif [[ -f "$(pwd)/.env" ]]; then
  env_file="$(pwd)/.env"
elif [[ -f "$HOME/metabot/.env" ]]; then
  env_file="$HOME/metabot/.env"
fi

api_port=""
api_secret="${API_SECRET:-}"
metabot_url="${METABOT_URL:-}"
if [[ -n "$env_file" ]]; then
  api_port="$(sed -n 's/^API_PORT=//p' "$env_file" 2>/dev/null || true)"
  api_secret="${api_secret:-$(sed -n 's/^API_SECRET=//p' "$env_file" 2>/dev/null || true)}"
  metabot_url="${metabot_url:-$(sed -n 's/^METABOT_URL=//p' "$env_file" 2>/dev/null || true)}"
fi

metabot_url="${metabot_url:-http://localhost:${api_port:-9100}}"
auth_header=()
if [[ -n "$api_secret" ]]; then
  auth_header=(-H "Authorization: Bearer $api_secret")
fi

response="$(curl -sS -w $'\n%{http_code}' "${auth_header[@]}" "$metabot_url/api/doctor" || true)"
http_code="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$http_code" != "200" ]]; then
  message="MetaBot doctor failed: HTTP $http_code"
  if [[ "$json" == "true" ]]; then
    printf '{"status":"error","checks":[{"id":"doctor_api","status":"error","message":%s}]}\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$message")"
  else
    echo "$message"
    [[ -n "$body" ]] && echo "$body"
  fi
  exit 1
fi

if [[ "$json" == "true" ]]; then
  echo "$body"
  exit 0
fi

python3 -c '
import json, sys
payload = json.load(sys.stdin)
report = payload.get("report", payload)
print(f"MetaBot doctor: {report.get(\"status\", \"unknown\")}")
for check in report.get("checks", []):
    print(f"- {check.get(\"status\")}: {check.get(\"id\")} - {check.get(\"message\")}")
' <<< "$body"
