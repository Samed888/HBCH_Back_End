import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { isValidUuid } from "../_shared/validate.ts";

serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const { event_id, contact_type, company_type } = await req.json();

    // --- INPUT VALIDATION ---
    if (!event_id) {
      return new Response(
        JSON.stringify({ error: "event_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (!isValidUuid(event_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid event_id format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get all active pricing for this event
    const { data: allPricing, error } = await supabase
      .from("event_pricing")
      .select("*")
      .eq("event_id", event_id)
      .eq("is_active", true)
      .order("sort_order");

    if (error) throw error;

    const ct = contact_type || "general";
    const cot = company_type || null;

    // Filter to only eligible tiers
    const eligible = (allPricing || []).filter((tier) => {
      if (!tier.eligible_contact_types.includes(ct)) return false;
      if (tier.eligible_company_types && tier.eligible_company_types.length > 0) {
        if (!cot || !tier.eligible_company_types.includes(cot)) return false;
      }
      return true;
    });

    // Check remaining capacity for each tier
    const tiersWithCapacity = await Promise.all(
      eligible.map(async (tier) => {
        let remaining = null;
        if (tier.capacity) {
          const { count } = await supabase
            .from("event_registrations")
            .select("*", { count: "exact", head: true })
            .eq("event_id", event_id)
            .eq("pricing_id", tier.id)
            .neq("payment_status", "refunded");
          remaining = tier.capacity - (count || 0);
        }
        return {
          id: tier.id,
          registration_type: tier.registration_type,
          label: tier.label,
          price_cents: tier.price_cents,
          capacity: tier.capacity,
          remaining,
          sold_out: remaining !== null && remaining <= 0,
        };
      })
    );

    return new Response(JSON.stringify({ pricing: tiersWithCapacity }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    // --- SANITIZED ERROR (no stack traces) ---
    console.error("get-event-pricing error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to get pricing" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
