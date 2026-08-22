#!/usr/bin/env bash
# Gallery image-load responsiveness benchmark (autoresearch entrypoint).
# Loads the real gallery frontend pipeline in Node with deterministic
# fixed-latency backend mocks and reports time-to-first-display metrics.
set -euo pipefail
cd "$(dirname "$0")"
exec node autoresearch/bench.mjs
