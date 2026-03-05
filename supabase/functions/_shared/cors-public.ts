// Public CORS — wildcard origin for endpoints called by
// email clients (Gmail, Outlook), email links, and external services (Resend).
// Used by: email-track, email-unsubscribe, resend-webhook

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};
