import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const globalLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(50, "10 s"),
  prefix: "ratelimit_global",
});

const aiLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit_ai",
});

const authLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit_auth",
});

const messageLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"),
  prefix: "ratelimit_message",
});

export default async function middleware(request: NextRequest) {
  const url = request.nextUrl;
  const pathname = url.pathname;
  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "127.0.0.1";

  // --- 1. HARD BYPASS ---
  if (
    pathname.startsWith('/_next') ||
    pathname.includes('/api/auth') ||
    pathname.match(/\.(xml|txt|webp|ico|png|jpg|jpeg|svg|css|js)$/) ||
    ['/terms', '/privacy-policy', '/faq', '/about'].includes(pathname)
  ) {
    return NextResponse.next();
  }

  // --- 2. DYNAMIC RATE LIMITING ---
  let limitResult;
  if (pathname.startsWith("/api/huggingface")) {
    limitResult = await aiLimiter.limit(ip);
  } else if (pathname.startsWith("/api/sign-in") || pathname.startsWith("/api/sign-up")) {
    limitResult = await authLimiter.limit(ip);
  } else if (pathname.startsWith("/api/send-message")) {
    limitResult = await messageLimiter.limit(ip);
  } else {
    limitResult = await globalLimiter.limit(ip);
  }

  if (!limitResult.success) {
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

  // --- 3. AUTHENTICATION LOGIC ---
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
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.webp$|sitemap\\.xml$|robots\\.txt$).*)'],
};