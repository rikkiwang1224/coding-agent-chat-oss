import { spawn, type ChildProcess } from "node:child_process";

/**
 * Persistent shell session that maintains state (cwd, env vars) across commands.
 * Uses boundary markers to delimit command output.
 */
export class ShellSession {
  private process: ChildProcess | null = null;
  private buffer = "";
  private readonly workspaceRoot: string;
  private readonly env: Record<string, string>;

  constructor(workspaceRoot: string, env?: Record<string, string>) {
    this.workspaceRoot = workspaceRoot;
    this.env = { ...process.env as Record<string, string>, ...env, TERM: "dumb" };
  }

  private ensureStarted(): ChildProcess {
    if (this.process && this.process.exitCode === null) {
      return this.process;
    }

    this.process = spawn("bash", ["--norc", "--noprofile", "-i"], {
      cwd: this.workspaceRoot,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
    });

    // Disable echo and set a simple prompt to avoid noise
    this.writeRaw("set +o history; export PS1=''; export PS2=''\n");

    return this.process;
  }

  private writeRaw(data: string): void {
    this.process?.stdin?.write(data);
  }

  async execute(command: string, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
    const proc = this.ensureStarted();

    // Generate a unique boundary marker
    const marker = `__SHELL_BOUNDARY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;

    return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
      const startIdx = this.buffer.length;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // Kill the timed-out command but keep the shell alive
          proc.kill("SIGINT");
          const output = this.extractOutput(startIdx, marker);
          resolve({ exitCode: 124, output: output + "\n[command timed out]" });
        }
      }, timeoutMs);

      const check = setInterval(() => {
        const endMarkerIdx = this.buffer.indexOf(marker, startIdx);
        if (endMarkerIdx !== -1) {
          clearInterval(check);
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            const { exitCode, output } = this.parseOutput(startIdx, endMarkerIdx, marker);
            resolve({ exitCode, output });
          }
        }
      }, 50);

      // Send the command followed by the exit-code echoing boundary
      const wrappedCommand = `${command}\n__ec=$?\necho "${marker}:$__ec"\n`;
      this.writeRaw(wrappedCommand);

      // If the process dies unexpectedly
      proc.once("exit", () => {
        clearInterval(check);
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          const output = this.buffer.slice(startIdx);
          resolve({ exitCode: 1, output: output || "Shell process exited unexpectedly" });
        }
      });
    });
  }

  private parseOutput(startIdx: number, endMarkerIdx: number, marker: string): { exitCode: number; output: string } {
    // Extract everything between start and the boundary marker line
    const raw = this.buffer.slice(startIdx, endMarkerIdx);

    // Parse exit code from the marker line
    const afterMarker = this.buffer.slice(endMarkerIdx);
    const markerLine = afterMarker.split("\n")[0];
    const ecMatch = markerLine.match(/:(\d+)/);
    const exitCode = ecMatch ? parseInt(ecMatch[1], 10) : 0;

    // Clean up: remove the command echo and any prompt artifacts
    const output = raw
      .split("\n")
      .filter((line) => {
        // Filter out our internal commands
        if (line.includes("__ec=$?")) return false;
        if (line.includes("echo \"" + marker)) return false;
        return true;
      })
      .join("\n")
      .trim();

    return { exitCode, output };
  }

  private extractOutput(startIdx: number, _marker: string): string {
    return this.buffer.slice(startIdx).trim();
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
