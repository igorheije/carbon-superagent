import { handle, HttpError, ok, requireAdmin } from "@/server/http";
import { deleteSessionsForUser, deleteUser, findUserById, listUsers } from "@/server/repo/users";

export const dynamic = "force-dynamic";

export function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    if (id === admin.id) throw new HttpError(400, "você não pode remover a si mesmo");
    const target = findUserById(id);
    if (!target) throw new HttpError(404, "usuário não encontrado");
    if (target.role === "admin" && listUsers().filter((u) => u.role === "admin").length <= 1) {
      throw new HttpError(400, "precisa existir ao menos um admin");
    }
    deleteSessionsForUser(id);
    deleteUser(id);
    return ok({ deleted: true });
  });
}
