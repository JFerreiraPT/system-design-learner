#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_DIR="${ROOT_DIR}/.agent-runs/.locks"
SLOTS_DIR="${ROOT_DIR}/.agent-runs/.slots"
MAX_PARALLEL_TASKS="${MAX_PARALLEL_TASKS:-3}"
DEVCONTAINER_BIN="${DEVCONTAINER_BIN:-devcontainer}"

usage() {
  echo "Usage: $0 <issue-number> [--bg]"
  exit 1
}

[[ $# -lt 1 ]] && usage

ISSUE_NUMBER="${1:-}"
MODE="${2:-}"
[[ "${ISSUE_NUMBER}" =~ ^[0-9]+$ ]] || usage
[[ -n "${MODE}" && "${MODE}" != "--bg" ]] && usage

RUN_ID="issue-${ISSUE_NUMBER}"
BRANCH="feat/${RUN_ID}"
WORKTREE="${ROOT_DIR}/.agent-runs/${RUN_ID}"
TASK_JSON_TMP="/tmp/${RUN_ID}.json"
RUN_LOG="${WORKTREE}/run.log"
PID_FILE="${LOCK_DIR}/${RUN_ID}.pid"
ISSUE_LOCK_DIR="${LOCK_DIR}/${RUN_ID}.lck"
COMPOSE_PROJECT_NAME="sdl-task-${ISSUE_NUMBER}"
export COMPOSE_PROJECT_NAME

mkdir -p "${LOCK_DIR}" "${SLOTS_DIR}" "${ROOT_DIR}/.agent-runs"

if [[ "${MODE}" == "--bg" && "${RUN_TASK_BG_CHILD:-0}" != "1" ]]; then
  RUN_TASK_BG_CHILD=1 nohup "$0" "${ISSUE_NUMBER}" --bg > "${ROOT_DIR}/.agent-runs/${RUN_ID}.launcher.log" 2>&1 &
  echo "$!" > "${PID_FILE}"
  echo "Queued ${RUN_ID} in background (pid $!)."
  exit 0
fi

if [[ -d "${WORKTREE}" ]]; then
  if git -C "${ROOT_DIR}" worktree list --porcelain | rg -q "^worktree ${WORKTREE}\$"; then
    echo "Worktree already registered for ${RUN_ID}: ${WORKTREE}"
    echo "Run 'pnpm task:cleanup ${ISSUE_NUMBER}' first if you want to relaunch."
    exit 1
  fi
  echo "Stale leftover dir at ${WORKTREE} (no git worktree); auto-cleaning."
  docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f "${WORKTREE}/.devcontainer/docker-compose.yml" down -v >/dev/null 2>&1 || true
  rm -rf "${WORKTREE}" 2>/dev/null || true
  if git -C "${ROOT_DIR}" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git -C "${ROOT_DIR}" branch -D "${BRANCH}" >/dev/null 2>&1 || true
  fi
  git -C "${ROOT_DIR}" worktree prune >/dev/null 2>&1 || true
fi

# Prevent duplicate launches of same issue (portable lock).
if ! mkdir "${ISSUE_LOCK_DIR}" 2>/dev/null; then
  echo "Issue ${ISSUE_NUMBER} is already running."
  exit 1
fi

acquire_slot() {
  local slot
  while true; do
    for slot in $(seq 1 "${MAX_PARALLEL_TASKS}"); do
      if mkdir "${SLOTS_DIR}/slot-${slot}" 2>/dev/null; then
        SLOT_ID="${slot}"
        echo "${SLOT_ID}" > "${LOCK_DIR}/${RUN_ID}.slot"
        return 0
      fi
    done
    if [[ "${MODE}" == "--bg" ]]; then
      sleep 2
      continue
    fi
    echo "No free slots. MAX_PARALLEL_TASKS=${MAX_PARALLEL_TASKS}. Retry with --bg to queue."
    return 1
  done
}

release_slot() {
  local slot_file="${LOCK_DIR}/${RUN_ID}.slot"
  if [[ -f "${slot_file}" ]]; then
    local slot_id
    slot_id="$(<"${slot_file}")"
    rmdir "${SLOTS_DIR}/slot-${slot_id}" 2>/dev/null || true
    rm -f "${slot_file}"
  fi
}

set_env_value() {
  local file_path="$1"
  local key="$2"
  local value="$3"
  [[ -z "${value}" ]] && return 0
  awk -v k="${key}" -v v="${value}" '
    BEGIN { updated = 0 }
    $0 ~ ("^" k "=") { print k "=" v; updated = 1; next }
    { print }
    END { if (!updated) print k "=" v }
  ' "${file_path}" > "${file_path}.tmp" && mv "${file_path}.tmp" "${file_path}"
}

RUN_SUCCESS=0
cleanup_on_exit() {
  local code=$?
  release_slot
  rmdir "${ISSUE_LOCK_DIR}" 2>/dev/null || true
  if [[ ${RUN_SUCCESS} -ne 1 && ${code} -ne 0 ]]; then
    gh issue edit "${ISSUE_NUMBER}" --remove-label "agent-in-progress" --add-label "agent-ready" >/dev/null 2>&1 || true
  fi
}
trap cleanup_on_exit EXIT

acquire_slot

if [[ ! -f "${ROOT_DIR}/.devcontainer/.env" ]]; then
  echo "Missing ${ROOT_DIR}/.devcontainer/.env. Copy .devcontainer/.env.example first."
  exit 1
fi

CURSOR_API_KEY_VALUE="$(rg '^CURSOR_API_KEY=' "${ROOT_DIR}/.devcontainer/.env" --no-line-number -m 1 2>/dev/null | sed 's/^CURSOR_API_KEY=//' || true)"
if [[ -z "${CURSOR_API_KEY_VALUE}" && -z "${CURSOR_API_KEY:-}" ]]; then
  echo "No CURSOR_API_KEY set."
  echo "  Generate one at https://cursor.com/dashboard/integrations and put it in .devcontainer/.env."
  exit 1
fi

echo "Fetching issue #${ISSUE_NUMBER}..."
gh issue view "${ISSUE_NUMBER}" --json number,title,body,labels > "${TASK_JSON_TMP}"

echo "Creating worktree ${WORKTREE} on ${BRANCH}..."
git -C "${ROOT_DIR}" worktree add "${WORKTREE}" -b "${BRANCH}"

# If runner assets are still uncommitted in the source workspace, seed them into
# the worktree so smoke-runs can execute before the initial commit exists.
for rel_path in ".devcontainer" "scripts" ".cursor" "apm.yml" ".github" "apm_modules"; do
  if [[ ! -e "${WORKTREE}/${rel_path}" && -e "${ROOT_DIR}/${rel_path}" ]]; then
    cp -R "${ROOT_DIR}/${rel_path}" "${WORKTREE}/${rel_path}"
  fi
done

cp "${TASK_JSON_TMP}" "${WORKTREE}/.agent-task.json"
cp "${ROOT_DIR}/.devcontainer/.env" "${WORKTREE}/.devcontainer/.env"

GH_TOKEN_VALUE="$(gh auth token 2>/dev/null || true)"
OPENAI_VALUE="$(rg '^OPENAI_API_KEY=' "${ROOT_DIR}/.env" --no-line-number -m 1 | sed 's/^OPENAI_API_KEY=//' || true)"
CURSOR_VALUE="${CURSOR_API_KEY:-}"
if [[ -z "${CURSOR_VALUE}" ]]; then
  CURSOR_VALUE="$(rg '^CURSOR_API_KEY=' "${ROOT_DIR}/.env" --no-line-number -m 1 | sed 's/^CURSOR_API_KEY=//' || true)"
fi

set_env_value "${WORKTREE}/.devcontainer/.env" "GITHUB_TOKEN" "${GH_TOKEN_VALUE}"
set_env_value "${WORKTREE}/.devcontainer/.env" "OPENAI_API_KEY" "${OPENAI_VALUE}"
set_env_value "${WORKTREE}/.devcontainer/.env" "CURSOR_API_KEY" "${CURSOR_VALUE}"

# The worktree's `.git` file is a pointer like
#   gitdir: <ROOT_DIR>/.git/worktrees/issue-N
# That host path must exist inside the container at the same absolute path,
# otherwise `git` fails with "not a git repository". Bind-mount the parent
# repo's .git via the docker-compose substitution variable HOST_REPO_GIT_DIR.
HOST_REPO_GIT_DIR="${ROOT_DIR}/.git"
export HOST_REPO_GIT_DIR
set_env_value "${WORKTREE}/.devcontainer/.env" "HOST_REPO_GIT_DIR" "${HOST_REPO_GIT_DIR}"

COMPOSE_FILE="${WORKTREE}/.devcontainer/docker-compose.yml"
echo "Starting isolated container stack ${COMPOSE_PROJECT_NAME}..."
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" up -d --build >/dev/null

echo "Running setup steps inside container..."
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" exec -T -u node app bash -lc "cd /workspace && pnpm install --frozen-lockfile || pnpm install" >/dev/null
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" exec -T -u node app bash -lc "cd /workspace && command -v apm >/dev/null 2>&1 && [ -f apm.yml ] && apm install && apm compile || echo 'APM skipped'" >/dev/null
docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" exec -T -u node app bash -lc "command -v agent >/dev/null 2>&1 || (curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh && bash /tmp/cursor-install.sh) || true" >/dev/null

echo "Running agent bootstrap..."
if docker compose --project-name "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" exec -T -u node app bash -lc "cd /workspace && COMPOSE_PROJECT_NAME='${COMPOSE_PROJECT_NAME}' bash .devcontainer/agent-bootstrap.sh" > "${RUN_LOG}" 2>&1; then
  echo "Task ${RUN_ID} completed successfully."
  RUN_SUCCESS=1
  "${ROOT_DIR}/scripts/cleanup-task.sh" "${ISSUE_NUMBER}" || true
  gh issue edit "${ISSUE_NUMBER}" --remove-label "agent-in-progress" >/dev/null 2>&1 || true
else
  echo "Task ${RUN_ID} failed. Logs: ${RUN_LOG}"
  gh issue edit "${ISSUE_NUMBER}" --add-label "agent-blocked" --remove-label "agent-in-progress" --remove-label "agent-ready" >/dev/null 2>&1 || true
  RUN_SUCCESS=1  # signal to trap that label state was already managed
  exit 2
fi
