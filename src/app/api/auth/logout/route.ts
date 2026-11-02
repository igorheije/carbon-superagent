import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { handle, SESSION_COOKIE } from "@/server/http";
import { deleteSession } from "@/server/repo/users";

export const dynamic = "force-dynamic";

export function POST() {
  return handle(async () => {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token) deleteSession(token);
    const response = NextResponse.json({ success: true, data: null, error: null });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  });
}
