import { describe, it, expect, beforeAll } from "bun:test";
import { loadCliConfigFromObject, matchCommand, type CliConfig, type CliResult } from "@mercury-fw/cli-engine";
import { zitadelCliConfig } from "./index.ts";

/**
 * Safety net for the ZITADEL plugin's real, checked-in allowlist
 * (`zitadel.json`). It covers the read commands the CLI has, run as the person:
 * ZITADEL decides what each person may read. Nothing mutating is allowed yet,
 * and `init`, `auth login` and `auth logout` stay out of the model's reach.
 */

let zitadelConfig: CliConfig;

beforeAll(async () => {
  const runCliFn = async (): Promise<CliResult> => ({ ok: true, data: "zitadel 2.6.0" });
  const result = await loadCliConfigFromObject(zitadelCliConfig, { runCliFn });
  if (!result.ok) throw new Error(`@mercury-fw/plugin-zitadel config failed to load: ${result.reason}`);
  zitadelConfig = result.config;
});

const allowed = (prefix: string[]) => ({ kind: "allowed" as const, prefix, mutating: false });

describe("@mercury-fw/plugin-zitadel allowlist", () => {
  it("allows the read commands", () => {
    expect(matchCommand(["user", "search", "--email-exact", "jane@example.com", "--select", "result.userId"], zitadelConfig)).toEqual(allowed(["user", "search"]));
    expect(matchCommand(["user", "get", "123"], zitadelConfig)).toEqual(allowed(["user", "get"]));
    expect(matchCommand(["user", "authorizations", "123", "--select", "authorizations.roles.key"], zitadelConfig)).toEqual(allowed(["user", "authorizations"]));
    expect(matchCommand(["user", "idp-links", "123", "--select", "result.idpName"], zitadelConfig)).toEqual(allowed(["user", "idp-links"]));
    expect(matchCommand(["organization", "list", "--select", "result.name"], zitadelConfig)).toEqual(allowed(["organization", "list"]));
    expect(matchCommand(["project", "list", "--select", "projects.name"], zitadelConfig)).toEqual(allowed(["project", "list"]));
    expect(matchCommand(["doctor"], zitadelConfig)).toEqual(allowed(["doctor"]));
    expect(matchCommand(["auth", "whoami"], zitadelConfig)).toEqual(allowed(["auth", "whoami"]));
  });

  it("allows --select before the subcommand", () => {
    expect(matchCommand(["--select", "result.userId", "user", "search"], zitadelConfig)).toEqual(allowed(["user", "search"]));
  });

  // Setting up and logging in or out are Mercury's job (mfw credentials, the
  // person's remote login), never the model's.
  it("refuses setup, login and logout", () => {
    expect(matchCommand(["init"], zitadelConfig)).toEqual({ kind: "not-allowed" });
    expect(matchCommand(["auth", "login"], zitadelConfig)).toEqual({ kind: "not-allowed" });
    expect(matchCommand(["auth", "logout"], zitadelConfig)).toEqual({ kind: "not-allowed" });
  });

  it("refuses commands it doesn't list, and always allows --help", () => {
    expect(matchCommand(["user", "create"], zitadelConfig)).toEqual({ kind: "not-allowed" });
    expect(matchCommand(["project", "delete", "1"], zitadelConfig)).toEqual({ kind: "not-allowed" });
    expect(matchCommand(["user", "search", "--help"], zitadelConfig)).toEqual(allowed([]));
  });

  it("has no mutating or confirm-gated commands", () => {
    expect(zitadelConfig.allowedPrefixes.filter((c) => c.mutating)).toEqual([]);
    expect(zitadelConfig.allowedPrefixes.filter((c) => c.confirm)).toEqual([]);
  });
});
