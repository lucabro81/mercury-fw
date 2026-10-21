/**
 * When a turn was written, as the model reads it: a line the core puts
 * before the person's message (`[Wednesday 2026-10-21 14:32 Europe/Rome]`),
 * so the model knows what day and time it is where the person is, and the
 * history keeps when each message was written (#293). The stamp goes on
 * the model's input only, never on the text a channel sent: the verbatim
 * archive keeps its own `timestamp`.
 *
 * A time zone is always an IANA name (`Europe/Rome`), never a fixed offset,
 * which would be wrong for half the year.
 */

/** Matches a stamp at the start of a message, line break included. */
const STAMP_RE = /^\[[A-Z][a-z]+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]\s]+\]\n/;

/** Whether `name` is a time zone `Intl` knows (an IANA name such as `Europe/Rome`). */
export function isTimeZone(name: string): boolean {
  if (name.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The time zone a turn is stamped in: the one the person saved, else the
 * channel's hint for this turn, else the instance's, else the process's.
 * A name that isn't a zone is skipped: a hint is whatever the client sent.
 */
export function resolveTimeZone(saved: string | undefined, hint: string | undefined, instance: string | undefined): string {
  for (const candidate of [saved, hint, instance]) {
    const name = candidate?.trim();
    if (name !== undefined && isTimeZone(name)) return name;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The stamp for a message written at `date` in `timeZone`, line break included. */
export function formatTurnStamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `[${part("weekday")} ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${timeZone}]\n`;
}

/** `text` without the stamp at its start, for whatever reads the history but isn't the model's turn. */
export function stripTurnStamp(text: string): string {
  return text.replace(STAMP_RE, "");
}
