const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function supabaseGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("=== check-scheduled invoked ===");
    const now = new Date().toISOString();

    // Find campaigns that are scheduled and due
    const campaigns = await supabaseGet(
      `email_campaigns?status=eq.scheduled&scheduled_at=lte.${now}&select=id,name,scheduled_at`
    );

    if (!campaigns || !Array.isArray(campaigns) || campaigns.length === 0) {
      console.log("No scheduled campaigns due to send");
      return new Response(
        JSON.stringify({ success: true, message: "No campaigns due", checked_at: now }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${campaigns.length} campaign(s) due to send`);

    const results = [];

    for (const campaign of campaigns) {
      console.log(`Triggering send for "${campaign.name}" (scheduled for ${campaign.scheduled_at})`);

      // Mark as sending to prevent double-trigger
      await supabasePatch(`email_campaigns?id=eq.${campaign.id}`, {
        scheduled_status: "triggered",
      });

      // Call send-campaign edge function
      try {
        const sendRes = await fetch(`${SUPABASE_URL}/functions/v1/send-campaign`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify({ campaign_id: campaign.id }),
        });

        const sendResult = await sendRes.json();

        if (sendRes.ok && sendResult.success) {
          console.log(`Campaign "${campaign.name}" send triggered successfully`);
          await supabasePatch(`email_campaigns?id=eq.${campaign.id}`, {
            scheduled_status: "completed",
          });
          results.push({ campaign_id: campaign.id, name: campaign.name, status: "sent", result: sendResult });
        } else {
          console.error(`Campaign "${campaign.name}" send failed:`, JSON.stringify(sendResult));
          await supabasePatch(`email_campaigns?id=eq.${campaign.id}`, {
            scheduled_status: "failed",
          });
          results.push({ campaign_id: campaign.id, name: campaign.name, status: "failed", error: sendResult.error });
        }
      } catch (err) {
        console.error(`Campaign "${campaign.name}" trigger error:`, err.message);
        await supabasePatch(`email_campaigns?id=eq.${campaign.id}`, {
          scheduled_status: "failed",
        });
        results.push({ campaign_id: campaign.id, name: campaign.name, status: "error", error: err.message });
      }
    }

    return new Response(
      JSON.stringify({ success: true, checked_at: now, campaigns_processed: results.length, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("check-scheduled error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
