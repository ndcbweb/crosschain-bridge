#!/usr/bin/env bash
# Builds dist/bridge.tar.gz, which bridge hosts download and run with node:22-alpine.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd server && npm ci --omit=dev)

rm -rf dist
mkdir -p dist/bridge
cp -R server dist/bridge/server
rm -rf dist/bridge/server/.data dist/bridge/server/test
cp -R web dist/bridge/web
cp -R artifacts dist/bridge/artifacts
cp run.sh dist/bridge/run.sh
tar -czf dist/bridge.tar.gz -C dist bridge
echo "Built $(pwd)/dist/bridge.tar.gz"
