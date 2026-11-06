import { NextResponse } from "next/server";
import { handle, HttpError, requireAdmin } from "@/server/http";
import { getSettings } from "@/server/repo/settings";
import { InvalidKitOptions, renderAgentCore, type KitFiles } from "@/server/setup-kit/agentcore";
import { renderKitArchive } from "@/server/setup-kit/archive";

export const dynamic = "force-dynamic";

const FOLDER = "carbon-agentcore";

/**
 * AgentCore kit (experimental) as `.tar.gz`. Holds no token: each AgentCore session gets a
 * one-time task token at dispatch. Uses the saved region and public panel URL (placeholder when unset).
 */
export function GET() {
  return handle(async () => {
    await requireAdmin();
    const settings = getSettings();
    let files: KitFiles;
    try {
      files = renderAgentCore({ region: settings.agentcore.region, panelUrl: settings.panelPublicUrl || undefined });
    } catch (error) {
      if (error instanceof InvalidKitOptions) throw new HttpError(400, error.message);
      throw error;
    }
    const prefixed = Object.fromEntries(Object.entries(files).map(([file, body]) => [`${FOLDER}/${file}`, body]));
    const archive = renderKitArchive(prefixed);
    return new NextResponse(new Uint8Array(archive), {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${FOLDER}.tar.gz"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
