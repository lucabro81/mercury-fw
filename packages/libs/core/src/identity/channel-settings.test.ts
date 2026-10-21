import { describe, expect, it } from "bun:test";
import type { Principal } from "@mercury-fw/channel-types";
import { createChannelSettings } from "./channel-settings.ts";
import type { People } from "./people.ts";

const alice: Principal = { id: "alice", provider: "static" };

/** Identifies everyone as themselves, by their key. */
const asThemselves: People["identify"] = async (principal) => ({
  ok: true,
  operator: false,
  person: { key: `${principal.provider}:${principal.id}`, roles: [] },
});

/** A time zone setter that keeps what it saves, refusing what the profile store refuses. */
function saved() {
  const zones = new Map<string, string>();
  const setTimeZone = (key: string, timeZone: string) => {
    if (timeZone.trim().toLowerCase() !== "asia/tokyo") throw new Error(`"${timeZone}" isn't a time zone`);
    zones.set(key, "Asia/Tokyo");
    return "Asia/Tokyo";
  };
  return { zones, setTimeZone };
}

// #293: a UI's settings save the person's time zone without the model.
describe("createChannelSettings: setTimeZone", () => {
  it("saves the zone for the person the core identifies, as the store writes it", async () => {
    const store = saved();
    const settings = createChannelSettings({ identify: asThemselves, setTimeZone: store.setTimeZone });
    expect(await settings.setTimeZone(alice, "asia/tokyo")).toEqual({ ok: true, value: "Asia/Tokyo" });
    expect([...store.zones]).toEqual([["static:alice", "Asia/Tokyo"]]);
  });

  it("saves it for the linked owner, not the raw principal", async () => {
    const store = saved();
    const settings = createChannelSettings({
      identify: async () => ({ ok: true, operator: false, person: { key: "static:bob", roles: [] } }),
      setTimeZone: store.setTimeZone,
    });
    await settings.setTimeZone(alice, "Asia/Tokyo");
    expect([...store.zones]).toEqual([["static:bob", "Asia/Tokyo"]]);
  });

  it("refuses what isn't a zone, with the store's reason", async () => {
    const store = saved();
    const settings = createChannelSettings({ identify: asThemselves, setTimeZone: store.setTimeZone });
    expect(await settings.setTimeZone(alice, "Rome")).toEqual({ ok: false, error: '"Rome" isn\'t a time zone' });
    expect(store.zones.size).toBe(0);
  });

  it("refuses someone the core doesn't admit, saving nothing", async () => {
    const store = saved();
    const settings = createChannelSettings({
      identify: async () => ({ ok: false, reason: "unknown", message: "no" }),
      setTimeZone: store.setTimeZone,
    });
    expect(await settings.setTimeZone(alice, "Asia/Tokyo")).toEqual({ ok: false, error: "no" });
    expect(store.zones.size).toBe(0);
  });
});
