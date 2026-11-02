import { generatePassword, hashPassword } from "@/server/auth/password";
import { handle, HttpError, ok, parseBody, requireAdmin } from "@/server/http";
import { createUser, findUserByEmail, listUsers } from "@/server/repo/users";
import { newUserSchema } from "@/server/schemas";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    await requireAdmin();
    return ok({ users: listUsers() });
  });
}

/** Admin invites a teammate. The temporary password is returned once and never stored in clear. */
export function POST(request: Request) {
  return handle(async () => {
    await requireAdmin();
    const input = await parseBody(request, newUserSchema);
    if (findUserByEmail(input.email)) throw new HttpError(409, "e-mail já cadastrado");
    const temporaryPassword = generatePassword();
    const user = createUser({ ...input, passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true });
    return ok({ user, temporaryPassword }, 201);
  });
}
