import { getCorsHeaders } from "../_shared/cors.ts";
import { verifyJwt } from "../_shared/jwt-verify.ts";
import { isValidUuid } from "../_shared/validate.ts";

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

async function supabasePost(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
}

// --- Extract company name from PostgREST joined result ---

function extractCompanyName(contact: Record<string, unknown>): string {
  const companies = contact.companies as Record<string, unknown> | null;
  if (companies && companies.name) {
    return companies.name as string;
  }
  return (contact.company_name as string) || "";
}

// --- Personalize subject line ---

function personalizeSubject(subject: string, recipient: Record<string, unknown>, campaign?: Record<string, unknown>): string {
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

// --- Email personalization (body) ---

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
    .replace(/{{sender_title}}/gi, senderTitle);

  result = result
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

  result = result.replace(
    /href="(https?:\/\/[^"]+)"/gi,
    (match, url) => {
      if (url.includes("email-unsubscribe") || url.startsWith("mailto:")) return match;
      const tracked = `${TRACK_BASE}?type=click&tid=${trackingId}&url=${encodeURIComponent(url)}`;
      return `href="${tracked}"`;
    }
  );

  const unsubUrl = `${UNSUB_BASE}?tid=${trackingId}`;
  result = result.replace(/{{unsubscribe_url}}/gi, unsubUrl);

  if (!result.includes(unsubUrl)) {
    const footer = `
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;text-align:center;font-size:12px;color:#999;">
        <p>Houston BCH &middot; Houston, TX</p>
        <p><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a></p>
      </div>`;
    if (result.includes("</body>")) {
      result = result.replace("</body>", `${footer}</body>`);
    } else {
      result += footer;
    }
  }

  return result;
}

// --- Build recipient list from segment filter ---

async function buildRecipientList(filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const companySegment = filter.company_segment as string | undefined;
  const needsCompanyFilter = !!companySegment && companySegment !== "all_contacts";

  const joinType = needsCompanyFilter ? "companies!inner" : "companies";
  let query = `contacts?select=id,email,first_name,last_name,contact_type,contact_status,${joinType}(name,member_type,membership_status)`;
  const conditions: string[] = [];

  if (filter.contact_type && Array.isArray(filter.contact_type) && filter.contact_type.length > 0) {
    conditions.push(`contact_type=in.(${filter.contact_type.join(",")})`);
  }
  if (filter.contact_status && Array.isArray(filter.contact_status) && filter.contact_status.length > 0) {
    conditions.push(`contact_status=in.(${filter.contact_status.join(",")})`);
  }
  if (filter.status && Array.isArray(filter.status) && filter.status.length > 0) {
    conditions.push(`status=in.(${filter.status.join(",")})`);
  }

  if (needsCompanyFilter) {
    switch (companySegment) {
      case "employer_member":
        conditions.push("companies.member_type=eq.employer");
        conditions.push("companies.membership_status=eq.active");
        break;
      case "associate_member":
        conditions.push("companies.member_type=eq.associate");
        conditions.push("companies.membership_status=eq.active");
        break;
      case "nonprofit_member":
        conditions.push("companies.member_type=eq.nonprofit");
        conditions.push("companies.membership_status=eq.active");
        break;
      case "all_members":
        conditions.push("companies.membership_status=eq.active");
        break;
      case "employer_nonmember":
        conditions.push("companies.member_type=eq.employer");
        conditions.push("companies.membership_status=eq.non-member");
        break;
      case "associate_nonmember":
        conditions.push("companies.member_type=eq.associate");
        conditions.push("companies.membership_status=eq.non-member");
        break;
      case "nonprofit_nonmember":
        conditions.push("companies.member_type=eq.nonprofit");
        conditions.push("companies.membership_status=eq.non-member");
        break;
      case "all_nonmembers":
        conditions.push("companies.membership_status=eq.non-member");
        break;
      case "all_prospects":
        conditions.push("companies.membership_status=eq.non-member");
        conditions.push("companies.member_type=not.is.null");
        break;
      case "vendors":
        conditions.push("companies.member_type=eq.vendor");
        break;
      case "unlinked":
        break;
      default:
        console.log(`Unknown company_segment: ${companySegment}, sending to all contacts`);
    }
  }

  conditions.push("email=not.is.null");

  if (companySegment === "unlinked") {
    const unlinkQuery = `contacts?select=id,email,first_name,last_name,contact_type,contact_status,companies(name)&company_id=is.null&email=not.is.null`;
    const allContacts: Array<Record<string, unknown>> = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
      const data = await supabaseGet(`${unlinkQuery}&offset=${offset}&limit=${limit}`);
      if (!data || data.length === 0) break;
      allContacts.push(...data);
      offset += limit;
      if (data.length < limit) break;
    }
    console.log(`Unlinked segment returned ${allContacts.length} contacts`);
    return allContacts;
  }

  if (conditions.length > 0) {
    query += "&" + conditions.join("&");
  }

  const allContacts: Array<Record<string, unknown>> = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const data = await supabaseGet(`${query}&offset=${offset}&limit=${limit}`);
    if (!data || data.length === 0) break;
    allContacts.push(...data);
    offset += limit;
    if (data.length < limit) break;
  }

  console.log(`Segment filter (company_segment: ${companySegment || "none"}) returned ${allContacts.length} contacts`);
  return allContacts;
}

