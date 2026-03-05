import { corsHeaders } from "../_shared/cors-public.ts";
import { rateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CONFIRM_PAGE = "https://app.houstonbch.org/unsubscribe-confirm";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // --- RATE LIMITING: 30 requests per minute per IP ---
  const clientIp = getClientIp(req);
  if (!rateLimit(clientIp, 30, 60_000)) {
    console.warn(`Rate limited unsubscribe: ${clientIp}`);
    return Response.redirect(CONFIRM_PAGE, 302);
  }

  try {
    const url = new URL(req.url);
    const trackingId = url.searchParams.get("tid");
    if (!trackingId) {
      return Response.redirect(CONFIRM_PAGE, 302);
    }

    const lookupRes = await fetch(
      SUPABASE_URL + "/rest/v1/campaign_recipients?tracking_id=eq." + trackingId + "&select=id,email,campaign_id",
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    const recipients = await lookupRes.json();

    if (recipients && recipients.length > 0) {
      const recipient = recipients[0];

      await fetch(SUPABASE_URL + "/rest/v1/email_unsubscribes", {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json",
          Prefer: "return=minimal,resolution=ignore-duplicates",
        },
        body: JSON.stringify({
          email: recipient.email,
          reason: "link_click",
          campaign_id: recipient.campaign_id,
        }),
      });

      await fetch(
        SUPABASE_URL + "/rest/v1/campaign_recipients?id=eq." + recipient.id,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            unsubscribed_at: new Date().toISOString(),
          }),
        }
      );

      console.log("Unsubscribed: " + recipient.email + " (tid: " + trackingId + ")");
    }

    return Response.redirect(CONFIRM_PAGE, 302);
  } catch (err) {
    console.error("Unsubscribe error:", err);
    return Response.redirect(CONFIRM_PAGE, 302);
  }
});
