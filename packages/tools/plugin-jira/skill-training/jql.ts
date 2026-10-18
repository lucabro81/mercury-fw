/**
 * A small JQL evaluator for the made-up Jira the skill is trained on: enough
 * of the language for what the skill teaches (projects, statuses, assignees,
 * summaries, due and created dates), with Jira's own matching (a status
 * wording that isn't the status's name matches nothing). A clause it doesn't
 * know is reported, never guessed: the fixture then answers it as a hole in
 * the training data, not as an empty result the model would be blamed for.
 */

/** An issue as the evaluator reads it. */
export type JqlIssue = {
  key: string;
  project: string;
  summary: string;
  status: string;
  statusCategory: "To Do" | "In Progress" | "Done";
  assignee: { accountId: string; displayName: string } | null;
  /** `YYYY-MM-DD`. */
  duedate: string | null;
  /** ISO timestamp. */
  created: string;
};

export type JqlResult<T> = { ok: true; issues: T[] } | { ok: false; unsupported: string };

const CLAUSE = /^(\w+)\s*(!=|<=|>=|=|<|>|~|is not|is)\s*(.+)$/i;
const DAY = 24 * 60 * 60 * 1000;

/** A value as written: quotes taken off. */
const unquote = (raw: string) => raw.trim().replace(/^(['"])(.*)\1$/, "$2");

/** A date value (`now()`, `-7d`/`2w`/`3h`, or a date) as a time, undefined when it's none of these. */
function dateOf(raw: string, now: Date): number | undefined {
  const value = unquote(raw);
  if (/^now\(\)$/i.test(value)) return now.getTime();
  const offset = /^([+-]?\d+)([dwh])$/i.exec(value);
  if (offset) {
    const unit = { d: DAY, w: 7 * DAY, h: DAY / 24 }[offset[2]!.toLowerCase() as "d" | "w" | "h"];
    return now.getTime() + Number(offset[1]) * unit;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date;
}

/** Compares two times by `op`. */
function compare(a: number, op: string, b: number): boolean {
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "=" ? a === b : a !== b;
}

/** The test `clause` puts on an issue, undefined when the evaluator doesn't know it. */
function predicate(clause: string, ctx: { now: Date; currentUser: string }): ((i: JqlIssue) => boolean) | undefined {
  const match = CLAUSE.exec(clause.trim());
  if (!match) return undefined;
  const field = match[1]!.toLowerCase();
  const op = match[2]!.toLowerCase();
  const raw = match[3]!;
  const value = unquote(raw).toLowerCase();
  const eq = (actual: string | undefined) => actual?.toLowerCase() === value;
  const negate = (test: (i: JqlIssue) => boolean) => (op === "!=" ? (i: JqlIssue) => !test(i) : op === "=" ? test : undefined);

  switch (field) {
    case "project":
      return negate((i) => eq(i.project));
    case "status":
      return negate((i) => eq(i.status));
    case "statuscategory":
      return negate((i) => eq(i.statusCategory));
    case "assignee": {
      if (op === "is" || op === "is not") {
        if (value !== "empty" && value !== "null") return undefined;
        return op === "is" ? (i) => i.assignee === null : (i) => i.assignee !== null;
      }
      const me = /^currentuser\(\)$/.test(value);
      return negate((i) => i.assignee !== null && (me ? i.assignee.accountId === ctx.currentUser : eq(i.assignee.displayName) || eq(i.assignee.accountId)));
    }
    case "summary":
      return op === "~" ? (i) => i.summary.toLowerCase().includes(value) : undefined;
    case "duedate":
    case "created": {
      const bound = dateOf(raw, ctx.now);
      if (bound === undefined || !["<", "<=", ">", ">=", "=", "!="].includes(op)) return undefined;
      return (i) => {
        const at = field === "duedate" ? i.duedate : i.created;
        return at !== null && compare(Date.parse(at), op, bound);
      };
    }
    default:
      return undefined;
  }
}

/** The issues `jql` matches, newest key first as Jira lists them, or the clause it couldn't read. */
export function filterJql<T extends JqlIssue>(jql: string, issues: T[], ctx: { now: Date; currentUser: string }): JqlResult<T> {
  const [where = ""] = jql.split(/\s+ORDER\s+BY\s+/i);
  if (/\s+OR\s+/i.test(where)) return { ok: false, unsupported: where.trim() };
  const tests: Array<(i: JqlIssue) => boolean> = [];
  for (const clause of where.split(/\s+AND\s+/i)) {
    const test = predicate(clause, ctx);
    if (!test) return { ok: false, unsupported: clause.trim() };
    tests.push(test);
  }
  const number = (key: string) => Number(key.split("-")[1]);
  const matched = issues
    .filter((i) => tests.every((t) => t(i)))
    .sort((a, b) => number(b.key) - number(a.key) || b.project.localeCompare(a.project));
  return { ok: true, issues: matched };
}
