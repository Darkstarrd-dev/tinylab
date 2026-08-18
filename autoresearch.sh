#!/usr/bin/env bash
# TinyRouter "小精灵" assistant dispatch-readiness benchmark.
#
# Builds the bench (which compiles the real project library in-process) and
# runs a deterministic intent-dispatch workload. No network, no live upstream,
# no time-of-day dependency. Emits METRIC lines on stdout, exit 0 on success.
set -euo pipefail
cd "$(dirname "$0")"

go run ./cmd/assistant-bench
