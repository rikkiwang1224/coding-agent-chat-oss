import { describe, it, expect } from "vitest";
import { sweBenchProtectedPathPatterns } from "../eval/swe-bench/protected-paths.js";

describe("swe-bench protected-paths", () => {
  it("exports stable test-file guard patterns", () => {
    expect(sweBenchProtectedPathPatterns()).toEqual([
      "test_*",
      "*_test.py",
      "tests/",
      "testing/",
    ]);
  });
});
