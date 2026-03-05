// resend-webhook — Supabase Edge Function
// Receives Resend delivery events and updates campaign analytics.
//
// Environment variables required:
//   RESEND_WEBHOOK_SECRET   — from Resend dashboard → Webhooks → Signing secret
//   SUPABASE_URL            — auto-set by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-set by Supabase
//
// Deploy with --no-verify-jwt (public endpoint, auth via HMAC)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET");

// Known email client / bot user agents — clicks from these are filtered
const BOT_UA_PATTERNS = [
  /googleimageproxy/i,
  /yahoo.*mail/i,
  /outlook/i,
  /apple.*mail/i,
  /thunderbird/i,
  /postmaster/i,
  /previewer/i,
  /bot/i,
  /crawler/i,
  /spider/i,
  /scan/i,
  /preview/i,
];

function isBotUserAgent(ua: string | null): boolean {
  if (!ua) return false;
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(ua));
}

// --- HMAC signature verification ---

function base64ToUint8Array(base64: string): Uint8Array {
  // Pure JS base64 decode — no atob, handles URL-safe and standard
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // Normalize: URL-safe to standard, strip padding
  const s = base64.replace(/-/g, "+").replace(/_/g, "/").replace(/=/g, "");
  const bytes: number[] = [];
  let buf = 0, bits = 0;
  for (const c of s) {
    const val = chars.indexOf(c);
    if (val === -1) continue;
    buf = (buf << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function verifySignature(secret: string, body: string, svixId: string, svixTimestamp: string, svixSignature: string): Promise<boolean> {
  try {
    const signedContent = `${svixId}.${svixTimestamp}.${body}`;
    const b64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    console.log(`verifySignature: b64 length=${b64.length} first10=${b64.slice(0, 10)}`);
    const secretBytes = base64ToUint8Array(b64);
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
    const computedBase64 = uint8ArrayToBase64(new Uint8Array(sig));
    const signatures = svixSignature.split(" ");
    return signatures.some((s) => {
      const sigValue = s.includes(",") ? s.split(",")[1] : s;
      return sigValue === computedBase64;
    });
  } catch (e) {
    console.error("verifySignature error:", e);
    return false;
  }
}

async function supabaseGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  return res.json();
}

async function supabasePatch(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
}

async function supabasePost(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
}

// --- Look up recipient by tracking_id tag ---

async function getRecipientByTrackingId(trackingId: string): Promise<Record<string, unknown> | null> {
  const data = await supabaseGet(
    `campaign_recipients?tracking_id=eq.${trackingId}&select=id,campaign_id,contact_id,email,opened_at,clicked_at&limit=1`
  );
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

// --- Event handlers ---

async function handleDelivered(event: Record<string, unknown>, trackingId: string) {
  const recipient = await getRecipientByTrackingId(trackingId);
  if (!recipient) {
    console.warn(`delivered: no recipient found for tracking_id=${trackingId}`);
    return;
  }

  await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, {
    status: "delivered",
  });

  // Log to campaign_delivery_events
  await supabasePost("campaign_delivery_events", {
    campaign_id: recipient.campaign_id,
    recipient_id: recipient.id,
    tracking_id: trackingId,
    event_type: "delivered",
    email: recipient.email,
    occurred_at: event.created_at || new Date().toISOString(),
  });

  console.log(`delivered: recipient=${recipient.id}`);
}

async function handleBounced(event: Record<string, unknown>, trackingId: string) {
  const recipient = await getRecipientByTrackingId(trackingId);
  if (!recipient) {
    console.warn(`bounced: no recipient found for tracking_id=${trackingId}`);
    return;
  }

  const email = (recipient.email as string).toLowerCase().trim();
  const bounceType = (event.data as Record<string, unknown>)?.bounce_type as string || "hard";

  await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, {
    status: "bounced",
    bounced_at: new Date().toISOString(),
  });

  // Log to campaign_delivery_events
  await supabasePost("campaign_delivery_events", {
    campaign_id: recipient.campaign_id,
    recipient_id: recipient.id,
    tracking_id: trackingId,
    event_type: "bounced",
    email,
    metadata: JSON.stringify({ bounce_type: bounceType }),
    occurred_at: event.created_at || new Date().toISOString(),
  });

  // Add hard bounces to suppression list
  if (bounceType === "hard") {
    await supabasePost("email_suppressions", {
      email,
      reason: "bounce",
      source: "resend_webhook",
      created_at: new Date().toISOString(),
    });
    console.log(`bounced (hard): added ${email} to suppressions`);
  } else {
    console.log(`bounced (soft): recipient=${recipient.id}`);
  }
}

async function handleComplained(event: Record<string, unknown>, trackingId: string) {
  const recipient = await getRecipientByTrackingId(trackingId);
  if (!recipient) {
    console.warn(`complained: no recipient found for tracking_id=${trackingId}`);
    return;
  }

  const email = (recipient.email as string).toLowerCase().trim();

  await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, {
    status: "complained",
  });

  // Log to campaign_delivery_events
  await supabasePost("campaign_delivery_events", {
    campaign_id: recipient.campaign_id,
    recipient_id: recipient.id,
    tracking_id: trackingId,
    event_type: "complained",
    email,
    occurred_at: event.created_at || new Date().toISOString(),
  });

  // Add to suppression list
  await supabasePost("email_suppressions", {
    email,
    reason: "complaint",
    source: "resend_webhook",
    created_at: new Date().toISOString(),
  });

  // Add to unsubscribes
  await supabasePost("email_unsubscribes", {
    email,
    source: "spam_complaint",
    created_at: new Date().toISOString(),
  });

  console.log(`complained: added ${email} to suppressions + unsubscribes`);
}

