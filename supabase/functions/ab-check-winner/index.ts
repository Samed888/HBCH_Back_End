const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, apikey, Authorization",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const TRACK_BASE = `${SUPABASE_URL}/functions/v1/email-track`;
const UNSUB_BASE = `${SUPABASE_URL}/functions/v1/email-unsubscribe`;

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1100;

// --- Supabase helpers ---

async function supabaseGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
  });
  return res.json();
}

async function supabasePatch(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

async function supabasePost(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
}

// --- Helpers ---

function extractCompanyName(contact: Record<string, unknown>): string {
  const companies = contact.companies as Record<string, unknown> | null;
  return (companies && companies.name) ? companies.name as string : (contact.company_name as string) || "";
}

function personalizeSubject(subject: string, recipient: Record<string, unknown>): string {
  const firstName = (recipient.first_name as string) || "";
  const lastName = (recipient.last_name as string) || "";
  const email = (recipient.email as string) || "";
  const companyName = extractCompanyName(recipient);

  return subject
    .replace(/{{first_name}}/gi, firstName)
    .replace(/{{last_name}}/gi, lastName)
    .replace(/{{email}}/gi, email)
    .replace(/{{full_name}}/gi, `${firstName} ${lastName}`.trim())
    .replace(/{{company_name}}/gi, companyName)
    .replace(/{{company}}/gi, companyName);
}

function personalize(html: string, recipient: Record<string, unknown>, trackingId: string, campaign?: Record<string, unknown>): string {
  const firstName = (recipient.first_name as string) || "";
  const lastName = (recipient.last_name as string) || "";
  const email = (recipient.email as string) || "";
  const companyName = extractCompanyName(recipient);

  const senderName = (campaign?.sender_name as string) || "Chris Skisak, PhD";
  const senderTitle = (campaign?.sender_title as string) || "Executive Director, HBCH";
  const previewText = (campaign?.preview_text as string) || "";
  const subject = (campaign?.subject as string) || "";

  let result = html
    .replace(/{{preview_text}}/gi, previewText)
    .replace(/{{subject}}/gi, subject)
    .replace(/{{sender_name}}/gi, senderName)
    .replace(/{{sender_title}}/gi, senderTitle)
    .replace(/{{first_name}}/gi, firstName)
    .replace(/{{last_name}}/gi, lastName)
    .replace(/{{email}}/gi, email)
    .replace(/{{full_name}}/gi, `${firstName} ${lastName}`.trim())
    .replace(/{{company_name}}/gi, companyName)
    .replace(/{{company}}/gi, companyName);

  const openPixel = `<img src="${TRACK_BASE}?type=open&tid=${trackingId}" width="1" height="1" style="display:none;" alt="" />`;
  if (result.includes("</body>")) {
    result = result.replace("</body>", `${openPixel}</body>`);
  } else {
    result += openPixel;
  }

  result = result.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
    if (url.includes("email-unsubscribe") || url.startsWith("mailto:")) return match;
    return `href="${TRACK_BASE}?type=click&tid=${trackingId}&url=${encodeURIComponent(url)}"`;
  });

  const unsubUrl = `${UNSUB_BASE}?tid=${trackingId}`;
  result = result.replace(/{{unsubscribe_url}}/gi, unsubUrl);

  if (!result.includes(unsubUrl)) {
    const footer = `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;text-align:center;font-size:12px;color:#999;">
        <p>Houston BCH &middot; Houston, TX</p>
        <p><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a></p></div>`;
    result = result.includes("</body>") ? result.replace("</body>", `${footer}</body>`) : result + footer;
  }

  return result;
}

async function sendEmail(to: string, from: string, subject: string, html: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const responseBody = await res.json();
    if (!res.ok) {
      console.error(`Resend error for ${to}: ${res.status}`, JSON.stringify(responseBody));
      return { success: false, error: responseBody.message || `Resend error ${res.status}` };
    }
    console.log(`Resend success for ${to}: id=${responseBody.id}`);
    return { success: true };
  } catch (err) {
    console.error(`Resend exception for ${to}:`, err.message);
    return { success: false, error: err.message || "Send failed" };
  }
}

