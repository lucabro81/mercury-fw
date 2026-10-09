import { describe, expect, test } from "bun:test";
import type { LoadedPlugin } from "./plugin-loader.ts";
import { ACT_AS_SELF, offeringFor } from "./offering.ts";

const jira: LoadedPlugin = { name: "jira", actsAs: "person", promptFragment: "JIRA", skills: [{ name: "jira", description: "d", body: "b" }] };
const admin: LoadedPlugin = { name: "admin", actsAs: "mercury", promptFragment: "ADMIN", skills: [] };
const plugins = [jira, admin];

/** The offering as `name:as`, `+` marking the variant that acts as Mercury beside the person's own. */
const shape = (offering: ReturnType<typeof offeringFor>) =>
  offering.entries.map((e) => `${e.plugin.name}:${e.as}${e.variant ? "+" : ""}`);

const person = (roles: string[] = []) => ({ roles, operator: false });

describe("offeringFor", () => {
  test("a person without the permission gets the plugins acting as the person, as themselves", () => {
    expect(shape(offeringFor(plugins, person()))).toEqual(["jira:person"]);
  });

  test("mercury.act-as-self adds every plugin as Mercury: a variant beside the person's own, the rest as they are", () => {
    expect(shape(offeringFor(plugins, person([ACT_AS_SELF])))).toEqual(["jira:person", "jira:mercury+", "admin:mercury"]);
  });

  test("mercury.act-as-self.<plugin> adds that plugin only", () => {
    expect(shape(offeringFor(plugins, person([`${ACT_AS_SELF}.admin`])))).toEqual(["jira:person", "admin:mercury"]);
    expect(shape(offeringFor(plugins, person([`${ACT_AS_SELF}.jira`])))).toEqual(["jira:person", "jira:mercury+"]);
  });

  // The role is the exact name: a role that only starts like it grants nothing.
  test("a role that only looks like the permission grants nothing", () => {
    expect(shape(offeringFor(plugins, person(["mercury.act-as-self-ish", `${ACT_AS_SELF}.adm`, "MERCURY.ACT-AS-SELF"])))).toEqual(["jira:person"]);
  });

  test("the operator gets every plugin as Mercury, under its own names", () => {
    expect(shape(offeringFor(plugins, { roles: [], operator: true }))).toEqual(["jira:mercury", "admin:mercury"]);
  });

  test("the installer's restriction removes a plugin from whoever holds none of its roles, permission or not", () => {
    const access = { jira: { roles: ["dev"] }, admin: { roles: ["it"] } };
    expect(shape(offeringFor(plugins, person([ACT_AS_SELF]), access))).toEqual([]);
    expect(shape(offeringFor(plugins, person(["dev"]), access))).toEqual(["jira:person"]);
    expect(shape(offeringFor(plugins, person(["dev", "it", ACT_AS_SELF]), access))).toEqual(["jira:person", "jira:mercury+", "admin:mercury"]);
  });

  test("the operator isn't subject to the installer's restriction", () => {
    expect(shape(offeringFor(plugins, { roles: [], operator: true }, { admin: { roles: ["it"] } }))).toEqual(["jira:mercury", "admin:mercury"]);
  });

  test("fragments and skills come from the plugins offered, once each", () => {
    expect(offeringFor(plugins, person()).promptFragments).toEqual(["JIRA"]);
    const all = offeringFor(plugins, person([ACT_AS_SELF]));
    expect(all.promptFragments).toEqual(["JIRA", "ADMIN"]);
    expect(all.skills.map((s) => s.name)).toEqual(["jira"]);
  });

  test("the signature tells two offerings apart, and is the same for the same offering", () => {
    expect(offeringFor(plugins, person(["x"])).signature).toBe(offeringFor(plugins, person(["y"])).signature);
    expect(offeringFor(plugins, person()).signature).not.toBe(offeringFor(plugins, person([ACT_AS_SELF])).signature);
    expect(offeringFor(plugins, person([ACT_AS_SELF])).signature).not.toBe(offeringFor(plugins, { roles: [], operator: true }).signature);
  });
});
