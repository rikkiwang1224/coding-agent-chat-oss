import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ToolExecutor } from "../src/tools/executor.js";
import type { CodebaseMemoryClient, CodebaseMemoryCliResult } from "../src/code-graph/codebase-memory.js";

const ok = (parsed: unknown): CodebaseMemoryCliResult => ({ ok: true, output: "", parsed });
const notFound = (): CodebaseMemoryCliResult => ({
  ok: false,
  output: "symbol not found. Use search_graph(name_pattern=\"...\") first to discover the exact qualified_name.",
});

async function withExecutor(
  stub: Partial<CodebaseMemoryClient>,
  fn: (ex: ToolExecutor) => Promise<void>,
): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cg-recover-"));
  const ex = new ToolExecutor({ workspaceRoot: tmp, codeGraph: stub as CodebaseMemoryClient });
  try {
    await fn(ex);
  } finally {
    ex.destroy();
    await rm(tmp, { recursive: true, force: true });
  }
}

describe("code_graph_snippet recovery (P3)", () => {
  it("auto-resolves a unique match when the qualified_name misses", async () => {
    let snippetCalls = 0;
    const stub: Partial<CodebaseMemoryClient> = {
      async getCodeSnippet({ qualified_name }) {
        snippetCalls++;
        if (qualified_name === "pkg.models.Request.prepare") {
          return ok({ qualified_name, file_path: "models.py", start_line: 10, code: "def prepare(self):\n    pass" });
        }
        return notFound();
      },
      async searchGraph() {
        return ok({ total: 1, results: [{ name: "prepare", qualified_name: "pkg.models.Request.prepare", file_path: "models.py", line: 10 }] });
      },
    };
    await withExecutor(stub, async (ex) => {
      const r = await ex.execute("code_graph_snippet", { qualified_name: "wrong.guess.prepare" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("Auto-resolved");
      expect(r.output).toContain("def prepare");
      expect(snippetCalls).toBe(2); // original miss + auto-resolved fetch
    });
  });

  it("returns copy-pasteable candidates when several symbols match", async () => {
    const stub: Partial<CodebaseMemoryClient> = {
      async getCodeSnippet() {
        return notFound();
      },
      async searchGraph() {
        return ok({
          total: 2,
          results: [
            { name: "get", qualified_name: "pkg.a.A.get", file_path: "a.py", line: 1 },
            { name: "get", qualified_name: "pkg.b.B.get", file_path: "b.py", line: 2 },
          ],
        });
      },
    };
    await withExecutor(stub, async (ex) => {
      const r = await ex.execute("code_graph_snippet", { qualified_name: "pkg.get" });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("Candidates for \"get\"");
      expect(r.output).toContain("pkg.a.A.get");
      expect(r.output).toContain("pkg.b.B.get");
    });
  });

  it("falls back to the original error when nothing matches", async () => {
    const stub: Partial<CodebaseMemoryClient> = {
      async getCodeSnippet() {
        return notFound();
      },
      async searchGraph() {
        return ok({ total: 0, results: [] });
      },
    };
    await withExecutor(stub, async (ex) => {
      const r = await ex.execute("code_graph_snippet", { qualified_name: "pkg.nonexistent" });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/symbol not found|search_graph/i);
    });
  });

  it("code_graph_search appends a snippet next-step hint", async () => {
    const stub: Partial<CodebaseMemoryClient> = {
      async searchGraph() {
        return ok({ total: 1, results: [{ name: "prepare", qualified_name: "pkg.models.Request.prepare", file_path: "models.py", line: 10 }] });
      },
    };
    await withExecutor(stub, async (ex) => {
      const r = await ex.execute("code_graph_search", { name_pattern: "prepare" });
      expect(r.ok).toBe(true);
      expect(r.output).toContain("[Next step]");
      expect(r.output).toContain('code_graph_snippet(qualified_name="pkg.models.Request.prepare")');
    });
  });
});
