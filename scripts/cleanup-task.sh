#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVCONTAINER_BIN="${DEVCONTAINER_BIN:-devcontainer}"

usage() {
  echo "Usage: $0 <issue-number> [--force]"
  exit 1
}

[[ $# -lt 1 ]] && usage
ISSUE_NUMBER="${1:-}"
FORCE="${2:-}"
[[ "${ISSUE_NUMBER}" =~ ^[0-9]+$ ]] || usage
[[ -n "${FORCE}" && "${FORCE}" != "--force" ]] && usage

RUN_ID="issue-${ISSUE_NUMBER}"
BRANCH="feat/${RUN_ID}"
WORKTREE="${ROOT_DIR}/.agent-runs/${RUN_ID}"
LOCK_DIR="${ROOT_DIR}/.agent-runs/.locks"

export COMPOSE_PROJECT_NAME="sdl-task-${ISSUE_NUMBER}"

if [[ -d "${WORKTREE}" ]]; then
  docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f "${WORKTREE}/.devcontainer/docker-compose.yml" down -v >/dev/null 2>&1 || true
fi

if [[ -d "${WORKTREE}" ]]; then
  if ! git -C "${ROOT_DIR}" worktree remove --force "${WORKTREE}"; then
    rm -rf "${WORKTREE}" 2>/dev/null || true
    git -C "${ROOT_DIR}" worktree prune || true
  fi
fi

if git -C "${ROOT_DIR}" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  if [[ "${FORCE}" == "--force" ]]; then
    git -C "${ROOT_DIR}" branch -D "${BRANCH}" || true
  else
    git -C "${ROOT_DIR}" branch -d "${BRANCH}" || true
  fi
fi

rm -f "${LOCK_DIR}/${RUN_ID}.pid" "${LOCK_DIR}/${RUN_ID}.slot" "${LOCK_DIR}/${RUN_ID}.lock"
rmdir "${LOCK_DIR}/${RUN_ID}.lck" 2>/dev/null || true
echo "Cleanup finished for ${RUN_ID}."
