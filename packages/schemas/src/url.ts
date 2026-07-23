/**
 * URL canonicalization for cache keys, dedup sets and stable storage ids.
 *
 * A URL's scheme and host are case-insensitive (RFC 3986), and a fragment is
 * never sent to the server, so `http://www.Example.COM/a/` and
 * `https`-vs-`http` aside `http://www.example.com/a` identify the same resource.
 * Hashing the raw string instead fragments the cache and mints duplicate rows
 * for the same listing. This collapses those variants to one canonical form.
 *
 * SCOPE: use the result as a KEY or ID, not as the URL to FETCH — it strips the
 * query string, which some sites need to resolve the page. Returns `null` for a
 * non-http(s) or unparseable input so callers can fall back to the raw string.
 */
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
