/**
 * Returns the first language tag from an Accept-Language header value.
 * Example: "de-CH,en;q=0.9" → "de-CH"
 */
export function primaryAcceptLanguage(header: string | undefined): string | undefined {
  if (header == null || !String(header).trim()) return undefined;
  const first = String(header).split(",")[0]?.trim();
  if (!first) return undefined;
  const tag = first.split(";")[0]?.trim();
  return tag || undefined;
}
