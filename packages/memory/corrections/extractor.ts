/**
 * Detects, within a single turn's tool calls (`FinishedTurn.calls`), a CLI
 * command call that failed followed later by one for the same binary that
 * succeeded: a candidate procedural correction, about a *tool*, true for
 * whoever uses that command next, not just this person. Pairing is
 * deterministic (pure string/status matching); describing *what* the
 * correction actually was is delegated to the model, with a fixed schema.
 */
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { HookCall } from "@mercury-fw/plugin-types";

export const ProceduralCorrectionCandidateSchema = z.object({ topic: z.string(), value: z.string() });
export type ProceduralCorrection = { tool: string; topic: string; value: string };

type GenerateObjectFn = (params: {
  model: LanguageModel;
  output: "array";
  schema: typeof ProceduralCorrectionCandidateSchema;
  instructions: string;
  prompt: string;
}) => Promise<{ object: z.infer<typeof ProceduralCorrectionCandidateSchema>[] }>;

// The note's file is `<tool>-<topic>.md`, so the tool's name in the topic
// doubles it, and two wordings of one rule make two files (#112).
const SYSTEM_PROMPT =
  "You are shown a command attempt that failed and a later one, for the same tool, that succeeded in " +
  "the same conversation turn. Describe the correction learned as a {topic, value} pair. " +
  '"topic" is a short, stable key for this correction: the name of the flag or subcommand it is about, ' +
  "in kebab-case, without the tool's name (the tool is already known: \"select-flag\", not " +
  '"jira-select-flag"); a correction about the same flag as another one gets the same key. ' +
  '"value" is the practical rule to remember, in one sentence, useful to anyone who runs this command ' +
  "later, not only to whoever found it now. If the second attempt isn't really a correction of the " +
  "first one's error (e.g. the user simply asked for something else), return an empty array.";

/** The topic is free text, not a closed enum (procedural corrections are open-ended by nature): normalized so one rule keeps one key. */
function normalizeTopic(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

type Attempt = { command: string; binary: string; ok: boolean; error?: string };


function extractAttempts(calls: HookCall[]): Attempt[] {
  const attempts: Attempt[] = [];
  for (const call of calls) {
    // A CLI attempt is any tool call carrying a `command` string — the
    // generic shape every CLI tool takes, whatever its name (jiraCommand,
    // bitbucketCommand, the residual runCommand). Keying on a fixed tool name
    // would silently miss plugin-owned CLI tools; keying on the input shape
    // stays correct as new CLI plugins are added.
    const input = call.input as { command?: unknown } | null;
    if (typeof input?.command !== "string") continue;
    // Group attempts by the binary they invoked, which is just the command's
    // first whitespace-delimited token. An empty/whitespace-only command has
    // no binary to group by.
    const binary = input.command.trim().split(/\s+/)[0] ?? "";
    if (binary === "") continue;
    attempts.push({ command: input.command, binary, ok: call.ok, ...(call.error === undefined ? {} : { error: call.error }) });
  }
  return attempts;
}

/** Each failed attempt paired with the first later attempt for the same binary that succeeded — never the reverse, and never across different binaries. */
function findCorrectionPairs(attempts: Attempt[]): Array<{ failed: Attempt; corrected: Attempt }> {
  const pairs: Array<{ failed: Attempt; corrected: Attempt }> = [];
  for (let i = 0; i < attempts.length; i++) {
    const failed = attempts[i];
    if (!failed || failed.ok) continue;
    const corrected = attempts.slice(i + 1).find((a) => a.binary === failed.binary && a.ok);
    if (corrected) {
      pairs.push({ failed, corrected });
    }
  }
  return pairs;
}

/** Whether `calls` hold a failed command followed by a successful one for the same binary: something for the model to describe. */
export function hasCorrectionCandidates(calls: HookCall[]): boolean {
  return findCorrectionPairs(extractAttempts(calls)).length > 0;
}

/** Returns a function that extracts candidate procedural corrections from a single turn's calls. */
export function createToolCorrectionExtractor(
  model: LanguageModel,
  generateObjectFn: GenerateObjectFn = generateObject as unknown as GenerateObjectFn,
  deps?: { log?: (msg: string) => void },
): (calls: HookCall[]) => Promise<ProceduralCorrection[]> {
  const log = deps?.log ?? ((msg: string) => console.error(msg));

  return async (calls) => {
    const pairs = findCorrectionPairs(extractAttempts(calls));
    const corrections: ProceduralCorrection[] = [];

    for (const { failed, corrected } of pairs) {
      try {
        const { object } = await generateObjectFn({
          model,
          output: "array",
          schema: ProceduralCorrectionCandidateSchema,
          instructions: SYSTEM_PROMPT,
          prompt:
            `Failed command: ${failed.command}\n` +
            `Error: ${failed.error ?? "(no message)"}\n` +
            `Corrected command (succeeded): ${corrected.command}`,
        });
        for (const candidate of object) {
          corrections.push({ tool: failed.binary, topic: normalizeTopic(candidate.topic), value: candidate.value });
        }
      } catch (err) {
        log(`procedural correction extraction failed for ${failed.binary}: ${String(err)}`);
      }
    }

    return corrections;
  };
}
