/**
 * VerifyHook — a generic "ground-truth" verification primitive.
 *
 * Design intent: when the agent declares done, the harness can invoke an
 * arbitrary external "judge" (typically the project's own test suite, a
 * typechecker, a linter, a CI dry-run...) and, if the judge reports failure,
 * inject the failure output as a user message and continue the loop.
 *
 * Contrast with `reason.ts` (the LLM Sensor): Verify is NOT an LLM. It's
 * deterministic, cheap, and ground-truth. An LLM Sensor can be fooled by a
 * plausible-looking patch; a failing test cannot.
 *
 * Generality: this module knows nothing about tests specifically. It just
 * runs a command, parses the output via a caller-supplied `parseOutput`,
 * and shapes the verdict. The SWE-bench adapter (eval/swe-bench/...) is one
 * of many possible callers; real projects can configure their own via
 * `.forgelet/verify.json` or a package.json `scripts.verify` adapter.
 *
 * Cost guard:
 *   - bounded by `maxRounds` (default 3)
 *   - command runs in-process via execFile with a hard timeout
 *
 * Failure mode:
 *   - command spawn errors / timeouts / unparseable output → verdict "fail"
 *     with the error in `feedback`. The agent sees the truth.
 *   - we NEVER auto-pass on infrastructure failure: that's how silent
 *     regressions sneak in.
 */
import { execFile } from "node:child_process";

export interface VerifyConfig {
  enabled: boolean;
  /**
   * Build the command to execute. Async so callers can do dynamic
   * lookups (e.g. read git diff to pick which tests to run). Returns
   * undefined to mean "nothing to verify this round — skip the gate"
   * (treated as pass).
   */
  buildCommand: () => Promise<VerifyCommand | undefined>;
  /**
   * Parse exec output → structured verdict. Caller-supplied because
   * different judges (pytest / runtests.py / tsc / cargo check) have
   * different output formats.
   */
  parseOutput: (result: ExecResult) => VerifyResult;
  /** Per-round command timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
  /** Max revise→retry cycles before accepting agent state. Default 3. */
  maxRounds?: number;
  /**
   * Optional human-friendly tag shown in trace events / feedback header,
   * e.g. "test-gate" or "tsc".
   */
  label?: string;
}

export interface VerifyCommand {
  /** First element is the program, rest are args. Avoid shell so we don't quote-escape. */
  argv: string[];
  cwd: string;
  /** Extra env vars (merged with process.env). */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Set when the process was killed by our timeout. */
  timedOut: boolean;
  /** Total wall time in ms. */
  durationMs: number;
  /** Command that was actually run (for diagnostics). */
  command: VerifyCommand;
}

export interface VerifyResult {
  verdict: "pass" | "fail";
  /**
   * Human-readable feedback. When verdict=fail, this is injected into the
   * agent loop as a user message. Should be concise (< 4k chars) and
   * actionable — favor showing the FAILING bits of output, not boilerplate.
   */
  feedback: string;
  /** Optional per-check breakdown for telemetry / trace. */
  checks?: VerifyCheck[];
}

