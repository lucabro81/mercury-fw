/**
 * A small JQL evaluator for the made-up Jira the skill is trained on: enough
 * of the language for what the skill teaches (keys, projects, statuses, types,
 * priorities, assignees, summaries, due and created dates), answering the way
 * Jira does, errors included: a value its field doesn't have is refused, not
 * matched to nothing, and a value of several words needs quotes. A clause it
 * doesn't know is reported, never guessed: the fixture then answers it as a
 * hole in the training data, not as a result the model would be blamed for.
 *
 * What's known to differ from Jira, none of it reached by a task's answer:
 * `summary ~` matches a substring (Jira matches stemmed words, so "log"
 * doesn't find "login" there); `created = <date>` compares timestamps, so a
 * bare day never matches; the reserved characters checked are a subset of
 * Jira's (not `.`, `,`, `/`); ORDER BY is found without regard to quotes;
 * empty values sort last whatever the direction, which wasn't checked against
 * Jira; without an ORDER BY, issues of different projects are ordered by
 * number and then project key, where Jira orders them by creation. The value
 * errors and the refusal of an unbounded query are Jira's wording, the syntax
 * errors follow its format; none was recorded from a real instance.
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

/** A relative offset (`-7d`, `2w`, `3h`) in milliseconds, undefined when `text` isn't one. */
function offsetOf(text: string): number | undefined {
  const offset = /^([+-]?\d+)([dwh])$/i.exec(text.trim());
  if (!offset) return undefined;
  const unit = { d: DAY, w: 7 * DAY, h: DAY / 24 }[offset[2]!.toLowerCase() as "d" | "w" | "h"];
  return Number(offset[1]) * unit;
}

/** Jira's date functions: the start or the end of the day, week (taken as starting on Monday, which in
 * Jira depends on the instance's locale) or month of `at`, in UTC. */
function boundary(name: string, at: number): number | undefined {
  const d = new Date(at);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monday = day - ((d.getUTCDay() + 6) % 7) * DAY;
  const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const values: Record<string, number> = {
    startofday: day,
    endofday: day + DAY - 1,
    startofweek: monday,
    endofweek: monday + 7 * DAY - 1,
    startofmonth: month,
    endofmonth: nextMonth - 1,
  };
  return values[name.toLowerCase()];
}

/** A date value (`now()`, a date function with an optional offset, `-7d`/`2w`/`3h`, or a date) as a time;
 * Jira's error for a function it doesn't have; undefined when it's none of these. */
function dateOf(raw: string, now: Date): number | { error: string } | undefined {
  const value = unquote(raw);
  const fn = /^(\w+)\((.*)\)$/.exec(value);
  if (fn) {
    const name = fn[1]!;
    const arg = unquote(fn[2]!);
    if (name.toLowerCase() === "now" && arg === "") return now.getTime();
    const shift = arg === "" ? 0 : offsetOf(arg);
    const at = shift === undefined ? undefined : boundary(name, now.getTime() + shift);
    return at ?? { error: `Unable to find JQL function '${name}()'.` };
  }
  const offset = offsetOf(value);
  if (offset !== undefined) return now.getTime() + offset;
  // A bare day, with dashes or slashes, is that day in UTC: never the machine's timezone.
  const day = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date;
}

/** Compares two times by `op`. */
function compare(a: number, op: string, b: number): boolean {
  return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "=" ? a === b : a !== b;
}

/** Jira's syntax error for a reserved character outside quoted strings. */
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
  return undefined;
}

/** Jira's syntax error for a clause whose value is several words without quotes; `at` is where the clause starts in the query. */
function unquotedWords(clause: string, at: number): string | undefined {
  const match = CLAUSE.exec(clause.trim());
  const value = match?.[3]?.trim();
  if (!value || /^['"]/.test(value) || /\)$/.test(value)) return undefined;
  const words = value.split(/\s+/);
  if (words.length < 2) return undefined;
  const position = at + clause.indexOf(value) + value.indexOf(words[1]!);
  return `Error in the JQL Query: Expecting either 'OR' or 'AND' but got '${words[1]}'. (line 1, character ${position + 1})`;
}

/** `s` split on `keyword` (AND, OR) where it stands outside quotes and parentheses, each part with where it starts. */
function splitTop(s: string, keyword: string, start: number): Array<{ text: string; at: number }> {
  const parts: Array<{ text: string; at: number }> = [];
  const pattern = new RegExp(`^\\s+${keyword}\\s+`, "i");
  let quote: string | null = null;
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      const found = pattern.exec(s.slice(i));
      if (found) {
        parts.push({ text: s.slice(from, i), at: start + from });
        from = i + found[0].length;
        i = from - 1;
      }
    }
  }
  parts.push({ text: s.slice(from), at: start + from });
  return parts;
}

