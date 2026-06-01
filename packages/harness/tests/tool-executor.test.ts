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

  it("rejects path traversal escapes", async () => {
    const result = await executor.execute("read_file", { path: "../etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/outside the workspace|Error/);
  });

  it("rejects sibling directories with a prefix collision", async () => {
    // workspace is /tmp/harness-test-XYZ; an attacker could pass
    // /tmp/harness-test-XYZ-evil/secret which would pass a naive
    // startsWith() check but is NOT inside the workspace.
    const sibling = `${tmpDir}-evil/secret.txt`;
    const result = await executor.execute("read_file", { path: sibling });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/outside the workspace/);
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

  it("treats shell metacharacters in pattern as literal — no command injection", async () => {
    await writeFile(path.join(tmpDir, "safe.ts"), "");
    // A malicious model output. If we ever passed `pattern` into `sh -c`,
    // this would try to run `rm`. We expect zero files matched and the
    // workspace to be intact.
    const injected = '*"; touch /tmp/forgelet-pwned-$$; echo "';
    const result = await executor.execute("glob_search", { pattern: injected });
    expect(result.ok).toBe(true);
    // safe.ts must still exist (no rm executed)
    const stillThere = await readFile(path.join(tmpDir, "safe.ts"), "utf8").then(
      () => true,
      () => false,
    );
    expect(stillThere).toBe(true);
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

describe("edit_file with dollar signs in replacement", () => {
  it("treats $' literally instead of as a JS replace pattern", async () => {
    await writeFile(path.join(tmpDir, "regex.py"), 'pattern = r"old"\n');
    const result = await executor.execute("edit_file", {
      path: "regex.py",
      old_string: 'pattern = r"old"',
      new_string: "pattern = r\"$'end\"",
    });
    expect(result.ok).toBe(true);
    const content = await readFile(path.join(tmpDir, "regex.py"), "utf8");
    expect(content).toBe("pattern = r\"$'end\"\n");
  });

  it("treats $& and $` literally", async () => {
    await writeFile(path.join(tmpDir, "shell.sh"), "echo hello\n");
    const result = await executor.execute("edit_file", {
      path: "shell.sh",
      old_string: "echo hello",
      new_string: "echo $&$`$$",
    });
    expect(result.ok).toBe(true);
    const content = await readFile(path.join(tmpDir, "shell.sh"), "utf8");
    expect(content).toBe("echo $&$`$$\n");
  });
});

describe("edit_file with replace_all", () => {
  it("replaces every occurrence when replace_all=true", async () => {
    await writeFile(path.join(tmpDir, "rename.ts"), "old(); old(); foo(old);");
    const result = await executor.execute("edit_file", {
      path: "rename.ts",
      old_string: "old",
      new_string: "renamed",
      replace_all: true,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("3 replacements");
    const content = await readFile(path.join(tmpDir, "rename.ts"), "utf8");
    expect(content).toBe("renamed(); renamed(); foo(renamed);");
  });
});

describe("multi_edit", () => {
  it("applies multiple edits in sequence atomically", async () => {
    await writeFile(
      path.join(tmpDir, "src.ts"),
      "export const foo = 1;\nexport const bar = 2;",
    );
    const result = await executor.execute("multi_edit", {
      path: "src.ts",
      edits: [
        { old_string: "const foo = 1", new_string: "const foo = 10" },
        { old_string: "const bar = 2", new_string: "const bar = 20" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 edits");
    const content = await readFile(path.join(tmpDir, "src.ts"), "utf8");
    expect(content).toBe("export const foo = 10;\nexport const bar = 20;");
  });

  it("is atomic — no partial writes on failure", async () => {
    const original = "alpha\nbeta\ngamma";
    await writeFile(path.join(tmpDir, "atomic.txt"), original);
    const result = await executor.execute("multi_edit", {
      path: "atomic.txt",
      edits: [
        { old_string: "alpha", new_string: "AAA" },
        // second edit fails (string not present) — first must be rolled back.
        { old_string: "delta", new_string: "DDD" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Edit #2");
    expect(result.output).toContain("no changes written");
    const content = await readFile(path.join(tmpDir, "atomic.txt"), "utf8");
    expect(content).toBe(original);
  });

  it("supports per-edit replace_all", async () => {
    await writeFile(path.join(tmpDir, "repeat.ts"), "x x x");
    const result = await executor.execute("multi_edit", {
      path: "repeat.ts",
      edits: [{ old_string: "x", new_string: "y", replace_all: true }],
    });
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(tmpDir, "repeat.ts"), "utf8")).toBe("y y y");
  });

  it("rejects empty edits array", async () => {
    await writeFile(path.join(tmpDir, "x.txt"), "");
    const result = await executor.execute("multi_edit", { path: "x.txt", edits: [] });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/non-empty/);
  });
});

describe("apply_patch", () => {
  async function initGitRepo(): Promise<void> {
    const { execFile: spawn } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(spawn);
    await run("git", ["init", "-q"], { cwd: tmpDir });
    await run("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir });
    await run("git", ["config", "user.name", "Test"], { cwd: tmpDir });
  }

  it("applies a unified diff that adds a line", async () => {
    await initGitRepo();
    await writeFile(path.join(tmpDir, "hello.txt"), "line one\nline two\n");
    const patch = `diff --git a/hello.txt b/hello.txt
--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1,3 @@
 line one
 line two
+line three
`;
    const result = await executor.execute("apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(tmpDir, "hello.txt"), "utf8")).toBe(
      "line one\nline two\nline three\n",
    );
  });

  it("returns error on failed hunk", async () => {
    await initGitRepo();
    await writeFile(path.join(tmpDir, "hello.txt"), "completely different content\n");
    const patch = `diff --git a/hello.txt b/hello.txt
--- a/hello.txt
+++ b/hello.txt
@@ -1,2 +1,3 @@
 line one
 line two
+line three
`;
    const result = await executor.execute("apply_patch", { patch });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("git apply failed");
  });

  it("check_only does not modify files", async () => {
    await initGitRepo();
    const original = "before\n";
    await writeFile(path.join(tmpDir, "f.txt"), original);
    const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-before
+after
`;
    const result = await executor.execute("apply_patch", { patch, check_only: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("cleanly");
    expect(await readFile(path.join(tmpDir, "f.txt"), "utf8")).toBe(original);
  });
});

describe("todo_write", () => {
  it("stores a todo list and returns a formatted summary", async () => {
    const result = await executor.execute("todo_write", {
      todos: [
        { id: "1", content: "Read the file", status: "completed" },
        { id: "2", content: "Apply the fix", status: "in_progress" },
        { id: "3", content: "Run the tests", status: "pending" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("3 items");
    expect(result.output).toContain("1 done");
    expect(result.output).toContain("1 in progress");
    expect(result.output).toContain("[x] Read the file");
    expect(result.output).toContain("[>] Apply the fix");
    expect(executor.getTodos()).toHaveLength(3);
    expect(executor.getTodos()[1].status).toBe("in_progress");
  });

  it("rejects more than one in_progress at a time", async () => {
    const result = await executor.execute("todo_write", {
      todos: [
        { id: "a", content: "x", status: "in_progress" },
        { id: "b", content: "y", status: "in_progress" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("in_progress at a time");
  });

  it("rejects duplicate ids", async () => {
    const result = await executor.execute("todo_write", {
      todos: [
        { id: "x", content: "a", status: "pending" },
        { id: "x", content: "b", status: "pending" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("duplicate id");
  });

  it("rejects invalid status", async () => {
    const result = await executor.execute("todo_write", {
      todos: [{ id: "x", content: "a", status: "running" }],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/status must be one of/);
  });

  it("replaces prior list completely", async () => {
    await executor.execute("todo_write", {
      todos: [{ id: "1", content: "first", status: "pending" }],
    });
    await executor.execute("todo_write", {
      todos: [{ id: "2", content: "second", status: "completed" }],
    });
    const todos = executor.getTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe("2");
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
