#!/bin/bash
# Test: fibonacci(0)=0, fibonacci(1)=1, fibonacci(5)=5, fibonacci(10)=55
cd "$WORKSPACE" || exit 1

cat > __eval_test.ts << 'EOF'
import { fibonacci } from "./src/index.ts";

const cases: [number, number][] = [[0,0],[1,1],[2,1],[5,5],[10,55]];
let pass = true;
for (const [input, expected] of cases) {
  const result = fibonacci(input);
  if (result !== expected) {
    console.error(`FAIL: fibonacci(${input}) = ${result}, expected ${expected}`);
    pass = false;
  }
}
if (!pass) process.exit(1);
console.log("All tests passed");
EOF

npx --yes tsx __eval_test.ts
