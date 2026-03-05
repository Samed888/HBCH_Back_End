# Registration Flow - Supabase CLI Deployment
# =============================================

## STEP 1: Install Supabase CLI (if not already installed)

# macOS:
brew install supabase/tap/supabase

# Windows (via npm):
npm install -g supabase

# Verify:
supabase --version


## STEP 2: Login & Link Project

supabase login
# This opens a browser to get your access token

supabase link --project-ref jpqqtxfbgryakzrcblca
# Your Supabase project ref


## STEP 3: Set Secrets (Edge Function environment variables)

# Your Resend API key (for sending OTP emails)
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx --project-ref jpqqtxfbgryakzrcblca

# Your Stripe secret key (for payment intents)
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxx --project-ref jpqqtxfbgryakzrcblca

# Note: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are automatically available


## STEP 4: Deploy Edge Functions

# From the directory containing the /supabase/functions folder:

supabase functions deploy send-otp --project-ref jpqqtxfbgryakzrcblca --no-verify-jwt
supabase functions deploy verify-otp --project-ref jpqqtxfbgryakzrcblca --no-verify-jwt
supabase functions deploy get-event-pricing --project-ref jpqqtxfbgryakzrcblca --no-verify-jwt
supabase functions deploy create-registration --project-ref jpqqtxfbgryakzrcblca --no-verify-jwt

# --no-verify-jwt because these are public-facing (OTP is the auth mechanism)


## STEP 5: Test

# Test send-otp:
curl -X POST https://jpqqtxfbgryakzrcblca.supabase.co/functions/v1/send-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com"}'

# Test verify-otp (use code from email):
curl -X POST https://jpqqtxfbgryakzrcblca.supabase.co/functions/v1/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","code":"123456"}'


## REGISTRATION FLOW SEQUENCE:
## 1. User enters email → call send-otp
## 2. User enters 6-digit code → call verify-otp → returns contact profile
## 3. UI calls get-event-pricing with contact_type + company_type → shows eligible tiers only
## 4. User picks tier → call create-registration → returns Stripe client_secret
## 5. UI completes Stripe payment with client_secret
## 6. Stripe webhook confirms payment → updates payment_status to 'paid'
