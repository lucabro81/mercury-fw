/**
 * A small JQL evaluator for the made-up Jira the skill is trained on: enough
 * of the language for what the skill teaches (projects, statuses, types,
 * priorities, assignees, summaries, due and created dates), answering the way
 * Jira does, errors included: a value its field doesn't have is refused, not
 * matched to nothing, and a value of several words needs quotes. A clause it
 * doesn't know is reported, never guessed: the fixture then answers it as a
 * hole in the training data, not as a result the model would be blamed for.
 * The value errors are Jira's wording; the syntax errors follow its format.
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
  issuetype?: string;
  priority?: string;
};

/** What the query runs against: now, who `currentUser()` is, and the values each field has. */
export type JqlContext = {
  now: Date;
  currentUser: string;
  projects: string[];
  statuses: string[];
  users: Array<{ accountId: string; displayName: string }>;
  issuetypes: string[];
  priorities: string[];
};

export type JqlResult<T> = { ok: true; issues: T[] } | { ok: false; unsupported: string } | { ok: false; error: string };

const CLAUSE = /^(\w+)\s*(!=|<=|>=|=|<|>|~|is not|is)\s*(.+)$/i;
const DAY = 24 * 60 * 60 * 1000;
const CATEGORIES = ["To Do", "In Progress", "Done"];

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

/** Jira's syntax errors outside quoted strings: a reserved character, then a second word where AND or OR should be. */
function syntaxError(where: string): string | undefined {
  let quote: string | null = null;
  for (let i = 0; i < where.length; i++) {
    const ch = where[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("+{}[]&|;?*%^$#@".includes(ch)) {
      const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      return `Error in the JQL Query: The character '${ch}' is a reserved JQL character. You must enclose it in a string or use the escape '${escape}' instead. (line 1, character ${i + 1})`;
    }
  }
  let offset = 0;
  for (const clause of where.split(/(\s+AND\s+)/i)) {
    const match = CLAUSE.exec(clause.trim());
    const value = match?.[3]?.trim();
    if (value && !/^['"]/.test(value) && !/\(\)$/.test(value)) {
      const words = value.split(/\s+/);
      if (words.length > 1) {
        const at = offset + clause.indexOf(value) + value.indexOf(words[1]!);
        return `Error in the JQL Query: Expecting either 'OR' or 'AND' but got '${words[1]}'. (line 1, character ${at + 1})`;
      }
    }
    offset += clause.length;
  }
  return undefined;
}

type Predicate = (i: JqlIssue) => boolean;

/** The test `clause` puts on an issue, Jira's error for a value its field doesn't have, or undefined when the evaluator doesn't know the clause. */
function predicate(clause: string, ctx: JqlContext): Predicate | { error: string } | undefined {
  const match = CLAUSE.exec(clause.trim());
  if (!match) return undefined;
  const field = match[1]!;
  const op = match[2]!.toLowerCase();
  const raw = match[3]!;
  const written = unquote(raw);
  const value = written.toLowerCase();
  const missing = { error: `The value '${written}' does not exist for the field '${field}'.` };
  const eq = (actual: string | undefined) => actual?.toLowerCase() === value;
  const negate = (test: Predicate): Predicate | undefined => (op === "!=" ? (i) => !test(i) : op === "=" ? test : undefined);
  const among = (values: string[], test: Predicate) => (values.some((v) => v.toLowerCase() === value) ? negate(test) : missing);
  const empty = (get: (i: JqlIssue) => unknown): Predicate | undefined => {
    if (value !== "empty" && value !== "null") return undefined;
    return op === "is" ? (i) => get(i) === null : (i) => get(i) !== null;
  };

  switch (field.toLowerCase()) {
    case "project":
      return among(ctx.projects, (i) => eq(i.project));
    case "status":
      return among(ctx.statuses, (i) => eq(i.status));
    case "statuscategory":
      return among(CATEGORIES, (i) => eq(i.statusCategory));
    case "issuetype":
    case "type":
      return among(ctx.issuetypes, (i) => eq(i.issuetype));
    case "priority":
      return among(ctx.priorities, (i) => eq(i.priority));
    case "assignee": {
      if (op === "is" || op === "is not") return empty((i) => i.assignee);
      if (/^currentuser\(\)$/.test(value)) return negate((i) => i.assignee?.accountId === ctx.currentUser);
      const user = ctx.users.find((u) => u.displayName.toLowerCase() === value || u.accountId.toLowerCase() === value);
      return user ? negate((i) => i.assignee?.accountId === user.accountId) : missing;
    }
    case "summary":
      return op === "~" ? (i) => i.summary.toLowerCase().includes(value) : undefined;
    case "duedate":
    case "created": {
      const get = (i: JqlIssue) => (field.toLowerCase() === "duedate" ? i.duedate : i.created);
      if (op === "is" || op === "is not") return empty(get);
      const bound = dateOf(raw, ctx.now);
      if (bound === undefined || !["<", "<=", ">", ">=", "=", "!="].includes(op)) return undefined;
      return (i) => {
        const at = get(i);
        return at !== null && compare(Date.parse(at), op, bound);
      };
    }
    default:
      return undefined;
  }
}

/** The issues `jql` matches, newest key first as Jira lists them; Jira's error for a query it refuses; or the clause the evaluator couldn't read. */
export function filterJql<T extends JqlIssue>(jql: string, issues: T[], ctx: JqlContext): JqlResult<T> {
  const [where = ""] = jql.split(/\s+ORDER\s+BY\s+/i);
  if (/\s+OR\s+/i.test(where)) return { ok: false, unsupported: where.trim() };
  const syntax = syntaxError(where);
  if (syntax !== undefined) return { ok: false, error: syntax };
  const tests: Predicate[] = [];
  for (const clause of where.split(/\s+AND\s+/i)) {
    const test = predicate(clause, ctx);
    if (test === undefined) return { ok: false, unsupported: clause.trim() };
    if (typeof test !== "function") return { ok: false, error: test.error };
    tests.push(test);
  }
  const number = (key: string) => Number(key.split("-")[1]);
  const matched = issues
    .filter((i) => tests.every((t) => t(i)))
    .sort((a, b) => number(b.key) - number(a.key) || b.project.localeCompare(a.project));
  return { ok: true, issues: matched };
}
