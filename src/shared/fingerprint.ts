/**
 * SHA-256 certificate fingerprints used to pin the panel's self-signed listener certificate
 * (`carbon join <ip>:<porta>` without a domain or a public CA).
 *
 * Canonical form: 64 lowercase hex chars, no separators. Accepted input: with or without `:`,
 * any case, optional `sha256:`/`SHA256 ` prefix (what `openssl x509 -fingerprint -sha256` and
 * Node's `fingerprint256` print).
 */

const HEX64 = /^[0-9a-f]{64}$/;

/** Canonical fingerprint, or null when `raw` is not a SHA-256 fingerprint. */
export function normalizeFingerprint(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^sha-?256(\s+fingerprint)?\s*[:= ]\s*/, "")
    .replace(/[:\s]/g, "");
  return HEX64.test(cleaned) ? cleaned : null;
}

/** `AB:CD:…` (what browsers and openssl show), for humans comparing by eye. */
export function formatFingerprint(canonical: string): string {
  return canonical.toUpperCase().match(/.{2}/g)?.join(":") ?? canonical;
}
