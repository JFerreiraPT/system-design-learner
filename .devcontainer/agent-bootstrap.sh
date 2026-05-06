#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/workspace"
TASK_FILE="${ROOT_DIR}/.agent-task.json"
PROMPT_FILE="${ROOT_DIR}/.agent-prompt.md"
FIX_PROMPT_FILE="${ROOT_DIR}/.agent-fix-prompt.md"
REPORT_FILE="${ROOT_DIR}/report.json"
GATES_LOG="${ROOT_DIR}/.agent-gates.log"

if [[ ! -f "${TASK_FILE}" ]]; then
  echo "Missing ${TASK_FILE}"
  exit 1
fi

ISSUE_NUMBER="$(jq -r '.number' "${TASK_FILE}")"
ISSUE_TITLE="$(jq -r '.title' "${TASK_FILE}")"

AGENT_BIN=""
if command -v cursor-agent >/dev/null 2>&1; then
  AGENT_BIN="cursor-agent"
elif command -v agent >/dev/null 2>&1; then
  AGENT_BIN="agent"
fi

if [[ -z "${AGENT_BIN}" ]]; then
  echo "No Cursor agent binary found (cursor-agent or agent)."
  exit 1
fi

if [[ ! -x "${ROOT_DIR}/scripts/prompt-for-issue.sh" ]]; then
  echo "Missing executable prompt builder at scripts/prompt-for-issue.sh"
  exit 1
fi

"${ROOT_DIR}/scripts/prompt-for-issue.sh" "${TASK_FILE}" > "${PROMPT_FILE}"

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "CURSOR_API_KEY is not set inside the container."
  echo "Set CURSOR_API_KEY in .devcontainer/.env (cursor.com/dashboard/integrations)."
  exit 1
fi
echo "Using CURSOR_API_KEY for headless agent run."

