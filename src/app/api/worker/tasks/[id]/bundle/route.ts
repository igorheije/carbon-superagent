import { createReadStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { requireWorker } from "@/server/auth/worker-auth";
import { handle, HttpError, ok } from "@/server/http";
import { buildBaseBundle, leaseOwnedBy, maxBundleBytes, receiveBundle } from "@/server/runner/remote-delivery";
import { LEASE_LOST } from "@/shared/worker-protocol";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Git bundle of the task's starting point, for workers that cannot clone from a remote. Lease owner only. */
export function GET(request: Request, { params }: Params) {
  return handle(async () => {
    const worker = requireWorker(request);
    const { id } = await params;
    if (!leaseOwnedBy(id, worker.id)) throw new HttpError(409, LEASE_LOST);
    const bundle = await buildBaseBundle(id);
    if ("error" in bundle) throw new HttpError(422, bundle.error);
    const stream = createReadStream(bundle.file);
    stream.once("close", () => rmSync(bundle.file, { force: true }));
    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-carbon-base-ref": bundle.ref },
    });
  });
}

/** Upload of the worker's result bundle (raw octet-stream), capped at settings.workers.maxBundleMb. Lease owner only. */
export function PUT(request: Request, { params }: Params) {
  return handle(async () => {
    const worker = requireWorker(request);
    const { id } = await params;
    if (!leaseOwnedBy(id, worker.id)) throw new HttpError(409, LEASE_LOST);
    const max = maxBundleBytes();
    const tooLarge = () => new HttpError(413, `resultado maior que ${Math.round(max / (1024 * 1024))} MB`);
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > max) throw tooLarge();
    const received = await receiveBundle(id, request.body, max);
    if (!received.ok) throw received.reason === "too_large" ? tooLarge() : new HttpError(400, "bundle vazio");
    return ok({ bytes: received.bytes });
  });
}
