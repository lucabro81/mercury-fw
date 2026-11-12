/**
 * The models an instance declares (`models` in its config): `ollamaModel` and
 * `ollamaEmbedding` give the handles its config holds, refused at once when
 * they can't work, and `resolveModels` turns them into the models each of the
 * core's roles uses — `turn` (the turns, the compression summary, plugins'
 * guards), `background` (the work no one waits on, the turn's model when left
 * out) and `embedding` (memory found by meaning). One model per handle: the
 * handle's identity, not its name, is what makes two roles one model.
 */
import type { EmbeddingModel, LanguageModel } from "ai";
import type { MercuryEmbeddingHandle, MercuryModelHandle, ModelSettings } from "@mercury-fw/plugin-types";
import { describeModelSettings, ollamaSettings, type OllamaModelSettings } from "./generation-settings.ts";

/** The models an instance declares, by the role the core gives each. */
export type MercuryModels = {
  /** The model the turns run on; also the compression summary and plugins' guards. */
  turn: MercuryModelHandle;
  /** The model for the work no one waits on (titles, memory captures, the nightly review); the turn's when left out. */
  background?: MercuryModelHandle;
  /** The model memory found by meaning is embedded with; needed with a vector index. */
  embedding?: MercuryEmbeddingHandle;
};

/** What the core builds a handle's model with: Ollama's provider in an instance, a fake in tests. */
export type ModelProvider = {
  language: (name: string, settings: OllamaModelSettings) => LanguageModel;
  embedding: (name: string) => EmbeddingModel;
};

/** What `resolveModels` gives: the model of each role, and the model of any other handle. */
export type ResolvedModels = {
  turn: LanguageModel;
  background: LanguageModel;
  embedding?: EmbeddingModel;
  /** The model of `handle`: a role's own when it's one of theirs, built on first ask otherwise. */
  modelFor: (handle: MercuryModelHandle) => LanguageModel;
  /** Each role's model name and capacity, for the startup event. */
  report: Partial<Record<"turn" | "background" | "embedding", { name: string; capacity: number }>>;
  /** The startup lines, one per role. */
  describe: () => string[];
};

/** Throws unless `name` has something in it. */
function requireName(factory: string, name: string | undefined): string {
  if (name === undefined || name.trim() === "") {
    throw new Error(`${factory} needs the model's name and got none: is the variable it's read from set?`);
  }
  return name;
}

/** `backgroundSlots` checked against `capacity`: 1 when left out; a whole number from 1 up, below a capacity above 1, 1 with capacity 1. */
function checkBackgroundSlots(label: string, capacity: number, backgroundSlots: number | undefined): number {
  if (backgroundSlots === undefined) return 1;
  if (!Number.isInteger(backgroundSlots) || backgroundSlots < 1) {
    throw new Error(`${label}: backgroundSlots must be a whole number from 1 up, got ${backgroundSlots}`);
  }
  if (capacity === 1 && backgroundSlots !== 1) {
    throw new Error(`${label}: backgroundSlots must be 1 with capacity 1, got ${backgroundSlots}`);
  }
  if (capacity > 1 && backgroundSlots >= capacity) {
    throw new Error(`${label}: backgroundSlots must be below capacity (${capacity}), got ${backgroundSlots}`);
  }
  return backgroundSlots;
}

/** `capacity` checked: 1 when left out, otherwise a whole number from 1 up. */
function checkCapacity(label: string, capacity: number | undefined): number {
  if (capacity === undefined) return 1;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`${label}: capacity must be a whole number from 1 up, got ${capacity}`);
  }
  return capacity;
}

/**
 * A language model on the instance's Ollama (`OLLAMA_HOST`): its name there,
 * how it generates (each setting left out isn't sent), how many requests it
 * serves at once (`capacity`, 1 when left out) and how many of them the work
 * nobody waits on may take (`backgroundSlots`, 1 when left out). Throws on an
 * empty name or a value out of its range, so a wrong config stops the start.
 */
export function ollamaModel(
  name: string | undefined,
  options: ModelSettings & { capacity?: number; backgroundSlots?: number } = {},
): MercuryModelHandle {
  const checked = requireName("ollamaModel", name);
  const label = `ollamaModel(${JSON.stringify(checked)})`;
  const { capacity, backgroundSlots, ...given } = options;
  try {
    ollamaSettings(given);
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const settings = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) as ModelSettings;
  return Object.freeze({
    provider: "ollama",
    kind: "language",
    name: checked,
    settings: Object.freeze(settings),
    capacity: checkCapacity(label, capacity),
    backgroundSlots: checkBackgroundSlots(label, checkCapacity(label, capacity), backgroundSlots),
  });
}

/** An embedding model on the instance's Ollama, with how many requests it serves at once (1 when left out). */
export function ollamaEmbedding(name: string | undefined, options: { capacity?: number } = {}): MercuryEmbeddingHandle {
  const checked = requireName("ollamaEmbedding", name);
  return Object.freeze({
    provider: "ollama",
    kind: "embedding",
    name: checked,
    capacity: checkCapacity(`ollamaEmbedding(${JSON.stringify(checked)})`, options.capacity),
  });
}

/** Builds each declared handle's model once, through `provider`. */
export function resolveModels(models: MercuryModels, provider: ModelProvider): ResolvedModels {
  const built = new Map<MercuryModelHandle, LanguageModel>();
  const modelFor = (handle: MercuryModelHandle): LanguageModel => {
    let model = built.get(handle);
    if (model === undefined) {
      model = provider.language(handle.name, ollamaSettings(handle.settings));
      built.set(handle, model);
    }
    return model;
  };
  const backgroundHandle = models.background ?? models.turn;
  const turn = modelFor(models.turn);
  const background = modelFor(backgroundHandle);
  const embedding = models.embedding === undefined ? undefined : provider.embedding(models.embedding.name);

  const entry = (handle: { name: string; capacity: number }) => ({ name: handle.name, capacity: handle.capacity });
  const line = (role: string, handle: MercuryModelHandle) =>
    `${describeModelSettings(`${role} ${handle.name}`, ollamaSettings(handle.settings))}, capacity ${handle.capacity}`;

  return {
    turn,
    background,
    ...(embedding === undefined ? {} : { embedding }),
    modelFor,
    report: {
      turn: entry(models.turn),
      background: entry(backgroundHandle),
      ...(models.embedding === undefined ? {} : { embedding: entry(models.embedding) }),
    },
    describe: () => [
      line("turn", models.turn),
      backgroundHandle === models.turn ? "[model] background: the turn's model" : line("background", backgroundHandle),
      ...(models.embedding === undefined ? [] : [`[model] embedding ${models.embedding.name}: capacity ${models.embedding.capacity}`]),
    ],
  };
}
