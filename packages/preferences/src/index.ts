/**
 * `@local-llm/preferences` — the durable per-user SEARCH PREFERENCE profile:
 * the shared source of truth for the agents graph (which writes/reads it via the
 * LangGraph store) and the web app (which lets the user edit it). Dependency-free
 * plain TS + pure helpers, consumed as source by every workspace.
 *
 * Kept as a SINGLE file (no internal relative imports) so it resolves identically
 * under Node's NodeNext (agents/engine) and the web's webpack bundler — mirroring
 * the `@local-llm/geo` precedent.
 *
 * Most fields are recency-ordered arrays (most-recent first, deduped, capped at
 * `CAP`) so the profile RETAINS history; the search backfill reads index 0
 * (last-write-wins). Price is the exception: a single min/max range, because
 * prices vary every search and a history would only add noise.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Durable, recency-ordered preference profile. `priceMin`/`priceMax` and
 *  `updatedAt` are scalars; every other field is a recency-ordered array. */
export interface UserPreferences {
  cities?: string[];
  regions?: string[];
  countries?: string[];
  listingTypes?: ("rent" | "buy")[];
  propertyTypes?: string[];
  currencies?: string[];
  bedroomsMins?: number[];
  roomsMins?: number[];
  // Single min/max range (last-write-wins), not a recency array.
  priceMin?: number;
  priceMax?: number;
  updatedAt?: string;
}

export type ListFieldKind = "string" | "enum" | "number";

/** The recency-ARRAY fields, with the value kind that drives validation + the
 *  editable-list UI. Price is NOT here — it is a scalar range handled apart. */
export type ListFieldKey =
  | "cities"
  | "regions"
  | "countries"
  | "listingTypes"
  | "propertyTypes"
  | "currencies"
  | "bedroomsMins"
  | "roomsMins";

export interface ProfileFieldDescriptor {
  key: ListFieldKey;
  kind: ListFieldKind;
  /** Allowed values for `kind: "enum"`. */
  options?: readonly string[];
}

export const PROFILE_FIELDS: readonly ProfileFieldDescriptor[] = [
  { key: "cities", kind: "string" },
  { key: "regions", kind: "string" },
  { key: "countries", kind: "string" },
  { key: "listingTypes", kind: "enum", options: ["rent", "buy"] },
  { key: "propertyTypes", kind: "string" },
  { key: "currencies", kind: "string" },
  { key: "bedroomsMins", kind: "number" },
  { key: "roomsMins", kind: "number" },
] as const;

// ---------------------------------------------------------------------------
// Store address (must match how the agents graph reads/writes the profile)
// ---------------------------------------------------------------------------

/** Cross-thread store namespace for a user's profile: `["preferences", userId]`. */
export function profileNamespace(userId: string): string[] {
  return ["preferences", userId];
}

/** The single key under the namespace holding the `UserPreferences` value. */
export const PROFILE_KEY = "profile";

// ---------------------------------------------------------------------------
// Pure normalization helpers (shared by the agents merge/backfill and the web
// edit route so the two can't drift on the dedupe / cap / placeholder rules)
// ---------------------------------------------------------------------------

/** Max entries kept per recency-ordered list field. */
export const CAP = 5;

/** True when a string carries no actual value — the intent LLM emits placeholders
 *  like "", "   ", ".*", ",", "*". A REAL value for our string fields always
 *  contains a letter, so "no letter ⇒ absent" is robust. */
export function blankString(s: string): boolean {
  return !/\p{L}/u.test(s);
}

/** A field is "absent" if null/undefined OR a placeholder string. Numbers are
 *  absent only when null/undefined (0 stays a real value). */
export function blank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return blankString(v);
  return false;
}

/** Case-insensitive, whitespace-trimmed equality for strings. Non-strings ===. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return a === b;
}

/** Fold a string to a comparison key: trimmed, lowercased, diacritics stripped
 *  so "Zürich" / "Zurich" / " zurich " collapse to one ("zurich"). */
export function foldKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** Drop later duplicates (case- AND diacritic-insensitive), keeping the first
 *  (most-recent) spelling. */
export function dedupeCI(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const k = foldKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Reserved tokens that must never surface as a real value — defensive against a
 *  polluted array (e.g. a stringified `null`/`undefined`). `blank` doesn't catch
 *  these because they contain letters. */
export function isReservedToken(v: unknown): boolean {
  return typeof v === "string" && /^[^\p{L}]*(null|undefined)[^\p{L}]*$/iu.test(v);
}

/**
 * Prepend a stated value into a recency list: newest first, deduped, capped.
 * An absent value (null/undefined/placeholder string) leaves the list unchanged.
 */
export function bump<T>(arr: T[] | undefined, v: T | null | undefined): T[] | undefined {
  if (v === null || v === undefined) return arr; // narrows v to T below
  if (typeof v === "string" && blankString(v)) return arr;
  const rest = (arr ?? []).filter((x) => !sameValue(x, v));
  return [v, ...rest].slice(0, CAP);
}

/** A finite number, or undefined for anything else (null, NaN, "", non-numeric). */
function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Dedupe numbers by value, preserving order. */
function dedupeNumbers(list: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of list) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Sanitize an (untrusted, e.g. user-edited) profile into a valid `UserPreferences`:
 * every list field is filtered of blanks/junk, deduped and capped by kind; the
 * price range is coerced to finite numbers and swapped if inverted. Legacy
 * `priceMins[]`/`priceMaxs[]` arrays (pre-range shape) migrate to the scalar
 * range via their index-0 value. Empty lists are dropped. When `now` is passed it
 * stamps `updatedAt` (kept as a param so the function stays pure for tests).
 */
export function normalizeProfile(
  input: Partial<UserPreferences> | null | undefined,
  now?: string,
): UserPreferences {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const field of PROFILE_FIELDS) {
    const raw = src[field.key];
    if (!Array.isArray(raw)) continue;

    let values: (string | number)[];
    if (field.kind === "number") {
      values = dedupeNumbers(
        raw.map(toFiniteNumber).filter((n): n is number => n !== undefined),
      ).slice(0, CAP);
    } else {
      let strs = raw.filter(
        (v): v is string =>
          typeof v === "string" && !blankString(v) && !isReservedToken(v),
      );
      if (field.kind === "enum" && field.options) {
        const allowed = field.options;
        strs = strs.filter((v) => allowed.includes(v));
      }
      values = dedupeCI(strs).slice(0, CAP);
    }

    if (values.length > 0) out[field.key] = values;
  }

  // Price range — scalars, not a recency array. Migrate legacy `priceMins[]` /
  // `priceMaxs[]` by taking their index-0 value. Swap if the user inverted them.
  const legacy = (arr: unknown): number | undefined =>
    Array.isArray(arr) ? toFiniteNumber(arr[0]) : undefined;
  let min = toFiniteNumber(src.priceMin) ?? legacy(src.priceMins);
  let max = toFiniteNumber(src.priceMax) ?? legacy(src.priceMaxs);
  if (min !== undefined && max !== undefined && min > max) {
    [min, max] = [max, min];
  }
  if (min !== undefined) out.priceMin = min;
  if (max !== undefined) out.priceMax = max;

  if (now) out.updatedAt = now;
  return out as UserPreferences;
}
