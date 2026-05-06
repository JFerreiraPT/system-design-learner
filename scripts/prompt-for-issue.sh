#!/usr/bin/env bash
set -euo pipefail

TASK_FILE="${1:-/workspace/.agent-task.json}"

if [[ ! -f "${TASK_FILE}" ]]; then
  echo "Missing task file: ${TASK_FILE}" >&2
  exit 1
fi

issue_number="$(jq -r '.number' "${TASK_FILE}")"
issue_title="$(jq -r '.title' "${TASK_FILE}")"
issue_body="$(jq -r '.body // ""' "${TASK_FILE}")"

cat <<EOF
You are implementing GitHub issue #${issue_number}: ${issue_title}

Requirements:
1) Implement only what this issue asks.
2) Use tests-for-diff: create/update tests only for developed behavior.
3) Run validate-done and require >=95 confidence before finalizing.
4) Use conventional-commit format with footer "Refs: #${issue_number}".
5) If validation passes, push branch and create PR with repository template.
6) If blocked, explain root cause and next action in the run report.

Issue body:
${issue_body}
EOF
