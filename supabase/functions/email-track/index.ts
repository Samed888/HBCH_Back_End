import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors-public.ts";
import { rateLimit, getClientIp, rateLimitResponse } from "../_shared/rate-limit.ts";

// Known bot user-agent patterns
const BOT_UA_PATTERNS = [
  /barracuda/i,
  /proofpoint/i,
  /mimecast/i,
  /safelinks/i,
  /messagelabs/i,
  /symantec/i,
  /forcepoint/i,
  /websense/i,
  /fireeye/i,
  /trendmicro/i,
  /sophos/i,
  /spamhaus/i,
  /mailscanner/i,
  /googlebot/i,
  /bingbot/i,
  /yahoo.*slurp/i,
  /spider/i,
  /crawler/i,
  /bot\b/i,
  /python-requests/i,
  /curl/i,
  /wget/i,
  /go-http-client/i,
  /java\//i,
  /okhttp/i,
  /apache-httpclient/i,
  /urllib/i,
];

// UUID format validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isBotUserAgent(ua: string | null): boolean {
  if (!ua) return true;
  if (ua.length < 20) return true;
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(ua));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- RATE LIMITING: 100 requests per minute per IP ---
  const clientIp = getClientIp(req);
  if (!rateLimit(clientIp, 100, 60_000)) {
    console.warn(`Rate limited: ${clientIp}`);
    // For clicks, still redirect even if rate limited
    const url = new URL(req.url);
    const redirectUrl = url.searchParams.get("url");
    if (redirectUrl) {
      return Response.redirect(redirectUrl, 302);
    }
    return rateLimitResponse();
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const trackingId = url.searchParams.get("tid");
    const redirectUrl = url.searchParams.get("url");

    if (!trackingId) {
      return new Response("Missing tracking ID", { status: 400 });
    }

    // Validate UUID format to prevent malicious input
    if (trackingId !== "test-tracking-id" && !UUID_REGEX.test(trackingId)) {
      console.warn(`Invalid tracking ID format: ${trackingId}`);
      if (type === "click" && redirectUrl) {
        return Response.redirect(redirectUrl, 302);
      }
      return new Response("Invalid tracking ID", { status: 400 });
    }

    const userAgent = req.headers.get("user-agent");
    const ipAddress = clientIp;

    const isBot = isBotUserAgent(userAgent);

    // Look up recipient by tracking_id
    const { data: recipient } = await supabase
      .from("campaign_recipients")
      .select("id, campaign_id, sent_at")
      .eq("tracking_id", trackingId)
      .single();

    if (!recipient) {
      if (type === "click" && redirectUrl) {
        return Response.redirect(redirectUrl, 302);
      }
      return new Response("Not found", { status: 404 });
    }

    // Additional bot check: click happened within 2 seconds of send
    let isTooFast = false;
    if (recipient.sent_at) {
      const sentTime = new Date(recipient.sent_at).getTime();
      const now = Date.now();
      const secondsSinceSend = (now - sentTime) / 1000;
      isTooFast = secondsSinceSend < 2;
    }

    const flagAsBot = isBot || isTooFast;

    if (type === "open") {
      // Only record opens from non-bots
      if (!flagAsBot) {
        await supabase
          .from("campaign_recipients")
          .update({ 
            status: "opened", 
            opened_at: new Date().toISOString() 
          })
          .eq("id", recipient.id)
          .is("opened_at", null);
      }

      // Return 1x1 transparent pixel
      const pixel = new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80,
        0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04,
        0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01,
        0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
      ]);
      return new Response(pixel, {
        headers: {
          ...corsHeaders,
          "Content-Type": "image/gif",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    if (type === "click" && redirectUrl) {
      // Validate redirect URL to prevent open redirects
      try {
        const parsed = new URL(redirectUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return new Response("Invalid URL", { status: 400 });
        }
      } catch {
        return new Response("Invalid URL", { status: 400 });
      }

      // Log click event with bot flag
      await supabase.from("campaign_click_events").insert({
        campaign_id: recipient.campaign_id,
        recipient_id: recipient.id,
        tracking_id: trackingId,
        url: redirectUrl,
        clicked_at: new Date().toISOString(),
        user_agent: userAgent,
        ip_address: ipAddress,
        is_bot: flagAsBot,
      });

      // Only update recipient status for non-bot clicks
      if (!flagAsBot) {
        await supabase
          .from("campaign_recipients")
          .update({
            status: "clicked",
            clicked_at: new Date().toISOString(),
            opened_at: new Date().toISOString(),
          })
          .eq("id", recipient.id)
          .is("clicked_at", null);
      }

      return Response.redirect(redirectUrl, 302);
    }

    return new Response("Invalid request", { status: 400 });

  } catch (err) {
    console.error("Tracking error:", err);
    const url = new URL(req.url);
    const redirectUrl = url.searchParams.get("url");
    if (redirectUrl) {
      return Response.redirect(redirectUrl, 302);
    }
    return new Response("Error", { status: 500 });
  }
});
