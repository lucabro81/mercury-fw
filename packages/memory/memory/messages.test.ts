import { describe, expect, test } from "bun:test";
import { formatTurnStamp } from "@mercury-fw/plugin-types";
import { stripTurnStamp } from "./messages.ts";

const NOON = new Date("2026-10-21T10:00:00.000Z");

describe("stripTurnStamp", () => {
  test("takes the stamp off the start of a message, and only that", () => {
    expect(stripTurnStamp(`${formatTurnStamp(NOON, "Europe/Rome")}ciao`)).toBe("ciao");
    expect(stripTurnStamp(`${formatTurnStamp(NOON, "Etc/GMT+1")}[Da: Luca]\nciao`)).toBe("[Da: Luca]\nciao");
  });

  test("leaves a message without a stamp, or with one in the middle, as it is", () => {
    expect(stripTurnStamp("ciao")).toBe("ciao");
    const quoted = `see ${formatTurnStamp(NOON, "Europe/Rome")}`;
    expect(stripTurnStamp(quoted)).toBe(quoted);
    expect(stripTurnStamp(stripTurnStamp(`${formatTurnStamp(NOON, "UTC")}ciao`))).toBe("ciao");
  });
});
