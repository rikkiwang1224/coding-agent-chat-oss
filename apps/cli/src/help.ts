export const HELP_TEXT = `lc — Lattice Code coding agent in your terminal

Usage:
  lc [options] [prompt]
  lc -i                         Interactive session
  echo "fix tests" | lc         Read prompt from stdin
  lc config set <key> <value>   Write ~/.lattice-code/config.json

Commands:
  config set              Set provider, model, api key, or base URL (see: lc config set --help)

Options:
  -h, --help              Show this help
  -V, --version           Show version
  -i, --interactive       Interactive REPL (continues same session)
  -c, --cwd <dir>         Workspace root (default: current directory)
  -s, --session <id>      Session id (default: random uuid)
  --resume                Resume an existing session for this workspace
  -y, --yes               Auto-approve permission prompts
  -v, --verbose           Show tool output in the terminal
  --no-trace              Disable JSONL trace under ~/.lattice-code/traces/
  --model <name>          LLM model id
  --provider <name>       Provider preset (deepseek, anthropic, …)
  --api-key <key>         API key (overrides env and config file)
  --base-url <url>        API base URL

Environment:
  DEEPSEEK_API_KEY / LATTICE_CODE_API_KEY   API key
  LATTICE_CODE_MODEL                        Default model
  LATTICE_CODE_PROVIDER                     Default provider
  LATTICE_CODE_BASE_URL                     API base URL
  LATTICE_CODE_HOME                         Config and data directory (~/.lattice-code)

Config file:
  ~/.lattice-code/config.json  { "provider", "primaryModel", "apiKey", "baseUrl" }

Examples:
  lc config set provider deepseek api-key sk-...
  lc "explain the auth flow in src/"
  lc -c ./my-repo --resume -s abc123 "continue fixing the tests"
  lc -i -y
`;
