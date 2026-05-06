#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS_DIR="${ROOT_DIR}/.agent-runs"
LOCK_DIR="${RUNS_DIR}/.locks"

if [[ ! -d "${RUNS_DIR}" ]]; then
  echo "No task runs found."
  exit 0
fi

for dir in "${RUNS_DIR}"/issue-*; do
  [[ -d "${dir}" ]] || continue
  run_id="$(basename "${dir}")"
  issue_number="${run_id#issue-}"
  branch="feat/${run_id}"
  pid_file="${LOCK_DIR}/${run_id}.pid"
  log_file="${dir}/run.log"
  compose_project="sdl-task-${issue_number}"

  printf "%s | branch=%s " "${run_id}" "${branch}"
  if [[ -f "${pid_file}" ]]; then
    pid="$(<"${pid_file}")"
    if kill -0 "${pid}" 2>/dev/null; then
      printf "| pid=%s (running) " "${pid}"
    else
      printf "| pid=%s (stale) " "${pid}"
    fi
  else
    printf "| pid=n/a "
  fi

  if [[ -f "${log_file}" ]]; then
    last_line="$(rg --no-line-number "." "${log_file}" | tail -n 1 2>/dev/null || true)"
    printf "| log=%s " "${last_line:-<empty>}"
  else
    printf "| log=<none> "
  fi

  printf "| compose=%s\n" "${compose_project}"
done