async function handleOpened(event: Record<string, unknown>, trackingId: string) {
  const recipient = await getRecipientByTrackingId(trackingId);
  if (!recipient) {
    console.warn(`opened: no recipient found for tracking_id=${trackingId}`);
    return;
  }

  // Only count as unique open if not already opened (webhook-based)
  const isFirstOpen = !recipient.opened_at;

  if (isFirstOpen) {
    await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, {
      opened_at: new Date().toISOString(),
    });

    // Increment unique open count on campaign
    const campaigns = await supabaseGet(
      `email_campaigns?id=eq.${recipient.campaign_id}&select=open_count`
    );
    if (campaigns && campaigns[0]) {
      const currentCount = (campaigns[0].open_count as number) || 0;
      await supabasePatch(`email_campaigns?id=eq.${recipient.campaign_id}`, {
        open_count: currentCount + 1,
      });
    }

    console.log(`opened (unique): recipient=${recipient.id}`);
  } else {
    console.log(`opened (repeat, not counted): recipient=${recipient.id}`);
  }
}

async function handleClicked(event: Record<string, unknown>, trackingId: string, userAgent: string | null) {
  // Filter bot clicks
  if (isBotUserAgent(userAgent)) {
    console.log(`clicked: filtered bot UA="${userAgent}"`);
    return;
  }

  const recipient = await getRecipientByTrackingId(trackingId);
  if (!recipient) {
    console.warn(`clicked: no recipient found for tracking_id=${trackingId}`);
    return;
  }

  const data = event.data as Record<string, unknown> || {};
  const url = (data.click?.link as string) || "";
  const isFirstClick = !recipient.clicked_at;

  // Always log individual click
  await supabasePost("campaign_click_events", {
    campaign_id: recipient.campaign_id,
    recipient_id: recipient.id,
    tracking_id: trackingId,
    url,
    clicked_at: new Date().toISOString(),
  });

  // Update recipient clicked_at on first click only
  if (isFirstClick) {
    await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, {
      clicked_at: new Date().toISOString(),
    });
  }

  // Increment total click count always; unique click count only on first click
  const campaigns = await supabaseGet(
    `email_campaigns?id=eq.${recipient.campaign_id}&select=click_count,unique_click_count`
  );
  if (campaigns && campaigns[0]) {
    const updates: Record<string, number> = {
      click_count: ((campaigns[0].click_count as number) || 0) + 1,
    };
    if (isFirstClick) {
      updates.unique_click_count = ((campaigns[0].unique_click_count as number) || 0) + 1;
    }
    await supabasePatch(`email_campaigns?id=eq.${recipient.campaign_id}`, updates);
  }

  console.log(`clicked: recipient=${recipient.id} url=${url} unique=${isFirstClick}`);
}

// --- Main handler ---

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();

  // HMAC verification
  if (WEBHOOK_SECRET) {
    const svixId = req.headers.get("svix-id") || "";
    const svixTimestamp = req.headers.get("svix-timestamp") || "";
    const svixSignature = req.headers.get("svix-signature") || "";

    if (!svixId || !svixTimestamp || !svixSignature) {
      console.warn("resend-webhook: missing svix headers");
      return new Response("Unauthorized", { status: 401 });
    }

    const ts = parseInt(svixTimestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    const ageSecs = now - ts;
    if (ageSecs > 300) {
      console.warn(`resend-webhook: timestamp too old (${ageSecs}s)`);
      return new Response("Unauthorized", { status: 401 });
    }

    const valid = await verifySignature(WEBHOOK_SECRET, rawBody, svixId, svixTimestamp, svixSignature);
    if (!valid) {
      console.warn("resend-webhook: invalid signature");
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    console.warn("resend-webhook: RESEND_WEBHOOK_SECRET not set — skipping verification");
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType = event.type as string;
  const data = (event.data || {}) as Record<string, unknown>;

  // Extract tracking_id from Resend tags
  const tags = (data.tags || []) as Array<{ name: string; value: string }>;
  const trackingIdTag = tags.find((t) => t.name === "tracking_id");
  const trackingId = trackingIdTag?.value;

  if (!trackingId || trackingId === "test-tracking-id") {
    console.log(`resend-webhook: skipping event type=${eventType} (no valid tracking_id)`);
    return new Response("OK", { status: 200 });
  }

  const userAgent = req.headers.get("user-agent");

  console.log(`resend-webhook: type=${eventType} tracking_id=${trackingId}`);

  try {
    switch (eventType) {
      case "email.delivered":
        await handleDelivered(event, trackingId);
        break;
      case "email.bounced":
        await handleBounced(event, trackingId);
        break;
      case "email.complained":
        await handleComplained(event, trackingId);
        break;
      case "email.opened":
        await handleOpened(event, trackingId);
        break;
      case "email.clicked":
        await handleClicked(event, trackingId, userAgent);
        break;
      default:
        console.log(`resend-webhook: unhandled event type=${eventType}`);
    }
  } catch (err) {
    console.error(`resend-webhook: error handling ${eventType}:`, err);
    // Return 200 to prevent Resend from retrying — log the error instead
    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
});
