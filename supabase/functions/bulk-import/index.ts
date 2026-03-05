import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface CsvContact {
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  mobile_phone?: string;
  contact_type?: string;
  contact_status?: string;
  company_name?: string;
  role_title?: string;
  [key: string]: unknown;
}

interface ImportResult {
  new_contacts: number;
  updated_contacts: number;
  skipped_contacts: number;
  errors: Array<{ row: number; email: string; error: string }>;
}

// Fetch all existing contacts by email for matching
async function getExistingContacts(): Promise<Map<string, Record<string, unknown>>> {
  const contacts = new Map();
  let offset = 0;
  const limit = 1000;

  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?select=id,email,first_name,last_name,phone,mobile_phone,contact_type,contact_status&offset=${offset}&limit=${limit}`,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const data = await res.json();
    if (!data || data.length === 0) break;

    for (const contact of data) {
      if (contact.email) {
        contacts.set(contact.email.toLowerCase().trim(), contact);
      }
    }

    offset += limit;
    if (data.length < limit) break;
  }

  return contacts;
}

// Fetch existing companies by name
async function getExistingCompanies(): Promise<Map<string, string>> {
  const companies = new Map();
  let offset = 0;
  const limit = 1000;

  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/companies?select=id,name&offset=${offset}&limit=${limit}`,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    const data = await res.json();
    if (!data || data.length === 0) break;

    for (const company of data) {
      if (company.name) {
        companies.set(company.name.toLowerCase().trim(), company.id);
      }
    }

    offset += limit;
    if (data.length < limit) break;
  }

  return companies;
}

// Preview mode: categorize contacts and return preview rows matching client PreviewRow interface
async function previewImport(csvContacts: CsvContact[]) {
  const existing = await getExistingContacts();

  const preview: Array<{
    rowIndex: number;
    email: string;
    category: "new" | "update" | "no_change" | "invalid";
    changes?: Record<string, { from: string | null; to: string }>;
    newContact?: Record<string, string>;
    error?: string;
  }> = [];

  csvContacts.forEach((csv, index) => {
    const email = (csv.email || "").toLowerCase().trim();

    // Validate email - must have @ and a full domain with TLD
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!email || !emailRegex.test(email)) {
      preview.push({
        rowIndex: index,
        email: csv.email || "(empty)",
        category: "invalid",
        error: "Invalid or missing email",
      });
      return;
    }

    const match = existing.get(email);

    if (!match) {
      // New contact
      const newContact: Record<string, string> = {};
      for (const [key, val] of Object.entries(csv)) {
        if (val && typeof val === "string") newContact[key] = val;
      }
      preview.push({
        rowIndex: index,
        email,
        category: "new",
        newContact,
      });
    } else {
      // Check for actual changes — only overwrite if CSV has a non-empty value
      // and it differs from existing
      const changes: Record<string, { from: string | null; to: string }> = {};

      const fieldsToCheck = ["first_name", "last_name", "phone", "mobile_phone", "contact_type", "contact_status"];
      for (const field of fieldsToCheck) {
        const csvVal = (csv[field] as string || "").trim();
        const existingVal = (match[field] as string || "").trim();

        // Only update if CSV has a value AND it's different from existing
        if (csvVal && csvVal !== existingVal) {
          changes[field] = { from: existingVal || null, to: csvVal };
        }
      }

      if (Object.keys(changes).length > 0) {
        preview.push({
          rowIndex: index,
          email,
          category: "update",
          changes,
        });
      } else {
        preview.push({
          rowIndex: index,
          email,
          category: "no_change",
        });
      }
    }
  });

  return { preview };
}

