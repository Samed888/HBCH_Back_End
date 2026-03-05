// Hardened CORS — restricted to app.houstonbch.org (replaces wildcard *)
const ALLOWED_ORIGINS = [
  "https://app.houstonbch.org",
  // Uncomment for local development:
  // "http://localhost:3000",
  // "http://localhost:5173",
];

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
    ...(isAllowed ? { "Access-Control-Allow-Credentials": "true" } : {}),
  };
}

// Legacy export for backward compatibility with functions that
// destructure `corsHeaders` directly. Points to production origin.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "https://app.houstonbch.org",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};
