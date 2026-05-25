#!/bin/bash
WORKSPACE="$1"
cd "$WORKSPACE" || exit 1
python3 tests/test_pipeline.py
