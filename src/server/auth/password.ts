import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
export const MIN_PASSWORD_LENGTH = 10;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, SCRYPT_PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$<salt b64>$<hash b64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await derive(password, Buffer.from(saltB64, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Readable one-time password for invited users (shown once to the admin). */
export function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions are stored hashed so a leaked DB does not leak live sessions. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
