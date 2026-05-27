#!/bin/bash
WORKSPACE="$1"
cd "$WORKSPACE" || exit 1

cat > __eval_test.ts << 'EOF'
import { paginate } from "./src/paginate.ts";

const items = [1,2,3,4,5,6,7,8,9,10];

// page 0, size 3 → [1,2,3]
const r1 = paginate(items, 0, 3);
if (JSON.stringify(r1) !== "[1,2,3]") {
  console.error(`FAIL: paginate(items, 0, 3) = ${JSON.stringify(r1)}, expected [1,2,3]`);
  process.exit(1);
}

// page 1, size 3 → [4,5,6]
const r2 = paginate(items, 1, 3);
if (JSON.stringify(r2) !== "[4,5,6]") {
  console.error(`FAIL: paginate(items, 1, 3) = ${JSON.stringify(r2)}, expected [4,5,6]`);
  process.exit(1);
}

// page 2, size 2 on [1,2,3,4,5] → [5]
const r3 = paginate([1,2,3,4,5], 2, 2);
if (JSON.stringify(r3) !== "[5]") {
  console.error(`FAIL: paginate([1..5], 2, 2) = ${JSON.stringify(r3)}, expected [5]`);
  process.exit(1);
}

console.log("All paginate tests passed");
EOF

npx --yes tsx __eval_test.ts
