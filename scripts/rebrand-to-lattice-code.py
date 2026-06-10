#!/usr/bin/env python3
"""One-shot Forgelet → Lattice Code rebrand for in-repo text and file renames."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SKIP_DIRS = {
    "node_modules",
    "dist",
    "release",
    ".packager",
    ".git",
    ".venv",
    ".venv-mac",
    "evaluation_results",
    "repos",
    "logs",
}

SKIP_FILES = {"pnpm-lock.yaml", "rebrand-to-lattice-code.py"}

TEXT_EXTENSIONS = {
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".sh",
    ".py",
    ".html",
    ".svg",
    ".example",
    ".txt",
    ".yml",
    ".yaml",
    "",
}

# Order matters: longer / more specific patterns first.
REPLACEMENTS: list[tuple[str, str]] = [
    ("@forgelet/", "@lattice-code/"),
    ("forgelet_agent:ForgeletAgent", "lattice_code_agent:LatticeCodeAgent"),
    ("forgelet_agent.py", "lattice_code_agent.py"),
    ("ForgeletAgent", "LatticeCodeAgent"),
    ("forgelet_run_evaluation.py", "lattice_code_run_evaluation.py"),
    ("prepare-forgelet-linux-deps.sh", "prepare-lattice-code-linux-deps.sh"),
    ("prepare-forgelet.sh", "prepare-lattice-code.sh"),
    ("forgelet-home-layout.md", "lattice-code-home-layout.md"),
    ("forgelet-icon.svg", "lattice-code-icon.svg"),
    ("tb-forgelet-staging", "tb-lattice-code-staging"),
    ("forgelet-docker-guard", "lattice-code-docker-guard"),
    ("forgelet-docker-gate", "lattice-code-docker-gate"),
    ("forgelet-docker-cg", "lattice-code-docker-cg"),
    ("forgelet-docker-v2", "lattice-code-docker-v2"),
    ("forgelet-docker", "lattice-code-docker"),
    ("forgelet-docker*.json", "lattice-code-docker*.json"),
    ("dev.forgelet.chat", "dev.latticecode.chat"),
    ("resolveForgeletTracesDir", "resolveLatticeCodeTracesDir"),
    ("resolveForgeletRunsDir", "resolveLatticeCodeRunsDir"),
    ("__FORGELET_BOUNDARY_", "__LATTICE_CODE_BOUNDARY_"),
    ("FORGELET_SPHINX_PINS", "LATTICE_CODE_SPHINX_PINS"),
    ("FORGELET_", "LATTICE_CODE_"),
    ("/root/.forgelet", "/root/.lattice-code"),
    ("~/.forgelet", "~/.lattice-code"),
    (".forgelet-apply-", ".lattice-code-apply-"),
    (".forgelet/", ".lattice-code/"),
    ('".forgelet"', '".lattice-code"'),
    ("'.forgelet'", "'.lattice-code'"),
    (".forgelet", ".lattice-code"),
    ("You are **Forgelet**", "You are **Lattice Code**"),
    ("say you are Forgelet", "say you are Lattice Code"),
    ("Forgelet on ", "Lattice Code on "),
    ("Identity section: Forgelet", "Identity section: Lattice Code"),
    ("Forgelet CLI", "Lattice Code CLI"),
    ("Forgelet harness", "Lattice Code harness"),
    ("Forgelet contributors", "Lattice Code contributors"),
    ("Forgelet icon", "Lattice Code icon"),
    ("Forgelet F mark", "Lattice Code mark"),
    ("the Forgelet CLI", "the Lattice Code CLI"),
    ("Forgelet staging", "Lattice Code staging"),
    ("Uploading Forgelet", "Uploading Lattice Code"),
    ("Forgelet already", "Lattice Code already"),
    ("Forgelet is not", "Lattice Code is not"),
    ("Forgelet install", "Lattice Code install"),
    ("Forgelet binaries", "Lattice Code binaries"),
    ("Forgelet binaries", "Lattice Code binaries"),
    ("Forgelet agent", "Lattice Code agent"),
    ("Forgelet inside", "Lattice Code inside"),
    ("for Forgelet", "for Lattice Code"),
    ("Run Forgelet", "Run Lattice Code"),
    ("with Forgelet", "with Lattice Code"),
    ("mount Node + Forgelet", "mount Node + Lattice Code"),
    ("Powered by the Forgelet", "Powered by the Lattice Code"),
    ("Terminal CLI for Forgelet", "Terminal CLI for Lattice Code"),
    ("Open-source coding agent — desktop chat and terminal CLI powered by the Forgelet harness.",
     "Open-source coding agent — desktop chat and terminal CLI powered by the Lattice Code harness."),
    ("Forgelet means", "Lattice Code means"),
    ("Use **Forgelet**", "Use **Lattice Code**"),
    ("Use `forgelet`", "Use `lc`"),
    ("# Forgelet", "# Lattice Code"),
    ('"Forgelet"', '"Lattice Code"'),
    ('appName: "Forgelet"', 'appName: "Lattice Code"'),
    ('return "Forgelet"', 'return "Lattice Code"'),
    ('const APP_NAME = "Forgelet"', 'const APP_NAME = "Lattice Code"'),
    ('<title>Forgelet</title>', '<title>Lattice Code</title>'),
    ('productName: "Forgelet"', 'productName: "Lattice Code"'),
    ('author: "Forgelet"', 'author: "Lattice Code"'),
    ('value \\"Forgelet\\"', 'value \\"Lattice Code\\"'),
    ('APP_NAME = "Forgelet"', 'APP_NAME = "Lattice Code"'),
    ("forgelet — coding agent", "lc — Lattice Code coding agent"),
    ("forgelet config set", "lc config set"),
    ("forgelet [options]", "lc [options]"),
    ("forgelet -i", "lc -i"),
    ("| forgelet", "| lc"),
    ("  forgelet ", "  lc "),
    ("pnpm forgelet", "pnpm lc"),
    ('"forgelet": "./dist/main.js"', '"lc": "./dist/main.js",\n    "lattice-code": "./dist/main.js"'),
    ('"name": "forgelet"', '"name": "lattice-code"'),
    ('"forgelet": "pnpm --filter @lattice-code/cli dev"', '"lc": "pnpm --filter @lattice-code/cli dev"'),
    ("Forgelet", "Lattice Code"),
    ("forgelet", "lc"),
]

FILE_RENAMES: list[tuple[str, str]] = [
    ("brand/forgelet-icon.svg", "brand/lattice-code-icon.svg"),
    ("docs/design/forgelet-home-layout.md", "docs/design/lattice-code-home-layout.md"),
    (
        "packages/harness/eval/terminal-bench/prepare-forgelet-linux-deps.sh",
        "packages/harness/eval/terminal-bench/prepare-lattice-code-linux-deps.sh",
    ),
    (
        "packages/harness/eval/terminal-bench/prepare-forgelet.sh",
        "packages/harness/eval/terminal-bench/prepare-lattice-code.sh",
    ),
    (
        "packages/harness/eval/terminal-bench/forgelet_agent.py",
        "packages/harness/eval/terminal-bench/lattice_code_agent.py",
    ),
    (
        "packages/harness/eval/swe-bench/forgelet_run_evaluation.py",
        "packages/harness/eval/swe-bench/lattice_code_run_evaluation.py",
    ),
]


def should_skip(path: Path) -> bool:
    parts = set(path.parts)
    if parts & SKIP_DIRS:
        return True
    if path.name in SKIP_FILES:
        return True
    if path.suffix not in TEXT_EXTENSIONS and path.name not in {"LICENSE", ".gitignore", "BRAND.md"}:
        return False
    return False


def transform(text: str) -> str:
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    return text


def patch_brand_md(text: str) -> str:
    return text.replace(
        "Meaning: a small forge. The app is a compact local workbench where prompts, tool calls, and code context are shaped into useful changes.",
        "Meaning: a structural layer where code, context, and agents connect. A local workbench for agent-driven development.",
    ).replace(
        "A small forge for code conversations.",
        "The structural layer for code conversations.",
    ).replace(
        "Use `lc` for package/repo slugs.",
        "Use `lc` for the CLI; `@lattice-code/*` for packages.",
    )


def patch_readme_intro(text: str) -> str:
    return text.replace(
        "Lattice Code means \"a small forge\": a compact local workbench where prompts, tool calls, and code context are shaped into useful changes.",
        "Lattice Code is a compact local workbench where prompts, tool calls, and code context connect into useful changes.",
    )


def process_file(path: Path) -> bool:
    try:
        original = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False

    updated = transform(original)
    if path.as_posix().endswith("brand/BRAND.md"):
        updated = patch_brand_md(updated)
    if path.name == "README.md" and path.parent == ROOT:
        updated = patch_readme_intro(updated)

    if updated != original:
        path.write_text(updated, encoding="utf-8")
        return True
    return False


def main() -> None:
    changed = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = Path(dirpath) / name
            if should_skip(path):
                continue
            if process_file(path):
                changed += 1
                print(f"updated: {path.relative_to(ROOT)}")

    for old, new in FILE_RENAMES:
        src = ROOT / old
        dst = ROOT / new
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dst)
            print(f"renamed: {old} -> {new}")

    print(f"\nDone. {changed} files updated, {len(FILE_RENAMES)} paths renamed.")


if __name__ == "__main__":
    main()
