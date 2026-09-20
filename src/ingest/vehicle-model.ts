/**
 * Vehicle model names, canonicalised so the index and the query meet.
 *
 * The problem this solves: model names arrive in the SOURCE's language. A Polish
 * dealer publishes `Seria 7`, `Klasa S`, `Klasa G`, and the index stores exactly
 * that (lowercased). The search filter is a `*contains*` wildcard, so a user
 * asking for "7 Series" or "S-Class" matched nothing — and because model is a
 * hard filter, the whole search came back empty.
 *
 * Two outputs, used together:
 *   · {@link canonicalVehicleModel} — the canonical English form, stored on the
 *     document as `model` so the field means one thing regardless of source.
 *   · {@link vehicleModelAliases} — every form the same car might be asked for
 *     (canonical, the source's own wording, the folded and re-separated
 *     spellings), stored as `model_aliases` and matched against at query time.
 *     That is the fallback for a model this table has never seen: the source
 *     wording is always in the list, so nothing gets worse than before.
 *
 * Unknown models pass through untouched — this table is a translation aid, not a
 * gate. Anything it cannot place is still searchable by what the source called it.
 */

/**
 * Strip accents so `škoda` and `skoda` are the same token. NFKD splits a letter
 * from its combining marks, which the range then removes. Same approach as the
 * real-estate city-variants table.
 */
export function foldDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Lowercase, fold accents, and collapse whitespace — the comparison form. */
function normalise(value: string): string {
  return foldDiacritics(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Localised model patterns → canonical English. Ordered: first match wins.
 *
 * `klasa s` ⇄ `s-class` (Mercedes) and `seria 7` ⇄ `7 series` (BMW) are the two
 * that actually occur in the corpus today; the reverse directions are here so a
 * Polish-speaking user's phrasing normalises to the same canonical value.
 */
const MODEL_PATTERNS: { match: RegExp; canonical: (m: RegExpMatchArray) => string }[] = [
  // Mercedes: "klasa s" / "s klasa" / "s-class" / "s class" → "s-class"
  { match: /^klasa\s+([a-z0-9]{1,4})$/, canonical: (m) => `${m[1]}-class` },
  { match: /^([a-z0-9]{1,4})\s+klasa$/, canonical: (m) => `${m[1]}-class` },
  { match: /^([a-z0-9]{1,4})[\s-]class$/, canonical: (m) => `${m[1]}-class` },
  // BMW: "seria 7" / "7 seria" / "7 series" → "7 series"
  { match: /^seria\s+([a-z0-9]{1,3})$/, canonical: (m) => `${m[1]} series` },
  { match: /^([a-z0-9]{1,3})\s+seria$/, canonical: (m) => `${m[1]} series` },
  { match: /^([a-z0-9]{1,3})\s+series$/, canonical: (m) => `${m[1]} series` }
];

/**
 * The canonical English model, or the input (normalised) when nothing matches.
 * Returns `""` for a missing/blank value, never null, so callers can write it
 * straight into a keyword field.
 */
export function canonicalVehicleModel(model: unknown): string {
  if (typeof model !== "string") return "";
  const value = normalise(model);
  if (!value) return "";
  for (const { match, canonical } of MODEL_PATTERNS) {
    const m = value.match(match);
    if (m) return canonical(m);
  }
  return value;
}

/** Hyphen ⇄ space, so `mercedes benz` also reaches a stored `mercedes-benz`. */
function separatorVariants(value: string): string[] {
  return [value, value.replace(/-/g, " "), value.replace(/\s+/g, "-")];
}

/**
 * Every spelling this car could reasonably be asked for, lowercase and deduped.
 *
 * Includes `variant` because several providers put the real model there —
 * otomoto's `version`, automarket's `equipmentVersion` / `generation` — leaving
 * `model` coarse or empty. Nothing queries `variant` today, so folding it in here
 * is what makes those ads findable at all.
 */
export function vehicleModelAliases(model?: unknown, variant?: unknown, make?: unknown): string[] {
  const out = new Set<string>();
  const add = (value: string): void => {
    for (const v of separatorVariants(value)) {
      const trimmed = v.trim();
      if (trimmed) out.add(trimmed);
    }
  };

  for (const raw of [model, variant, make]) {
    if (typeof raw !== "string") continue;
    const value = normalise(raw);
    if (!value) continue;
    add(value);
    add(foldDiacritics(value));
    const canonical = canonicalVehicleModel(raw);
    if (canonical) add(canonical);
  }

  return [...out];
}
