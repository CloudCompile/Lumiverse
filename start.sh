#!/usr/bin/env bash
set -euo pipefail

# ─── Lumiverse Launcher (macOS / Linux) ───────────────────────────────────────
# Usage:
#   ./start.sh                  Start backend, serve pre-built frontend (default)
#   ./start.sh -b|--build       Rebuild frontend before starting backend
#   ./start.sh --build-only     Build frontend only, don't start backend
#   ./start.sh --backend-only   Start backend only, skip frontend serving
#   ./start.sh --dev            Start backend in watch mode (no frontend build)
#   ./start.sh --setup          Run setup wizard only
#   ./start.sh -m|--migrate-st  Run SillyTavern migration helper
#   ./start.sh --no-runner      Start without the visual runner
#
# Environment overrides:
#   FRONTEND_PATH   Path to frontend directory (default: ./frontend)
# ──────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[error]${NC} $*" >&2; }

# ─── Parse arguments ─────────────────────────────────────────────────────────

MODE="all"  # all | build-only | backend-only | dev | setup | migrate-st
USE_RUNNER=true
FORCE_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --build|-b)     FORCE_BUILD=true ;;
    --build-only)   MODE="build-only" ;;
    --backend-only) MODE="backend-only" ;;
    --dev)          MODE="dev" ;;
    --setup)        MODE="setup" ;;
    --migrate-st|-m) MODE="migrate-st" ;;
    --no-runner)    USE_RUNNER=false ;;
    --help|-h)
      sed -n '3,15p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) err "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ─── Resolve paths ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR"
FRONTEND_DIR="${FRONTEND_PATH:-$SCRIPT_DIR/frontend}"

# ─── Ensure Bun is installed ────────────────────────────────────────────────

ensure_bun() {
  if command -v bun &>/dev/null; then
    ok "Bun $(bun --version) found"
    return
  fi

  warn "Bun not found. Installing..."

  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    err "On Windows, please run start.ps1 instead, or install Bun manually:"
    err "  powershell -c \"irm bun.sh/install.ps1 | iex\""
    exit 1
  fi

  curl -fsSL https://bun.sh/install | bash

  # ── Make bun available in this session ──────────────────────────────────
  # The installer modifies shell profiles but we can't rely on re-sourcing
  # them (non-interactive shells hit the early-exit guard in .bashrc).
  # Instead we manually wire up the PATH the same way the installer does.

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  # Newer Bun installers create a dedicated env file — source it if present
  [[ -f "$BUN_INSTALL/env" ]] && source "$BUN_INSTALL/env"

  if command -v bun &>/dev/null; then
    ok "Bun $(bun --version) installed successfully"
    return
  fi

  # Last resort: the binary exists but isn't resolving through PATH.
  # Try common install locations directly.
  local try_paths=(
    "$BUN_INSTALL/bin/bun"
    "$HOME/.bun/bin/bun"
  )
  for try in "${try_paths[@]}"; do
    if [[ -x "$try" ]]; then
      ok "Bun $("$try" --version) installed (using direct path: $try)"
      # Make it available for every subsequent call in this script
      export PATH="$(dirname "$try"):$PATH"
      return
    fi
  done

  err "Bun installation failed. Please install manually: https://bun.sh"
  exit 1
}

# ─── First-run setup wizard ─────────────────────────────────────────────────

run_setup_if_needed() {
  local identity_file="$BACKEND_DIR/data/lumiverse.identity"
  local env_file="$BACKEND_DIR/.env"

  # Run wizard if identity file or .env doesn't exist
  if [[ ! -f "$identity_file" || ! -f "$env_file" ]]; then
    info "First run detected — launching setup wizard..."
    echo ""
    install_deps "$BACKEND_DIR" "backend"
    (cd "$BACKEND_DIR" && bun run scripts/setup-wizard.ts)
  fi
}

run_setup() {
  install_deps "$BACKEND_DIR" "backend"
  (cd "$BACKEND_DIR" && bun run scripts/setup-wizard.ts)
}

run_migrate_st() {
  install_deps "$BACKEND_DIR" "backend"
  info "Launching SillyTavern migration helper..."
  (cd "$BACKEND_DIR" && bun run migrate:st)
}

# ─── Install dependencies ───────────────────────────────────────────────────

install_deps() {
  local dir="$1"
  local name="$2"

  info "Installing $name dependencies..."
  (cd "$dir" && bun install)
  ok "$name dependencies installed"
}

# ─── Build frontend ─────────────────────────────────────────────────────────

build_frontend() {
  if [[ ! -d "$FRONTEND_DIR" ]]; then
    err "Frontend directory not found at: $FRONTEND_DIR"
    err "Set FRONTEND_PATH to the correct location."
    exit 1
  fi

  install_deps "$FRONTEND_DIR" "frontend"

  info "Building frontend..."
  (cd "$FRONTEND_DIR" && bun run build)
  ok "Frontend built -> $FRONTEND_DIR/dist"
}

# ─── Start backend ──────────────────────────────────────────────────────────

start_backend() {
  local frontend_dist=""

  # Point to frontend dist if it exists (skip in dev mode — Vite proxies)
  if [[ "$MODE" != "dev" && -d "$FRONTEND_DIR/dist" ]]; then
    frontend_dist="$FRONTEND_DIR/dist"
    info "Serving frontend from: $frontend_dist"
  elif [[ "$MODE" != "dev" ]]; then
    warn "No frontend build found. Backend will start without serving frontend."
    warn "Run './start.sh --build-only' first, or use './start.sh' to build + start."
  fi

  install_deps "$BACKEND_DIR" "backend"

  # Export FRONTEND_DIR for the backend process
  export FRONTEND_DIR="$frontend_dist"

  # Load .env for PORT and other vars
  if [[ -f "$BACKEND_DIR/.env" ]]; then
    set -a
    source "$BACKEND_DIR/.env"
    set +a
  fi

  # Decide: visual runner or plain process
  if [[ "$USE_RUNNER" == true ]] && [[ -t 1 ]]; then
    # Interactive terminal — use the visual runner
    local runner_args=""
    if [[ "$MODE" == "dev" ]]; then
      runner_args="-- --dev"
    fi
    (cd "$BACKEND_DIR" && bun run scripts/runner.ts $runner_args)
  else
    # Non-interactive (piped, CI, --no-runner) — plain process
    echo ""
    echo -e "${BOLD}Starting Lumiverse Backend on port ${PORT:-7860}...${NC}"
    echo ""

    if [[ "$MODE" == "dev" ]]; then
      (cd "$BACKEND_DIR" && bun run dev)
    else
      (cd "$BACKEND_DIR" && bun run start)
    fi
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Lumiverse${NC} — Launcher"
echo ""

ensure_bun

case "$MODE" in
  all)
    run_setup_if_needed
    if [[ "$FORCE_BUILD" == true ]]; then
      build_frontend
    fi
    start_backend
    ;;
  build-only)
    build_frontend
    ;;
  backend-only)
    run_setup_if_needed
    start_backend
    ;;
  dev)
    run_setup_if_needed
    start_backend
    ;;
  setup)
    run_setup
    ;;
  migrate-st)
    run_migrate_st
    ;;
esac
