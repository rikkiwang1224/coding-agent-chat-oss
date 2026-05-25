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

    this.process = spawn("bash", ["--norc", "--noprofile"], {
      cwd: this.workspaceRoot,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.appendBuffer(chunk.toString());
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      this.appendBuffer(chunk.toString());
    });

    this.process.on("exit", (code) => {
      if (this.pendingExecute) {
        const { startIdx, marker, finish } = this.pendingExecute;
        this.pendingExecute = null;
        const output = this.cleanOutput(this.buffer.slice(startIdx), marker);
        finish({ exitCode: code ?? 1, output: output || "Shell process exited" });
      }
      this.process = null;
    });

    this.writeRaw("set +o history 2>/dev/null; export PS1=''; export PS2=''\n");

    return this.process;
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

  async execute(command: string, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
    this.ensureStarted();

    const marker = `__FORGELET_BOUNDARY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const markerPattern = new RegExp(`(?:^|\\n)${escapeRegExp(marker)}:(\\d+)(?:\\r)?(?:\\n|$)`);

    return new Promise<{ exitCode: number; output: string }>((resolve) => {
      const startIdx = this.buffer.length;
      let settled = false;

      const finish = (result: { exitCode: number; output: string }): void => {
        if (settled) return;
        settled = true;
        this.pendingExecute = null;
        clearInterval(check);
        clearTimeout(timer);
        resolve(result);
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

        // Interrupt the foreground job without tearing down the shell.
        this.writeRaw("\x03");
        const output = this.cleanOutput(this.buffer.slice(startIdx), marker);
        finish({ exitCode: 124, output: output + "\n[command timed out]" });
      }, timeoutMs);

      const check = setInterval(() => {
        tryResolveFromBuffer();
      }, 25);

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
      this.process.kill("SIGTERM");
    }
    this.process = null;
    this.buffer = "";
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
