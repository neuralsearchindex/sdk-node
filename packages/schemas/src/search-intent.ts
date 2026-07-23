/**
 * The structured search intent parsed from a natural-language query — the input
 * side of the search-graph contract. Shared so the agents (which fill it) and the
 * web frontend (which renders its chips) agree on one shape.
 */
import { z } from "zod";

/**
 * How much each retrieval leg counts when Milvus fuses them into one ranking.
 *
 * RELATIVE, not absolute: only the ratios matter, so scaling all three changes
 * nothing — which is also why a leg dropping out (its encoder unreachable) needs
 * no renormalizing.
 *
 * Every field defaults independently, so a model that judges only the one it has
 * an opinion about still yields a complete, sane set.
 */
export const retrievalWeightsSchema = z.object({
  dense: z
    .number()
    .min(0)
    .max(1)
    .default(0.4)
    .describe("Weight for MEANING in the listing text. Raise for vague/descriptive prose."),
  sparse: z
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe(
      "Weight for the EXACT WORDS in the listing text. Raise when the query names a rare " +
        "term the text must literally contain — a brand, a standard ('Minergie'), a street " +
        "or a reference number.",
    ),
  image: z
    .number()
    .min(0)
    .max(1)
    .default(0.4)
    .describe(
      "Weight for what the property LOOKS like, matched against its photos. Raise for " +
        "photo-led wishes ('modern kitchen', 'lake view'); lower for fact-led ones " +
        "(price, rooms, city, 'near the station').",
    ),
});

export type RetrievalWeights = z.infer<typeof retrievalWeightsSchema>;

/**
 * The neutral split — derived from the schema, so it cannot drift from it.
 *
 * Photos are weighted level with meaning, and above exact wording. Retrieval
 * decides what the rerank is even allowed to consider, so a visual-led ranking
 * (see DEFAULT_RERANK_WEIGHTS in scored-listing.ts, where visual is half the
 * total) needs visually-matching listings in the candidate set to begin with —
 * a photo leg held at a quarter would filter them out before ranking ran.
 *
 * Text still carries the majority together, deliberately: CLIP judges how a
 * property looks, not where it is or what it costs, so a photo-dominated
 * RETRIEVAL would return beautiful houses in the wrong city. The intent parser
 * lowers `image` per query for fact-led searches.
 */
export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = retrievalWeightsSchema.parse({});

