import { describe, expect, it } from "vitest";
import { PermissionGuard } from "../src/permissions.js";

describe("PermissionGuard session allowlist", () => {
  it("skips confirm after addAlwaysAllow", async () => {
    const guard = new PermissionGuard();
    guard.addAlwaysAllow("git push origin main");

    const first = await guard.check("bash", { command: "git push origin main" });
    expect(first.allowed).toBe(true);

    let confirmCalls = 0;
    const guardWithConfirm = new PermissionGuard(undefined, async () => {
      confirmCalls += 1;
      return true;
    });
    guardWithConfirm.addAlwaysAllow("npm publish");

    const allowed = await guardWithConfirm.check("bash", { command: "npm publish --access public" });
    expect(allowed.allowed).toBe(true);
    expect(confirmCalls).toBe(0);
  });

  it("denies destructive commands without callback", async () => {
    const guard = new PermissionGuard();
    const result = await guard.check("bash", { command: "sudo rm -rf /" });
    expect(result.allowed).toBe(false);
  });
});
