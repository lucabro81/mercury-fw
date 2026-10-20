import { describe, it, expect } from "bun:test";
import { defaultStatusLabel } from "@mercury-fw/plugin-types";
import { createI18n, createTexts, englishTexts } from "../i18n/i18n.ts";
import { CORE_MESSAGES } from "../i18n/core-messages.ts";

/** The core's texts in English, as a turn with no other language gets them. */
const t = englishTexts().forPerson(undefined).t;

/**
 * The contract-level default status label — what every CLI command's status
 * reads as unless a plugin overrides it with its own describer. The core
 * doesn't classify read vs write; this plain "Running <binary> <subcommand>"
 * (`core.status.command`) is the plugin-layer default the core merely
 * transports. The subcommand is the leading non-flag tokens, capped at two
 * (the command + subcommand depth), so positional args and flags don't leak
 * into the label.
 */
describe("defaultStatusLabel", () => {
  it("names the binary and its subcommand, dropping flags and their values", () => {
    expect(defaultStatusLabel({ binary: "jira", args: ["issue", "search", "--jql", "X"], mutating: false }, t)).toBe(
      "Running jira issue search",
    );
  });

  it("caps the subcommand at two leading tokens, so positional args don't leak in", () => {
    expect(defaultStatusLabel({ binary: "bitbucket", args: ["pr", "list", "workspace/repo"], mutating: false }, t)).toBe(
      "Running bitbucket pr list",
    );
    expect(defaultStatusLabel({ binary: "jira", args: ["issue", "delete", "KAN-1"], mutating: true }, t)).toBe(
      "Running jira issue delete",
    );
  });

  it("handles a single-token subcommand and an empty argument list", () => {
    expect(defaultStatusLabel({ binary: "bitbucket", args: ["doctor"], mutating: false }, t)).toBe("Running bitbucket doctor");
    expect(defaultStatusLabel({ binary: "bitbucket", args: [], mutating: false }, t)).toBe("Running bitbucket");
  });

  it("ignores the mutating flag — read vs write is not the default's concern", () => {
    expect(defaultStatusLabel({ binary: "jira", args: ["issue", "create"], mutating: true }, t)).toBe(
      "Running jira issue create",
    );
  });

  it("reads in the turn's language", () => {
    const italian = createTexts(
      createI18n({
        english: CORE_MESSAGES,
        locales: { it: { "core.status.command": "Eseguo {binary} {command}", "core.status.command-bare": "Eseguo {binary}" } },
        defaultLocale: "it",
      }),
      () => undefined,
    ).forPerson(undefined).t;
    expect(defaultStatusLabel({ binary: "jira", args: ["issue", "search"], mutating: false }, italian)).toBe(
      "Eseguo jira issue search",
    );
    expect(defaultStatusLabel({ binary: "jira", args: [], mutating: false }, italian)).toBe("Eseguo jira");
  });
});