// --- Build recipient list from specific emails ---

async function buildSpecificRecipientList(emails: string[]): Promise<Array<Record<string, unknown>>> {
  const cleanEmails = emails.map((e) => e.toLowerCase().trim()).filter((e) => e.includes("@"));
  if (cleanEmails.length === 0) return [];

  const allContacts: Array<Record<string, unknown>> = [];

  for (let i = 0; i < cleanEmails.length; i += 50) {
    const batch = cleanEmails.slice(i, i + 50);
    const data = await supabaseGet(
      `contacts?select=id,email,first_name,last_name,companies(name)&email=in.(${batch.join(",")})`
    );
    if (data && Array.isArray(data)) allContacts.push(...data);
  }

  const foundEmails = new Set(allContacts.map((c) => (c.email as string).toLowerCase().trim()));
  for (const email of cleanEmails) {
    if (!foundEmails.has(email)) {
      allContacts.push({ id: null, email, first_name: null, last_name: null, companies: null });
    }
  }

  return allContacts;
}

// --- Filter out unsubscribed emails ---

async function getUnsubscribedEmails(): Promise<Set<string>> {
  const unsubs = new Set<string>();
  let offset = 0;
  while (true) {
    const data = await supabaseGet(`email_unsubscribes?select=email&offset=${offset}&limit=1000`);
    if (!data || data.length === 0) break;
    for (const row of data) unsubs.add(row.email.toLowerCase().trim());
    offset += 1000;
    if (data.length < 1000) break;
  }
  return unsubs;
}

// --- Filter out suppressed emails (hard bounces, complaints) ---

async function getSuppressedEmails(): Promise<Set<string>> {
  const suppressed = new Set<string>();
  let offset = 0;
  while (true) {
    const data = await supabaseGet(`email_suppressions?select=email&offset=${offset}&limit=1000`);
    if (!data || data.length === 0) break;
    for (const row of data) suppressed.add(row.email.toLowerCase().trim());
    offset += 1000;
    if (data.length < 1000) break;
  }
  return suppressed;
}

// --- Fetch A/B variants for a campaign ---

async function getABVariants(campaign_id: string): Promise<Array<Record<string, unknown>>> {
  const data = await supabaseGet(
    `campaign_ab_variants?campaign_id=eq.${campaign_id}&select=*&order=variant_label.asc`
  );
  return (data && Array.isArray(data) && data.length > 0) ? data : [];
}

// --- Send a single email via Resend ---
// UPDATED: passes tracking_id as a Resend tag + returns resend_message_id

async function sendEmail(
  to: string,
  from: string,
  subject: string,
  html: string,
  trackingId: string,
): Promise<{ success: boolean; resendMessageId?: string; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        tags: [{ name: "tracking_id", value: trackingId }],
      }),
    });
    const responseBody = await res.json();
    if (!res.ok) {
      console.error(`Resend error for ${to}: ${res.status}`, JSON.stringify(responseBody));
      return { success: false, error: responseBody.message || `Resend error ${res.status}` };
    }
    console.log(`Resend success for ${to}: id=${responseBody.id}`);
    return { success: true, resendMessageId: responseBody.id };
  } catch (err) {
    console.error(`Resend exception for ${to}:`, err.message);
    return { success: false, error: err.message || "Send failed" };
  }
}

