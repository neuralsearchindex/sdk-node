import { createHmac } from "node:crypto";

export interface ImgproxyOptions {
  width?: number;
  height?: number;
  resize?: "fit" | "fill" | "fill-down" | "force" | "auto";
  gravity?: string;
  quality?: number;
  enlarge?: boolean;
  /** Output format, e.g. "webp", "jpg", "avif". */
  extension?: string;
  /** Embed source as a plain absolute URL (/plain/<url>) instead of base64url. Default: false. */
  plain?: boolean;
}

export interface ImgproxySignerConfig {
  /** Endpoint (varnish front), e.g. http://imgproxy:8080. */
  baseUrl: string;
  /** Hex-encoded IMGPROXY_KEY. Empty ⇒ unsigned (/insecure/…). */
  key?: string;
  /** Hex-encoded IMGPROXY_SALT. Empty ⇒ unsigned (/insecure/…). */
  salt?: string;
  /** IMGPROXY_SIGNATURE_SIZE, default 32. */
  signatureSize?: number;
}

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function buildProcessingPath(sourceUrl: string, opts: ImgproxyOptions): string {
  const segs: string[] = [];
  if (opts.resize || opts.width != null || opts.height != null) {
    segs.push(`rs:${opts.resize ?? "fit"}:${opts.width ?? 0}:${opts.height ?? 0}:${opts.enlarge ? 1 : 0}`);
  }
  if (opts.gravity) segs.push(`g:${opts.gravity}`);
  if (opts.quality != null) segs.push(`q:${opts.quality}`);

  const optionsPart = segs.length ? `${segs.join("/")}/` : "";

  if (opts.plain) {
    // Plain/absolute source: /plain/<url>, format suffixed with @ext (not .ext).
    // imgproxy requires the plain URL percent-encoded; at minimum escape the chars
    // that break its parsing (% first, then ? and @).
    const escaped = sourceUrl.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/@/g, "%40");
    const ext = opts.extension ? `@${opts.extension}` : "";
    return `/${optionsPart}plain/${escaped}${ext}`;
  }

  const encoded = base64Url(Buffer.from(sourceUrl, "utf8"));
  const ext = opts.extension ? `.${opts.extension}` : "";
  return `/${optionsPart}${encoded}${ext}`;
}

/**
 * Build an imgproxy URL. If key+salt are set, signs it —
 * sig = base64url(HMAC-SHA256(key, salt || path))[:signatureSize], where `path` is the
 * processing-options + source portion (key/salt are hex bytes). If either is empty,
 * emits the unsigned `/insecure/…` form (imgproxy accepts it only when no key+salt are
 * configured on the server).
 */
export function imgproxyUrl(
  cfg: ImgproxySignerConfig,
  sourceUrl: string,
  opts: ImgproxyOptions = {},
): string {
  const path = buildProcessingPath(sourceUrl, opts);
  const base = cfg.baseUrl.replace(/\/$/, "");

  const keyBytes = Buffer.from(cfg.key ?? "", "hex");
  const saltBytes = Buffer.from(cfg.salt ?? "", "hex");
  if (keyBytes.length === 0 || saltBytes.length === 0) {
    return `${base}/insecure${path}`;
  }

  const hmac = createHmac("sha256", keyBytes);
  hmac.update(saltBytes);
  hmac.update(path);
  const sig = base64Url(hmac.digest().subarray(0, cfg.signatureSize ?? 32));
  return `${base}/${sig}${path}`;
}
