#!/usr/bin/env bash
set -euo pipefail

gh label create "agent-ready" --color "1D76DB" --description "Ready for autonomous implementation" >/dev/null 2>&1 || true
gh label create "agent-in-progress" --color "FBCA04" --description "Currently being implemented by local agent runner" >/dev/null 2>&1 || true
gh label create "agent-blocked" --color "D73A4A" --description "Implementation blocked; manual intervention needed" >/dev/null 2>&1 || true

echo "Agent labels ensured."
