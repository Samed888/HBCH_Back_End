/**
 * JWT authorization — AUDIT MODE
 *
 * Dual-database architecture: frontend authenticates against Lovable's
 * Supabase, edge functions run on production Supabase. Full cryptographic
 * validation isn't possible across projects.
 *
 * Current security model:
 *  - CORS lockdown (app.houstonbch.org only) = primary access control
 *  - JWT audit logging = visibility into who is calling
 *  - Token presence + expiry check = basic validation
 *
 * verifyJwt() returns user info when decodable, null otherwise.
 * Callers decide whether to block or just log.
 */

/** Decode base64url (JWT standard) to string */
function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return atob(base64);
}

export function verifyJwt(
  req: Request
): { id: string; email?: string } | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.warn("JWT audit: No Bearer token present");
    return null;
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      console.warn("JWT audit: Malformed token (not 3 parts)");
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(parts[1]));

    if (!payload.sub) {
      console.warn("JWT audit: No 'sub' claim");
      return null;
    }

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.warn(`JWT audit: Token expired at ${new Date(payload.exp * 1000).toISOString()}`);
      return null;
    }

    console.log(`JWT audit: Authorized user ${payload.email || payload.sub}`);
    return {
      id: payload.sub,
      email: payload.email || undefined,
    };
  } catch (err) {
    console.error("JWT audit: Decode failed:", err);
    return null;
  }
}

export function unauthorizedResponse(
  headers: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    {
      status: 401,
      headers: { ...headers, "Content-Type": "application/json" },
    }
  );
}
