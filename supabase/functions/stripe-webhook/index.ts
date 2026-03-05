import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const event = body;

    // Handle payment_intent.succeeded
    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const piId = paymentIntent.id;

      // Update all registrations with this payment intent to "paid"
      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/event_registrations?stripe_payment_intent_id=eq.${piId}`,
        {
          method: "PATCH",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
          },
          body: JSON.stringify({ payment_status: "paid" }),
        }
      );

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        console.error("Failed to update registrations:", errText);
        return new Response(JSON.stringify({ error: "Update failed" }), { status: 500 });
      }

      const updated = await updateRes.json();
      console.log(`Updated ${updated.length} registrations to paid for PI: ${piId}`);
    }

    // Handle payment_intent.payment_failed
    if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object;
      const piId = paymentIntent.id;

      await fetch(
        `${SUPABASE_URL}/rest/v1/event_registrations?stripe_payment_intent_id=eq.${piId}`,
        {
          method: "PATCH",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ payment_status: "failed" }),
        }
      );
      console.log(`Marked registrations as failed for PI: ${piId}`);
    }

    // Handle charge.refunded
    if (event.type === "charge.refunded") {
      const charge = event.data.object;
      const piId = charge.payment_intent;

      if (piId) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/event_registrations?stripe_payment_intent_id=eq.${piId}`,
          {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ payment_status: "refunded" }),
          }
        );
        console.log(`Marked registrations as refunded for PI: ${piId}`);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
