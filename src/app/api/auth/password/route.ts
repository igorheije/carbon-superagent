import { hashPassword, verifyPassword } from "@/server/auth/password";
import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { findUserByEmail, updatePassword } from "@/server/repo/users";
import { changePasswordSchema } from "@/server/schemas";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const { current, next } = await parseBody(request, changePasswordSchema);
    const stored = findUserByEmail(user.email);
    if (!stored || !(await verifyPassword(current, stored.passwordHash))) throw new HttpError(400, "senha atual incorreta");
    updatePassword(user.id, await hashPassword(next));
    return ok({ changed: true });
  });
}
