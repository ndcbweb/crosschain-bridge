#!/bin/sh
set -e
cd /app/server
exec node --experimental-sqlite --no-warnings src/index.js
