/**
 * The relevance-score wrapper around a PropertyListing, plus the normalization
 * helpers every producer of a score must go through.
 *
 * A PropertyListing is a pure DOMAIN RECORD — what a property IS, independent of
 * any query. A score is a RELATION between a listing and one query, produced by
 * one engine, valid only for that query. Putting `score` on the listing would
 * conflate the two and force every non-query path (browse, hydrate-by-id) to
 * invent a number it cannot know. Hence the wrapper.
 *
 * CONTRACT: `score` is ALWAYS 0..1, comparable across engines, renderable as a
 * percentage. Each producer maps its native output into that range — `sigmoid`
 * for cross-encoder logits, `(x+1)/2` for a cosine, `normalizeScores` for RRF
 * sums and rule-point totals. The helpers live here, next to the schema that
 * declares the rule, because `packages/milvus` and `apps/agents` both need them
 * and cannot import each other's internals.
 */
import { z } from "zod";
import { propertyListingSchema } from "./listing.js";

const unitInterval = z.number().min(0).max(1);

/**
 * Per-engine breakdown of `score`, for explainability ("why 74%?").
 *
 * EVERY field is optional and each is present ONLY when that engine actually
 * measured this listing. Absent ≠ zero ≠ 0.5: absent means "not measured" —
 * the engine was disabled, its service was down, the listing has no photos, or
 * the listing arrived by a path that engine never saw. Blends substitute a
 * neutral 0.5 for an absent component in the ARITHMETIC, but deliberately do
 * not write that 0.5 back here: reporting a fabricated measurement as a
 * measurement is worse than reporting nothing.
 */
export const scoreComponentsSchema = z.object({
  /** Cross-encoder query↔listing-text relevance, sigmoid(logit). Absolute. */
  semantic: unitInterval.optional(),
  /** Rule-based structured fit (budget/type/rooms/city), min-max over the set. */
  structured: unitInterval.optional(),
  /** Best CLIP cosine of the visual query against any of the listing's photos. */
  visual: unitInterval.optional(),
  /**
   * Milvus retrieval score, min-max over the result set.
   *
   * ONE number for all three legs (dense, learned-sparse and CLIP-over-photos):
   * they are fused inside Milvus by RRF, and it reports only the merged rank,
   * never each leg's contribution. There is deliberately no per-leg component —
   * splitting them again would mean asking Milvus once per leg, which is exactly
   * the round-trip the single-collection schema removed.
   */
  fusion: unitInterval.optional(),
});

export type ScoreComponents = z.infer<typeof scoreComponentsSchema>;

export const scoredListingSchema = z.object({
  listing: propertyListingSchema,
  /** Relevance in [0,1]. Render as `Math.round(score * 100)`%. */
  score: unitInterval,
  components: scoreComponentsSchema.optional(),
});

export type ScoredListing = z.infer<typeof scoredListingSchema>;

/** Squash an unbounded logit (cross-encoder) into (0,1). */
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Clamp into the contract range — defence against float drift at boundaries. */
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Min-max normalize a set of raw scores into [0,1].
 *
 * WARNING — this is SET-RELATIVE, not absolute. The worst item in an excellent
 * set gets 0 and the best item in a terrible set gets 1. That is inherent to
 * min-max and is the price of the "0..1 everywhere" contract for engines whose
 * native output has no meaningful absolute scale (RRF sums, rule-point totals).
 * Only `semantic` (sigmoid of a calibrated cross-encoder logit) and `visual`
 * (a cosine) are absolute.
 *
 * `loneValue` / `equalValue` disambiguate the degenerate cases — a 1-item set
 * has no range at all, an all-equal set has range 0 — and callers must choose
 * deliberately. RETRIEVAL paths pass 1: a lone hit is the best (and only) thing
 * the index returned for the query, and calling it "50% relevant" would leak a
 * normalization artifact into the UI as a claim about the property. BLEND
 * components pass 0.5, where all-equal genuinely means "this signal cannot
 * discriminate here".
 */
export function normalizeScores(
  values: number[],
  options: { loneValue?: number; equalValue?: number } = {},
): number[] {
  const loneValue = options.loneValue ?? 0.5;
  const equalValue = options.equalValue ?? 0.5;
  if (values.length === 0) return [];
  if (values.length === 1) return [loneValue];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => equalValue);
  return values.map((v) => (v - min) / range);
}

/**
 * {@link normalizeScores} over a sparse column: normalizes the MEASURED subset
 * and scatters the results back into place, leaving nulls null.
 *
 * Unmeasured items must not enter the min-max — a null is not a low value, and
 * feeding it in as one would drag the whole range. Callers get a column that is
 * still aligned to their items and still knows what it never measured.
 */
