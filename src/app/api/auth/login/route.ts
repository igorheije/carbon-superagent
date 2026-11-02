import { NextResponse } from "next/server";
import { verifyPassword } from "@/server/auth/password";
import { clearFailures, isRateLimited, recordFailure } from "@/server/auth/rate-limit";
import { handle, HttpError, parseBody, sessionCookie } from "@/server/http";
import { createSession, findUserByEmail } from "@/server/repo/users";
import { loginSchema } from "@/server/schemas";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handle(async () => {
    const { email, password } = await parseBody(request, loginSchema);
    if (isRateLimited(email)) throw new HttpError(429, "muitas tentativas; aguarde 15 minutos");

    const user = findUserByEmail(email);
    const isValid = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !isValid) {
      recordFailure(email);
      throw new HttpError(401, "e-mail ou senha incorretos");
    }
    clearFailures(email);
    const session = createSession(user.id);
    const publicUser = { id: user.id, email: user.email, name: user.name, persona: user.persona, role: user.role, mustChangePassword: user.mustChangePassword };
    const response = NextResponse.json({ success: true, data: { user: publicUser }, error: null });
    response.cookies.set(sessionCookie(session.token, session.expiresAt));
    return response;
  });
}
