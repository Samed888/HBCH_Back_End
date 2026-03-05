import { getCorsHeaders } from "../_shared/cors.ts";

/**
 * Verify a Cloudflare Turnstile token server-side.
 *
 * Frontend sends the turnstile token before completing registration.
 * This function verifies it with Cloudflare and returns success/failure.
 *
 * Setup:
 *  1. Add TURNSTILE_SECRET_KEY to Supabase edge function secrets
 *  2. Frontend includes Turnstile widget on registration page
 *  3. Frontend calls this function with the token before calling create-registration
 */

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const { token, remoteip } = await req.json();

    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing turnstile token" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const secretKey = Deno.env.get("TURNSTILE_SECRET_KEY");
    if (!secretKey) {
      console.error("TURNSTILE_SECRET_KEY not configured");
      // Fail open in case key isn't set yet — don't block registrations
      return new Response(
        JSON.stringify({ success: true, warning: "Turnstile not configured" }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Verify with Cloudflare
    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token);
    if (remoteip) {
      formData.append("remoteip", remoteip);
    }

    const verifyRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString(),
      }
    );

    const result = await verifyRes.json();

    if (result.success) {
      console.log("Turnstile verification passed");
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    } else {
      console.warn("Turnstile verification failed:", result["error-codes"]);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Verification failed",
          codes: result["error-codes"],
        }),
        { status: 403, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return new Response(
      JSON.stringify({ error: "Verification failed" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
