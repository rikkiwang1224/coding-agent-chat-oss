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
        "Perform a precise string replacement in a file. The old_string must match exactly one " +
        "location in the file. Include enough surrounding context to ensure uniqueness.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or workspace-relative path to the file",
          },
          old_string: {
            type: "string",
            description: "The exact text to find and replace (must be unique in the file)",
          },
          new_string: {
            type: "string",
            description: "The text to replace it with",
          },
        },
        required: ["path", "old_string", "new_string"],
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