# Make `git push` work non-interactively against GitHub HTTPS by routing
# credentials through `gh`. Safe to call even if already configured.
if [[ -n "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
  export GH_TOKEN="${GITHUB_TOKEN}"
fi
if command -v gh >/dev/null 2>&1 && [[ -n "${GH_TOKEN:-}" ]]; then
  gh auth setup-git 2>/dev/null || true
fi

# Provide a default git identity for commits made by the agent runner.
git config --global user.email "cursor-agent@local" 2>/dev/null || true
git config --global user.name "Cursor Agent" 2>/dev/null || true
# The host .git is mounted in; mark it as a safe directory for the `node` user.
HOST_REPO_GIT_PARENT="$(dirname "$(git -C "${ROOT_DIR}" rev-parse --git-common-dir 2>/dev/null || echo "/workspace/.git")")"
git config --global --add safe.directory "${ROOT_DIR}" 2>/dev/null || true
git config --global --add safe.directory "${HOST_REPO_GIT_PARENT}" 2>/dev/null || true

CURSOR_MODEL="${CURSOR_MODEL:-auto}"
MAX_ATTEMPTS="${AGENT_MAX_ATTEMPTS:-3}"

run_agent() {
  local prompt_path="$1"
  local label="$2"
  echo "=== Cursor agent run (${label}) — model=${CURSOR_MODEL} ==="
  if ! "${AGENT_BIN}" --print --force --trust --model "${CURSOR_MODEL}" < "${prompt_path}"; then
    echo "cursor-agent failed during ${label}"
    return 1
  fi
  return 0
}

run_gates() {
  local attempt="$1"
  : > "${GATES_LOG}"
  LINT_OK=0
  TYPE_OK=0
  TEST_OK=0
  echo "=== Validation gates (attempt ${attempt}) ===" | tee -a "${GATES_LOG}"
  if pnpm -w lint 2>&1 | tee -a "${GATES_LOG}"; then LINT_OK=1; fi
  if pnpm -w turbo run typecheck 2>&1 | tee -a "${GATES_LOG}"; then TYPE_OK=1; fi
  if pnpm -w turbo run test 2>&1 | tee -a "${GATES_LOG}"; then TEST_OK=1; fi
  echo "Gate results — lint=${LINT_OK} typecheck=${TYPE_OK} test=${TEST_OK}" | tee -a "${GATES_LOG}"
}

write_report() {
  local status="$1"
  local attempts="$2"
  cat > "${REPORT_FILE}" <<EOF
{
  "lintOk": ${LINT_OK:-0},
  "typecheckOk": ${TYPE_OK:-0},
  "testsOk": ${TEST_OK:-0},
  "attempts": ${attempts},
  "status": "${status}"
}
EOF
}

build_fix_prompt() {
  local attempt="$1"
  local lint_status typecheck_status test_status
  lint_status=$([[ ${LINT_OK} -eq 1 ]] && echo PASS || echo FAIL)
  typecheck_status=$([[ ${TYPE_OK} -eq 1 ]] && echo PASS || echo FAIL)
  test_status=$([[ ${TEST_OK} -eq 1 ]] && echo PASS || echo FAIL)
  {
    echo "Validation attempt ${attempt} left some gates failing. Fix them."
    echo
    echo "Gate results:"
    echo "- lint: ${lint_status}"
    echo "- typecheck: ${typecheck_status}"
    echo "- test: ${test_status}"
    echo
    echo "Tail of gate output (last 200 lines):"
    echo '```'
    tail -n 200 "${GATES_LOG}"
    echo '```'
    echo
    echo "Constraints:"
    echo "- Make minimal changes to make all three gates pass."
    echo "- Do NOT regress the original issue's acceptance criterion."
    echo "- Do NOT commit or push; the runner handles that after gates pass."
    echo "- If a failure is in third-party code, fix the consuming code, not the dep."
    echo
    echo "Original task:"
    echo "---"
    cat "${PROMPT_FILE}"
  } > "${FIX_PROMPT_FILE}"
}

# Iterate: agent run -> gates -> if fail, fix prompt -> agent run -> gates -> ...
attempt=1
GATES_PASSED=0
while true; do
  if [[ ${attempt} -eq 1 ]]; then
    if ! run_agent "${PROMPT_FILE}" "initial implementation"; then
      if [[ ${attempt} -ge ${MAX_ATTEMPTS} ]]; then
        write_report "fail" "${attempt}"
        echo "Agent failed and no attempts remain; see ${REPORT_FILE}"
        exit 2
      fi
      attempt=$((attempt + 1))
      continue
    fi
  else
    if ! run_agent "${FIX_PROMPT_FILE}" "fix attempt ${attempt}"; then
      if [[ ${attempt} -ge ${MAX_ATTEMPTS} ]]; then
        write_report "fail" "${attempt}"
        echo "Agent fix attempt failed and no attempts remain; see ${REPORT_FILE}"
        exit 2
      fi
      attempt=$((attempt + 1))
      continue
    fi
  fi

  run_gates "${attempt}"

  if [[ ${LINT_OK} -eq 1 && ${TYPE_OK} -eq 1 && ${TEST_OK} -eq 1 ]]; then
    GATES_PASSED=1
    write_report "pass" "${attempt}"
    echo "All validation gates passed on attempt ${attempt}."
    break
  fi

  if [[ ${attempt} -ge ${MAX_ATTEMPTS} ]]; then
    write_report "fail" "${attempt}"
    echo "Validation failed after ${MAX_ATTEMPTS} attempts; see ${REPORT_FILE}"
    exit 3
  fi

  build_fix_prompt "${attempt}"
  attempt=$((attempt + 1))
done

if [[ ${GATES_PASSED} -ne 1 ]]; then
  echo "Unexpected: exited gate loop without pass marker"
  exit 3
fi

# --- Commit / push / PR -------------------------------------------------------
if git diff --quiet && git diff --cached --quiet; then
  echo "No git changes detected after run; skipping commit and PR."
  exit 0
fi

git add -A

if ! git diff --cached --quiet; then
  git commit -m "$(cat <<EOF
feat(issue-${ISSUE_NUMBER}): implement ${ISSUE_TITLE}

- implement requested changes for issue #${ISSUE_NUMBER}
- pass lint, typecheck, and test gates in agent bootstrap

Refs: #${ISSUE_NUMBER}
EOF
)" --author="Cursor Agent <cursor-agent@local>" || true
fi

git push -u origin HEAD

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
EXISTING_PR_URL="$(gh pr list --head "${CURRENT_BRANCH}" --json url --jq '.[0].url' 2>/dev/null || true)"

if [[ -n "${EXISTING_PR_URL}" ]]; then
  echo "PR already exists: ${EXISTING_PR_URL}"
  exit 0
fi

gh pr create --title "feat: ${ISSUE_TITLE}" --body "$(cat <<EOF
## Summary

- Implements issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

## Changes

- Generated by local agent task runner in isolated devcontainer worktree.

## Tests

- [x] Lint passed
- [x] Typecheck passed
- [x] Tests passed

## Validation report

- Report path: \`report.json\`

## Linked issue

Closes #${ISSUE_NUMBER}
EOF
)"
