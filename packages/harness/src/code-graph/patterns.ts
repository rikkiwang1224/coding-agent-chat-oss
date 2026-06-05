/**
 * Normalize file_pattern / path args for codebase-memory-mcp v0.7 CLI.
 *
 * search_graph file_pattern → SQL LIKE (`%` wildcards), NOT regex.
 * search_code file_pattern   → glob (`*` wildcards); use `path` for directory prefix.
 */

/** Split "route|router" into ["route", "router"] for multi-scope search. */
export function splitAlternatives(pattern: string): string[] {
  return pattern
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * search_graph: wrap module names like "purchase-order" as "%purchase-order%".
 * Regex-style ".*foo.*" is converted to "%foo%".
 */
export function normalizeSearchGraphFilePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("%")) return trimmed;
  if (trimmed.includes("|")) {
    return normalizeSearchGraphFilePattern(splitAlternatives(trimmed)[0] ?? trimmed);
  }
  const globLike = trimmed.match(/^\.\*(.+)\.\*$/);
  if (globLike) return `%${globLike[1]}%`;
  if (trimmed.startsWith(".*")) return `%${trimmed.slice(2).replace(/\.\*$/, "")}%`;
  if (trimmed.endsWith(".*")) return `%${trimmed.slice(0, -2).replace(/^\.\*/, "")}%`;
  if (!trimmed.includes("*") && !trimmed.includes("?") && !trimmed.includes("^") && !trimmed.includes("$")) {
    return `%${trimmed}%`;
  }
  return trimmed;
}

export interface SearchCodeScope {
  file_pattern?: string;
  path?: string;
}

/**
 * search_code: map module names to glob "*module*"; directory paths use `**`.
 *
 * CBM's file_pattern is a standard glob where `*` does NOT cross `/`.
 * Patterns containing `/` must use `**` to match across directory separators.
 * "purchase-order/views/list" → "**​/purchase-order/views/list/**"
 */
export function normalizeSearchCodeScope(raw?: string): SearchCodeScope {
  if (!raw?.trim()) return {};
  const trimmed = raw.trim();
  if (trimmed.includes("/")) {
    const cleaned = trimmed.replace(/^\/+|\/+$/g, "");
    return { file_pattern: `**/${cleaned}/**` };
  }
  if (trimmed.includes("*")) {
    return { file_pattern: trimmed };
  }
  if (trimmed.includes("%")) {
    return { file_pattern: trimmed.replace(/%/g, "*") };
  }
  const globLike = trimmed.match(/^\.\*(.+)\.\*$/);
  if (globLike) return { file_pattern: `*${globLike[1]}*` };
  return { file_pattern: `*${trimmed}*` };
}

/** codebase-memory-mcp rejects `(?i)` inline flags in name_pattern. */
export function sanitizeSearchGraphNamePattern(pattern: string): string {
  return pattern.replace(/^\(\?i\)/, "").replace(/^\(\?[a-z]*i[a-z]*\)/, "");
}

/**
 * CBM search_code `pattern` is literal text — no regex, no `|` alternation.
 * Strip regex meta-characters (`.`, `*`, `+`, `?`, `^`, `$`, `(`, `)`) and
 * split on `|` so the caller can issue one query per alternative.
 */
export function splitAndCleanCodeSearchQuery(raw: string): string[] {
  return raw
    .split("|")
    .map((seg) =>
      seg
        .replace(/\.\*/g, "")
        .replace(/\.\+/g, "")
        .replace(/[\\^$()[\]{}+?]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((s) => s.length > 0);
}
