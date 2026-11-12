/**
 * The instance's context while it runs (#387): what an admin may change in a
 * profile without a restart (its budget, its layers' order, its layers'
 * knobs), kept across restarts, with a record of every change.
 *
 * - A change is checked whole before anything of it applies: a budget that is
 *   a whole number from 0 up, an order with exactly the profile's layers, a
 *   knob the layer declares with a value its spec allows (`null` puts it back
 *   to its default). It applies to the running profiles (`ResolvedProfile`),
 *   which the assembler reads at every turn.
 * - The settings live in `context-settings.json` in the data folder, written
 *   whole through a temporary file renamed over the old one. At startup each
 *   kept value is checked again, against the config and the plugins as they
 *   are now: one that no longer fits is ignored with a line, and the config's
 *   value holds. A file that can't be read applies nothing and is never
 *   written over.
 * - Every change is a line of `context-changes.jsonl` in the data folder
 *   (who, when, which profile, what it changed, before and after) and a
 *   `context.changed` event.
 *
 * Used by: `compose.ts`, through `context-admin.ts` for the channels.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ContextChangeEntry, ContextProfileChange, ContextProfileView, ContextView, ContextAdminOutcome } from "@mercury-fw/channel-types";
import type { KnobValue } from "@mercury-fw/plugin-types";
import type { TraceInput } from "../traces/tracer.ts";
import type { ResolvedContext, ResolvedProfile } from "./context.ts";
import { knobValueError } from "./knobs.ts";

/** Where the context settings live in the data folder. */
export function contextSettingsPath(dataPath: string): string {
  return resolve(dataPath, "context-settings.json");
}

/** Where the record of the context changes lives in the data folder. */
export function contextChangesPath(dataPath: string): string {
  return resolve(dataPath, "context-changes.jsonl");
}

/** What is kept of a profile: only what an admin set. */
type KeptProfile = { maxChars?: number; order?: string[]; knobs?: Record<string, Record<string, KnobValue>> };
type SettingsFile = { version: 1; profiles: Record<string, KeptProfile> };

export type ContextSettings = {
  /** The context as it runs now, `default` first. */
  view: () => ContextView;
  /** Applies `change` to `profile` for the person with key `by`, keeps it and records it; refused whole when anything of it doesn't fit. Throws when the settings file can't be read. */
  update: (by: string, profile: string, change: ContextProfileChange) => ContextAdminOutcome<ContextProfileView>;
  /** The newest `limit` changes, newest first. */
  changes: (limit: number) => ContextChangeEntry[];
};

/** Whether `value` is a plain object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `value` isn't a budget; `undefined` when it is. */
function maxCharsError(value: unknown): string | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? undefined : "maxChars must be a whole number from 0 up";
}

/** Why `value` isn't an order of `profile`'s layers; `undefined` when it is. */
function orderError(profile: ResolvedProfile, value: unknown): string | undefined {
  const names = profile.layers.map((p) => p.name);
  const fits =
    Array.isArray(value) && value.length === names.length && new Set(value).size === value.length && value.every((n) => typeof n === "string" && names.includes(n));
  return fits ? undefined : `order must list the profile's layers, each once: ${names.join(", ")}`;
}

/** Why `value` can't be `knob` of `plugin`'s layer in `profile` (`null`, its default, always can when the knob exists); `undefined` when it can. */
function knobError(profile: ResolvedProfile, plugin: string, knob: string, value: unknown): string | undefined {
  const layer = profile.layers.find((p) => p.name === plugin);
  if (layer === undefined) return `the profile has no layer of "${plugin}"`;
  const declared = layer.context!.knobs ?? {};
  // Own keys only: "constructor" and the like are every object's, never a knob.
  const spec = Object.hasOwn(declared, knob) ? declared[knob] : undefined;
  if (spec === undefined) return `the layer of "${plugin}" has no knob "${knob}"`;
  if (value === null) return undefined;
  const error = knobValueError(spec, value);
  return error === undefined ? undefined : `knob "${knob}" of "${plugin}" ${error}`;
}

