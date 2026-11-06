import { gzipSync } from "node:zlib";
import type { KitFiles } from "./worker-kit";

/**
 * Packs a setup kit as `.tar.gz` with node built-ins only: a minimal POSIX ustar writer
 * (regular files, no links) + zlib gzip. Files that hold secrets (`.env`, `secret.yaml`) get mode
 * 0600, everything else 0644. Entries are sorted so the archive is deterministic for a given mtime.
 */

const BLOCK = 512;
const NAME_LENGTH = 100;
const PREFIX_LENGTH = 155;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SECRET_FILES = new Set([".env", "secret.yaml"]);
/** Relative path segments of printable ASCII without `\`; no empty, `.` or `..` segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export interface ArchiveOptions {
  /** Modification time (seconds since epoch) for every entry. Default: now. */
  readonly mtimeSeconds?: number;
}

function assertSafePath(filePath: string): void {
  const segments = filePath.split("/");
  const ok = segments.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..");
  if (!ok) throw new Error(`caminho inválido no kit: ${JSON.stringify(filePath)}`);
}

/** Splits a path into ustar `prefix` + `name` (name ≤ 100 bytes, prefix ≤ 155 bytes). */
function splitName(filePath: string): { readonly name: string; readonly prefix: string } {
  if (filePath.length <= NAME_LENGTH) return { name: filePath, prefix: "" };
  for (let at = filePath.indexOf("/"); at !== -1; at = filePath.indexOf("/", at + 1)) {
    const prefix = filePath.slice(0, at);
    const name = filePath.slice(at + 1);
    if (prefix.length <= PREFIX_LENGTH && name.length <= NAME_LENGTH) return { name, prefix };
  }
  throw new Error(`caminho longo demais para tar: ${filePath}`);
}

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

function header(filePath: string, size: number, mode: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(filePath);
  block.write(name, 0, NAME_LENGTH, "ascii");
  block.write(octal(mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii"); // uid
  block.write(octal(0, 8), 116, 8, "ascii"); // gid
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(mtime, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii"); // checksum placeholder: 8 spaces
  block.write("0", 156, 1, "ascii"); // regular file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write("carbon", 265, 32, "ascii"); // uname
  block.write("carbon", 297, 32, "ascii"); // gname
  block.write(prefix, 345, PREFIX_LENGTH, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** Uncompressed ustar archive of `files` (exported for tests). */
export function renderTar(files: KitFiles, options: ArchiveOptions = {}): Buffer {
  const mtime = Math.max(0, Math.floor(options.mtimeSeconds ?? Date.now() / 1000));
  const parts: Buffer[] = [];
  for (const filePath of Object.keys(files).sort()) {
    assertSafePath(filePath);
    const data = Buffer.from(files[filePath], "utf8");
    if (data.length > MAX_FILE_BYTES) throw new Error(`arquivo grande demais no kit: ${filePath}`);
    const base = filePath.split("/").pop() ?? filePath;
    const mode = SECRET_FILES.has(base) ? 0o600 : 0o644;
    parts.push(header(filePath, data.length, mode, mtime), data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive marker
  return Buffer.concat(parts);
}

/** `.tar.gz` of `files`, ready to be served as `application/gzip`. */
export function renderKitArchive(files: KitFiles, options: ArchiveOptions = {}): Buffer {
  return gzipSync(renderTar(files, options));
}
