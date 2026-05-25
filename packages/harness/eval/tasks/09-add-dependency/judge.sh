#!/bin/bash
WORKSPACE="$1"
# Check: isEmpty function exists in validators.ts
if ! grep -q "isEmpty" "$WORKSPACE/src/validators.ts"; then
  echo "FAIL: isEmpty not found in validators.ts"
  exit 1
fi
# Check: isEmpty is imported in handler.ts
if ! grep -q "isEmpty" "$WORKSPACE/src/handler.ts"; then
  echo "FAIL: isEmpty not imported/used in handler.ts"
  exit 1
fi
# Check: handler.ts imports from validators
if ! grep -q "validators" "$WORKSPACE/src/handler.ts"; then
  echo "FAIL: handler.ts doesn't import from validators"
  exit 1
fi
echo "PASS"
exit 0