/** Builds the context settings over `resolved` and applies the kept ones; see the module comment. */
export function createContextSettings(deps: {
  resolved: ResolvedContext;
  dataPath: string;
  log: (message: string) => void;
  emit?: (event: TraceInput) => void;
  now?: () => Date;
}): ContextSettings {
  const { resolved, log } = deps;
  const now = deps.now ?? (() => new Date());
  const settingsPath = contextSettingsPath(deps.dataPath);
  const changesPath = contextChangesPath(deps.dataPath);
  const kept: Record<string, KeptProfile> = {};
  /** Whether the settings file was there but couldn't be read: then nothing is written over it. */
  let unreadable = false;

  /** The profiles in the order the view shows them: `default` first, then as the config lists them. */
  function ordered(): ResolvedProfile[] {
    const profiles = [...resolved.profiles.values()];
    return [...profiles.filter((p) => p.name === "default"), ...profiles.filter((p) => p.name !== "default")];
  }

  /** `profile` as the view shows it. */
  function profileView(profile: ResolvedProfile): ContextProfileView {
    return {
      name: profile.name,
      assignedTo: [...(resolved.assign.find(([name]) => name === profile.name)?.[1] ?? [])],
      maxChars: profile.maxChars,
      layers: profile.layers.map((plugin) => ({
        plugin: plugin.name,
        scope: plugin.context!.scope,
        knobs: Object.entries(plugin.context!.knobs ?? {}).map(([name, spec]) => ({
          name,
          ...spec,
          value: profile.knobs.get(plugin.name)?.[name] ?? spec.default,
        })),
      })),
    };
  }

  /** Sets `knob` of `plugin` in `knobs` (a profile's, by plugin) to `value`, or back to its default when `null`. */
  function setKnob(knobs: ResolvedProfile["knobs"], plugin: string, knob: string, value: KnobValue | null): void {
    const set = { ...knobs.get(plugin) };
    if (value === null) delete set[knob];
    else set[knob] = value;
    if (Object.keys(set).length === 0) knobs.delete(plugin);
    else knobs.set(plugin, set);
  }

  /** Puts `profile`'s layers in `order`, by name. */
  function reorder(profile: ResolvedProfile, order: string[]): void {
    profile.layers = order.map((name) => profile.layers.find((p) => p.name === name)!);
  }

  /** Applies the kept settings, each value checked again; see the module comment. */
  function load(): void {
    let file: Partial<SettingsFile>;
    try {
      file = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<SettingsFile>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log(`[context] can't read the context settings in ${settingsPath}, none applied: ${err instanceof SyntaxError ? "not JSON" : String(err)}`);
      unreadable = true;
      return;
    }
    for (const [name, saved] of Object.entries(isObject(file.profiles) ? file.profiles : {})) {
      const profile = resolved.profiles.get(name);
      if (profile === undefined || !isObject(saved)) {
        const why = profile === undefined ? `there's no context profile "${name}"` : "they aren't an object";
        log(`[context] kept settings of profile "${name}" ignored: ${why}`);
        continue;
      }
      const entry: KeptProfile = {};
      if (saved.maxChars !== undefined) {
        const error = maxCharsError(saved.maxChars);
        if (error === undefined) {
          profile.maxChars = saved.maxChars as number;
          entry.maxChars = profile.maxChars;
        } else log(`[context] kept maxChars of profile "${name}" ignored: ${error}`);
      }
      if (saved.order !== undefined) {
        const error = orderError(profile, saved.order);
        if (error === undefined) {
          reorder(profile, saved.order as string[]);
          entry.order = [...(saved.order as string[])];
        } else log(`[context] kept order of profile "${name}" ignored: ${error}`);
      }
      for (const [plugin, knobs] of Object.entries(isObject(saved.knobs) ? saved.knobs : {})) {
        if (!profile.layers.some((p) => p.name === plugin) || !isObject(knobs)) {
          log(`[context] kept knobs of "${plugin}" in profile "${name}" ignored: the profile has no layer of "${plugin}"`);
          continue;
        }
        for (const [knob, value] of Object.entries(knobs)) {
          const error = value === null ? `knob "${knob}" of "${plugin}" has no value` : knobError(profile, plugin, knob, value);
          if (error !== undefined) {
            log(`[context] kept knob "${knob}" of "${plugin}" in profile "${name}" ignored: ${error}`);
            continue;
          }
          setKnob(profile.knobs, plugin, knob, value as KnobValue);
          entry.knobs = { ...entry.knobs, [plugin]: { ...entry.knobs?.[plugin], [knob]: value as KnobValue } };
        }
      }
      if (Object.keys(entry).length > 0) kept[name] = entry;
    }
  }

  /** Writes the kept settings, whole, through a temporary file renamed over the old one. */
  function save(): void {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const file: SettingsFile = { version: 1, profiles: kept };
    const temporary = `${settingsPath}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temporary, settingsPath);
  }

  /** Why `change` can't apply to `profile`; `undefined` when all of it can. */
  function changeError(profile: ResolvedProfile, change: unknown): string | undefined {
    if (!isObject(change)) return "a change is an object with maxChars, order or knobs";
    const unknown = Object.keys(change).find((key) => key !== "maxChars" && key !== "order" && key !== "knobs");
    if (unknown !== undefined) return `a change has no field "${unknown}"`;
    if (change.maxChars === undefined && change.order === undefined && change.knobs === undefined) return "the change changes nothing";
    if (change.maxChars !== undefined) {
      const error = maxCharsError(change.maxChars);
      if (error !== undefined) return error;
    }
    if (change.order !== undefined) {
      const error = orderError(profile, change.order);
      if (error !== undefined) return error;
    }
    if (change.knobs !== undefined) {
      if (!isObject(change.knobs)) return "knobs must be an object, by plugin";
      for (const [plugin, knobs] of Object.entries(change.knobs)) {
        if (!profile.layers.some((p) => p.name === plugin)) return `the profile has no layer of "${plugin}"`;
        if (!isObject(knobs)) return `knobs of "${plugin}" must be an object, by knob`;
        for (const [knob, value] of Object.entries(knobs)) {
          const error = knobError(profile, plugin, knob, value);
          if (error !== undefined) return error;
        }
      }
    }
    return undefined;
  }

  load();

  return {
    view: () => ({ profiles: ordered().map(profileView) }),

    update(by, name, change) {
      const profile = resolved.profiles.get(name);
      if (profile === undefined) return { ok: false, status: "notFound", error: `there's no context profile "${name}"` };
      const error = changeError(profile, change);
      if (error !== undefined) return { ok: false, status: "invalid", error };
      if (unreadable) throw new Error(`the context settings in ${settingsPath} can't be read: fix or remove the file first`);

      // The new state is worked out apart, kept and recorded, and only then
      // applied: a write that fails leaves the running profile as it was.
      const before: ContextProfileChange = {};
      const after: ContextProfileChange = {};
      const changed: string[] = [];
      const entry: KeptProfile = { ...kept[name] };
      if (change.maxChars !== undefined) {
        before.maxChars = profile.maxChars;
        after.maxChars = change.maxChars;
        changed.push("maxChars");
        entry.maxChars = change.maxChars;
      }
      if (change.order !== undefined) {
        before.order = profile.layers.map((p) => p.name);
        after.order = [...change.order];
        changed.push("order");
        entry.order = [...change.order];
      }
      const knobs = new Map([...profile.knobs].map(([plugin, set]) => [plugin, { ...set }]));
      for (const [plugin, values] of Object.entries(change.knobs ?? {})) {
        for (const [knob, value] of Object.entries(values)) {
          before.knobs = { ...before.knobs, [plugin]: { ...before.knobs?.[plugin], [knob]: profile.knobs.get(plugin)?.[knob] ?? null } };
          after.knobs = { ...after.knobs, [plugin]: { ...after.knobs?.[plugin], [knob]: value } };
          changed.push(`knobs.${plugin}.${knob}`);
          setKnob(knobs, plugin, knob, value);
        }
      }
      if (knobs.size > 0) entry.knobs = Object.fromEntries(knobs);
      else delete entry.knobs;

      const previous = kept[name];
      /** Puts back what was kept before this change. */
      const restore = () => {
        if (previous === undefined) delete kept[name];
        else kept[name] = previous;
      };
      kept[name] = entry;
      try {
        save();
      } catch (err) {
        restore();
        throw err;
      }
      const record: ContextChangeEntry = { at: now().toISOString(), by, profile: name, before, after };
      try {
        mkdirSync(dirname(changesPath), { recursive: true });
        appendFileSync(changesPath, `${JSON.stringify(record)}\n`);
      } catch (err) {
        // A change that can't be recorded doesn't happen: the kept settings go back too.
        restore();
        save();
        throw err;
      }

      if (change.maxChars !== undefined) profile.maxChars = change.maxChars;
      if (change.order !== undefined) reorder(profile, change.order);
      profile.knobs = knobs;
      deps.emit?.({ kind: "context.changed", person: by, profile: name, changed, args: { before, after } });
      return { ok: true, value: profileView(profile) };
    },

    changes(limit) {
      let text: string;
      try {
        text = readFileSync(changesPath, "utf8");
      } catch {
        return [];
      }
      const entries: ContextChangeEntry[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          entries.push(JSON.parse(line) as ContextChangeEntry);
        } catch {
          // A line cut short or written by hand: the others still count.
        }
      }
      return entries.reverse().slice(0, Math.max(0, limit));
    },
  };
}
