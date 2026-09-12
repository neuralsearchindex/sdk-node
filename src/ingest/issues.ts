import type { z } from "zod";

/**
 * A single normalized validation failure, flattened out of a `ZodError` so it can
 * cross a service boundary and be stored as jsonb.
 *
 * The raw zod issue tree is unbounded — `received` can be an entire nested object
 * and a union issue carries a full sub-error per branch — so everything here is
 * capped. See `normalizeZodIssues`.
 */
export interface IngestIssue {
  /** Dotted field path with array indices inline, e.g. `address.country`, `images.3.url`. Empty at the root. */
  path: string;
  /** The zod issue code, e.g. `invalid_string`, `invalid_type`, `invalid_union`. */
  code: string;
  /** Zod's human-readable message. */
  message: string;
  /** What the schema wanted, when zod says so. */
  expected?: string;
  /** What the ad actually carried, stringified and truncated. */
  received?: string;
}

/** The structured failure persisted alongside an item's one-line `failReason`. */
export interface FailDetail {
  kind: "validation";
  issues: IngestIssue[];
  /** True when `issues` was capped — the ad had more problems than are listed. */
  truncated: boolean;
  /** The scraper's row id, so an operator can pull the raw payload it came from. */
  scrapedId?: string;
}

/** Cap on issues per ad. A malformed `images` array alone can produce hundreds. */
const MAX_ISSUES = 20;
/** Cap on any single stringified value. */
const MAX_VALUE_CHARS = 200;
/** Sub-issues taken from a union's FIRST branch only — never walk every branch. */
const MAX_UNION_SUB_ISSUES = 2;
/** Field paths named in the one-line summary. */
const MAX_SUMMARY_PATHS = 4;
const MAX_SUMMARY_CHARS = 500;

/** Stringify anything to a bounded, log-safe string. */
function brief(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === null || typeof value !== "object") text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = "[unserializable]";
    }
  }
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/**
 * Pull the offending value out of the raw ad by walking the issue's path.
 *
 * Zod only populates `received` for some codes — notably NOT `invalid_string`,
 * which is what a regex-constrained ISO code produces. Without this, an ad rejected
 * for `address.country` would report the rule but not the value that broke it, which
 * is the one thing an operator actually needs.
 */
function valueAtPath(root: unknown, segments: ReadonlyArray<string | number>): unknown {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

function pathOf(segments: ReadonlyArray<string | number>, prefix = ""): string {
  const joined = segments.join(".");
  if (!prefix) return joined;
  return joined ? `${prefix}.${joined}` : prefix;
}

/** zod issue shapes vary by code; read the optional fields defensively. */
type LooseIssue = z.ZodIssue & {
  expected?: unknown;
  received?: unknown;
  options?: unknown;
  keys?: unknown;
  validation?: unknown;
  unionErrors?: { issues: z.ZodIssue[] }[];
};

function toIngestIssue(issue: LooseIssue, prefix: string, raw: unknown, prefixPath: ReadonlyArray<string | number>): IngestIssue {
  const absolute = [...prefixPath, ...(issue.path as ReadonlyArray<string | number>)];
  const out: IngestIssue = {
    path: pathOf(issue.path as ReadonlyArray<string | number>, prefix),
    code: issue.code,
    message: issue.message,
  };

  // `options` is what an enum wanted; `validation` names the string rule (e.g.
  // "regex"); `expected` covers every other code.
  const expected =
    issue.options !== undefined ? issue.options : issue.expected !== undefined ? issue.expected : issue.validation;
  const expectedText = brief(expected);
  if (expectedText !== undefined) out.expected = expectedText;

  // `unrecognized_keys` reports the offending keys instead of a received value.
  // When zod supplies nothing, read the value out of the ad itself.
  const received = issue.keys !== undefined ? issue.keys : issue.received;
  const receivedText = brief(received !== undefined ? received : valueAtPath(raw, absolute));
  if (receivedText !== undefined) out.received = receivedText;

  return out;
}

function collect(
  issues: readonly z.ZodIssue[],
  prefix: string,
  out: IngestIssue[],
  raw: unknown,
  prefixPath: ReadonlyArray<string | number>,
): void {
  for (const entry of issues) {
    const issue = entry as LooseIssue;
    out.push(toIngestIssue(issue, prefix, raw, prefixPath));

    // A union reports one sub-error per branch. Take a couple from the FIRST branch
    // for context and stop — walking them all is the unbounded blob this cap exists
    // to prevent (a PLN gross rent fails both `{amount,currency}` and `null`, and the
    // whole rent object comes back as `received`).
    if (issue.code === "invalid_union" && Array.isArray(issue.unionErrors)) {
      const branch = issue.unionErrors[0];
      if (branch && Array.isArray(branch.issues)) {
        const unionPath = pathOf(issue.path as ReadonlyArray<string | number>, prefix);
        const unionPrefixPath = [...prefixPath, ...(issue.path as ReadonlyArray<string | number>)];
        for (const sub of branch.issues.slice(0, MAX_UNION_SUB_ISSUES)) {
          out.push(toIngestIssue(sub as LooseIssue, unionPath, raw, unionPrefixPath));
        }
      }
    }
  }
}

/**
 * Flatten a `ZodError` into a bounded, storable list: deduped by `path|code`, then
 * capped at {@link MAX_ISSUES}. When the cap bites, a trailing `truncated` marker
 * issue says how many were dropped.
 */
export function normalizeZodIssues(error: z.ZodError, raw?: unknown): IngestIssue[] {
  const collected: IngestIssue[] = [];
  collect(error.issues, "", collected, raw, []);

  // Dedupe BEFORE capping, so 100 bad `images.N.url` entries collapse to one useful
  // line rather than filling the cap with copies of the same problem.
  const seen = new Set<string>();
  const deduped: IngestIssue[] = [];
  for (const issue of collected) {
    const key = `${issue.path}|${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }

  if (deduped.length <= MAX_ISSUES) return deduped;
  const kept = deduped.slice(0, MAX_ISSUES);
  kept.push({
    path: "",
    code: "truncated",
    message: `+${deduped.length - MAX_ISSUES} more issues`,
  });
  return kept;
}

/** True when `issues` carries the marker `normalizeZodIssues` appends at the cap. */
export function issuesTruncated(issues: readonly IngestIssue[]): boolean {
  return issues.some((i) => i.code === "truncated");
}

/**
 * A one-line summary for the item's `failReason` column — the field paths that were
 * rejected, so the admin's existing table cell says something useful without any UI
 * change. The full list lives in `failDetail`.
 */
export function summarizeIssues(issues: readonly IngestIssue[]): string {
  const paths: string[] = [];
  for (const issue of issues) {
    if (issue.code === "truncated") continue;
    const label = issue.path || "(root)";
    if (!paths.includes(label)) paths.push(label);
  }
  if (paths.length === 0) return "validation failed (schema)";

  const shown = paths.slice(0, MAX_SUMMARY_PATHS);
  const rest = paths.length - shown.length;
  const summary = `validation failed: ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…` : summary;
}

/** Build the persisted failure record from a zod error. */
export function toFailDetail(error: z.ZodError, scrapedId?: string, raw?: unknown): FailDetail {
  const issues = normalizeZodIssues(error, raw);
  return { kind: "validation", issues, truncated: issuesTruncated(issues), ...(scrapedId ? { scrapedId } : {}) };
}
