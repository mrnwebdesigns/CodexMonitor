#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if [ "$(uname -s)" = Darwin ] &&
    { [ -f .mrn-local/tauri.conf.json ] || [ -d .mrn-local/codex-home ]; }; then
    exec python3 scripts/build-mrn-local-chromium.py "$@"
fi

exec tauri build "$@"
