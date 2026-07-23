import type { IncomingHttpHeaders } from "http";

export function toWebHeaders(src: IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [key, value] of Object.entries(src)) {
    if (Array.isArray(value)) {
      for (const v of value) h.append(key, v);
    } else if (value !== undefined) {
      h.set(key, String(value));
    }
  }
  return h;
}
