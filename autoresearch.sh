#!/usr/bin/env bash
# Gallery video switching latency benchmark.
# Deterministic, no network, no time-of-day dependency.
# Builds the bench (real source scan + fixture workload) and emits METRIC lines.
set -euo pipefail
cd "$(dirname "$0")"
go run ./cmd/gallery-video-bench
