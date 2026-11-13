import { describe, expect, it } from "bun:test";
import { PLUGIN_API_VERSION, type PluginRuntimeContext, type Profiles, type SessionToolContext } from "@mercury-fw/plugin-types";
import { profile, PROFILE_PROMPT_FRAGMENT } from "./index.ts";

/** The core's profiles, shipping `languages`, recording the names saved. */
function profiles(languages: string[]) {
  const names: Array<[string, string]> = [];
  const p = {
    languages,
    setName: (person: string, name: string) => (names.push([person, name]), name),
  } as unknown as Profiles;
  return { p, names };
}

/** A turn's tool context for the person `key` (`null`: acting as nobody). */
function sessionCtx(key: string | null): SessionToolContext {
  return { sessionKey: "s", person: key === null ? null : { key } } as unknown as SessionToolContext;
}

async function built(p: Profiles) {
  return profile().build!({ model: {} as never, env: {}, log: () => {}, profiles: p } as unknown as PluginRuntimeContext);
}

describe("profile", () => {
  it("is a plugin acting as no one, telling the model when to save the person's name", () => {
    const plugin = profile();
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("profile");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.needs).toBeUndefined();
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.systemPromptFragment).toBe(PROFILE_PROMPT_FRAGMENT);
  });

  // The model read this block in the core's system prompt before #393, word for word.
  it("says what the core's prompt said about set_preferred_name", () => {
    expect(PROFILE_PROMPT_FRAGMENT).toBe(
      "You have access to the set_preferred_name tool.\nDO:\n- When the person tells you how they want to be called, now or in any later conversation, save it with set_preferred_name.",
    );
  });

  // #222: a tool text naming Mercury made the model take that for its own name.
  it("never names Mercury in what the model reads", async () => {
    expect(PROFILE_PROMPT_FRAGMENT).not.toContain("Mercury");
    const tools = (await built(profiles(["en", "it"]).p)).sessionTools!(sessionCtx("static:alice"));
    for (const t of Object.values(tools)) expect(t.description ?? "").not.toContain("Mercury");
  });

  it("gives the turn's person their tools, the language's only when the instance ships more than one", async () => {
    const one = (await built(profiles(["en"]).p)).sessionTools!(sessionCtx("static:alice"));
    expect(Object.keys(one).sort()).toEqual(["set_preferred_name", "set_time_zone"]);
    const two = (await built(profiles(["en", "it"]).p)).sessionTools!(sessionCtx("static:alice"));
    expect(Object.keys(two).sort()).toEqual(["set_preferred_language", "set_preferred_name", "set_time_zone"]);
  });

  it("saves for the turn's person, and gives no tools to a turn acting as nobody", async () => {
    const { p, names } = profiles(["en"]);
    const contributions = await built(p);
    const tools = contributions.sessionTools!(sessionCtx("static:alice"));
    await tools.set_preferred_name!.execute!({ name: "Luca" }, {} as never);
    expect(names).toEqual([["static:alice", "Luca"]]);
    expect(contributions.sessionTools!(sessionCtx(null))).toEqual({});
  });
});
