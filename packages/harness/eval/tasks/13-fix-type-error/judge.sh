#!/bin/bash
WORKSPACE="$1"
cd "$WORKSPACE" || exit 1
npx --yes tsc --noEmit 2>&1
