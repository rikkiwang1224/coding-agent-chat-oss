import type { ToolDefinition } from "../types.js";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file at the given path. Returns the file content as a string. " +
        "Use this to inspect source code, config files, or any text-based file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or workspace-relative path to the file to read",
          },
          offset: {
            type: "integer",
            description: "Starting line number (1-indexed). Omit to read from the beginning.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to read. Omit to read the entire file.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
        "Creates parent directories automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or workspace-relative path to the file",
          },
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Perform a precise string replacement in a file. By default old_string must match exactly " +
        "one location in the file — include enough surrounding context to ensure uniqueness. " +
        "Set replace_all=true to replace every occurrence (useful for renames).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or workspace-relative path to the file",
          },
          old_string: {
            type: "string",
            description: "The exact text to find and replace (must be unique unless replace_all=true)",
          },
          new_string: {
            type: "string",
            description: "The text to replace it with",
          },
          replace_all: {
            type: "boolean",
            description:
              "If true, replace every occurrence of old_string. Defaults to false (require unique match).",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "multi_edit",
      description:
        "Apply a batch of sequential string replacements to a single file in one atomic operation. " +
        "Each edit is applied in order; if any edit fails (old_string not found, or non-unique " +
        "without replace_all) the file is NOT modified and an error is returned. Use this instead " +
        "of multiple edit_file calls to reduce round trips when making several related changes to " +
        "the same file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or workspace-relative path to the file",
          },
          edits: {
            type: "array",
            description: "Ordered list of edits to apply. Each edit operates on the output of the previous one.",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string", description: "Text to find" },
                new_string: { type: "string", description: "Text to replace it with" },
                replace_all: {
                  type: "boolean",
                  description: "If true, replace every occurrence. Default false (require unique match).",
                },
              },
              required: ["old_string", "new_string"],
            },
            minItems: 1,
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply a unified diff patch to the workspace using `git apply`. The patch must be in " +
        "standard unified diff format (`--- a/file` / `+++ b/file` headers, `@@ -l,n +l,n @@` " +
        "hunk headers). Use this for multi-file changes where edit_file would require many round " +
        "trips. Returns clear errors when hunks fail to apply (line drift, conflicts, missing files).",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description: "The unified diff content. Whitespace and context must match the working tree.",
          },
          check_only: {
            type: "boolean",
            description: "If true, run `git apply --check` and report whether the patch would apply, without modifying any files.",
          },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Write or update the agent's working todo list for this session. Use for multi-step tasks " +
        "(3+ distinct steps) so the user can see your plan and you can track progress. Pass the " +
        "FULL list every call — items not present are removed. Mark one item as in_progress at a " +
        "time. Updates replace prior state for the session.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete todo list (replaces any prior list).",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable identifier (used to track across updates)." },
                content: { type: "string", description: "What this step does." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a command in a persistent bash shell. State (cwd, environment variables) " +
        "persists between calls — use `cd` to change directories and it will stick. " +
        "Use for running tests, git, package managers, build tools, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          timeout_ms: {
            type: "integer",
            description: "Command timeout in milliseconds. Defaults to 60000 (60s).",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_search",
      description:
        "Search for files matching a glob pattern in the workspace. " +
        "Returns a list of matching file paths sorted by modification time.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'Glob pattern (e.g. "**/*.ts", "src/**/*.tsx", "package.json")',
          },
          cwd: {
            type: "string",
            description: "Directory to search in. Defaults to workspace root.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description:
        "Search file contents using a regex pattern (ripgrep). " +
        "Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for",
          },
          path: {
            type: "string",
            description: "File or directory to search in. Defaults to workspace root.",
          },
          include: {
            type: "string",
            description: 'Glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}")',
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List the contents of a directory. Returns file/directory names with type indicators.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the directory. Defaults to workspace root.",
          },
        },
        required: [],
      },
    },
  },
];