/** Whether the parenthesis opening `s` closes at its very end, so the whole of `s` is one group. */
function wrapped(s: string): boolean {
  if (!s.startsWith("(")) return false;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i === s.length - 1;
  }
  return false;
}

type Parsed = Predicate | { error: string } | { unsupported: string };

/** The test of the condition `s` (ORs of ANDs of clauses or parenthesized groups), starting at `at` in the query. */
function parseCondition(s: string, at: number, ctx: JqlContext, keys: Set<string>): Parsed {
  const any: Predicate[] = [];
  for (const orPart of splitTop(s, "OR", at)) {
    const all: Predicate[] = [];
    for (const andPart of splitTop(orPart.text, "AND", orPart.at)) {
      const lead = andPart.text.length - andPart.text.trimStart().length;
      const text = andPart.text.trim();
      const start = andPart.at + lead;
      let test: Parsed | undefined;
      if (wrapped(text)) test = parseCondition(text.slice(1, -1), start + 1, ctx, keys);
      else {
        const syntax = unquotedWords(text, start);
        if (syntax !== undefined) return { error: syntax };
        test = listPredicate(text, ctx, keys) ?? predicate(text, ctx, keys) ?? { unsupported: text };
      }
      if (typeof test !== "function") return test;
      all.push(test);
    }
    any.push((i) => all.every((t) => t(i)));
  }
  return (i) => any.some((t) => t(i));
}

type Predicate = (i: JqlIssue) => boolean;

/** An issue's resolution in the made-up Jira: Done once its status is in the Done category, none before. */
const resolutionOf = (i: JqlIssue): string | null => (i.statusCategory === "Done" ? "Done" : null);

/** The test `clause` puts on an issue, Jira's error for a value its field doesn't have, or undefined when the evaluator doesn't know the clause. */
function predicate(clause: string, ctx: JqlContext, keys: Set<string>): Predicate | { error: string } | undefined {
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
  // EMPTY and null, with `is`/`is not` or `=`/`!=` alike, on the fields that can be empty.
  const emptiable: Record<string, (i: JqlIssue) => unknown> = {
    assignee: (i) => i.assignee,
    duedate: (i) => i.duedate,
    priority: (i) => i.priority ?? null,
    issuetype: (i) => i.issuetype ?? null,
    type: (i) => i.issuetype ?? null,
    resolution: (i) => resolutionOf(i),
  };
  const get = emptiable[field.toLowerCase()];
  if (value === "empty" || value === "null") {
    if (get === undefined || !["is", "is not", "=", "!="].includes(op)) return undefined;
    return op === "is" || op === "=" ? (i) => get(i) === null : (i) => get(i) !== null;
  }
  if (op === "is" || op === "is not") return undefined;

  switch (field.toLowerCase()) {
    case "key":
    case "issuekey":
      if (!keys.has(written.toUpperCase())) return { error: `An issue with key '${written}' does not exist for field 'key'.` };
      return negate((i) => eq(i.key));
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
      if (/^currentuser\(\)$/.test(value)) return negate((i) => i.assignee?.accountId === ctx.currentUser);
      const user = ctx.users.find((u) => u.displayName.toLowerCase() === value || u.accountId.toLowerCase() === value);
      return user ? negate((i) => i.assignee?.accountId === user.accountId) : missing;
    }
    case "resolution":
      // Unresolved is how JQL names the empty resolution.
      if (value === "unresolved") return negate((i) => resolutionOf(i) === null);
      return among(["Done"], (i) => eq(resolutionOf(i) ?? undefined));
    case "summary":
      return op === "~" ? (i) => i.summary.toLowerCase().includes(value) : undefined;
    case "duedate":
    case "created": {
      // A due date is a day, taken here as its midnight, so `duedate < now()` takes in what's due
      // today. Not checked against a real Jira: the tasks whose answer depends on it accept both readings.
      const at = (i: JqlIssue) => (field.toLowerCase() === "duedate" ? i.duedate : i.created);
      const bound = dateOf(raw, ctx.now);
      if (typeof bound === "object") return bound;
      if (bound === undefined || !["<", "<=", ">", ">=", "=", "!="].includes(op)) return undefined;
      return (i) => {
        const when = at(i);
        return when !== null && compare(Date.parse(when), op, bound);
      };
    }
    default:
      return undefined;
  }
}