// --- Send a batch of recipient records ---

async function sendRecipientBatch(
  recipients: Array<Record<string, unknown>>,
  campaign: Record<string, unknown>,
  contactLookup: Map<string, Record<string, unknown>>,
  variantLookup: Map<string, Record<string, unknown>>,
  hasAB: boolean
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const fromAddress = `${campaign.from_name} <${campaign.from_email}>`;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    const promises = batch.map(async (recipient) => {
      const email = (recipient.email as string).toLowerCase().trim();
      const contactData = contactLookup.get(email);
      const enrichedRecipient = { ...recipient, companies: contactData?.companies || null };
      const trackingId = recipient.tracking_id as string;

      const html = personalize(
        (campaign.html_body as string) || "",
        enrichedRecipient,
        trackingId,
        campaign
      );

      let subjectTemplate = (campaign.subject as string) || "";
      if (hasAB && recipient.variant_id) {
        const variant = variantLookup.get(recipient.variant_id as string);
        if (variant) subjectTemplate = (variant.subject_line as string) || subjectTemplate;
      }

      const personalizedSubject = personalizeSubject(subjectTemplate, enrichedRecipient, campaign);

      const result = await sendEmail(
        recipient.email as string,
        fromAddress,
        personalizedSubject,
        html,
        trackingId,
      );

      if (result.success) {
        await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, {
          status: "sent",
          sent_at: new Date().toISOString(),
          resend_message_id: result.resendMessageId || null,
        });
        sent++;
      } else {
        await supabasePatch(`campaign_recipients?id=eq.${recipient.id}`, { status: "failed" });
        failed++;
      }
    });

    await Promise.all(promises);
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return { sent, failed };
}

// --- Standard send (no A/B or simple A/B where all get variants) ---

