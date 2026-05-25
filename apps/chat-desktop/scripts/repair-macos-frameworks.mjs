import { existsSync, lstatSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function ensureSymlink(linkPath, targetPath) {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }

    return readlinkSync(linkPath) === targetPath;
  } catch {
    symlinkSync(targetPath, linkPath);
    return true;
  }
}

export function verifyCodeSignature(appPath) {
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

export function adHocSign(appPath) {
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "ignore"
    });
  } catch {
    // Best effort repair only.
  }
}

export function repairFrameworkSymlinks(appBundlePath) {
  const frameworksDir = path.join(appBundlePath, "Contents", "Frameworks");
  const frameworkNames = ["Electron Framework", "Mantle", "ReactiveObjC", "Squirrel"];

  for (const frameworkName of frameworkNames) {
    const frameworkRoot = path.join(frameworksDir, `${frameworkName}.framework`);
    const versionDir = path.join(frameworkRoot, "Versions", "A");
    if (!existsSync(versionDir)) {
      continue;
    }

    ensureSymlink(path.join(frameworkRoot, "Versions", "Current"), "A");

    if (existsSync(path.join(versionDir, frameworkName))) {
      ensureSymlink(path.join(frameworkRoot, frameworkName), `Versions/Current/${frameworkName}`);
    }

    for (const entry of ["Resources", "Libraries", "Helpers"]) {
      if (existsSync(path.join(versionDir, entry))) {
        ensureSymlink(path.join(frameworkRoot, entry), `Versions/Current/${entry}`);
      }
    }
  }
}

function resolveAppBundlePath(appOutDir) {
  const candidates = readdirSync(appOutDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(appOutDir, entry.name));

  return candidates[0] ?? null;
}

export default async function afterPack(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const appBundlePath = resolveAppBundlePath(context.appOutDir);
  if (!appBundlePath) {
    return;
  }

  repairFrameworkSymlinks(appBundlePath);
  if (!verifyCodeSignature(appBundlePath)) {
    adHocSign(appBundlePath);
  }
}
