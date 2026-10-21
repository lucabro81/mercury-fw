import { describe, expect, test } from "bun:test";
import { formatTurnStamp, isTimeZone, resolveTimeZone, stripTurnStamp } from "./turn-stamp.ts";

// 2026-10-21T12:32:00Z: a Wednesday in Rome (14:32, summer time) and in New York (08:32).
const NOON = new Date("2026-10-21T12:32:00Z");

describe("formatTurnStamp", () => {
  test("is the weekday, date, time and zone where the person is, on a line of its own", () => {
    expect(formatTurnStamp(NOON, "Europe/Rome")).toBe("[Wednesday 2026-10-21 14:32 Europe/Rome]\n");
    expect(formatTurnStamp(NOON, "America/New_York")).toBe("[Wednesday 2026-10-21 08:32 America/New_York]\n");
  });

  test("moves the day across midnight", () => {
    expect(formatTurnStamp(new Date("2026-10-21T23:30:00Z"), "Asia/Tokyo")).toBe("[Thursday 2026-10-22 08:30 Asia/Tokyo]\n");
    expect(formatTurnStamp(new Date("2026-10-21T22:05:00Z"), "Europe/Rome")).toBe("[Thursday 2026-10-22 00:05 Europe/Rome]\n");
  });

  test("follows summer time: the same zone is an hour apart across the change", () => {
    expect(formatTurnStamp(new Date("2026-12-01T12:00:00Z"), "Europe/Rome")).toBe("[Tuesday 2026-12-01 13:00 Europe/Rome]\n");
  });
});

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

describe("isTimeZone", () => {
  test("is true for a zone name, false for anything else", () => {
    expect(isTimeZone("Europe/Rome")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("  ")).toBe(false);
  });
});

describe("resolveTimeZone", () => {
  test("is the saved zone first, then the channel's hint, then the instance's, then the process's", () => {
    expect(resolveTimeZone("Asia/Tokyo", "America/New_York", "Europe/Rome")).toBe("Asia/Tokyo");
    expect(resolveTimeZone(undefined, "America/New_York", "Europe/Rome")).toBe("America/New_York");
    expect(resolveTimeZone(undefined, undefined, "Europe/Rome")).toBe("Europe/Rome");
    expect(resolveTimeZone(undefined, undefined, undefined)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test("skips a name that isn't a zone: a hint is whatever the client sent", () => {
    expect(resolveTimeZone("Mars/Olympus", "nonsense", "Europe/Rome")).toBe("Europe/Rome");
    expect(resolveTimeZone(undefined, " America/New_York ", undefined)).toBe("America/New_York");
  });
});