export function normalizeSparseScores(
  values: (number | null)[],
  options: { loneValue?: number; equalValue?: number } = {},
): (number | null)[] {
  const present: number[] = [];
  const at: number[] = [];
  values.forEach((v, i) => {
    if (v != null) {
      present.push(v);
      at.push(i);
    }
  });
  const normalized = normalizeScores(present, options);
  const out: (number | null)[] = values.map(() => null);
  at.forEach((index, i) => {
    out[index] = normalized[i];
  });
  return out;
}

/**
 * Relative weights of the rerank signals. Mirrors `retrievalWeights` (see
 * search-intent.ts): only RATIOS count, so these need not sum to 1 — the blend
 * renormalizes over whichever signals survive.
 */
export const rerankWeightsSchema = z.object({
  /** Milvus's fused retrieval score. Modest: absent for fresh scrapes. */
  fusion: z.number().min(0).default(0.14),
  /** Rule-based structured fit (rank.ts). */
  structured: z.number().min(0).default(0.14),
  /** Cross-encoder query↔text relevance. */
  semantic: z.number().min(0).default(0.22),
  /** CLIP photo match — the dominant signal, see DEFAULT_RERANK_WEIGHTS. */
  visual: z.number().min(0).default(0.5),
});

export type RerankWeights = z.infer<typeof rerankWeightsSchema>;

/**
 * Derived from the schema so the two cannot drift.
 *
 * VISUAL LEADS, at half the total weight — more than any other signal and more
 * than the two text signals combined. What a property LOOKS like is the thing a
 * photo query is actually asking about, and it is the signal the text engines
 * are worst at: "red windows" or "exposed beams" is often nowhere in the prose,
 * so a text-led blend ranks on everything except the thing that was asked.
 *
 * This deliberately supersedes the earlier balance (`semantic` 0.45 /
 * `structured` 0.30 / `visual` 0.25), which reproduced the pre-registry
 * hardcoded blend. Note the visual signal is min-max normalized across the
 * candidate set before blending (see rerank.ts) — without that, raw CLIP
 * cosines are compressed into ~0.1 of range and even a 0.5 weight would barely
 * move an ordering.
 *
 * Only ratios matter; the blend renormalizes over whichever signals survive.
 */
export const DEFAULT_RERANK_WEIGHTS: RerankWeights = rerankWeightsSchema.parse({});

/** One signal's contribution to a blended score. */
export interface BlendSignal {
  /** Which component this is; also the key written into ScoreComponents. */
  key: keyof ScoreComponents;
  /** Relative weight. Only RATIOS matter — the surviving set is renormalized. */
  weight: number;
  /**
   * The signal's 0..1 value per item, `null` where it was NOT MEASURED for that
   * item (engine off, service down, no photos, arrived by a path it never saw).
   */
  values: (number | null)[];
}

/**
 * Blend independently-toggleable relevance signals into one 0..1 score per item,
 * plus the per-item {@link ScoreComponents} of what was actually MEASURED.
 *
 * Weights are RELATIVE and renormalized over the signals that survive, so a
 * signal switching off redistributes its weight PROPORTIONALLY across the rest
 * instead of silently handing it to whichever term was written as its
 * complement. That hardcoded `1 - weight` is exactly why the engines could not
 * be toggled independently before. The same reasoning governs the retrieval legs
 * in packages/milvus/src/search.ts: a leg that drops out takes its weight with it.
 *
 * Survival is decided per BATCH, not per item, on purpose. Renormalizing per
 * item would give two items different denominators — one blended over three
 * signals, one over two — and their scores would then answer different
 * questions, defeating the point of a shared 0..1 scale. So a signal is in when
 * its weight is positive AND it measured at least one item here; within a
 * surviving signal, an item it did not measure takes the neutral 0.5 in the
 * ARITHMETIC and stays absent from its `components` (absent ≠ zero ≠ 0.5).
 *
 * With NO surviving signal every item scores 0.5 and `components` is empty; the
 * caller's input order then stands, which is the identity the toggles promise.
 */
export function blendSignals(
  count: number,
  signals: BlendSignal[],
): { scores: number[]; components: ScoreComponents[] } {
  const live = signals.filter(
    (s) => s.weight > 0 && s.values.some((v) => v != null),
  );
  const total = live.reduce((sum, s) => sum + s.weight, 0);
  const components: ScoreComponents[] = Array.from({ length: count }, () => ({}));
  const scores = new Array<number>(count);

  for (let i = 0; i < count; i++) {
    if (total === 0) {
      scores[i] = 0.5;
      continue;
    }
    let acc = 0;
    for (const s of live) {
      const v = s.values[i];
      if (v != null) components[i][s.key] = v;
      acc += (s.weight / total) * (v ?? 0.5);
    }
    scores[i] = clamp01(acc);
  }
  return { scores, components };
}
