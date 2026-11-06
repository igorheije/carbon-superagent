import "server-only";
import type { z } from "zod";
import { HttpError } from "@/server/http";
import { MAX_JSON_BODY_BYTES } from "@/shared/worker-protocol";

/** Reads the request body as UTF-8, failing with 413 as soon as it passes `maxBytes`. */
async function readLimited(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "corpo da requisição grande demais");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "corpo da requisição grande demais");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * JSON body for /api/worker/*: size-capped (1 MB), parsed and validated with the shared protocol
 * schema. An empty body is treated as `{}`.
 */
export async function readWorkerJson<S extends z.ZodTypeAny>(request: Request, schema: S, maxBytes = MAX_JSON_BODY_BYTES): Promise<z.infer<S>> {
  const text = await readLimited(request, maxBytes);
  let raw: unknown;
  try {
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "inválido"}`);
  }
  return parsed.data;
}
