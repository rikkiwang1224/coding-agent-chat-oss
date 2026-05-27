import { createSession, getSession, isSessionValid, invalidateSession } from "../src/session.js";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// Test 1: Create and retrieve session
const session = createSession("user-1", "token-abc");
assert(session.userId === "user-1", "session userId");
assert(session.token === "token-abc", "session token");

const retrieved = getSession("token-abc");
assert(retrieved !== undefined, "session should be retrievable immediately after creation");
assert(retrieved!.userId === "user-1", "retrieved session userId");

// Test 2: Session should be valid immediately
assert(isSessionValid("token-abc"), "session should be valid right after creation");

// Test 3: Invalid token returns undefined
assert(getSession("nonexistent") === undefined, "unknown token should return undefined");
assert(!isSessionValid("nonexistent"), "unknown token should not be valid");

// Test 4: Invalidation
createSession("user-2", "token-xyz");
assert(isSessionValid("token-xyz"), "token-xyz should be valid");
invalidateSession("token-xyz");
assert(!isSessionValid("token-xyz"), "token-xyz should be invalid after invalidation");

// Test 5: Session should still be valid after 1 second (TTL is 30 minutes)
// This simulates checking a session shortly after creation
const freshSession = createSession("user-3", "token-fresh");
// Synchronous check — no time has passed, so it must be valid
assert(isSessionValid("token-fresh"), "fresh session must be valid (TTL is 30 min, not expired)");

console.log("All session tests passed!");
