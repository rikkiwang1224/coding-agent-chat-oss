/**
 * The execution boundary for the agent — the "E" layer of ETCLOVG.
 *
 * Every command the agent runs goes through an `ExecutionEnvironment`. This is
 * the single chokepoint where isolation policy is applied: env redaction,
 * resource limits, and (in future implementations) filesystem/network
 * confinement. Tools depend on this interface, never on a concrete shell, so
 * that a sandboxed implementation can be swapped in without touching the
 * agent loop or tool layer.
 *
 * Implementations:
 *   - LocalEnvironment      — persistent local bash, hardened (default).
 *   - SandboxedEnvironment  — OS-native sandbox (macOS Seatbelt / Linux bwrap). [planned]
 */
export interface ExecutionEnvironment {
  /**
   * Run a shell command and resolve with its exit code and combined
   * stdout/stderr. Honors `timeoutMs` (the command is force-killed on timeout)
   * and `signal` (abort tears down the environment). State such as cwd/env set
   * by a previous command may persist across calls within the same instance.
   */
  execute(
    command: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; output: string }>;

  /** Resolve the environment's current working directory. */
  getCwd(): Promise<string>;

  /** Tear down the environment and any processes it owns. */
  destroy(): void;
}

/** Factory used by the tool layer to lazily create an execution environment. */
export type ExecutionEnvironmentFactory = (
  workspaceRoot: string,
) => ExecutionEnvironment;
