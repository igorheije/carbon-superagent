import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "carbon_session";
const PUBLIC_PAGES = ["/login", "/setup"];
/** Webhooks have no session: each route verifies the sender's signature or shared secret. */
const PUBLIC_API = ["/api/setup/", "/api/auth/login", "/api/webhooks/"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Machine-to-machine API for remote workers: no cookie and no browser Origin. Every handler under
 * this prefix authenticates with requireWorker() (Bearer token). Note the trailing slash: the admin
 * routes under /api/workers stay behind the session cookie.
 */
const WORKER_API = "/api/worker/";

/**
 * Cheap edge gate: cookie presence + same-origin for mutations.
 * Real session validation happens in every route handler (requireUser).
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  if (pathname.startsWith(WORKER_API)) return NextResponse.next();

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