export const searchIntentSchema = z.object({
  location: z.object({
    city: z
      .string()
      .nullable()
      .describe(
        "City or town (in German), written the way a LOCAL listing writes it — the endonym, accents " +
          "and all: Zürich (not Zurich), Genève (not Geneva/Genf), München (not Munich). " +
          "This is matched against the city on the listing itself, so an exonym finds " +
          "nothing. null if none given.",
      ),
    region: z
      .string()
      .nullable()
      .describe("Canton, state or region, e.g. Zurich, Brandenburg. null if none given."),
    country: z
      .string()
      .min(2)
      .max(2)
      .nullable()
      .describe(
        "ISO 3166-1 alpha-2 country code. Infer from the location when unambiguous " +
          "(Zürich/Genf/Basel → CH; Berlin/München → DE). null if unknown.",
      ),
  }),
  listingType: z
    .enum(["rent", "buy"])
    .nullable()
    .describe(
      "'buy' for sale/kaufen/zu verkaufen/à vendre; 'rent' for rent/mieten/zu vermieten/" +
        "à louer. null when unclear.",
    ),
  propertyType: z
    .string()
    .nullable()
    .describe(
      "Free-text property type, e.g. apartment, house, villa, chalet, penthouse, studio, " +
        "land. null if unspecified.",
    ),
  priceMin: z
    .number()
    .nonnegative()
    .nullable()
    .describe("Lower price bound: 'from'/'ab' sets this. Expand shorthand (750k → 750000). null if none."),
  priceMax: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      "Upper price bound: 'under CHF 1M'/'unter 900k'/'€900,000' set this. " +
        "Expand shorthand (1M → 1000000). null if none.",
    ),
  currency: z
    .string()
    .min(3)
    .max(3)
    .nullable()
    .describe(
      "ISO 4217 currency of the price bounds. Infer from the symbol (€ → EUR, CHF/Fr. → CHF), " +
        "or when a price is given without one, from the country (CH → CHF, DE → EUR). null if no price.",
    ),
  bedroomsMin: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      "Minimum bedrooms — ONLY when bedrooms are explicitly stated ('3-bedroom', " +
        "'3 Schlafzimmer'). Never derive from total room counts. null otherwise.",
    ),
  roomsMin: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      "Minimum total rooms (Swiss 'Zimmer' counting allows halves, e.g. '3.5 Zimmer' → 3.5). " +
        "null otherwise.",
    ),
  // --- One query text per retrieval engine ---------------------------------
  // Three engines score every listing, and each fails differently, so each gets
  // a text written for it rather than one string shared out. They are the SAME
  // wish encoded three ways: a lake view belongs in ALL of them — as prose in
  // dense, as `Seesicht` in sparse, as `lake view` in the caption. Do not
  // partition the user's cues between these; partition the PHRASING.
  denseVectorSearchText: z
    .string()
    .min(1)
    .describe(
      "MEANING query — the dense vector leg. ALWAYS write one. This encoder matches " +
        "MEANING, not words, and is multilingual: write ONE natural ENGLISH sentence and it " +
        "still matches German/French listings. Describe the property as a listing would " +
        "describe ITSELF, never as a request — no 'I am looking for', no 'show me'. Name what " +
        "it is and where it is, then how it should look and feel, folding in every cue the " +
        "user gave. e.g. 'Spacious 3.5-room duplex penthouse in Zürich with an open-plan " +
        "living room, a fireplace and views over the lake.'",
    )
    // A query for an encoder, not prose for a human — trim so the sentence is
    // exactly what gets embedded. Whitespace-only is repaired in parseIntent.
    .transform((v) => v.trim()),
  sparseVectorSearchText: z
    .string()
    .min(1)
    .describe(
      "EXACT-WORDS query — the sparse lexical leg. ALWAYS write one. This leg does NOT " +
        "expand: a term matches only if the listing LITERALLY contains it — 'garage' will " +
        "never match 'Einstellhalle'. So write the words a matching listing would ACTUALLY " +
        "contain, IN THE LISTING'S OWN LANGUAGE: German for CH/DE, French for Romandie/FR, " +
        "Italian for Ticino — infer it from location.country and the city. Bare " +
        "space-separated terms, NOT a sentence, no stop-words, no articles. Prefer rare and " +
        "distinctive over common: the property type, named features, standards and brands — " +
        "'Attikawohnung Seesicht Cheminée Minergie'. Never numbers, prices or areas: a " +
        "listing writes those in a form you cannot guess, so they can only miss. When the " +
        "user names nothing distinctive, fall back to the local-language words for the " +
        "property type and the town — 'Wohnung Zürich', 'appartement Genève'.",
    )
    // Terms for an encoder — trim so the query is exactly what gets embedded.
    // Whitespace-only is repaired in parseIntent.
    .transform((v) => v.trim()),
  imageSearchText: z
    .string()
    .min(1)
    .describe(
      "PHOTO-search query — the CLIP leg. ALWAYS write one; every search is matched against " +
        "listing PHOTOS, so this is never empty. Phrase it as a short ENGLISH caption of the " +
        "property the user wants to SEE: start from the property type ('apartment interior', " +
        "'single family house exterior') and append every appearance cue the user gave. Cues " +
        "to fold in: (a) any concrete OBJECT the property contains — furniture or fixture, " +
        "indoors or out (office chair, sofa, kitchen island, bathtub, fireplace, large " +
        "windows, pool, trees, balcony, garden); (b) any interior ROOM/space named with a " +
        "look/condition/size word — 'modern kitchen', 'renovated bathroom', 'open-plan living " +
        "room', 'big kitchen', 'luxury ensuite'; (c) the LOOK — colour, style, material, " +
        "light, mood (blue windows, modern, minimalist, rustic, exposed wooden beams, flower " +
        "garden); (d) the SETTING visible in a photo — views/surroundings (lake view, " +
        "mountain view, in the forest, waterfront, surrounded by vineyards). When the user " +
        "asks for nothing visual, fall back to the bare property type ('apartment interior'). " +
        "Never put price, room counts, city names or anything else a photo cannot show in " +
        "here — those are matched by the text legs and filtered structurally.",
    )
    // A caption, not a sentence — trim so the CLIP text encoder sees exactly the
    // phrase. A model that still returns whitespace is repaired in parseIntent.
    .transform((v) => v.trim()),
  displayChips: z
    .array(z.string())
    .default([])
    .describe(
      "Short human-readable labels of the notable EXTRA criteria in the query — " +
        "amenities (garden, pool, parking), appearance cues (lake view, modern kitchen), and " +
        "positional wishes (near the station) — for UI display ONLY. One or two words each, in " +
        "the user's wording. Do NOT include location, property type, price or room counts (those " +
        "already have their own chips). Purely cosmetic: not used for search or ranking. Empty " +
        "when there are none.",
    ),
  resultTarget: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe(
      "How many results the user asked for ('two homes', '5 Wohnungen' → 2, 5); " +
        "default 10 when unspecified.",
    ),
  retrievalWeights: retrievalWeightsSchema
    .default({})
    .describe(
      "How much each of the three search engines should count FOR THIS QUERY — the weight of " +
        "the text you wrote for it. `dense` scores denseVectorSearchText, `sparse` scores " +
        "sparseVectorSearchText, `image` scores imageSearchText. Weight them by what the query " +
        "actually leans on. A query mostly about how the place LOOKS ('bright loft with " +
        "exposed beams and a lake view') → image 0.4-0.6. One that is mostly hard facts " +
        "('3.5 Zimmer under CHF 2000 in Zürich near the station') → image 0.1-0.2, and the " +
        "look barely matters. Raise `sparse` only when you actually wrote distinctive terms " +
        "for it. Only ratios count, so do not try to make them sum to 1. Omit any you have no " +
        "opinion on; omit all three for a query with no clear lean.",
    ),
});

export type SearchIntent = z.infer<typeof searchIntentSchema>;
