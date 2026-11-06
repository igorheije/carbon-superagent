import type { TLSSocket } from "node:tls";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { normalizeFingerprint } from "../shared/fingerprint";
import type { FetchLike } from "./client";

/**
 * fetch that talks only to the panel whose certificate has the pinned SHA-256 fingerprint
 * (CARBON_PANEL_FINGERPRINT). Used for `carbon join <ip>:<porta>`: the listener's certificate is
 * self-signed and the address is a bare IP, so neither a CA nor the hostname can be checked.
 *
 * The check runs right after the TLS handshake, before undici writes the request: a server with
 * another certificate never sees the worker token. Session resumption is off so every connection
 * presents the full certificate.
 */

export class PinMismatchError extends Error {
  constructor(readonly expected: string, readonly received: string | null) {
    super(
      received
        ? "o certificado do painel não confere com CARBON_PANEL_FINGERPRINT (painel trocou de certificado ou não é o seu painel)"
        : "o painel não apresentou certificado TLS",
    );
    this.name = "PinMismatchError";
  }
}

const CONNECT_TIMEOUT_MS = 15_000;

/** The peer's fingerprint (canonical form), or null. */
export function peerFingerprint(socket: TLSSocket): string | null {
  return normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
}

export function createPinnedFetch(fingerprint: string): FetchLike {
  const expected = normalizeFingerprint(fingerprint);
  if (!expected) throw new Error("CARBON_PANEL_FINGERPRINT inválido");
  // Trust comes from the pin, not from a CA (the certificate is self-signed by design).
  const base = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0, timeout: CONNECT_TIMEOUT_MS });
  const connect: buildConnector.connector = (options, callback) => {
    if (options.protocol !== "https:") {
      callback(new Error("com CARBON_PANEL_FINGERPRINT o painel precisa ser https"), null);
      return;
    }
    base(options, (error, socket) => {
      if (error || !socket) {
        callback(error ?? new Error("falha ao conectar"), null);
        return;
      }
      const received = peerFingerprint(socket as TLSSocket);
      if (received !== expected) {
        socket.destroy();
        callback(new PinMismatchError(expected, received), null);
        return;
      }
      callback(null, socket);
    });
  };
  const dispatcher = new Agent({ connect });
  return (input, init) => undiciFetch(input, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher }) as unknown as Promise<Response>;
}
