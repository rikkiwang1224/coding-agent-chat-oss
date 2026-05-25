import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { adHocSign, repairFrameworkSymlinks, verifyCodeSignature } from "./repair-macos-frameworks.mjs";

if (process.platform !== "darwin") {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electronBinaryPath = require("electron");
const electronAppPath = path.resolve(electronBinaryPath, "..", "..", "..");

repairFrameworkSymlinks(electronAppPath);
if (!verifyCodeSignature(electronAppPath)) {
  adHocSign(electronAppPath);
}
