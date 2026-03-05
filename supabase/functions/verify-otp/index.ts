import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, code } = await req.json();
    if (!email || !code) {
      return new Response(JSON.stringify({ error: "Email and code required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const normalizedEmail = email.toLowerCase();

    // Find valid OTP
    const { data: otp, error: otpError } = await supabase
      .from("otp_codes")
      .select("*")
      .eq("email", normalizedEmail)
      .eq("code", code)
      .eq("verified", false)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (otpError || !otp) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired code" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mark OTP as verified
    await supabase.from("otp_codes").update({ verified: true }).eq("id", otp.id);

    // Look up contact
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, email, contact_type, status")
      .eq("email", normalizedEmail)
      .limit(1)
      .single();

    // Look up company via contact_company_roles
    let company = null;
    if (contact) {
      const { data: role } = await supabase
        .from("contact_company_roles")
        .select("company_id, role, is_primary")
        .eq("contact_id", contact.id)
        .eq("is_primary", true)
        .limit(1)
        .single();

      if (role) {
        const { data: co } = await supabase
          .from("companies")
          .select("id, name, company_type")
          .eq("id", role.company_id)
          .single();
        company = co;
      }
    }

    // Determine registration profile
    const profile = {
      verified: true,
      email: normalizedEmail,
      contact_id: contact?.id || null,
      first_name: contact?.first_name || null,
      last_name: contact?.last_name || null,
      contact_type: contact?.contact_type || "general",  // member, prospect, vendor, contact, general
      company_id: company?.id || null,
      company_name: company?.name || null,
      company_type: company?.company_type || null,        // business, nonprofit
      is_member: contact?.contact_type === "member",
    };

    return new Response(JSON.stringify(profile), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("verify-otp error:", err);
    return new Response(JSON.stringify({ error: "Verification failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
