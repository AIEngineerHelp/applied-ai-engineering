// Gives every browser an anonymous workspace: a random, HTTP-only cookie that
// owns the reports it creates. No sign-in yet; a user id would replace it.
import { NextResponse, type NextRequest } from "next/server";
import { WORKSPACE_COOKIE } from "@/lib/workspace-cookie";

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (!request.cookies.get(WORKSPACE_COOKIE)?.value) {
    const id = crypto.randomUUID().replace(/-/g, "");
    // Also visible to this request's server code, not just the next one.
    request.cookies.set(WORKSPACE_COOKIE, id);
    const next = NextResponse.next({ request });
    next.cookies.set(WORKSPACE_COOKIE, id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 400,
    });
    return next;
  }
  return response;
}

export const config = {
  // Skip static files, images and Workflow's internal routes.
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/|.*\\.(?:svg|png|jpg|ico|webp)$).*)" }],
};
