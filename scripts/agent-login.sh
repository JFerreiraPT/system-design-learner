#!/usr/bin/env bash
# One-time interactive Cursor login that persists credentials to a named
# docker volume (`cursor-auth`). All subsequent task containers mount that
# volume read-only so headless `cursor-agent --print` runs use your
# subscription with no API key.
#
# Usage:
#   scripts/agent-login.sh           # run interactive `agent login`
#   scripts/agent-login.sh --status  # show `agent status` from the volume
#   scripts/agent-login.sh --logout  # `agent logout` and clear the volume
#   scripts/agent-login.sh --reset   # destroy the volume entirely

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOLUME_NAME="${CURSOR_AUTH_VOLUME:-cursor-auth}"
IMAGE_TAG="sdl-agent-login:latest"

ACTION="login"
case "${1:-}" in
  --status) ACTION="status" ;;
  --logout) ACTION="logout" ;;
  --reset)  ACTION="reset" ;;
  -h|--help)
    sed -n '1,16p' "$0" | sed 's/^# \?//'
    exit 0
    ;;
  "") ;;
  *) echo "Unknown arg: $1"; exit 1 ;;
esac

ensure_image() {
  echo "Building login image (cached after first run)..."
  docker build -q -t "${IMAGE_TAG}" -f "${ROOT_DIR}/.devcontainer/Dockerfile" "${ROOT_DIR}" >/dev/null
}

ensure_volume() {
  if ! docker volume inspect "${VOLUME_NAME}" >/dev/null 2>&1; then
    docker volume create "${VOLUME_NAME}" >/dev/null
  fi
}

run_in_container() {
  local cmd="$1"
  docker run --rm -it \
    --user node \
    -e HOME=/home/node \
    -v "${VOLUME_NAME}:/home/node/.cursor" \
    --entrypoint bash \
    "${IMAGE_TAG}" \
    -lc "
      set -e
      mkdir -p /home/node/.cursor
      if ! command -v agent >/dev/null 2>&1 && ! command -v cursor-agent >/dev/null 2>&1; then
        echo 'Installing cursor-agent CLI...'
        curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh
        bash /tmp/cursor-install.sh
        export PATH=\"\$HOME/.local/bin:\$PATH\"
      fi
      BIN=\"\$(command -v cursor-agent || command -v agent)\"
      ${cmd}
    "
}

case "${ACTION}" in
  reset)
    docker volume rm -f "${VOLUME_NAME}" >/dev/null 2>&1 || true
    echo "Volume '${VOLUME_NAME}' removed. Run scripts/agent-login.sh to re-login."
    exit 0
    ;;
  status)
    ensure_image
    ensure_volume
    run_in_container '"$BIN" status'
    ;;
  logout)
    ensure_image
    ensure_volume
    run_in_container '"$BIN" logout'
    ;;
  login)
    ensure_image
    ensure_volume
    cat <<'EOM'

================================================================
Starting interactive 'agent login' inside a container.
It will print a URL — open it in your browser to complete login.
Credentials persist in docker volume 'cursor-auth' for all tasks.
================================================================

EOM
    run_in_container '"$BIN" login && "$BIN" status'
    echo
    echo "Login complete. 'pnpm task:start' will now run autonomously with your subscription."
    ;;
esac
