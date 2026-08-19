#!/usr/bin/env bash
# TinyRouter "小精灵" assistant PRODUCT-readiness benchmark.
#
# Builds the bench (which compiles the real project library in-process) and
# runs a deterministic workload: a contract-driven correctness probe over
# tricky disambiguation intents, plus structural source scans of the five
# product features under study (assistant settings entry, draggable dock,
# LLM-assisted dispatch, reply correctness, systray pet release). No network,
# no live upstream, no time-of-day dependency. Emits METRIC lines on stdout,
# exit 0 on success.
set -euo pipefail
cd "$(dirname "$0")"

go run ./cmd/assistant-product-bench