/** The values of an `in (…)` list, split on the commas outside quotes. */
function splitList(list: string): string[] {
  const values: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of list) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values.filter((v) => v !== "");
}

/** The test of `field in (…)` / `field not in (…)`, each value read as `field = value`; undefined for any other clause. */
function listPredicate(clause: string, ctx: JqlContext, keys: Set<string>): Predicate | { error: string } | undefined {
  const match = /^(\w+)\s+(not\s+in|in)\s*\((.*)\)$/i.exec(clause.trim());
  if (!match) return undefined;
  const tests: Predicate[] = [];
  for (const value of splitList(match[3]!)) {
    const test = predicate(`${match[1]} = ${value}`, ctx, keys);
    // A field the evaluator doesn't know: the clause falls through to being reported, not guessed.
    if (test === undefined) return undefined;
    if (typeof test !== "function") return test;
    tests.push(test);
  }
  return /^not/i.test(match[2]!) ? (i) => !tests.some((t) => t(i)) : (i) => tests.some((t) => t(i));
}

/** The issues `jql` matches, newest key first as Jira lists them; Jira's error for a query it refuses; or the clause the evaluator couldn't read. */
export function filterJql<T extends JqlIssue>(jql: string, issues: T[], ctx: JqlContext): JqlResult<T> {
  const ordered = /^(.*?)\s*\bORDER\s+BY\s+(.+)$/is.exec(jql.trim());
  const where = ordered ? ordered[1]! : jql.trim();
  const orderBy = ordered?.[2];
  if (where === "") return { ok: false, error: "Unbounded JQL queries are not allowed here. Please add a search restriction to your query." };
  const syntax = syntaxError(where);
  if (syntax !== undefined) return { ok: false, error: syntax };
  const keys = new Set(issues.map((i) => i.key.toUpperCase()));
  const test = parseCondition(where, 0, ctx, keys);
  if (typeof test !== "function") return { ok: false, ...test };
  const order = sortOf(orderBy);
  if (typeof order !== "function") return { ok: false, unsupported: `ORDER BY ${orderBy}` };
  return { ok: true, issues: issues.filter((i) => test(i)).sort(order) };
}

/** The issue number of a key. */
const numberOf = (key: string) => Number(key.split("-")[1]);

/** Newest key first: the order the real CLI's searches came back in without an ORDER BY. */
const newestFirst = (a: JqlIssue, b: JqlIssue) => numberOf(b.key) - numberOf(a.key) || b.project.localeCompare(a.project);

/** Priorities from the highest down, for ordering by priority. */
const PRIORITY_RANK = ["highest", "high", "medium", "low", "lowest"];

/** How each orderable field compares two issues ascending; null means the issue has no value there. */
const SORT_KEYS: Record<string, (i: JqlIssue) => string | number | null> = {
  key: (i) => `${i.project}-${String(numberOf(i.key)).padStart(8, "0")}`,
  issuekey: (i) => `${i.project}-${String(numberOf(i.key)).padStart(8, "0")}`,
  created: (i) => Date.parse(i.created),
  duedate: (i) => (i.duedate === null ? null : Date.parse(i.duedate)),
  // Descending puts the highest first, as Jira does: rank 0 for Highest is the largest value.
  priority: (i) => (i.priority === undefined ? null : PRIORITY_RANK.length - PRIORITY_RANK.indexOf(i.priority.toLowerCase())),
};

/** The comparator an ORDER BY asks for (fields Jira sorts ascending by default, empty values last,
 * newest key first as the last tie-break); undefined for a field the evaluator doesn't order by. */
function sortOf(orderBy: string | undefined): ((a: JqlIssue, b: JqlIssue) => number) | undefined {
  if (orderBy === undefined) return newestFirst;
  const keys: Array<{ get: (i: JqlIssue) => string | number | null; desc: boolean }> = [];
  for (const part of orderBy.split(",")) {
    const match = /^(\w+)(?:\s+(ASC|DESC))?$/i.exec(part.trim());
    const get = match ? SORT_KEYS[match[1]!.toLowerCase()] : undefined;
    if (!match || !get) return undefined;
    keys.push({ get, desc: match[2]?.toUpperCase() === "DESC" });
  }
  return (a, b) => {
    for (const { get, desc } of keys) {
      const [x, y] = [get(a), get(b)];
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp = x < y ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return newestFirst(a, b);
  };
}
