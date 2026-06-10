import { describe, it, expect } from "vitest";
import { isBatchFatalApiStatus } from "../eval/swe-bench/agent-task.js";

describe("isBatchFatalApiStatus", () => {
  it("treats balance/auth failures as batch-fatal (every instance would fail)", () => {
    expect(isBatchFatalApiStatus(402)).toBe(true); // Insufficient Balance
    expect(isBatchFatalApiStatus(401)).toBe(true); // bad/expired key
    expect(isBatchFatalApiStatus(403)).toBe(true); // forbidden
  });

  it("does not abort the batch on transient/per-instance errors", () => {
    expect(isBatchFatalApiStatus(429)).toBe(false); // rate limit — retried in-client
    expect(isBatchFatalApiStatus(500)).toBe(false);
    expect(isBatchFatalApiStatus(503)).toBe(false);
    expect(isBatchFatalApiStatus(undefined)).toBe(false); // no API error
  });
});
