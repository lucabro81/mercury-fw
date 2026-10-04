/**
 * The nightly self-review job's three LLM passes. Each is a fresh,
 * stateless `generateText` call — never a persisted conversation history
 * like `agent-turn.ts`'s `runTurn` — so nothing carries over between
 * passes or between nights except what actually landed on disk. Running
 * all four checks as one giant multi-step call would let tool-call
 * context accumulate across unrelated jobs at once; splitting into three
 * independent calls keeps each one's context bounded to its own job.
 *
 * `generateText` comes from `ai-sdk-ollama`, matching `agent-turn.ts` —
 * plain `ai`'s version is documented there to return empty text after a
 * tool call on this codebase's Ollama setup, which applies here too
 * since every pass uses tools.
 */
import { isStepCount, type LanguageModel, type Tool } from "ai";
import { generateText } from "ai-sdk-ollama";
import type { Message } from "../session/history.ts";
import { createSelfReviewTools } from "./self-review-tools.ts";

/** A guard against a model that loops, not what decides how far a pass gets:
 * 15 left passes half done, and rereading a doc that changed costs steps. */
export const SELF_REVIEW_STEP_COUNT = 100;

type GenerateTextFn = (params: {
  model: LanguageModel;
  messages: Message[];
  tools: Record<string, Tool>;
  instructions: string;
}) => Promise<{ text: string }>;

const defaultGenerateTextFn: GenerateTextFn = (params) =>
  generateText({ ...params, stopWhen: isStepCount(SELF_REVIEW_STEP_COUNT) });

async function runPass(params: {
  vaultPath: string;
  model: LanguageModel;
  instructions: string;
  userMessage: string;
  generateTextFn?: GenerateTextFn;
}): Promise<void> {
  const tools = createSelfReviewTools({ vaultPath: params.vaultPath });
  const generate = params.generateTextFn ?? defaultGenerateTextFn;
  await generate({
    model: params.model,
    messages: [{ role: "user", content: params.userMessage }],
    tools,
    instructions: params.instructions,
  });
}

const SHARED_BOUNDARIES =
  "You can read/list/grep curated/ and raw/, write curated docs, add/update or remove a curated " +
  "doc's index.md entry (update_index_entry/remove_index_entry — never hand-write index.md's " +
  "content yourself, those tools own its exact format), and delete resolved raw/ entries. You have " +
  "no access to inferred/ — it is written exclusively by a separate deterministic process, never by " +
  "judgment calls like this one. Read a curated doc before you rewrite or delete it: write_curated and " +
  "delete_curated act only on the version you last read, because other writes can land while you work. " +
  "If one says the doc changed since you read it, read it again and redo your edit on the current version.";

const RAW_TRIAGE_SYSTEM =
  "You are performing Mercury's periodic wiki self-review — the raw/ triage pass. For each entry " +
  "in raw/, read it and decide: merge its content into an existing curated doc, promote it into a " +
  "new curated doc, or discard it (already superseded, duplicate, or simply not wiki-worthy — one " +
  "bucket, not three). Then delete it from raw/ once resolved. If you create or meaningfully change " +
  "a curated doc, call update_index_entry for it too. " +
  SHARED_BOUNDARIES;

const INDEX_AND_ORPHAN_SYSTEM =
  "You are performing Mercury's periodic wiki self-review — the index.md and orphan-page pass. For " +
  "each orphaned curated doc listed below, decide whether it needs an index.md entry " +
  "(update_index_entry), a cross-link from a related doc, or both. " +
  SHARED_BOUNDARIES;

const CONTRADICTION_CHECK_SYSTEM =
  "You are performing Mercury's periodic wiki self-review — the contradiction and cross-link check. " +
  "Read through curated/ and look for direct contradictions between documents, or clearly-related " +
  "documents missing a cross-link between them. Fix what you're confident about; leave the rest — " +
  "this is best-effort, not exhaustive. If you delete a doc as a resolved duplicate, call " +
  "remove_index_entry for it in the same pass. " +
  SHARED_BOUNDARIES;

export type RawTriagePassDeps = {
  vaultPath: string;
  model: LanguageModel;
  rawEntries: string[];
  generateTextFn?: GenerateTextFn;
};

export async function runRawTriagePass(deps: RawTriagePassDeps): Promise<void> {
  const userMessage = ["raw/ entries to triage:", ...deps.rawEntries.map((e) => `- ${e}`)].join("\n");
  await runPass({
    vaultPath: deps.vaultPath,
    model: deps.model,
    instructions: RAW_TRIAGE_SYSTEM,
    userMessage,
    generateTextFn: deps.generateTextFn,
  });
}

export type IndexAndOrphanPassDeps = {
  vaultPath: string;
  model: LanguageModel;
  orphans: string[];
  generateTextFn?: GenerateTextFn;
};

export async function runIndexAndOrphanPass(deps: IndexAndOrphanPassDeps): Promise<void> {
  const userMessage = [
    "Orphaned curated docs (not referenced by index.md nor any [[wikilink]]):",
    ...deps.orphans.map((o) => `- ${o}`),
  ].join("\n");
  await runPass({
    vaultPath: deps.vaultPath,
    model: deps.model,
    instructions: INDEX_AND_ORPHAN_SYSTEM,
    userMessage,
    generateTextFn: deps.generateTextFn,
  });
}

export type ContradictionCheckPassDeps = {
  vaultPath: string;
  model: LanguageModel;
  generateTextFn?: GenerateTextFn;
};

export async function runContradictionCheckPass(deps: ContradictionCheckPassDeps): Promise<void> {
  await runPass({
    vaultPath: deps.vaultPath,
    model: deps.model,
    instructions: CONTRADICTION_CHECK_SYSTEM,
    userMessage: "Review curated/ for contradictions and missing cross-links.",
    generateTextFn: deps.generateTextFn,
  });
}
