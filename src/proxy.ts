import { NextResponse, type NextRequest } from "next/server";
import { adminConfig } from "@/server/admin-config";
import { adminSession } from "@/server/auth";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/status") return NextResponse.next();
  if (!adminConfig()) return NextResponse.next();
  const signedIn = adminSession(request);
  const login = request.nextUrl.pathname === "/login";
  if (login === signedIn) {
    const target = new URL(signedIn ? "/" : "/login", process.env.NODEGUARD_ORIGIN ?? request.nextUrl.origin);
    return NextResponse.redirect(target);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico$|[^/]+\\.svg$).*)"],
};
