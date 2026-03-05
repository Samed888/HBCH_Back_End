import { isValidUuid } from "../_shared/validate.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

const ALLOWED_ORIGINS = [
  "https://app.houstonbch.org",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const origin = req.headers.get("origin") || "";
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn(`create-registration-checkout: blocked origin=${origin}`);
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const body = await req.json();
    const {
      event_id,
      pricing_id,
      registrants,
      email,
      first_name,
      last_name,
      contact_id,
      company_id,
    } = body;

    // --- INPUT VALIDATION ---
    if (!event_id || !pricing_id) {
      return new Response(
        JSON.stringify({ error: "event_id and pricing_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (!isValidUuid(event_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid event_id format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (!isValidUuid(pricing_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid pricing_id format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (contact_id && !isValidUuid(contact_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid contact_id format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (company_id && !isValidUuid(company_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid company_id format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const people =
      registrants && registrants.length > 0
        ? registrants
        : [{ email, first_name, last_name, contact_id, company_id }];

    if (!people.length || !people[0].email) {
      return new Response(
        JSON.stringify({ error: "At least one registrant with email is required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Validate UUIDs inside registrants array
    for (const p of people) {
      if (p.contact_id && !isValidUuid(p.contact_id)) {
        return new Response(
          JSON.stringify({ error: "Invalid contact_id in registrants" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
      if (p.company_id && !isValidUuid(p.company_id)) {
        return new Response(
          JSON.stringify({ error: "Invalid company_id in registrants" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // --- GET PRICING TIER ---
    const tierRes = await fetch(
      `${SUPABASE_URL}/rest/v1/event_pricing?id=eq.${pricing_id}&event_id=eq.${event_id}&is_active=eq.true&select=*`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const tiers = await tierRes.json();
    const tier = tiers[0];
    if (!tier) {
      return new Response(
        JSON.stringify({ error: "Invalid or inactive pricing tier" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // --- CHECK CAPACITY ---
    if (tier.capacity) {
      const countRes = await fetch(
        `${SUPABASE_URL}/rest/v1/event_registrations?event_id=eq.${event_id}&pricing_id=eq.${pricing_id}&payment_status=neq.refunded&select=id`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: "count=exact",
          },
          method: "HEAD",
        }
      );
      const range = countRes.headers.get("content-range") || "0/0";
      const count = parseInt(range.split("/")[1] || "0");
      if (count + people.length > tier.capacity) {
        return new Response(
          JSON.stringify({
            error: `Only ${tier.capacity - count} spot(s) remaining`,
          }),
          { status: 409, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    // --- CHECK PER-CONTACT LIMITS ---
    const limitsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/registration_limits?event_id=eq.${event_id}&select=*`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const limits = await limitsRes.json();

    for (const person of people) {
      for (const limit of limits) {
        if (limit.limit_type === "per_contact") {
          const cRes = await fetch(
            `${SUPABASE_URL}/rest/v1/event_registrations?event_id=eq.${event_id}&email=eq.${encodeURIComponent(
              person.email.toLowerCase()
            )}&payment_status=neq.refunded&select=id`,
            {
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                Prefer: "count=exact",
              },
              method: "HEAD",
            }
          );
          const r = cRes.headers.get("content-range") || "0/0";
          const c = parseInt(r.split("/")[1] || "0");
          if (c >= limit.max_count) {
            return new Response(
              JSON.stringify({
                error: `${person.email} is already registered for this event`,
              }),
              { status: 409, headers: { ...cors, "Content-Type": "application/json" } }
            );
          }
        }
      }
    }

    // --- STRIPE PAYMENT INTENT ---
    const totalCents = tier.price_cents * people.length;
    let paymentIntentId: string | null = null;
    let clientSecret: string | null = null;

    if (totalCents > 0) {
      const piRes = await fetch("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STRIPE_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          amount: String(totalCents),
          currency: "usd",
          "metadata[event_id]": event_id,
          "metadata[pricing_id]": pricing_id,
          "metadata[primary_email]": people[0].email.toLowerCase(),
          "metadata[num_registrants]": String(people.length),
        }),
      });

      if (!piRes.ok) {
        // --- SANITIZED: log detail server-side only ---
        const errText = await piRes.text();
        console.error("Stripe error:", errText);
        return new Response(
          JSON.stringify({ error: "Payment setup failed" }),
          { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      const pi = await piRes.json();
      paymentIntentId = pi.id;
      clientSecret = pi.client_secret;
    }

    // --- INSERT REGISTRATIONS ---
    const records = people.map((p: any) => ({
      event_id,
      contact_id: p.contact_id || null,
      company_id: p.company_id || null,
      pricing_id,
      registration_type: tier.registration_type,
      email: p.email.toLowerCase(),
      first_name: p.first_name,
      last_name: p.last_name,
      amount_cents: tier.price_cents,
      payment_status: totalCents === 0 ? "paid" : "pending",
      stripe_payment_intent_id: paymentIntentId,
    }));

    const insertRes = await fetch(
      `${SUPABASE_URL}/rest/v1/event_registrations`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(records),
      }
    );

    if (!insertRes.ok) {
      // --- SANITIZED: log detail server-side only ---
      const errText = await insertRes.text();
      console.error("Insert error:", errText);
      return new Response(
        JSON.stringify({ error: "Failed to create registrations" }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const registrations = await insertRes.json();

    return new Response(
      JSON.stringify({
        registration_ids: registrations.map((r: any) => r.id),
        num_registrants: people.length,
        price_per_person: tier.price_cents,
        total_cents: totalCents,
        client_secret: clientSecret,
        payment_status: totalCents === 0 ? "paid" : "pending",
      }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    // --- SANITIZED ERROR (no stack traces leaked) ---
    console.error("create-registration error:", err);
    return new Response(
      JSON.stringify({ error: "Registration failed" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
