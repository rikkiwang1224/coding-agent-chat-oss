import { spawn, type ChildProcess } from "node:child_process";
import type { ExecutionEnvironment } from "./execution-environment.js";

const MAX_BUFFER_CHARS = 512 * 1024;

/**
 * Env var name patterns that must never be exposed to the agent's shell.
 * Matched case-insensitively against the variable NAME. Covers the harness's
 * own provider keys plus the broad universe of secrets a developer is likely
 * to have exported (cloud creds, CI tokens, etc).
 */
const SENSITIVE_ENV_PATTERNS: RegExp[] = [
  /API[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /PRIVATE[_-]?KEY/i,
  /SESSION[_-]?KEY/i,
  /PASSPHRASE/i,
];

/**
 * Env var name prefixes that are stripped wholesale (provider + cloud vendor
 * namespaces). Catches keys that don't contain an obvious "secret" token, e.g.
 * `DEEPSEEK_API_KEY` is already caught above but `AWS_SESSION_*` etc. are
 * covered defensively here too.
 */
const SENSITIVE_ENV_PREFIXES: string[] = [
  "AWS_",
  "TENCENTCLOUD_",
  "ALIYUN_",
  "OPENAI_",
  "ANTHROPIC_",
  "DEEPSEEK_",
  "KIMI_",
  "MOONSHOT_",
  "GLM_",
  "ZHIPU_",
  "GROQ_",
  "GEMINI_",
  "MISTRAL_",
  "OPENROUTER_",
];

/** Env names the harness uses internally that should not leak into the shell. */
const SENSITIVE_ENV_EXACT: string[] = ["LATTICE_CODE_API_KEY"];

function isSensitiveEnvName(name: string): boolean {
  if (SENSITIVE_ENV_EXACT.includes(name)) return true;
  const upper = name.toUpperCase();
  if (SENSITIVE_ENV_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(name));
}

/**
 * Produce a redacted copy of `source` with secret-looking variables removed.
 *
 * `allow` force-keeps specific names even if they match a sensitive pattern
 * (e.g. a user who genuinely needs `GITHUB_TOKEN` for `git push`). When
 * `passthrough` is true the source is returned untouched (escape hatch for
 * workflows broken by redaction).
 */
export function redactSensitiveEnv(
  source: NodeJS.ProcessEnv,
  options: { allow?: string[]; passthrough?: boolean } = {},
): Record<string, string> {
  const allow = new Set(options.allow ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!options.passthrough && !allow.has(name) && isSensitiveEnvName(name)) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Read the comma-separated allowlist from LATTICE_CODE_EXEC_ENV_ALLOW. */
function resolveEnvAllowlist(): string[] {
  const raw = process.env.LATTICE_CODE_EXEC_ENV_ALLOW?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Escape hatch: LATTICE_CODE_EXEC_ENV_PASSTHROUGH=1 disables env redaction. */
function isEnvPassthrough(): boolean {
  return process.env.LATTICE_CODE_EXEC_ENV_PASSTHROUGH === "1";
}

/**
 * Conservative resource limits applied at shell startup. Values are generous
 * enough not to disturb normal dev workflows (builds, test suites) but cap
 * the blast radius of a runaway/forky command. Each is overridable via env,
 * and `0`/empty disables that specific limit.
 *
 *   LATTICE_CODE_EXEC_MAX_PROCS      ulimit -u  (max user processes)
 *   LATTICE_CODE_EXEC_MAX_FILESIZE   ulimit -f  (max file size, blocks of 1KB)
 *   LATTICE_CODE_EXEC_CORE           ulimit -c  (core dump size, blocks)
 */
interface ResourceLimits {
  maxProcs: number | null;
  maxFileSizeBlocks: number | null;
  coreBlocks: number | null;
}

function resolveLimitEnv(name: string, fallback: number | null): number | null {
  const raw = process.env[name]?.trim();
  if (raw === undefined) return fallback;
  if (raw === "" || raw === "unlimited") return null; // explicitly disabled
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function resolveResourceLimits(): ResourceLimits {
  return {
    // 4096 procs: well above any normal build/test fan-out, stops fork bombs.
    maxProcs: resolveLimitEnv("LATTICE_CODE_EXEC_MAX_PROCS", 4096),
    // ~4GB single-file cap (blocks are 1KB): prevents runaway disk fill while
    // leaving room for large build artifacts.
    maxFileSizeBlocks: resolveLimitEnv("LATTICE_CODE_EXEC_MAX_FILESIZE", 4 * 1024 * 1024),
    // No core dumps by default — pure safety, never needed for agent work.
    coreBlocks: resolveLimitEnv("LATTICE_CODE_EXEC_CORE", 0),
  };
}

function buildUlimitInit(limits: ResourceLimits): string {
  const parts: string[] = [];
  if (limits.coreBlocks !== null) parts.push(`ulimit -c ${limits.coreBlocks} 2>/dev/null`);
  if (limits.maxProcs !== null) parts.push(`ulimit -u ${limits.maxProcs} 2>/dev/null`);
  if (limits.maxFileSizeBlocks !== null) {
    parts.push(`ulimit -f ${limits.maxFileSizeBlocks} 2>/dev/null`);
  }
  // `: ` (no-op) guarantees a zero exit even if every ulimit was disabled,
  // so the init line never poisons the first command's status.
  parts.push(":");
  return parts.join("; ");
}

/**
 * Local, hardened execution environment: a persistent `bash` subprocess bound
 * to `workspaceRoot`. Maintains shell state (cwd, env vars) across commands and
 * uses boundary markers to delimit command output.
 *
 * Hardening (vs. a raw shell):
 *   - secret env vars are redacted before the shell ever sees them;
 *   - conservative ulimits cap process/file-size/core blast radius;
 *   - the shell is a process-group leader so the whole job tree is killable.
 *
 * This is the default `ExecutionEnvironment`. It does NOT confine the
 * filesystem or network — that is the job of a future SandboxedEnvironment.
 */
export class LocalEnvironment implements ExecutionEnvironment {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pendingExecute: PendingExecute | null = null;
  private readonly workspaceRoot: string;
  private readonly env: Record<string, string>;
  private readonly ulimitInit: string;

  constructor(workspaceRoot: string, env?: Record<string, string>) {
    this.workspaceRoot = workspaceRoot;
    // Redact secrets from the inherited environment BEFORE handing it to the
    // shell. The harness process holds provider API keys; the agent's commands
    // must never be able to read them via `env`/`printenv`.
    const base = redactSensitiveEnv(process.env, {
      allow: resolveEnvAllowlist(),
      passthrough: isEnvPassthrough(),
    });
    this.env = {
      ...base,
      ...env,
      TERM: "dumb",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
      PS1: "",
      PS2: "",
    };
    this.ulimitInit = buildUlimitInit(resolveResourceLimits());
  }

  private ensureStarted(): ChildProcess {
    if (this.process && this.process.exitCode === null) {
      return this.process;
    }

    this.buffer = "";

    // `detached: true` makes the shell a process-group leader so we can kill
    // the entire job tree (the shell *and* any child like `pytest`) on timeout
    // or abort. Without this, a non-interactive bash ignores Ctrl-C from stdin
    // and a runaway command keeps running, blocking every subsequent command.
    const proc = spawn("bash", ["--norc", "--noprofile"], {
      cwd: this.workspaceRoot,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    proc.stdout!.on("data", (chunk: Buffer) => {
      if (this.process !== proc) return; // stale data from a torn-down shell
      this.appendBuffer(chunk.toString());
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      if (this.process !== proc) return;
      this.appendBuffer(chunk.toString());
    });

    proc.on("exit", (code) => {
      // If we've already swapped to a different process (e.g. user aborted
      // mid-command and a new shell was spawned for the next call), this
      // listener belongs to the dead one — must not touch the new shell's
      // pendingExecute.
      if (this.process !== proc) return;
      if (this.pendingExecute) {
        const { startIdx, marker, finish } = this.pendingExecute;
        this.pendingExecute = null;
        const output = this.cleanOutput(this.buffer.slice(startIdx), marker);
        finish({ exitCode: code ?? 1, output: output || "Shell process exited" });
      }
      this.process = null;
    });

    this.process = proc;
    // Apply resource limits + quiet the prompt before any user command runs.
    this.writeRaw(
      `set +o history 2>/dev/null; export PS1=''; export PS2=''; ${this.ulimitInit}\n`,
    );

    return proc;
  }

  private appendBuffer(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_CHARS);
    }
  }

  private writeRaw(data: string): void {
    this.process?.stdin?.write(data);
  }

  async execute(
    command: string,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; output: string }> {
    this.ensureStarted();

    const marker = `__LATTICE_CODE_BOUNDARY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const markerPattern = new RegExp(`(?:^|\\n)${escapeRegExp(marker)}:(\\d+)(?:\\r)?(?:\\n|$)`);

    if (signal?.aborted) {
      throw new Error("Shell command aborted");
    }

    return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
      const startIdx = this.buffer.length;
      let settled = false;
      let abortHandler: (() => void) | undefined;

      const cleanup = (): void => {
        clearInterval(check);
        clearTimeout(timer);
        if (abortHandler) {
          signal?.removeEventListener("abort", abortHandler);
          abortHandler = undefined;
        }
      };

      const finish = (result: { exitCode: number; output: string }): void => {
        if (settled) return;
        settled = true;
        this.pendingExecute = null;
        cleanup();
        resolve(result);
      };

      const failWith = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.pendingExecute = null;
        cleanup();
        reject(error);
      };

      this.pendingExecute = { startIdx, marker, finish };

      const tryResolveFromBuffer = (): boolean => {
        const slice = this.buffer.slice(startIdx);
        const match = markerPattern.exec(slice);
        if (!match) return false;

        const endMarkerIdx = startIdx + match.index;
        finish(this.parseOutput(startIdx, endMarkerIdx, marker, Number(match[1])));
        return true;
      };

      const timer = setTimeout(() => {
        if (tryResolveFromBuffer()) return;

        // A non-interactive bash (no TTY/job control) ignores `\x03` from
        // stdin, so the foreground job would keep running and block every
        // later command until it too timed out. Kill the whole process group
        // and reset the shell; the next execute() spawns a fresh one.
        const output = this.cleanOutput(this.buffer.slice(startIdx), marker);
        const proc = this.process;
        if (proc) this.killProcessTree(proc, "SIGKILL");
        this.process = null;
        this.buffer = "";
        const seconds = Math.round(timeoutMs / 1000);
        finish({
          exitCode: 124,
          output:
            output +
            `\n[command timed out after ${seconds}s and was terminated. ` +
            `Narrow the scope (e.g. run a single test file or test case) ` +
            `or pass a larger timeout_ms.]`,
        });
      }, timeoutMs);

      const check = setInterval(() => {
        tryResolveFromBuffer();
      }, 25);

      if (signal) {
        abortHandler = (): void => {
          // Non-interactive bash (no TTY, no job control) ignores `\x03` from
          // stdin, so we must signal the process directly. Killing the whole
          // group (shell + any child job) is the right semantics for "user
          // aborted the agent run": the next tool call (if any) will spawn a
          // fresh shell via ensureStarted().
          if (this.process && this.process.exitCode === null) {
            this.killProcessTree(this.process, "SIGTERM");
          }
          this.process = null;
          this.buffer = "";
          failWith(new Error("Shell command aborted"));
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      const wrappedCommand = `${command}
__ec=$?
printf '\\n${marker}:%s\\n' "$__ec"
`;
      this.writeRaw(wrappedCommand);
    });
  }

  private parseOutput(
    startIdx: number,
    endMarkerIdx: number,
    marker: string,
    exitCode: number,
  ): { exitCode: number; output: string } {
    const raw = this.buffer.slice(startIdx, endMarkerIdx);
    return { exitCode, output: this.cleanOutput(raw, marker) };
  }

  private cleanOutput(raw: string, marker: string): string {
    return raw
      .split("\n")
      .filter((line) => {
        if (line.includes("__ec=$?")) return false;
        if (line.includes(marker)) return false;
        if (line.includes("bash: no job control in this shell")) return false;
        if (line.includes("The default interactive shell is now zsh")) return false;
        if (line.includes("support.apple.com/kb/HT208050")) return false;
        if (/^bash-[\d.]+$/.test(line.trim())) return false;
        return true;
      })
      .join("\n")
      .trim();
  }

  getCwd(): Promise<string> {
    return this.execute("pwd", 5000).then((r) => r.output.trim());
  }

  destroy(): void {
    if (this.process && this.process.exitCode === null) {
      this.killProcessTree(this.process, "SIGTERM");
    }
    this.process = null;
    this.buffer = "";
  }

  /**
   * Kill the shell and every process it spawned. Because the shell is started
   * as a process-group leader (`detached: true`), `process.kill(-pid)` signals
   * the whole group. Falls back to killing just the shell if the group send
   * fails (e.g. it already exited).
   */
  private killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (typeof proc.pid !== "number") return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // already exited — nothing to clean up
      }
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface PendingExecute {
  startIdx: number;
  marker: string;
  finish: (result: { exitCode: number; output: string }) => void;
}
