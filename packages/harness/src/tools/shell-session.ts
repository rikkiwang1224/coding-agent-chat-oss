import { spawn, type ChildProcess } from "node:child_process";

const MAX_BUFFER_CHARS = 512 * 1024;

/**
 * Persistent shell session that maintains state (cwd, env vars) across commands.
 * Uses boundary markers to delimit command output.
 */
export class ShellSession {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pendingExecute: PendingExecute | null = null;
  private readonly workspaceRoot: string;
  private readonly env: Record<string, string>;

  constructor(workspaceRoot: string, env?: Record<string, string>) {
    this.workspaceRoot = workspaceRoot;
    this.env = {
      ...(process.env as Record<string, string>),
      ...env,
      TERM: "dumb",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
      PS1: "",
      PS2: "",
    };
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
    this.writeRaw("set +o history 2>/dev/null; export PS1=''; export PS2=''\n");

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

    const marker = `__FORGELET_BOUNDARY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
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
