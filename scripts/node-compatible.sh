#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED_MAJOR="${METABOT_NODE_MAJOR:-22}"
BUILD_ENV_DIR="${METABOT_NATIVE_BUILD_ENV:-$ROOT_DIR/.cache/native-build-node${REQUIRED_MAJOR}-sysroot228-v2}"

NODE_BIN=""
NPM_CLI=""

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  bash scripts/node-compatible.sh install [npm install args]
  bash scripts/node-compatible.sh rebuild-native [npm rebuild args]
  bash scripts/node-compatible.sh npm <npm args>
  bash scripts/node-compatible.sh npx <package-bin> [args...]
  bash scripts/node-compatible.sh exec <command> [args...]

Environment:
  METABOT_NODE_MAJOR      Required Node major version. Default: 22
  METABOT_COMPAT_NODE     Absolute path to the compatible node binary.
  METABOT_NPM_NODE        Backward-compatible alias for METABOT_COMPAT_NODE.
  METABOT_NODE_INTERPRETER Backward-compatible alias for METABOT_COMPAT_NODE.
  METABOT_CXX             Absolute path to a C++20 compiler.
  METABOT_NATIVE_BUILD_ENV Conda prefix used for the build compiler.
USAGE
}

node_major() {
  "$1" -p "process.versions.node.split('.')[0]"
}

npm_cli_for_node() {
  local node_bin="$1"
  local node_prefix
  node_prefix="$(cd "$(dirname "$node_bin")/.." && pwd)"

  local cli="$node_prefix/lib/node_modules/npm/bin/npm-cli.js"
  [[ -f "$cli" ]] || die "npm CLI is missing for $node_bin: $cli"
  printf '%s\n' "$cli"
}

validate_node() {
  local var_name="$1"
  local node_bin="$2"

  [[ -x "$node_bin" ]] || die "$var_name is not executable: $node_bin"
  local major
  major="$(node_major "$node_bin")"
  [[ "$major" == "$REQUIRED_MAJOR" ]] || die "$var_name must point to Node ${REQUIRED_MAJOR}.x, got $("$node_bin" -v)"
}

choose_env_node() {
  local var_name
  for var_name in METABOT_COMPAT_NODE METABOT_NPM_NODE METABOT_NODE_INTERPRETER; do
    local node_bin="${!var_name:-}"
    [[ -n "$node_bin" ]] || continue
    validate_node "$var_name" "$node_bin"
    printf '%s\n' "$node_bin"
    return 0
  done
  return 1
}

choose_discovered_node() {
  local candidate
  if [[ -d "${HOME:-}/.nvm/versions/node" ]]; then
    while IFS= read -r candidate; do
      [[ -x "$candidate" ]] || continue
      [[ "$(node_major "$candidate")" == "$REQUIRED_MAJOR" ]] || continue
      printf '%s\n' "$candidate"
      return 0
    done < <(find "$HOME/.nvm/versions/node" -path '*/bin/node' -type f | sort -Vr)
  fi

  candidate="$(command -v node || true)"
  if [[ -n "$candidate" && -x "$candidate" && "$(node_major "$candidate")" == "$REQUIRED_MAJOR" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

choose_node() {
  choose_env_node && return
  choose_discovered_node && return
  die "Node ${REQUIRED_MAJOR}.x is required. Set METABOT_COMPAT_NODE=/path/to/node${REQUIRED_MAJOR}."
}

supports_cxx20() {
  printf '#include <ctime>\nint main() { timespec ts{}; return timespec_get(&ts, TIME_UTC); }\n' \
    | "$1" -x c++ -std=c++20 -fsyntax-only - >/dev/null 2>&1
}

install_build_compiler() {
  conda "$1" -y --solver libmamba --override-channels -p "$BUILD_ENV_DIR" -c conda-forge \
    gxx_linux-64=15 sysroot_linux-64=2.28 make pkg-config >&2
}

ensure_build_compiler() {
  if [[ -n "${METABOT_CXX:-}" ]]; then
    supports_cxx20 "$METABOT_CXX" || die "METABOT_CXX does not support -std=c++20: $METABOT_CXX"
    printf '%s\n' "$METABOT_CXX"
    return
  fi

  local conda_cxx="$BUILD_ENV_DIR/bin/x86_64-conda-linux-gnu-g++"
  if [[ ! -x "$conda_cxx" ]]; then
    command -v conda >/dev/null || die "conda is required to provision a C++20 compiler at $BUILD_ENV_DIR"
    install_build_compiler create
  fi

  if ! supports_cxx20 "$conda_cxx"; then
    install_build_compiler install
  fi
  supports_cxx20 "$conda_cxx" || die "Provisioned compiler does not support -std=c++20: $conda_cxx"
  printf '%s\n' "$conda_cxx"
}

configure_node_env() {
  cd "$ROOT_DIR"
  NODE_BIN="$(choose_node)"
  NPM_CLI="$(npm_cli_for_node "$NODE_BIN")"

  local node_bin_dir
  node_bin_dir="$(dirname "$NODE_BIN")"
  export PATH="$ROOT_DIR/node_modules/.bin:$node_bin_dir:$PATH"
  export npm_config_node="$NODE_BIN"
}

configure_build_env() {
  local cxx_bin
  cxx_bin="$(ensure_build_compiler)"

  export PATH="$(dirname "$cxx_bin"):$PATH"
  export CC="${cxx_bin%++}cc"
  export CXX="$cxx_bin"
  export LDFLAGS="${LDFLAGS:-} -static-libstdc++ -static-libgcc"
  export npm_config_fetch_timeout="${npm_config_fetch_timeout:-600000}"
  export npm_config_build_from_source="${npm_config_build_from_source:-true}"
}

print_runtime() {
  printf 'Using Node: %s (%s)\n' "$NODE_BIN" "$("$NODE_BIN" -v)" >&2
  printf 'Using npm:  %s (%s)\n' "$NPM_CLI" "$("$NODE_BIN" "$NPM_CLI" -v)" >&2
}

print_build_runtime() {
  print_runtime
  printf 'Using CXX:  %s\n' "$CXX" >&2
}

run_npm() {
  "$NODE_BIN" "$NPM_CLI" "$@"
}

rebuild_native() {
  [[ -d "$ROOT_DIR/node_modules/better-sqlite3" ]] || die "better-sqlite3 is missing after npm install"
  run_npm rebuild better-sqlite3 --build-from-source "$@"
}

run_exec() {
  [[ "$#" -gt 0 ]] || die "exec requires a command"
  exec "$@"
}

main() {
  local subcommand="${1:-install}"
  if [[ "$subcommand" == "-h" || "$subcommand" == "--help" ]]; then
    usage
    return
  fi
  [[ "$#" -gt 0 ]] && shift

  configure_node_env
  case "$subcommand" in
    install)
      configure_build_env
      print_build_runtime
      run_npm install --include=dev "$@"
      rebuild_native
      ;;
    rebuild-native)
      configure_build_env
      print_build_runtime
      rebuild_native "$@"
      ;;
    npm)
      [[ "$#" -gt 0 ]] || die "npm requires arguments"
      print_runtime
      run_npm "$@"
      ;;
    npx)
      [[ "$#" -gt 0 ]] || die "npx requires a package binary"
      print_runtime
      run_npm exec -- "$@"
      ;;
    exec)
      print_runtime
      run_exec "$@"
      ;;
    *)
      usage
      die "unknown subcommand: $subcommand"
      ;;
  esac
}

main "$@"
