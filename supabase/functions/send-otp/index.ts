import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email } = await req.json();
    if (!email || !email.includes("@")) {
      return new Response(JSON.stringify({ error: "Valid email required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Invalidate any existing codes for this email
    await supabase
      .from("otp_codes")
      .delete()
      .eq("email", email.toLowerCase());

    // Store new code
    const { error: insertError } = await supabase.from("otp_codes").insert({
      email: email.toLowerCase(),
      code,
      expires_at,
    });

    if (insertError) throw insertError;

    // Send email via Resend
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (resendKey) {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Houston BCH <noreply@houstonbch.org>",
          to: [email],
          subject: "Your verification code",
          html: `
            <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #333;">Verification Code</h2>
              <p>Your code for Houston BCH registration is:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; 
                          padding: 20px; background: #f5f5f5; border-radius: 8px; margin: 20px 0;">
                ${code}
              </div>
              <p style="color: #666; font-size: 14px;">This code expires in 10 minutes.</p>
            </div>
          `,
        }),
      });

      if (!emailRes.ok) {
        const errBody = await emailRes.text();
        console.error("Resend error:", errBody);
        // Don't fail — code is stored, user can retry
      }
    } else {
      console.warn("RESEND_API_KEY not set — OTP stored but not emailed. Code:", code);
    }

    return new Response(
      JSON.stringify({ success: true, message: "Verification code sent" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("send-otp error:", err);
    return new Response(JSON.stringify({ error: "Failed to send code" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
