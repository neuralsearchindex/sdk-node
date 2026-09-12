import type { z } from "zod";

import { type FailDetail, toFailDetail } from "./issues.js";

/** The result of a validating parse: the ad, or the reason it was rejected. */
export type ParseResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; detail: FailDetail };

/**
 * Build the `{ parse, parseSafe }` pair every domain descriptor exposes, so the
 * boolean-ish `parse` is literally a lossy wrapper around the detailed one rather
 * than a second call site that discards `error.issues` independently.
 */
export function zodParser(schema: z.ZodTypeAny): {
  parse(raw: unknown): Record<string, unknown> | null;
  parseSafe(raw: unknown, scrapedId?: string): ParseResult;
} {
  function parseSafe(raw: unknown, scrapedId?: string): ParseResult {
    const result = schema.safeParse(raw);
    if (result.success) return { ok: true, data: result.data as Record<string, unknown> };
    return { ok: false, detail: toFailDetail(result.error, scrapedId, raw) };
  }

  return {
    parseSafe,
    parse(raw: unknown): Record<string, unknown> | null {
      const result = parseSafe(raw);
      return result.ok ? result.data : null;
    },
  };
}
