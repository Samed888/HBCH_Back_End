/**
 * Simple in-memory IP-based rate limiter for edge functions.
 *
 * Limits reset when the edge function cold-starts, so this is
 * defense-in-depth rather than a hard guarantee. For the HBCH
 * traffic volume, this is more than sufficient.
 */

const requestCounts = new Map<string, { count: number; resetAt: number }>();

/**
 * Check if a request from this IP should be allowed.
 * @param ip - Client IP address
 * @param maxRequests - Max requests per window (default: 100)
 * @param windowMs - Window duration in ms (default: 60000 = 1 minute)
 * @returns true if allowed, false if rate limited
 */
export function rateLimit(
  ip: string,
  maxRequests = 100,
  windowMs = 60_000
): boolean {
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  entry.count++;
  if (entry.count > maxRequests) {
    return false;
  }

  return true;
}

/**
 * Get client IP from request headers.
 */
export function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function rateLimitResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests" }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
