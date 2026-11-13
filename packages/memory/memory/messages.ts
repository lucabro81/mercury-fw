/**
 * The messages the memory keeps of a session until it captures them: what the
 * person wrote, stamped with when and where (the core's own stamp,
 * `formatTurnStamp`), and the answer they got.
 */

/** One message of a session, as the memory keeps it. */
export type Message = { role: "user" | "assistant"; content: string };

/** The stamp the core puts at the start of a person's message, line break included. */
const STAMP_RE = /^\[[A-Z][a-z]+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]\s]+\]\n/;

/** `text` without the stamp at its start. */
export function stripTurnStamp(text: string): string {
  return text.replace(STAMP_RE, "");
}