// Apply mode: actually insert/update contacts
async function applyImport(
  csvContacts: CsvContact[],
  options: { skipNew: boolean; skipUpdates: boolean }
): Promise<ImportResult> {
  const existing = await getExistingContacts();
  const companies = await getExistingCompanies();

  const result: ImportResult = {
    new_contacts: 0,
    updated_contacts: 0,
    skipped_contacts: 0,
    errors: [],
  };

  for (let i = 0; i < csvContacts.length; i++) {
    const csv = csvContacts[i];
    const email = (csv.email || "").toLowerCase().trim();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!email || !emailRegex.test(email)) {
      result.errors.push({ row: i + 2, email: csv.email || "(empty)", error: "Invalid email" });
      continue;
    }

    const match = existing.get(email);

    try {
      if (!match && !options.skipNew) {
        // Insert new contact
        const newContact: Record<string, unknown> = {
          email: email,
          first_name: (csv.first_name || "").trim() || null,
          last_name: (csv.last_name || "").trim() || null,
          phone: (csv.phone || "").trim() || null,
          mobile_phone: (csv.mobile_phone || "").trim() || null,
          contact_type: (csv.contact_type || "contact").trim().toLowerCase(),
          contact_status: (csv.contact_status || "active").trim().toLowerCase(),
        };

        const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
          method: "POST",
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
          },
          body: JSON.stringify(newContact),
        });

        if (!res.ok) {
          const err = await res.json();
          result.errors.push({ row: i + 2, email, error: err.message || "Insert failed" });
          continue;
        }

        const inserted = await res.json();
        const contactId = inserted[0]?.id;

        // Link company if provided
        if (csv.company_name && contactId) {
          const companyName = csv.company_name.trim();
          let companyId = companies.get(companyName.toLowerCase());

          if (!companyId) {
            // Create new company
            const compRes = await fetch(`${SUPABASE_URL}/rest/v1/companies`, {
              method: "POST",
              headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "return=representation",
              },
              body: JSON.stringify({ name: companyName, company_type: "business" }),
            });

            if (compRes.ok) {
              const compData = await compRes.json();
              companyId = compData[0]?.id;
              if (companyId) {
                companies.set(companyName.toLowerCase(), companyId);
              }
            }
          }

          if (companyId) {
            await fetch(`${SUPABASE_URL}/rest/v1/contact_company_roles`, {
              method: "POST",
              headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
              },
              body: JSON.stringify({
                contact_id: contactId,
                company_id: companyId,
                role_title: (csv.role_title || "").trim() || null,
              }),
            });
          }
        }

        result.new_contacts++;
      } else if (match && !options.skipUpdates) {
        // Update existing — only overwrite non-empty CSV values
        const updates: Record<string, unknown> = {};
        const fieldsToCheck = ["first_name", "last_name", "phone", "mobile_phone", "contact_type", "contact_status"];

        for (const field of fieldsToCheck) {
          const csvVal = (csv[field] as string || "").trim();
          const existingVal = (match[field] as string || "").trim();

          if (csvVal && csvVal !== existingVal) {
            updates[field] = csvVal;
          }
        }

        if (Object.keys(updates).length > 0) {
          updates.updated_at = new Date().toISOString();

          const res = await fetch(
            `${SUPABASE_URL}/rest/v1/contacts?id=eq.${match.id}`,
            {
              method: "PATCH",
              headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
              },
              body: JSON.stringify(updates),
            }
          );

          if (!res.ok) {
            const err = await res.json();
            result.errors.push({ row: i + 2, email, error: err.message || "Update failed" });
            continue;
          }

          result.updated_contacts++;
        } else {
          result.skipped_contacts++;
        }
      } else {
        result.skipped_contacts++;
      }
    } catch (err) {
      result.errors.push({ row: i + 2, email, error: err.message || "Unknown error" });
    }
  }

  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { mode, contacts, options } = await req.json();

    if (!contacts || !Array.isArray(contacts)) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing contacts array" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (mode === "preview") {
      const preview = await previewImport(contacts);
      return new Response(
        JSON.stringify({ success: true, ...preview }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (mode === "apply") {
      const importResult = await applyImport(contacts, options || { skipNew: false, skipUpdates: false });
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            created: importResult.new_contacts,
            updated: importResult.updated_contacts,
            skipped: importResult.skipped_contacts,
            errors: importResult.errors.map(e => `Row ${e.row} (${e.email}): ${e.error}`),
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: "Invalid mode. Use 'preview' or 'apply'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("bulk-import error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
