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
#   ./start.sh --reset-password  Reset owner account password
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

# ─── Platform detection ─────────────────────────────────────────────────────

IS_TERMUX=false
IS_PROOT=false

# Detect native Termux: $PREFIX is always set in Termux shell sessions
if [[ -n "${PREFIX:-}" && -d "/data/data/com.termux" ]]; then
  IS_TERMUX=true
# Detect proot-distro inside Termux (running a full Linux distro)
elif [[ -f "/etc/os-release" && -d "/data/data/com.termux" ]] 2>/dev/null; then
  IS_PROOT=true
fi

# ─── Parse arguments ─────────────────────────────────────────────────────────

MODE="all"  # all | build-only | backend-only | dev | setup | reset-password | migrate-st
USE_RUNNER=true
FORCE_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --build|-b)     FORCE_BUILD=true ;;
    --build-only)   MODE="build-only" ;;
    --backend-only) MODE="backend-only" ;;
    --dev)          MODE="dev" ;;
    --setup)        MODE="setup" ;;
    --reset-password) MODE="reset-password" ;;
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

# Try to find bun in PATH or common install locations.
# Called at the start and after install attempts.
_resolve_bun() {
  # Load Bun env early — catches cases where Bun was previously installed
  # but the current shell session hasn't sourced the profile yet.
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  [[ -f "$BUN_INSTALL/env" ]] && source "$BUN_INSTALL/env"

  if command -v bun &>/dev/null; then
    return 0
  fi

  # Fallback: check common locations directly (covers proot /root/.bun, etc.)
  local try_paths=(
    "$BUN_INSTALL/bin/bun"
    "$HOME/.bun/bin/bun"
    "/root/.bun/bin/bun"
  )
  for try in "${try_paths[@]}"; do
    if [[ -x "$try" ]]; then
      export PATH="$(dirname "$try"):$PATH"
      return 0
    fi
  done

  return 1
}

# Install Termux prerequisites for running glibc-linked Bun binaries.
# Bun is compiled against glibc, but Termux uses Android's bionic libc.
# We need glibc-runner to bridge the gap, plus bun-termux for a proper
# wrapper that handles /proc/self/exe, hardlink stubs, and path remapping.
_install_bun_termux() {
  info "Termux detected — installing Bun with glibc compatibility layer..."

  # Ensure pkg is up to date and install glibc prerequisites
  if ! command -v pkg &>/dev/null; then
    err "Termux 'pkg' package manager not found."
    exit 1
  fi

  info "Installing Termux prerequisites (glibc-repo, glibc-runner, build-essential)..."
  pkg update -y
  pkg install -y git curl build-essential glibc-repo glibc-runner

  # The official Bun installer downloads the linux-aarch64 glibc binary,
  # which is exactly what we need — glibc-runner will execute it.
  touch "$HOME/.bashrc" 2>/dev/null || true
  curl -fsSL https://bun.sh/install | bash
  source "$HOME/.bashrc" 2>/dev/null || true

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  [[ -f "$BUN_INSTALL/env" ]] && source "$BUN_INSTALL/env"

  # Install bun-termux wrapper (userland-exec + LD_PRELOAD shim)
  # This replaces the raw bun binary with a wrapper that:
  #   - Loads glibc's ld-linux via userland exec (fixes /proc/self/exe)
  #   - Intercepts syscalls for Android filesystem compatibility
  #   - Remaps shebang paths to Termux prefix
  if [[ ! -d "$HOME/.bun-termux" ]]; then
    info "Installing bun-termux wrapper..."
    git clone https://github.com/Happ1ness-dev/bun-termux.git "$HOME/.bun-termux"
    (cd "$HOME/.bun-termux" && make && make install)
    ok "bun-termux wrapper installed"
  else
    info "bun-termux wrapper already present, skipping..."
  fi
}

ensure_bun() {
  # ── Try to resolve an existing Bun installation ──────────────────────────
  if _resolve_bun; then
    ok "Bun $(bun --version) found"
    return
  fi

  # ── No Bun found — install it ───────────────────────────────────────────
  warn "Bun not found. Installing..."

  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    err "On Windows, please run start.ps1 instead, or install Bun manually:"
    err "  powershell -c \"irm bun.sh/install.ps1 | iex\""
    exit 1
  fi

  if [[ "$IS_TERMUX" == true ]]; then
    _install_bun_termux
  else
    curl -fsSL https://bun.sh/install | bash
  fi

  # ── Make bun available in this session ──────────────────────────────────
  if _resolve_bun; then
    ok "Bun $(bun --version) installed successfully"
    return
  fi

  # ── Installation failed ─────────────────────────────────────────────────
  if [[ "$IS_TERMUX" == true ]]; then
    err "Bun installation failed on Termux."
    err "You can also try running inside proot-distro:"
    err "  pkg install proot-distro && proot-distro install ubuntu"
    err "  proot-distro login ubuntu"
    err "  # Then re-run this script inside the Ubuntu environment"
  else
    err "Bun installation failed. Please install manually: https://bun.sh"
  fi
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

run_reset_password() {
  install_deps "$BACKEND_DIR" "backend"
  info "Launching password reset..."
  (cd "$BACKEND_DIR" && bun run reset-password)
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

  if [[ "$IS_TERMUX" == true ]]; then
    # Android doesn't support hardlinks — use file copy backend instead.
    # Without this, bun install fails with EPERM on node_modules linking.
    (cd "$dir" && bun install --backend=copyfile)
  else
    (cd "$dir" && bun install)
  fi

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
    (cd "$BACKEND_DIR" && bun run scripts/runner.tsx $runner_args)
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

if [[ "$IS_TERMUX" == true ]]; then
  info "Running on Termux (Android)"
elif [[ "$IS_PROOT" == true ]]; then
  info "Running inside proot-distro (Android)"
fi

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
  reset-password)
    run_reset_password
    ;;
  migrate-st)
    run_migrate_st
    ;;
esac
