import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "carbon_session";
const PUBLIC_PAGES = ["/login", "/setup"];
const PUBLIC_API = ["/api/setup/", "/api/auth/login"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cheap edge gate: cookie presence + same-origin for mutations.
 * Real session validation happens in every route handler (requireUser).
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isApi && !SAFE_METHODS.has(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) {
      return NextResponse.json({ success: false, data: null, error: "origem não permitida" }, { status: 403 });
    }
  }

  const isPublic = PUBLIC_PAGES.includes(pathname) || PUBLIC_API.some((p) => pathname.startsWith(p));
  if (isPublic || request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  if (isApi) return NextResponse.json({ success: false, data: null, error: "não autenticado" }, { status: 401 });
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
