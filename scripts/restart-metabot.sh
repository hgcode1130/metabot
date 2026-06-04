#!/usr/bin/env bash
set -euo pipefail

app_name="${1:-metabot}"

pm2 restart "$app_name"
