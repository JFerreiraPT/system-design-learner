#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS_DIR="${ROOT_DIR}/.agent-runs"
LOCK_DIR="${RUNS_DIR}/.locks"
SLOTS_DIR="${RUNS_DIR}/.slots"

if [[ ! -d "${RUNS_DIR}" ]]; then
  echo "No task runs found."
  exit 0
fi

# --- Slot summary ------------------------------------------------------------
held_slots=0
if [[ -d "${SLOTS_DIR}" ]]; then
  for d in "${SLOTS_DIR}"/slot-*; do
    [[ -d "${d}" ]] && held_slots=$((held_slots + 1))
  done
fi
printf "Slots held: %d\n" "${held_slots}"
if [[ -d "${SLOTS_DIR}" ]]; then
  for d in "${SLOTS_DIR}"/slot-*; do
    [[ -d "${d}" ]] || continue
    slot_id="$(basename "${d}")"
    slot_id="${slot_id#slot-}"
    owner="<unknown>"
    owner_alive="?"
    for slot_file in "${LOCK_DIR}"/issue-*.slot; do
      [[ -f "${slot_file}" ]] || continue
      if [[ "$(<"${slot_file}")" == "${slot_id}" ]]; then
        owner="$(basename "${slot_file}" .slot)"
        owner_pid_file="${LOCK_DIR}/${owner}.pid"
        if [[ -f "${owner_pid_file}" ]] && kill -0 "$(<"${owner_pid_file}")" 2>/dev/null; then
          owner_alive="alive"
        else
          owner_alive="ORPHAN"
        fi
        break
      fi
    done
    printf "  slot-%s -> %s (%s)\n" "${slot_id}" "${owner}" "${owner_alive}"
  done
fi
echo

# --- Per-task status ---------------------------------------------------------
shopt -s nullglob
runs=("${RUNS_DIR}"/issue-*/)
shopt -u nullglob
if [[ ${#runs[@]} -eq 0 ]]; then
  echo "No active task worktrees."
  exit 0
fi

for dir in "${runs[@]}"; do
  dir="${dir%/}"
  run_id="$(basename "${dir}")"
  issue_number="${run_id#issue-}"
  branch="feat/${run_id}"
  pid_file="${LOCK_DIR}/${run_id}.pid"
  slot_file="${LOCK_DIR}/${run_id}.slot"
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

  if [[ -f "${slot_file}" ]]; then
    printf "| slot=%s " "$(<"${slot_file}")"
  else
    printf "| slot=- "
  fi

  if [[ -f "${log_file}" ]]; then
    last_line="$(rg --no-line-number "." "${log_file}" | tail -n 1 2>/dev/null || true)"
    printf "| log=%s " "${last_line:-<empty>}"
  else
    printf "| log=<none> "
  fi

  printf "| compose=%s\n" "${compose_project}"
done