export interface VerifyCheck {
  name: string;
  passed: boolean;
  /** Truncated error / traceback when !passed. */
  detail?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Run a single verification round. Returns the structured verdict.
 *
 * Does NOT throw: any spawn/timeout/parse error is captured into a `fail`
 * verdict with the error visible in `feedback`. That way the loop in
 * agent-loop.ts can treat all outcomes uniformly.
 */
export async function runVerify(config: VerifyConfig): Promise<VerifyResult | "skipped"> {
  const command = await config.buildCommand().catch((err) => {
    throw new Error(`buildCommand threw: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!command) return "skipped";

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await execCommand(command, timeoutMs);

  try {
    return config.parseOutput(result);
  } catch (err) {
    // A broken parser is our bug, not the agent's — surface it loudly but
    // still fail the gate so we don't accidentally ship.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verdict: "fail",
      feedback: [
        `[verify ${config.label ?? "gate"}] parser error: ${msg.slice(0, 200)}`,
        `command: ${formatArgv(command.argv)}`,
        `exit ${result.exitCode}, ${result.timedOut ? "TIMED OUT, " : ""}${result.durationMs}ms`,
        ``,
        `stdout (tail):`,
        truncateTail(result.stdout, 1500),
        ``,
        `stderr (tail):`,
        truncateTail(result.stderr, 1500),
      ].join("\n"),
    };
  }
}

/**
 * Format the verdict as a user message to inject into the agent loop.
 * The header includes the round number so the agent (and we, debugging)
 * can see how many verify cycles have happened.
 */
export function formatVerifyFeedback(
  result: VerifyResult,
  round: number,
  label?: string,
): string {
  return [
    `[${label ?? "verify"} gate — round ${round}]`,
    result.feedback.trim(),
    ``,
    `Please address the failures above, then say done. I'll re-verify.`,
  ].join("\n");
}

async function execCommand(cmd: VerifyCommand, timeoutMs: number): Promise<ExecResult> {
  const startedAt = Date.now();
  const env = cmd.env ? { ...process.env, ...cmd.env } : process.env;

  return new Promise<ExecResult>((resolve) => {
    let timedOut = false;
    const child = execFile(
      cmd.argv[0],
      cmd.argv.slice(1),
      {
        cwd: cmd.cwd,
        env,
        // Captures large outputs (pytest can be loud) without bombing.
        // 8 MiB is generous; truncation happens later in the parser.
        maxBuffer: MAX_OUTPUT_BYTES,
        // Use signal-based termination so child gets a chance to flush.
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const errObj = err as (Error & { code?: number | string; killed?: boolean }) | null;
        const exitCode =
          errObj && typeof errObj.code === "number"
            ? errObj.code
            : err
              ? null
              : 0;
        // execFile sets err.killed when the timeout fires.
        if (errObj?.killed) timedOut = true;
        // Spawn failures (ENOENT, EACCES, etc.) come through the callback
        // with `err.code` as a string and empty stderr — surface the message
        // so parsers and humans can see what actually went wrong.
        let stderrStr = String(stderr ?? "");
        if (err && stderrStr.length === 0) {
          const tag = typeof errObj?.code === "string" ? `${errObj.code}: ` : "";
          stderrStr = `${tag}${err.message ?? "exec error"}`;
        }

        resolve({
          stdout: String(stdout ?? ""),
          stderr: stderrStr,
          exitCode,
          timedOut,
          durationMs,
          command: cmd,
        });
      },
    );

    // execFile spawn failure (ENOENT) — surface as an exec result rather
    // than rejecting, so the parser sees it uniformly.
    child.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: `spawn error: ${err.message}`,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        command: cmd,
      });
    });
  });
}

function formatArgv(argv: string[]): string {
  return argv
    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
    .join(" ");
}

/** Keep the last `maxChars` of a string; useful for showing the tail of long pytest output. */
export function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `... [${text.length - maxChars} bytes elided] ...\n${text.slice(-maxChars)}`;
}

/** Keep the first `maxChars`; useful when failure markers tend to be at the top. */
export function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [${text.length - maxChars} bytes elided] ...`;
}

/**
 * Common helper for parsers that want to show "first N lines containing FAIL/ERROR
 * + tail context" — works well for unittest / pytest output.
 */
export function extractFailureExcerpt(
  text: string,
  patterns: RegExp[],
  contextLines = 5,
  maxBytes = 3000,
): string {
  const lines = text.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) hits.push(i);
  }
  if (hits.length === 0) return truncateTail(text, maxBytes);

  // Collect a window around each hit, merging overlapping windows.
  const windows: Array<[number, number]> = [];
  for (const h of hits) {
    const start = Math.max(0, h - contextLines);
    const end = Math.min(lines.length - 1, h + contextLines);
    if (windows.length > 0 && start <= windows[windows.length - 1][1] + 1) {
      windows[windows.length - 1][1] = end;
    } else {
      windows.push([start, end]);
    }
  }

  const parts: string[] = [];
  let used = 0;
  for (const [start, end] of windows) {
    const block = lines.slice(start, end + 1).join("\n");
    if (used + block.length > maxBytes) {
      parts.push(truncateHead(block, maxBytes - used));
      parts.push(`... [more failures elided to fit budget] ...`);
      break;
    }
    parts.push(block);
    used += block.length;
    parts.push(`...`);
  }
  return parts.join("\n");
}