// --- Main handler ---
// Can be called:
//   POST { campaign_id } — check specific campaign
//   POST { campaign_id, force_variant_id } — force a winner manually
//   POST {} — check all campaigns in ab_testing status (for cron)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { campaign_id, force_variant_id } = body;

    console.log("=== ab-check-winner invoked ===");

    // Find campaigns to check
    let campaignsToCheck: Array<Record<string, unknown>> = [];

    if (campaign_id) {
      const data = await supabaseGet(`email_campaigns?id=eq.${campaign_id}&select=*`);
      if (data && data.length > 0) campaignsToCheck = data;
    } else {
      // Check all campaigns in ab_testing status
      campaignsToCheck = await supabaseGet(`email_campaigns?ab_test_status=eq.testing&select=*`);
      if (!Array.isArray(campaignsToCheck)) campaignsToCheck = [];
    }

    console.log(`Found ${campaignsToCheck.length} campaigns to check`);

    const results = [];

    for (const campaign of campaignsToCheck) {
      const cid = campaign.id as string;
      const delayMinutes = (campaign.ab_winner_delay_minutes as number) || 60;

      // Check if enough time has passed (skip check if forcing)
      if (!force_variant_id) {
        const sentRecipients = await supabaseGet(
          `campaign_recipients?campaign_id=eq.${cid}&status=eq.sent&select=sent_at&order=sent_at.asc&limit=1`
        );
        if (sentRecipients && sentRecipients.length > 0) {
          const firstSentAt = new Date(sentRecipients[0].sent_at as string);
          const elapsed = (Date.now() - firstSentAt.getTime()) / 60000;
          if (elapsed < delayMinutes) {
            console.log(`Campaign "${campaign.name}": ${Math.round(elapsed)}/${delayMinutes} minutes elapsed, skipping`);
            results.push({ campaign_id: cid, name: campaign.name, status: "waiting", minutes_elapsed: Math.round(elapsed), minutes_required: delayMinutes });
            continue;
          }
        }
      }

      // Get variants and count opens
      const variants = await supabaseGet(
        `campaign_ab_variants?campaign_id=eq.${cid}&select=*&order=variant_label.asc`
      );

      if (!variants || variants.length === 0) {
        console.log(`Campaign "${campaign.name}": no variants found`);
        continue;
      }

      // Count opens per variant
      const variantStats = [];
      for (const variant of variants) {
        const openedData = await supabaseGet(
          `campaign_recipients?campaign_id=eq.${cid}&variant_id=eq.${variant.id}&opened_at=not.is.null&select=id`
        );
        const openCount = (openedData && Array.isArray(openedData)) ? openedData.length : 0;
        const sentCount = (variant.total_sent as number) || (variant.total_recipients as number) || 1;
        const openRate = sentCount > 0 ? (openCount / sentCount) * 100 : 0;

        variantStats.push({
          variant_id: variant.id,
          label: variant.variant_label,
          subject: variant.subject_line,
          sent: sentCount,
          opened: openCount,
          open_rate: openRate,
        });

        // Update opened count on variant
        await supabasePatch(`campaign_ab_variants?id=eq.${variant.id}`, { total_opened: openCount });

        console.log(`  Variant ${variant.variant_label}: ${openCount}/${sentCount} opens (${openRate.toFixed(1)}%)`);
      }

      // Determine winner
      let winnerId = force_variant_id;
      if (!winnerId) {
        const sorted = [...variantStats].sort((a, b) => b.open_rate - a.open_rate);
        winnerId = sorted[0].variant_id;
      }

      const winnerVariant = variants.find((v: Record<string, unknown>) => v.id === winnerId);
      const winnerSubject = (winnerVariant?.subject_line as string) || (campaign.subject as string) || "";

      console.log(`Winner: Variant ${winnerVariant?.variant_label} — "${winnerSubject}"`);

      // Mark winner
      await supabasePatch(`campaign_ab_variants?id=eq.${winnerId}`, { is_winner: true });
      await supabasePatch(`email_campaigns?id=eq.${cid}`, { ab_winner_variant_id: winnerId, ab_test_status: "sending_winner" });

      // Get remainder recipients (pending_winner)
      const remainderRecipients: Array<Record<string, unknown>> = [];
      let offset = 0;
      while (true) {
        const batch = await supabaseGet(
          `campaign_recipients?campaign_id=eq.${cid}&status=eq.pending_winner&select=id,email,first_name,last_name,tracking_id&offset=${offset}&limit=1000`
        );
        if (!batch || batch.length === 0) break;
        remainderRecipients.push(...batch);
        offset += 1000;
        if (batch.length < 1000) break;
      }

      console.log(`Sending winner subject to ${remainderRecipients.length} remainder recipients`);

      // Update remainder recipients with winner variant_id and status to pending
      for (let i = 0; i < remainderRecipients.length; i += 500) {
        const ids = remainderRecipients.slice(i, i + 500).map(r => r.id);
        for (const id of ids) {
          await supabasePatch(`campaign_recipients?id=eq.${id}`, {
            variant_id: winnerId,
            status: "pending",
          });
        }
      }

      // Re-fetch with updated status to send
      const toSend: Array<Record<string, unknown>> = [];
      offset = 0;
      while (true) {
        const batch = await supabaseGet(
          `campaign_recipients?campaign_id=eq.${cid}&status=eq.pending&select=id,email,first_name,last_name,tracking_id,variant_id&offset=${offset}&limit=1000`
        );
        if (!batch || batch.length === 0) break;
        toSend.push(...batch);
        offset += 1000;
        if (batch.length < 1000) break;
      }

      // Build contact lookup for company names
      const emails = toSend.map(r => (r.email as string).toLowerCase().trim());
      const contactLookup = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < emails.length; i += 50) {
        const batch = emails.slice(i, i + 50);
        const data = await supabaseGet(
          `contacts?select=id,email,first_name,last_name,companies(name)&email=in.(${batch.join(",")})`
        );
        if (data && Array.isArray(data)) {
          for (const c of data) contactLookup.set((c.email as string).toLowerCase().trim(), c);
        }
      }

      // Build variant lookup
      const variantLookup = new Map<string, Record<string, unknown>>();
      for (const v of variants) variantLookup.set(v.id as string, v);

      // Send to remainder
      let totalSent = 0;
      let totalFailed = 0;
      const fromAddress = `${campaign.from_name} <${campaign.from_email}>`;

      for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
        const batch = toSend.slice(i, i + BATCH_SIZE);

        const promises = batch.map(async (recipient) => {
          const email = (recipient.email as string).toLowerCase().trim();
          const contactData = contactLookup.get(email);
          const enrichedRecipient = { ...recipient, companies: contactData?.companies || null };

          const html = personalize(
            (campaign.html_body as string) || "",
            enrichedRecipient,
            recipient.tracking_id as string,
            campaign
          );

          const personalizedSubject = personalizeSubject(winnerSubject, enrichedRecipient);

          const result = await sendEmail(recipient.email as string, fromAddress, personalizedSubject, html);

          if (result.success) {
            await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, { status: "sent", sent_at: new Date().toISOString() });
            totalSent++;
          } else {
            await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, { status: "failed" });
            totalFailed++;
          }
        });

        await Promise.all(promises);
        if (i + BATCH_SIZE < toSend.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      // Update campaign
      const prevSent = (campaign.total_sent as number) || 0;
      await supabasePatch(`email_campaigns?id=eq.${cid}`, {
        status: "sent",
        ab_test_status: "completed",
        sent_at: new Date().toISOString(),
        total_sent: prevSent + totalSent,
      });

      console.log(`Campaign "${campaign.name}" A/B test completed. Winner: ${winnerVariant?.variant_label}. Remainder sent: ${totalSent}, failed: ${totalFailed}`);

      results.push({
        campaign_id: cid,
        name: campaign.name,
        status: "completed",
        winner: { label: winnerVariant?.variant_label, subject: winnerSubject },
        variant_stats: variantStats,
        remainder_sent: totalSent,
        remainder_failed: totalFailed,
      });
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("ab-check-winner error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
