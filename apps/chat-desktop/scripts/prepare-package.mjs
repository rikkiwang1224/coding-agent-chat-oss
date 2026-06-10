import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(appRoot, "../..");
const packagerRoot = path.join(appRoot, ".packager");
const stagedAppRoot = path.join(packagerRoot, "app");
const BUILD_SCRIPT = "build";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function shouldCopyStaticPath(sourcePath) {
  const baseName = path.basename(sourcePath);
  return ![".DS_Store", ".turbo", ".cache", ".vite"].includes(baseName);
}

function shouldCopyRuntimePath(sourcePath) {
  const baseName = path.basename(sourcePath);
  if (!shouldCopyStaticPath(sourcePath)) {
    return false;
  }

  return ![".bin", ".cache", ".turbo", ".vite", ".tsbuildinfo"].includes(baseName);
}

async function copyPath(sourcePath, destinationPath, options = {}) {
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required path: ${sourcePath}`);
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    dereference: options.dereference ?? false,
    verbatimSymlinks: options.dereference === true ? false : true,
    filter: options.filter ?? shouldCopyStaticPath
  });
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

async function stageRootPackage(destinationRoot, sourcePackage) {
  const excludedDependencies = new Set(["electron"]);
  await writeJson(path.join(destinationRoot, "package.json"), {
    name: "lc",
    productName: "Lattice Code",
    version: sourcePackage.version,
    private: true,
    description: sourcePackage.description,
    author: "Lattice Code",
    type: "module",
    main: "apps/chat-desktop/dist/main.js",
    dependencies: Object.fromEntries(
      Object.entries(sourcePackage.dependencies ?? {}).filter(([dependencyName]) => !excludedDependencies.has(dependencyName))
    ),
    optionalDependencies: Object.fromEntries(
      Object.entries(sourcePackage.optionalDependencies ?? {}).filter(
        ([dependencyName]) => !excludedDependencies.has(dependencyName)
      )
    )
  });
}

function readRuntimeDependencyNames(packageJson, options = {}) {
  const exclude = options.exclude ?? new Set();
  return [
    ...new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {})
    ])
  ].filter((dependencyName) => !exclude.has(dependencyName));
}

function resolveNodeModuleEntry(nodeModulesRoot, packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    return path.join(nodeModulesRoot, scope, name);
  }

  return path.join(nodeModulesRoot, packageName);
}

async function stageRuntimeDependencies(sourceDir, destinationDir, options = {}) {
  const packageJson = await readJson(path.join(sourceDir, "package.json"));
  const dependencyNames = readRuntimeDependencyNames(packageJson, options);
  if (dependencyNames.length === 0) {
    return;
  }

  await stageDependencyTree(
    path.join(sourceDir, "node_modules"),
    path.join(destinationDir, "node_modules"),
    dependencyNames
  );
}

async function stageDependencyTree(sourceNodeModulesRoot, destinationNodeModulesRoot, dependencyNames, seen = new Set()) {
  for (const dependencyName of dependencyNames) {
    const sourcePath = resolveNodeModuleEntry(sourceNodeModulesRoot, dependencyName);
    if (!existsSync(sourcePath)) {
      continue;
    }
    const realPackageDir = await realpath(sourcePath);
    const destinationPath = resolveNodeModuleEntry(destinationNodeModulesRoot, dependencyName);
    const cacheKey = `${destinationPath}::${realPackageDir}`;
    if (seen.has(cacheKey)) {
      continue;
    }
    seen.add(cacheKey);

    await copyPath(sourcePath, destinationPath, {
      dereference: true,
      filter: shouldCopyRuntimePath
    });

    const nestedDependencies = await readNestedDependencies(realPackageDir);
    if (nestedDependencies.length === 0) {
      continue;
    }

    const nestedSourceNodeModulesRoot = await resolveNestedNodeModulesRoot(realPackageDir, nestedDependencies);
    if (!nestedSourceNodeModulesRoot) {
      continue;
    }

    await stageDependencyTree(
      nestedSourceNodeModulesRoot,
      path.join(destinationPath, "node_modules"),
      nestedDependencies,
      seen
    );
  }
}

async function readNestedDependencies(packageDir) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  const packageJson = await readJson(packageJsonPath);
  return readRuntimeDependencyNames(packageJson);
}

async function resolveNestedNodeModulesRoot(packageDir, dependencyNames = []) {
  const localNodeModules = path.join(packageDir, "node_modules");
  if (
    existsSync(localNodeModules) &&
    dependencyNames.some((dependencyName) => existsSync(resolveNodeModuleEntry(localNodeModules, dependencyName)))
  ) {
    return localNodeModules;
  }

  const normalized = packageDir.split(path.sep);
  const nodeModulesIndex = normalized.lastIndexOf("node_modules");
  if (nodeModulesIndex >= 0) {
    return normalized.slice(0, nodeModulesIndex + 1).join(path.sep);
  }

  return null;
}

async function stagePackageRuntime(sourceDir, destinationDir) {
  await copyPath(path.join(sourceDir, "dist"), path.join(destinationDir, "dist"));
  await copyPath(path.join(sourceDir, "package.json"), path.join(destinationDir, "package.json"));
  await stageRuntimeDependencies(sourceDir, destinationDir);
}

async function stageChatDesktopApp() {
  const sourceDir = path.join(workspaceRoot, "apps", "chat-desktop");
  const sourcePackage = await readJson(path.join(sourceDir, "package.json"));
  const destinationDir = path.join(stagedAppRoot, "apps", "chat-desktop");
  const excludedDependencies = new Set(["electron"]);

  await stageRootPackage(stagedAppRoot, sourcePackage);
  await copyPath(path.join(sourceDir, "dist"), path.join(destinationDir, "dist"));
  await copyPath(path.join(sourceDir, "package.json"), path.join(destinationDir, "package.json"));

  // electron-builder only preserves app-level production dependencies reliably,
  // so stage chat-desktop runtime deps at the staged app root.
  await stageRuntimeDependencies(sourceDir, stagedAppRoot, { exclude: excludedDependencies });
}

async function main() {
  await runCommand("pnpm", ["run", BUILD_SCRIPT], appRoot);

  await rm(packagerRoot, { recursive: true, force: true });
  await mkdir(stagedAppRoot, { recursive: true });

  await stageChatDesktopApp();

  console.log(`[prepare-package] staged app at ${stagedAppRoot}`);
}

await main();
