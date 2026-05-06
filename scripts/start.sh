#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Single-command autonomous trigger.

Usage:
  scripts/start.sh                  Pick up to MAX_PARALLEL_TASKS open `agent-ready`
                                    issues and run them in parallel.
  scripts/start.sh 12 14 19         Run a specific list of issue numbers in parallel.
  scripts/start.sh --max 2          Cap the number of parallel issues launched.

Each task gets its own worktree + isolated docker compose stack and runs
`cursor-agent --print --force --trust` headlessly using your Cursor
subscription (host ~/.cursor/cli-config.json mounted into the container,
no API key needed).
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MAX_PARALLEL_TASKS="${MAX_PARALLEL_TASKS:-3}"
EXPLICIT_MAX=""
EXPLICIT_ISSUES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max)
      EXPLICIT_MAX="${2:-}"
      shift 2
      ;;
    --max=*)
      EXPLICIT_MAX="${1#--max=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      EXPLICIT_ISSUES+=("$1")
      shift
      ;;
  esac
done
[[ -n "${EXPLICIT_MAX}" ]] && MAX_PARALLEL_TASKS="${EXPLICIT_MAX}"
export MAX_PARALLEL_TASKS

ENV_FILE="${ROOT_DIR}/.devcontainer/.env"
HAVE_API_KEY=0
if [[ -n "${CURSOR_API_KEY:-}" ]]; then HAVE_API_KEY=1; fi
if [[ -f "${ENV_FILE}" ]] && rg -q '^CURSOR_API_KEY=.+' "${ENV_FILE}" 2>/dev/null; then HAVE_API_KEY=1; fi
if [[ ${HAVE_API_KEY} -eq 0 ]]; then
  echo "CURSOR_API_KEY is not set."
  echo "  Generate a key at https://cursor.com/dashboard/integrations"
  echo "  and add CURSOR_API_KEY=... to ${ENV_FILE}"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI 'gh' is required on the host. Install it and run 'gh auth login'."
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run 'gh auth login' first."
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/.devcontainer/.env" ]]; then
  echo "Seeding ${ROOT_DIR}/.devcontainer/.env from .env.example"
  cp "${ROOT_DIR}/.devcontainer/.env.example" "${ROOT_DIR}/.devcontainer/.env"
fi

ISSUES=()
if [[ ${#EXPLICIT_ISSUES[@]} -gt 0 ]]; then
  for n in "${EXPLICIT_ISSUES[@]}"; do
    [[ "${n}" =~ ^[0-9]+$ ]] || { echo "Skip non-numeric arg: ${n}"; continue; }
    ISSUES+=("${n}")
  done
else
  echo "Querying open issues with label 'agent-ready'..."
  while IFS= read -r line; do
    [[ -n "${line}" ]] && ISSUES+=("${line}")
  done < <(gh issue list --state open --label agent-ready --limit "${MAX_PARALLEL_TASKS}" --json number --jq '.[].number')
fi

if [[ ${#ISSUES[@]} -eq 0 ]]; then
  echo "No issues to run. Label issues 'agent-ready' or pass issue numbers explicitly."
  exit 0
fi

echo "Launching ${#ISSUES[@]} task(s) in parallel (cap=${MAX_PARALLEL_TASKS})..."
for n in "${ISSUES[@]}"; do
  echo "  -> issue #${n}"
  # NOTE: label flip from agent-ready -> agent-in-progress is performed
  # inside scripts/run-task.sh once the container is actually up, so a
  # task stuck waiting for a parallel slot does not lie about being
  # in-progress.
  MAX_PARALLEL_TASKS="${MAX_PARALLEL_TASKS}" \
    "${ROOT_DIR}/scripts/run-task.sh" "${n}" --bg
done

echo
echo "All tasks queued. Monitor with:"
echo "  pnpm task:status"
echo "  tail -f .agent-runs/issue-<N>/run.log"