async function sendToRecipients(
  campaign: Record<string, unknown>,
  campaign_id: string,
  contacts: Array<Record<string, unknown>>
): Promise<{ totalSent: number; totalFailed: number; totalRecipients: number }> {
  const unsubscribed = await getUnsubscribedEmails();
  const suppressed = await getSuppressedEmails();
  const variants = await getABVariants(campaign_id);
  const hasAB = variants.length > 0;

  if (hasAB) {
    console.log(`A/B testing: ${variants.length} variants`);
    for (const v of variants) console.log(`  ${v.variant_label}: "${v.subject_line}" (${v.percentage}%)`);
  }

  const contactLookup = new Map<string, Record<string, unknown>>();
  for (const c of contacts) contactLookup.set((c.email as string).toLowerCase().trim(), c);

  const seen = new Set<string>();
  const eligibleContacts: Array<Record<string, unknown>> = [];
  for (const contact of contacts) {
    const email = (contact.email as string).toLowerCase().trim();
    if (!email || !email.includes("@") || unsubscribed.has(email) || suppressed.has(email) || seen.has(email)) continue;
    seen.add(email);
    eligibleContacts.push(contact);
  }

  console.log(`Eligible contacts: ${eligibleContacts.length} (excluded: ${unsubscribed.size} unsubscribed, ${suppressed.size} suppressed, ${contacts.length - eligibleContacts.length - unsubscribed.size - suppressed.size} dupes/invalid)`);

  const variantPercentTotal = variants.reduce((sum, v) => sum + ((v.percentage as number) || 0), 0);
  const remainderPercent = hasAB ? Math.max(0, 100 - variantPercentTotal) : 0;
  const isSmartSplit = hasAB && remainderPercent > 0 && eligibleContacts.length >= 10;

  if (hasAB && eligibleContacts.length < 10) {
    console.log(`Small audience (${eligibleContacts.length}), skipping smart split — all get variants`);
  }

  console.log(`Variant total: ${variantPercentTotal}%, Remainder: ${remainderPercent}%, Smart split: ${isSmartSplit}`);

  const shuffled = [...eligibleContacts].sort(() => Math.random() - 0.5);

  const testCount = isSmartSplit ? Math.ceil(shuffled.length * (variantPercentTotal / 100)) : shuffled.length;
  const testContacts = shuffled.slice(0, testCount);
  const remainderContacts = shuffled.slice(testCount);

  console.log(`Test group: ${testContacts.length}, Remainder group: ${remainderContacts.length}`);

  const variantCounts = new Map<string, number>();

  const testRows = testContacts.map((c) => {
    const email = (c.email as string).toLowerCase().trim();
    let variantId = null;

    if (hasAB) {
      const rand = Math.random() * variantPercentTotal;
      let cumulative = 0;
      for (const variant of variants) {
        cumulative += (variant.percentage as number) || 0;
        if (rand < cumulative) {
          variantId = variant.id as string;
          break;
        }
      }
      if (!variantId) variantId = variants[variants.length - 1].id as string;
      variantCounts.set(variantId, (variantCounts.get(variantId) || 0) + 1);
    }

    return {
      campaign_id,
      contact_id: c.id || null,
      email,
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      status: "pending",
      variant_id: variantId,
    };
  });

  const remainderRows = remainderContacts.map((c) => ({
    campaign_id,
    contact_id: c.id || null,
    email: (c.email as string).toLowerCase().trim(),
    first_name: c.first_name || null,
    last_name: c.last_name || null,
    status: "pending_winner",
    variant_id: null,
  }));

  const allRows = [...testRows, ...remainderRows];
  for (let i = 0; i < allRows.length; i += 500) {
    await supabasePost("campaign_recipients", allRows.slice(i, i + 500));
  }

  if (hasAB) {
    for (const [variantId, count] of variantCounts) {
      await supabasePatch(`campaign_ab_variants?id=eq.${variantId}`, { total_recipients: count });
    }
  }

  await supabasePatch(`email_campaigns?id=eq.${campaign_id}`, {
    total_recipients: eligibleContacts.length,
    ab_remainder_percentage: remainderPercent,
  });

  await new Promise((r) => setTimeout(r, 2000));

  const testRecipients: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    const batch = await supabaseGet(
      `campaign_recipients?campaign_id=eq.${campaign_id}&status=eq.pending&select=id,email,first_name,last_name,tracking_id,variant_id&offset=${offset}&limit=1000`
    );
    if (!batch || batch.length === 0) break;
    testRecipients.push(...batch);
    offset += 1000;
    if (batch.length < 1000) break;
  }

  console.log(`Sending to ${testRecipients.length} test recipients now`);

  const variantLookup = new Map<string, Record<string, unknown>>();
  for (const v of variants) variantLookup.set(v.id as string, v);

  const results = await sendRecipientBatch(testRecipients, campaign, contactLookup, variantLookup, hasAB);

  if (hasAB) {
    const variantSentCounts = new Map<string, number>();
    for (const r of testRecipients) {
      if (r.variant_id) {
        variantSentCounts.set(r.variant_id as string, (variantSentCounts.get(r.variant_id as string) || 0) + 1);
      }
    }
    for (const [variantId, count] of variantSentCounts) {
      await supabasePatch(`campaign_ab_variants?id=eq.${variantId}`, { total_sent: count });
    }
  }

  if (isSmartSplit) {
    await supabasePatch(`email_campaigns?id=eq.${campaign_id}`, {
      status: "ab_testing",
      ab_test_status: "testing",
      total_sent: results.sent,
    });
    console.log(`A/B test started. ${remainderContacts.length} recipients waiting for winner. Check in ${campaign.ab_winner_delay_minutes || 60} minutes.`);
  }

  return { totalSent: results.sent, totalFailed: results.failed, totalRecipients: eligibleContacts.length };
}

