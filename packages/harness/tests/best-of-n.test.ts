import { describe, expect, it } from "vitest";
import {
  selectPatch,
  normalizeSourceChange,
  extractChangeLines,
  type PatchCandidate,
} from "../src/best-of-n/select.js";

// Helper: build a minimal unified diff that edits one source line in a file.
function srcDiff(file: string, oldLine: string, newLine: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `index 1111111..2222222 100644`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,3 +10,3 @@ def f():`,
    `     context_before`,
    `-${oldLine}`,
    `+${newLine}`,
    `     context_after`,
    ``,
  ].join("\n");
}

// Helper: a diff that adds a brand-new test file (agent-written reproduction).
function newTestFileDiff(file: string, body: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `new file mode 100644`,
    `index 0000000..3333333`,
    `--- /dev/null`,
    `+++ b/${file}`,
    `@@ -0,0 +1,2 @@`,
    `+${body}`,
    `+assert True`,
    ``,
  ].join("\n");
}

describe("extractChangeLines", () => {
  it("captures +/- content lines tagged with file, ignoring headers/context", () => {
    const lines = extractChangeLines(srcDiff("django/db/models/x.py", "return a", "return b"));
    expect(lines).toEqual([
      { sign: "-", file: "django/db/models/x.py", content: "return a" },
      { sign: "+", file: "django/db/models/x.py", content: "return b" },
    ]);
  });

  it("ignores blank / whitespace-only added lines", () => {
    const diff = [
      `diff --git a/f.py b/f.py`,
      `--- a/f.py`,
      `+++ b/f.py`,
      `@@ -1,1 +1,2 @@`,
      ` keep`,
      `+   `,
      `+real = 1`,
    ].join("\n");
    expect(extractChangeLines(diff)).toEqual([
      { sign: "+", file: "f.py", content: "real = 1" },
    ]);
  });
});

describe("normalizeSourceChange", () => {
  it("is identical for two patches making the same edit with different context/hunk headers", () => {
    const a = srcDiff("pkg/mod.py", "x = 1", "x = 2");
    const b = [
      `diff --git a/pkg/mod.py b/pkg/mod.py`,
      `index aaaa..bbbb 100644`,
      `--- a/pkg/mod.py`,
      `+++ b/pkg/mod.py`,
      `@@ -200,5 +200,5 @@ class C:`, // different line numbers / context
      `     totally_different_context`,
      `-x = 1`,
      `+x = 2`,
      `     more_context`,
    ].join("\n");
    expect(normalizeSourceChange(a)).toBe(normalizeSourceChange(b));
    expect(normalizeSourceChange(a)).not.toBe("");
  });

  it("differs for patches making different edits", () => {
    const a = srcDiff("pkg/mod.py", "x = 1", "x = 2");
    const b = srcDiff("pkg/mod.py", "x = 1", "x = 3");
    expect(normalizeSourceChange(a)).not.toBe(normalizeSourceChange(b));
  });

  it("returns empty for a test-only patch (test file changes are excluded)", () => {
    expect(normalizeSourceChange(newTestFileDiff("tests/test_repro.py", "import x"))).toBe("");
  });

  it("clusters two patches with the same source fix but different repro tests", () => {
    const fix = srcDiff("pkg/mod.py", "x = 1", "x = 2");
    const a = fix + newTestFileDiff("tests/test_a.py", "case_a = 1");
    const b = fix + newTestFileDiff("tests/test_b.py", "case_b = 2");
    expect(normalizeSourceChange(a)).toBe(normalizeSourceChange(b));
  });
});

describe("selectPatch", () => {
  it("returns allEmpty when every candidate is empty", () => {
    const cands: PatchCandidate[] = [
      { index: 1, diff: "" },
      { index: 2, diff: "   \n" },
    ];
    const r = selectPatch(cands);
    expect(r.allEmpty).toBe(true);
    expect(r.selectedIndex).toBe(1); // first, but caller treats allEmpty specially
  });

  it("drops empty candidates in favor of one that made a real edit", () => {
    const cands: PatchCandidate[] = [
      { index: 1, diff: "" },
      { index: 2, diff: srcDiff("a.py", "p", "q") },
      { index: 3, diff: "" },
    ];
    const r = selectPatch(cands);
    expect(r.allEmpty).toBe(false);
    expect(r.selectedIndex).toBe(2);
  });

  it("picks the majority edit when samples disagree", () => {
    const fixA = srcDiff("a.py", "v", "A");
    const fixB = srcDiff("a.py", "v", "B");
    const cands: PatchCandidate[] = [
      { index: 1, diff: fixB },
      { index: 2, diff: fixA },
      { index: 3, diff: fixA }, // A appears twice → majority
    ];
    const r = selectPatch(cands);
    expect([2, 3]).toContain(r.selectedIndex);
    expect(r.clusters[0].members.sort()).toEqual([2, 3]);
  });

  it("prefers a regression-passing candidate over a more-popular failing one", () => {
    const fixPopular = srcDiff("a.py", "v", "POPULAR");
    const fixGreen = srcDiff("a.py", "v", "GREEN");
    const cands: PatchCandidate[] = [
      { index: 1, diff: fixPopular, regression: "fail" },
      { index: 2, diff: fixPopular, regression: "fail" }, // popular but breaks tests
      { index: 3, diff: fixGreen, regression: "pass" }, // lone, but green
    ];
    const r = selectPatch(cands);
    expect(r.selectedIndex).toBe(3);
    expect(r.selectedTier).toBe("pass");
  });

  it("breaks ties deterministically by minimal change size then lowest index", () => {
    const small = srcDiff("a.py", "v", "S");
    const big = [
      srcDiff("a.py", "v", "S"),
      srcDiff("b.py", "extra", "EXTRA"),
    ].join("\n");
    // Two singleton clusters of equal popularity (1 each) → smaller change wins.
    const cands: PatchCandidate[] = [
      { index: 1, diff: big },
      { index: 2, diff: small },
    ];
    const r = selectPatch(cands);
    expect(r.selectedIndex).toBe(2);
  });

  it("excludes test-file noise so source-equivalent samples form one cluster", () => {
    const fix = srcDiff("a.py", "v", "FIX");
    const cands: PatchCandidate[] = [
      { index: 1, diff: fix + newTestFileDiff("tests/test_x.py", "x=1") },
      { index: 2, diff: fix + newTestFileDiff("tests/test_y.py", "y=2") },
      { index: 3, diff: srcDiff("a.py", "v", "OTHER") },
    ];
    const r = selectPatch(cands);
    expect(r.clusters[0].members.sort()).toEqual([1, 2]);
    expect([1, 2]).toContain(r.selectedIndex);
  });
});
