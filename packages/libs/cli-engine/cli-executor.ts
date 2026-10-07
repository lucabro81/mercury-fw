/**
 * Generic subprocess runner for the external CLI binaries Mercury talks
 * to (jira, google-chat, ...). Every external integration is a separate
 * CLI binary invoked as a subprocess — never an arbitrary shell string,
 * never MCP. This file is the one and only place that spawns a process,
 * in the one shape Mercury needs: a one-shot command that exits and
 * produces a single parsed output (`runCli`).
 *
 * Nothing imports `runCli` to call it directly except the composition root:
 * every consumer declares it as a `typeof runCli` dependency and receives
 * it injected, so a test can supply a fake without spawning a subprocess.
 * `cli-tool.ts` (`runCommand`'s `execute`) and
 * `@mercury-fw/confirm-engine`'s `confirm-flow.ts` (the second half of the confirm
 * flow) are the two that actually run model-requested commands; the rest use it for
 * version checks and diagnostics. The registered
 * Google Chat provider (`@mercury-fw/channel-google-chat`) does not use this module at all — it talks to
 * the Chat REST API and Pub/Sub directly over HTTPS, never through a CLI
 * subprocess (see `google-chat-app-client.ts`).
 */

// `CliResult` is part of the plugin contract (a post-processor receives and
// returns one), so it lives in `@mercury-fw/plugin-types` and is re-exported here
// for the many core callers that import it from this module. Never throws —
// callers branch on `ok` instead of catching.
import type { CliResult } from "@mercury-fw/plugin-types";
export type { CliResult };

/** The exit code the CLIs Mercury's plugins run use when the identity a
 * command runs as (the service, or the person `--user` names) has no login,
 * or one that has to be made again: what tells it apart from any other
 * failure. */
export const CLI_NOT_LOGGED_IN_EXIT_CODE = 3;

/**
 * Thin wrapper around `Bun.spawn` with both stdout and stderr piped.
 * Extracted into its own function (rather than calling `Bun.spawn`
 * inline in `runCli`) so its return type carries the literal `"pipe"`
 * option through to the caller — assigning the spawn call to a
 * pre-declared `ReturnType<typeof Bun.spawn>` variable would otherwise
 * widen `stdout`/`stderr` to a generic union TypeScript can't narrow.
 */
function spawnPiped(binary: string, args: string[]) {
  return Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
}

/**
 * Runs `binary` with `args`, waits for it to exit, and parses its
 * stdout as JSON when possible.
 *
 * Resolves to `{ ok: false, error }` — never rejects/throws — for the
 * binary not existing on `PATH` or a non-zero exit code (the error
 * includes the exit code and stderr, and `exitCode` carries the code). Success is exit code 0, full stop:
 * if stdout happens to be valid JSON it's parsed into `data`, otherwise
 * the raw trimmed text is `data` instead. Non-JSON stdout on a 0 exit is
 * not a parse failure — `--help` output is exactly this shape (plain
 * text, exit 0), and treating it as `ok: false` meant the model saw a
 * "failed" tool call for what was actually a successful discovery call —
 * observed live to send it into a confused, apologetic retry spiral.
 */
export async function runCli(
  binary: string,
  args: string[],
): Promise<CliResult> {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(binary, args);
  } catch (err) {
    return { ok: false, error: `failed to spawn ${binary}: ${String(err)}` };
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return {
      ok: false,
      error: `${binary} exited with code ${exitCode}: ${stderr.trim()}`,
      exitCode,
    };
  }

  try {
    return { ok: true, data: JSON.parse(stdout) };
  } catch {
    return { ok: true, data: stdout.trim() };
  }
}
