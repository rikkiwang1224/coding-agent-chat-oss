#!/bin/bash
WORKSPACE="$1"
# Check that getData is gone and fetchUserData exists in both files
if grep -q "getData" "$WORKSPACE/src/api.ts"; then
  echo "FAIL: getData still exists in api.ts"
  exit 1
fi
if grep -q "getData" "$WORKSPACE/src/display.ts"; then
  echo "FAIL: getData still exists in display.ts"
  exit 1
fi
if ! grep -q "fetchUserData" "$WORKSPACE/src/api.ts"; then
  echo "FAIL: fetchUserData not found in api.ts"
  exit 1
fi
if ! grep -q "fetchUserData" "$WORKSPACE/src/display.ts"; then
  echo "FAIL: fetchUserData not found in display.ts"
  exit 1
fi
echo "PASS"
exit 0
