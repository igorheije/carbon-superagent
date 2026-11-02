import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { activeProjectFor, type Project } from "./repo/projects";
import { findUserById, userForSession, type User } from "./repo/users";

export const SESSION_COOKIE = "carbon_session";

export interface ApiBody<T> {
  readonly success: boolean;
  readonly data: T | null;
  readonly error: string | null;
}

export function ok<T>(data: T, status = 200): NextResponse<ApiBody<T>> {
  return NextResponse.json({ success: true, data, error: null }, { status });
}

export function fail(error: string, status: number): NextResponse<ApiBody<never>> {
  return NextResponse.json({ success: false, data: null, error }, { status });
}

/** Thrown by guards/parsers; converted to a JSON response by `handle`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function parseBody<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
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

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? userForSession(token) : null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "não autenticado");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") throw new HttpError(403, "apenas administradores");
  return findUserById(user.id) ?? user;
}

/** Wraps a route handler: HttpError → JSON status; anything else → logged 500 without leaking internals. */
export async function handle<T>(fn: () => Promise<NextResponse<T>>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) return fail(error.message, error.status);
    process.stderr.write(`[carbon] unhandled route error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return fail("erro interno", 500);
  }
}

export function sessionCookie(token: string, expiresAt: number) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.CARBON_SECURE_COOKIES === "true",
    path: "/",
    expires: new Date(expiresAt),
  };
}

/** The signed-in user's active project; 400 when no project exists yet. */
export async function requireActiveProject(): Promise<{ readonly user: User; readonly project: Project }> {
  const user = await requireUser();
  const project = activeProjectFor(user.id);
  if (!project) throw new HttpError(400, "crie um projeto primeiro (Configurações → Projetos)");
  return { user, project };
}
