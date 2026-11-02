import { handle, ok, requireAdmin } from "@/server/http";
import { deleteRule } from "@/server/permissions/rules";

export const dynamic = "force-dynamic";

export function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireAdmin();
    deleteRule((await params).id);
    return ok({ deleted: true });
  });
}