// --- Main handler ---

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const user = verifyJwt(req);
  if (user) {
    console.log(`Authenticated: ${user.email || user.id}`);
  } else {
    console.warn("JWT audit: Could not identify caller (CORS still enforced)");
  }

  try {
    const body = await req.json();
    const { campaign_id, test_email, specific_emails } = body;

    console.log("=== send-campaign invoked ===");
    console.log("Payload received:", JSON.stringify({
      campaign_id,
      test_email: test_email || null,
      specific_emails: specific_emails || null,
      has_specific_emails: !!(specific_emails && Array.isArray(specific_emails) && specific_emails.length > 0),
    }));

    if (!campaign_id) {
      return new Response(
        JSON.stringify({ error: "Missing campaign_id" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
    if (!isValidUuid(campaign_id)) {
      return new Response(
        JSON.stringify({ error: "Invalid campaign_id format" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const campaigns = await supabaseGet(`email_campaigns?id=eq.${campaign_id}&select=*`);
    if (!campaigns || campaigns.length === 0) {
      return new Response(
        JSON.stringify({ error: "Campaign not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const campaign = campaigns[0];
    console.log(`Campaign: "${campaign.name}", status: ${campaign.status}, has html_body: ${!!campaign.html_body}`);

    if (test_email) {
      console.log(`MODE: test_email -> ${test_email}`);

      const variants = await getABVariants(campaign_id);
      let testSubjectTemplate = campaign.subject || "";
      if (variants.length > 0) {
        testSubjectTemplate = (variants[0].subject_line as string) || testSubjectTemplate;
        console.log(`A/B test mode: using variant ${variants[0].variant_label} subject`);
      }

      const testHtml = personalize(campaign.html_body || "", {
        first_name: "Test", last_name: "User", email: test_email, companies: { name: "Test Company" },
      }, "test-tracking-id", campaign);

      const testSubject = personalizeSubject(testSubjectTemplate, {
        first_name: "Test", last_name: "User", email: test_email, companies: { name: "Test Company" },
      }, campaign);

      const result = await sendEmail(
        test_email,
        `${campaign.from_name} <${campaign.from_email}>`,
        `[TEST] ${testSubject}`,
        testHtml,
        "test-tracking-id",
      );

      return new Response(
        JSON.stringify({ success: result.success, error: result.error }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    if (specific_emails && Array.isArray(specific_emails) && specific_emails.length > 0) {
      console.log(`MODE: specific_emails -> ${specific_emails.join(", ")}`);

      await supabasePatch(`email_campaigns?id=eq.${campaign_id}`, { status: "sending" });

      const contacts = await buildSpecificRecipientList(specific_emails);
      console.log(`Found ${contacts.length} contacts`);

      const results = await sendToRecipients(campaign, campaign_id, contacts);

      await supabasePatch(`email_campaigns?id=eq.${campaign_id}`, {
        status: "sent",
        sent_at: new Date().toISOString(),
        total_sent: results.totalSent,
      });

      return new Response(
        JSON.stringify({
          success: true, mode: "specific_emails",
          total_recipients: results.totalRecipients, total_sent: results.totalSent, total_failed: results.totalFailed,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    console.log("MODE: full_audience_send");

    if (campaign.status === "sent" || campaign.status === "sending" || campaign.status === "ab_testing") {
      return new Response(
        JSON.stringify({ error: `Campaign is already ${campaign.status}` }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    await supabasePatch(`email_campaigns?id=eq.${campaign_id}`, { status: "sending" });

    const contacts = await buildRecipientList(campaign.segment_filter || {});
    console.log(`Segment filter returned ${contacts.length} contacts`);

    const results = await sendToRecipients(campaign, campaign_id, contacts);

    const refreshed = await supabaseGet(`email_campaigns?id=eq.${campaign_id}&select=status`);
    if (refreshed && refreshed[0] && refreshed[0].status !== "ab_testing") {
      await supabasePatch(`email_campaigns?id=eq.${campaign_id}`, {
        status: "sent",
        sent_at: new Date().toISOString(),
        total_sent: results.totalSent,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode: refreshed?.[0]?.status === "ab_testing" ? "ab_testing" : "full_audience",
        total_recipients: results.totalRecipients,
        total_sent: results.totalSent,
        total_failed: results.totalFailed,
        ab_testing: refreshed?.[0]?.status === "ab_testing",
        remainder_waiting: refreshed?.[0]?.status === "ab_testing" ? results.totalRecipients - results.totalSent - results.totalFailed : 0,
      }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("send-campaign error:", err);
    return new Response(
      JSON.stringify({ error: "Campaign send failed" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
