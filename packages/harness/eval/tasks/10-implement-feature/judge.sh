#!/bin/bash
WORKSPACE="$1"
cd "$WORKSPACE" || exit 1

cat > __eval_test.ts << 'EOF'
import { KVStore } from "./src/store.ts";

const store = new KVStore();

// Test set/get
store.set("name", "Alice");
if (store.get("name") !== "Alice") {
  console.error("FAIL: get after set");
  process.exit(1);
}

// Test has
if (!store.has("name")) {
  console.error("FAIL: has returns false for existing key");
  process.exit(1);
}
if (store.has("nonexistent")) {
  console.error("FAIL: has returns true for missing key");
  process.exit(1);
}

// Test size
store.set("age", "30");
if (store.size() !== 2) {
  console.error(`FAIL: size() = ${store.size()}, expected 2`);
  process.exit(1);
}

// Test delete
const deleted = store.delete("name");
if (!deleted) {
  console.error("FAIL: delete returns false for existing key");
  process.exit(1);
}
if (store.has("name")) {
  console.error("FAIL: has returns true after delete");
  process.exit(1);
}
if (store.size() !== 1) {
  console.error(`FAIL: size after delete = ${store.size()}, expected 1`);
  process.exit(1);
}

// Test get undefined
if (store.get("name") !== undefined) {
  console.error("FAIL: get deleted key should return undefined");
  process.exit(1);
}

// Test delete non-existent
if (store.delete("nope") !== false) {
  console.error("FAIL: delete non-existent should return false");
  process.exit(1);
}

console.log("All KVStore tests passed");
EOF

npx --yes tsx __eval_test.ts
