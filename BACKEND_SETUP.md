# HUEBLOC Trading — Backend Setup

How a $50/mo membership goes from "Register" click to unlocked dashboard.

## The flow, end to end

1. Member enters their email on the **Register** tab and clicks **Continue to Payment**
2. They land on Stripe's hosted **Payment Link** page (their email is prefilled) and pay $50 once
3. Stripe fires a webhook → `stripe-webhook.js` marks that email `active` in Supabase — permanently, since there's no recurring charge to track
4. Stripe redirects them back to a confirmation page telling them to check their email / log in
5. Member goes to the **Log In** tab, enters their email → `magic-link.js` checks they're `active` and emails them a sign-in link
6. They click the link → `magic-link.js` verifies it, sets a session cookie, redirects to `dashboard.html`

If Craig ever issues a refund from the Stripe dashboard, `charge.refunded` fires automatically and flips that member's `payment_status` to `refunded` — no manual database work needed.

Only step 3 and steps 5–6 involve code — step 2 is entirely handled by Stripe's hosted page, no custom checkout code needed.

## One-time setup checklist

**Stripe**
- [x] Create the **one-time** $50 product in Stripe Dashboard → Product Catalog
- [x] Create a **Payment Link** for that product, with "Don't show confirmation page" → redirect to `https://huebloc.com/client-area.html?tab=login&justPaid=true`
- [x] Payment Link URL wired into `client-area.html` (`https://buy.stripe.com/14AfZhcis7wl2YE69JcfK0k`)
- [ ] Developers → Webhooks → Add endpoint: `https://huebloc.com/.netlify/functions/stripe-webhook`, sending `checkout.session.completed` and `charge.refunded` — **do this after the site is deployed to Netlify**, since Stripe needs a live URL to send to
- [ ] Copy the webhook signing secret into `STRIPE_WEBHOOK_SECRET`

**Supabase**
- [ ] Create a new Supabase project
- [ ] Run `supabase-schema.sql` in the SQL Editor
- [ ] Copy the Project URL and the `service_role` key (Project Settings → API) — **never** the `anon` key, since these functions need full read/write access and RLS blocks everything else

**Resend** (or swap for Postmark — see comment in `magic-link.js`)
- [ ] Verify the `huebloc.com` sending domain
- [ ] Create an API key

**Netlify**
- [ ] Site settings → Environment variables — add all of these:

| Variable | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe → the webhook endpoint you created |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (service_role, secret) |
| `RESEND_API_KEY` | Resend → API Keys |
| `JWT_SECRET` | Any long random string — generate with `openssl rand -hex 32` |
| `SITE_URL` | `https://huebloc.com` (no trailing slash) |

- [ ] `cd netlify/functions && npm install` before first deploy (or let Netlify install from `package.json` automatically)

## What's still missing (on purpose, for now)

- **Protecting `dashboard.html` itself** — right now it's a static file anyone can visit directly. Once this is a real Netlify site, either move it behind a small "check session cookie" function that serves the page, or rebuild the dashboard as part of the React app so it can check the `hueb_session` cookie client-side on load and redirect to `client-area.html` if missing/invalid. The verification snippet is already commented at the bottom of `magic-link.js`.
- **A "refund processed" email** — the webhook now revokes access automatically on `charge.refunded`, but nothing currently tells the member their access changed. Worth adding once the core loop is working.
- **Rate limiting the magic-link request endpoint** — someone could currently spam `POST /magic-link` for any email. Fine for launch, but worth adding basic rate limiting (Netlify has built-in options) before scaling.
