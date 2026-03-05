import { corsHeaders } from "../_shared/cors.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

interface EmailBlock {
  type: string;
  content?: Record<string, unknown>;
  [key: string]: unknown;
}

function renderBlockToHtml(block: EmailBlock): string {
  const type = block.type;
  const c = (block.content || block) as Record<string, unknown>;

  switch (type) {
    case "logo-header": {
      const url = (c.imageUrl || c.image_url || "") as string;
      const width = (c.width || 40) as number;
      const align = (c.alignment || "center") as string;
      if (!url) return "";
      return `
        <tr>
          <td align="${align}" style="padding: 20px 30px;">
            <img src="${url}" alt="Logo" width="${Math.round(600 * width / 100)}" style="max-width: ${width}%; height: auto; display: block;" />
          </td>
        </tr>`;
    }

    case "partner-bar": {
      const logos = (c.logos || []) as Array<Record<string, unknown>>;
      if (!logos.length) return "";
      const imgs = logos
        .filter((l) => l.imageUrl || l.image_url)
        .map((l) => {
          const lUrl = (l.imageUrl || l.image_url) as string;
          const lWidth = (l.width || 120) as number;
          return `<img src="${lUrl}" alt="Partner" width="${lWidth}" style="height: auto; display: inline-block; margin: 0 10px;" />`;
        })
        .join("");
      return `
        <tr>
          <td align="center" style="padding: 10px 30px; background-color: ${(c.backgroundColor || c.background_color || "#f5f5f5") as string};">
            ${imgs}
          </td>
        </tr>`;
    }

    case "section-header": {
      const title = (c.title || "") as string;
      const subtitle = (c.subtitle || "") as string;
      const bgColor = (c.backgroundColor || c.background_color || "#6C2BD9") as string;
      const textColor = (c.textColor || c.text_color || "#ffffff") as string;
      return `
        <tr>
          <td style="padding: 15px 30px; background-color: ${bgColor};">
            <h2 style="margin: 0; color: ${textColor}; font-family: Arial, sans-serif; font-size: 22px; font-weight: bold;">${title}</h2>
            ${subtitle ? `<p style="margin: 5px 0 0; color: ${textColor}; font-family: Arial, sans-serif; font-size: 14px; opacity: 0.9;">${subtitle}</p>` : ""}
          </td>
        </tr>`;
    }

    case "text": {
      const text = (c.text || c.content || "") as string;
      // Replace personalization variables with test placeholders
      const replaced = text
        .replace(/\{\{first_name\}\}/g, "[First Name]")
        .replace(/\{\{last_name\}\}/g, "[Last Name]")
        .replace(/\{\{full_name\}\}/g, "[Full Name]")
        .replace(/\{\{email\}\}/g, "[Email]")
        .replace(/\{\{company_name\}\}/g, "[Company Name]")
        .replace(/\{\{contact_type\}\}/g, "[Contact Type]")
        .replace(/\{\{membership_status\}\}/g, "[Membership Status]")
        .replace(/\{\{membership_type\}\}/g, "[Membership Type]");
      return `
        <tr>
          <td style="padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #333333;">
            ${replaced}
          </td>
        </tr>`;
    }

    case "bullet-list": {
      const items = (c.items || []) as string[];
      if (!items.length) return "";
      const lis = items.map((item) => `<li style="margin-bottom: 8px;">${item}</li>`).join("");
      return `
        <tr>
          <td style="padding: 10px 30px 10px 50px; font-family: Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #333333;">
            <ul style="margin: 0; padding-left: 20px;">${lis}</ul>
          </td>
        </tr>`;
    }

    case "button": {
      const btnText = (c.text || c.buttonText || "Click Here") as string;
      const btnUrl = (c.url || c.buttonUrl || "#") as string;
      const btnColor = (c.color || c.buttonColor || "#6C2BD9") as string;
      const borderRadius = (c.borderRadius || c.border_radius || 6) as number;
      return `
        <tr>
          <td align="center" style="padding: 20px 30px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${btnUrl}" style="height:45px;v-text-anchor:middle;width:220px;" arcsize="${Math.round(borderRadius / 45 * 100)}%" fillcolor="${btnColor}">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${btnText}</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-->
            <a href="${btnUrl}" target="_blank" style="display: inline-block; padding: 12px 36px; background-color: ${btnColor}; color: #ffffff; font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; text-decoration: none; border-radius: ${borderRadius}px;">${btnText}</a>
            <!--<![endif]-->
          </td>
        </tr>`;
    }

    case "image": {
      const imgUrl = (c.imageUrl || c.image_url || "") as string;
      const altText = (c.altText || c.alt_text || "Image") as string;
      const imgWidth = (c.width || 100) as number;
      const imgAlign = (c.alignment || "center") as string;
      if (!imgUrl) return "";
      return `
        <tr>
          <td align="${imgAlign}" style="padding: 15px 30px;">
            <img src="${imgUrl}" alt="${altText}" width="${Math.round(600 * imgWidth / 100)}" style="max-width: ${imgWidth}%; height: auto; display: block;" />
          </td>
        </tr>`;
    }

    case "callout": {
      const calloutText = (c.text || c.content || "") as string;
      const calloutBg = (c.backgroundColor || c.background_color || "#f5f5f5") as string;
      return `
        <tr>
          <td style="padding: 15px 30px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding: 20px; background-color: ${calloutBg}; border-radius: 6px; font-family: Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #333333;">
                  ${calloutText}
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    }

    case "divider": {
      const divColor = (c.color || "#e0e0e0") as string;
      return `
        <tr>
          <td style="padding: 15px 30px;">
            <hr style="border: 0; border-top: 1px solid ${divColor}; margin: 0;" />
          </td>
        </tr>`;
    }

    case "social-icons": {
      const socials = [];
      if (c.facebook) socials.push(`<a href="${c.facebook}" target="_blank" style="margin: 0 8px; text-decoration: none; color: #666;">Facebook</a>`);
      if (c.linkedin) socials.push(`<a href="${c.linkedin}" target="_blank" style="margin: 0 8px; text-decoration: none; color: #666;">LinkedIn</a>`);
      if (c.twitter) socials.push(`<a href="${c.twitter}" target="_blank" style="margin: 0 8px; text-decoration: none; color: #666;">X/Twitter</a>`);
      if (c.instagram) socials.push(`<a href="${c.instagram}" target="_blank" style="margin: 0 8px; text-decoration: none; color: #666;">Instagram</a>`);
      if (!socials.length) return "";
      return `
        <tr>
          <td align="center" style="padding: 15px 30px; font-family: Arial, sans-serif; font-size: 14px;">
            ${socials.join(" | ")}
          </td>
        </tr>`;
    }

    case "footer": {
      const address = (c.address || "Houston Business Coalition on Health, 9550 Spring Green Blvd, Suite 408-433, Katy, Texas 77494") as string;
      const phone = (c.phone || "2818096960") as string;
      return `
        <tr>
          <td align="center" style="padding: 20px 30px; font-family: Arial, sans-serif; font-size: 12px; color: #999999; line-height: 1.5;">
            ${address}<br/>
            ${phone ? `Phone: ${phone}<br/>` : ""}
            <br/>
            <a href="#" style="color: #999999; text-decoration: underline;">Unsubscribe</a> &nbsp;|&nbsp;
            <a href="#" style="color: #999999; text-decoration: underline;">Manage Preferences</a>
          </td>
        </tr>`;
    }

    default:
      return "";
  }
}

function renderEmail(blocks: EmailBlock[], subject: string, isTest: boolean): string {
  const blockHtml = blocks.map(renderBlockToHtml).join("");

  const testBanner = isTest
    ? `<tr>
        <td style="padding: 12px 20px; background-color: #FFF3CD; border-bottom: 2px solid #FFC107; font-family: Arial, sans-serif; font-size: 14px; color: #856404; text-align: center; font-weight: bold;">
          ⚠️ TEST EMAIL — This message was sent only to you for review purposes. Your audience has NOT received this email.
        </td>
      </tr>`
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${subject}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body { margin: 0; padding: 0; background-color: #f4f4f4; }
    table { border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a { color: #6C2BD9; }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f4;">
    <tr>
      <td align="center" style="padding: 20px 0;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff;">
          ${testBanner}
          ${blockHtml}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { to, subject, preview_text, blocks, from_name, from_email } = await req.json();

    if (!to || !subject || !blocks) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields: to, subject, blocks" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const html = renderEmail(blocks, subject, true);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${from_name || "Houston Business Coalition on Health"} <${from_email || "noreply@houstonbch.org"}>`,
        to: [to],
        subject: `[TEST] ${subject}`,
        html: html,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Resend error:", data);
      return new Response(
        JSON.stringify({ success: false, error: data.message || "Failed to send email" }),
        { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message_id: data.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("send-test-email error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
