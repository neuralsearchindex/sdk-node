// NOTE: engine copy, differs from ../schemas/url — the SDK's `schemas/url` is a
// pure type re-export shim (no `canonicalizeUrl`), whereas the ingest path needs
// the real URL canonicalizer the engine uses to derive stable listing ids.
// Ported verbatim from engine `search/shared/schemas/url.ts`.

export function canonicalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}
