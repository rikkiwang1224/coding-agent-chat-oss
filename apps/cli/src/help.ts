export const HELP_TEXT = `forgelet — coding agent in your terminal

Usage:
  forgelet [options] [prompt]
  forgelet -i                         Interactive session
  echo "fix tests" | forgelet         Read prompt from stdin
  forgelet config set <key> <value>   Write ~/.forgelet/config.json

Commands:
  config set              Set provider, model, api key, or base URL (see: forgelet config set --help)

Options:
  -h, --help              Show this help
  -V, --version           Show version
  -i, --interactive       Interactive REPL (continues same session)
  -c, --cwd <dir>         Workspace root (default: current directory)
  -s, --session <id>      Session id (default: random uuid)
  --resume                Resume an existing session for this workspace
  -y, --yes               Auto-approve permission prompts
  -v, --verbose           Show tool output in the terminal
  --no-trace              Disable JSONL trace under ~/.forgelet/traces/
  --model <name>          LLM model id
  --provider <name>       Provider preset (deepseek, anthropic, …)
  --api-key <key>         API key (overrides env and config file)
  --base-url <url>        API base URL

Environment:
  DEEPSEEK_API_KEY / FORGELET_API_KEY   API key
  FORGELET_MODEL                        Default model
  FORGELET_PROVIDER                     Default provider
  FORGELET_BASE_URL                     API base URL
  FORGELET_HOME                         Config and data directory (~/.forgelet)

Config file:
  ~/.forgelet/config.json  { "provider", "primaryModel", "apiKey", "baseUrl" }

Examples:
  forgelet config set provider deepseek api-key sk-...
  forgelet "explain the auth flow in src/"
  forgelet -c ./my-repo --resume -s abc123 "continue fixing the tests"
  forgelet -i -y
`;
