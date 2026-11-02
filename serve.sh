#!/usr/bin/env bash
# Serve SIGIL locally. The project is static; there is no build step.
set -e
PORT="${1:-8080}"
cd "$(dirname "$0")"
echo "SIGIL → http://localhost:$PORT/"
echo "spec  → http://localhost:$PORT/tests/core.spec.html"
python3 -m http.server "$PORT"