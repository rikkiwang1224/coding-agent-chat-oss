export interface CliArgs {
  help: boolean;
  version: boolean;
  interactive: boolean;
  resume: boolean;
  yes: boolean;
  verbose: boolean;
  noTrace: boolean;
  cwd?: string;
  sessionId?: string;
  prompt?: string;
  model?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

export function parseArgv(argv: string[]): CliArgs {
  const args = [...argv];
  const consumed = new Set<number>();

  function hasFlag(...names: string[]): boolean {
    return names.some((n) => args.includes(`--${n}`) || args.includes(`-${n}`));
  }

  function getArg(...names: string[]): string | undefined {
    for (const name of names) {
      const long = `--${name}`;
      const idx = args.indexOf(long);
      if (idx >= 0 && args[idx + 1]) {
        consumed.add(idx);
        consumed.add(idx + 1);
        return args[idx + 1];
      }
      const short = name.length === 1 ? `-${name}` : undefined;
      if (short) {
        const sidx = args.indexOf(short);
        if (sidx >= 0 && args[sidx + 1]) {
          consumed.add(sidx);
          consumed.add(sidx + 1);
          return args[sidx + 1];
        }
      }
      const inline = args.find((a) => a.startsWith(`${long}=`));
      if (inline) {
        const i = args.indexOf(inline);
        consumed.add(i);
        return inline.slice(long.length + 1);
      }
    }
    return undefined;
  }

  const cwd = getArg("cwd", "c");
  const sessionId = getArg("session", "s");
  const model = getArg("model");
  const provider = getArg("provider");
  const apiKey = getArg("api-key");
  const baseUrl = getArg("base-url");

  const prompt = args
    .filter((_, i) => !consumed.has(i))
    .filter((a) => !a.startsWith("-"))
    .join(" ")
    .trim();

  return {
    help: hasFlag("help", "h"),
    version: hasFlag("version", "V"),
    interactive: hasFlag("interactive", "i"),
    resume: hasFlag("resume"),
    yes: hasFlag("yes", "y"),
    verbose: hasFlag("verbose", "v"),
    noTrace: hasFlag("no-trace"),
    cwd,
    sessionId,
    prompt: prompt || undefined,
    model,
    provider,
    apiKey,
    baseUrl,
  };
}
