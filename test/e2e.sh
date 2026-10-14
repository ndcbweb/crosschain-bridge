#!/usr/bin/env bash
# Unpacks dist/bridge.tar.gz and relays a round trip between two anvil chains with it.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar -xzf dist/bridge.tar.gz -C "$WORK"
node server/test/e2e.mjs "$WORK/bridge"
