#!/bin/bash
WORKSPACE="$1"
cd "$WORKSPACE" || exit 1

# Tests must pass
python3 tests/test_task_manager.py || exit 1

# Verify refactoring was actually done:
# 1. Should use a dict for storage (not just a list)
if ! grep -q "dict\|Dict\|{}" src/task_manager.py; then
  echo "FAIL: No dict usage found — refactoring not done"
  exit 1
fi

# 2. Should use dataclass or namedtuple
if ! grep -qE "dataclass|NamedTuple|namedtuple" src/task_manager.py; then
  echo "FAIL: No dataclass/namedtuple found — refactoring not done"
  exit 1
fi

echo "PASS: Tests pass and refactoring verified"
