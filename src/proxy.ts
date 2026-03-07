import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// 1. AI & Suggestions
const aiLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit_ai",
});

// 2. Critical Auth (Sign-up, Verify, Password Resets)
const authLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"),
  prefix: "ratelimit_auth",
});

// 3. Messaging (Send, Delete, Toggle Accept)
const messageLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit_message",
});

// 4. Data Fetching (Get Messages, Username Check)
const dataLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "1 m"),
  prefix: "ratelimit_data",
});

export default async function middleware(request: NextRequest) {
  const url = request.nextUrl;
  const pathname = url.pathname;

  const ip = 
    request.headers.get("x-real-ip") || 
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() || 
    "127.0.0.1";

  // --- 1. TARGETED API MONITORING ---
  // We exclude standard NextAuth system routes to avoid breaking logins
  const isNextAuthInternal = pathname.startsWith('/api/auth/session') || 
                             pathname.startsWith('/api/auth/callback') || 
                             pathname.startsWith('/api/auth/csrf');

  if (pathname.startsWith('/api') && !isNextAuthInternal) {
    let limitResult;

    // A. AI & Suggestions
    if (pathname.startsWith("/api/suggest-messages") || pathname.startsWith("/api/huggingface")) {
      limitResult = await aiLimiter.limit(ip);
    } 
    // B. Auth & Account Security
    else if (
      pathname.startsWith("/api/sign-up") || 
      pathname.startsWith("/api/auth/forgot-password") ||
      pathname.startsWith("/api/auth/reset-password") ||
      pathname.startsWith("/api/auth/change-password") ||
      pathname.startsWith("/api/verify-code") ||
      pathname.startsWith("/api/auth/delete-account")
    ) {
      limitResult = await authLimiter.limit(ip);
    } 
    // C. Messaging Actions
    else if (
      pathname.startsWith("/api/send-message") || 
      pathname.startsWith("/api/delete-message") || 
      pathname.startsWith("/api/delete-all-messages") ||
      pathname.startsWith("/api/accept-messages")
    ) {
      limitResult = await messageLimiter.limit(ip);
    } 
    // D. General Data Retrieval
    else {
      limitResult = await dataLimiter.limit(ip);
    }

    if (limitResult && !limitResult.success) {
      const now = Date.now();
      const retryAfter = Math.max(1, Math.floor((limitResult.reset - now) / 1000));

      return NextResponse.json(
        { 
          success: false, 
          message: `Too many requests. Please try again in ${retryAfter} seconds.`, 
          retryAfter 
        },
        { 
          status: 429, 
          headers: { "Retry-After": retryAfter.toString() } 
        }
      );
    }
  }

  // --- 2. AUTHENTICATION LOGIC ---
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  const isAuthPage = ["/sign-in", "/sign-up", "/verify"].some(path => pathname.startsWith(path));
  const isProtectedRoute = pathname.startsWith("/dashboard") || pathname.startsWith("/settings");

  if (token && isAuthPage) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (!token && isProtectedRoute) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.webp$|sitemap\\.xml$|robots\\.txt$).*)'],
};