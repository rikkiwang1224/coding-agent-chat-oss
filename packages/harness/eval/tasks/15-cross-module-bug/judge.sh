#!/bin/bash
WORKSPACE="$1"
cd "$WORKSPACE" || exit 1
npx --yes tsx tests/session.test.ts
