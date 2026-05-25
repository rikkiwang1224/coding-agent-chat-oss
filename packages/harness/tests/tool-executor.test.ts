import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolExecutor } from "../src/tools/executor.js";

let tmpDir: string;
let executor: ToolExecutor;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "harness-test-"));
  executor = new ToolExecutor({ workspaceRoot: tmpDir });
});

afterEach(async () => {
  executor.destroy();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("read_file", () => {
  it("reads a file and returns numbered lines", async () => {
    await writeFile(path.join(tmpDir, "hello.txt"), "line1\nline2\nline3");
    const result = await executor.execute("read_file", { path: "hello.txt" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1|line1");
    expect(result.output).toContain("2|line2");
    expect(result.output).toContain("3|line3");
  });

  it("supports offset and limit", async () => {
    await writeFile(path.join(tmpDir, "big.txt"), "a\nb\nc\nd\ne\nf");
    const result = await executor.execute("read_file", { path: "big.txt", offset: 3, limit: 2 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("3|c");
    expect(result.output).toContain("4|d");
    expect(result.output).not.toContain("2|b");
    expect(result.output).not.toContain("5|e");
  });

  it("returns error for non-existent file", async () => {
    const result = await executor.execute("read_file", { path: "nope.txt" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Error");
  });

  it("handles absolute paths", async () => {
    const absPath = path.join(tmpDir, "abs.txt");
    await writeFile(absPath, "absolute content");
    const result = await executor.execute("read_file", { path: absPath });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("absolute content");
  });
});

describe("write_file", () => {
  it("creates a new file", async () => {
    const result = await executor.execute("write_file", {
      path: "new.txt",
      content: "hello world",
    });
    expect(result.ok).toBe(true);
    const content = await readFile(path.join(tmpDir, "new.txt"), "utf8");
    expect(content).toBe("hello world");
  });

  it("creates parent directories automatically", async () => {
    const result = await executor.execute("write_file", {
      path: "deep/nested/dir/file.ts",
      content: "export const x = 1;",
    });
    expect(result.ok).toBe(true);
    const content = await readFile(path.join(tmpDir, "deep/nested/dir/file.ts"), "utf8");
    expect(content).toBe("export const x = 1;");
  });

  it("overwrites existing file", async () => {
    await writeFile(path.join(tmpDir, "exist.txt"), "old");
    const result = await executor.execute("write_file", {
      path: "exist.txt",
      content: "new",
    });
    expect(result.ok).toBe(true);
    const content = await readFile(path.join(tmpDir, "exist.txt"), "utf8");
    expect(content).toBe("new");
  });
});

describe("edit_file", () => {
  it("replaces a unique string", async () => {
    await writeFile(path.join(tmpDir, "code.ts"), 'const x = "old";\nconst y = 2;');
    const result = await executor.execute("edit_file", {
      path: "code.ts",
      old_string: 'const x = "old";',
      new_string: 'const x = "new";',
    });
    expect(result.ok).toBe(true);
    const content = await readFile(path.join(tmpDir, "code.ts"), "utf8");
    expect(content).toBe('const x = "new";\nconst y = 2;');
  });

  it("fails if old_string not found", async () => {
    await writeFile(path.join(tmpDir, "code.ts"), "const a = 1;");
    const result = await executor.execute("edit_file", {
      path: "code.ts",
      old_string: "not found",
      new_string: "replacement",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("fails if old_string matches multiple locations", async () => {
    await writeFile(path.join(tmpDir, "dup.ts"), "foo\nfoo\nbar");
    const result = await executor.execute("edit_file", {
      path: "dup.ts",
      old_string: "foo",
      new_string: "baz",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("2 times");
  });

  it("fails if old_string is empty", async () => {
    await writeFile(path.join(tmpDir, "x.ts"), "content");
    const result = await executor.execute("edit_file", {
      path: "x.ts",
      old_string: "",
      new_string: "something",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("cannot be empty");
  });
});

describe("bash", () => {
  it("runs a simple command and returns stdout", async () => {
    const result = await executor.execute("bash", { command: "echo hello" });
    expect(result.ok).toBe(true);
    expect(result.output.trim()).toContain("hello");
  });

  it("returns error for failing command", async () => {
    const result = await executor.execute("bash", { command: "exit 1" });
    expect(result.ok).toBe(false);
  });

  it("supports persistent cwd via cd", async () => {
    await mkdir(path.join(tmpDir, "subdir"));
    await writeFile(path.join(tmpDir, "subdir", "marker.txt"), "found");
    const result = await executor.execute("bash", {
      command: "cd subdir && cat marker.txt",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("found");
  });

  it("times out long commands", async () => {
    const result = await executor.execute("bash", {
      command: "sleep 30",
      timeout_ms: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out");
  });

  it("returns empty command error", async () => {
    const result = await executor.execute("bash", { command: "" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("required");
  });
});

describe("glob_search", () => {
  it("finds files matching pattern", async () => {
    await writeFile(path.join(tmpDir, "a.ts"), "");
    await writeFile(path.join(tmpDir, "b.ts"), "");
    await writeFile(path.join(tmpDir, "c.js"), "");
    const result = await executor.execute("glob_search", { pattern: "*.ts" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("a.ts");
    expect(result.output).toContain("b.ts");
    expect(result.output).not.toContain("c.js");
  });

  it("returns message for no matches", async () => {
    const result = await executor.execute("glob_search", { pattern: "*.xyz" });
    expect(result.ok).toBe(true);
    expect(result.output.toLowerCase()).toContain("no files");
  });
});

describe("grep_search", () => {
  it("finds pattern in files", async () => {
    await writeFile(path.join(tmpDir, "search.ts"), "const hello = 1;\nconst world = 2;");
    const result = await executor.execute("grep_search", { pattern: "hello" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("returns no matches message", async () => {
    await writeFile(path.join(tmpDir, "empty.ts"), "nothing here");
    const result = await executor.execute("grep_search", { pattern: "ZZZZZ_NOT_FOUND" });
    expect(result.ok).toBe(true);
    expect(result.output.toLowerCase()).toContain("no matches");
  });
});

describe("list_directory", () => {
  it("lists files and directories", async () => {
    await mkdir(path.join(tmpDir, "src"));
    await writeFile(path.join(tmpDir, "package.json"), "{}");
    await writeFile(path.join(tmpDir, "index.ts"), "");
    const result = await executor.execute("list_directory", {});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("src/");
    expect(result.output).toContain("package.json");
    expect(result.output).toContain("index.ts");
  });

  it("supports subdirectory path", async () => {
    await mkdir(path.join(tmpDir, "lib"));
    await writeFile(path.join(tmpDir, "lib", "util.ts"), "");
    const result = await executor.execute("list_directory", { path: "lib" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("util.ts");
  });

  it("hides dotfiles by default", async () => {
    await writeFile(path.join(tmpDir, ".hidden"), "");
    await writeFile(path.join(tmpDir, "visible.ts"), "");
    const result = await executor.execute("list_directory", {});
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain(".hidden");
    expect(result.output).toContain("visible.ts");
  });
});

describe("unknown tool", () => {
  it("returns error for unknown tool name", async () => {
    const result = await executor.execute("nonexistent_tool", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Unknown tool");
  });
});
