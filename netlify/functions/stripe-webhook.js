// netlify/functions/stripe-webhook.js
//
// Listens for Stripe events and keeps the `members` table in sync.
// This is the ONLY place payment_status ever gets written — the
// magic-link function just reads it.
//
// Membership is a single one-time $50 payment — no subscription
// lifecycle to track. We listen for three events:
//   checkout.session.completed  → grants access
//   charge.refunded             → revokes access if Craig issues a refund
//   charge.dispute.created      → revokes access immediately if the
//                                  customer opens a chargeback with their bank
//
// Stripe dashboard → Developers → Webhooks → Add endpoint:
//   https://huebloc.com/.netlify/functions/stripe-webhook
// Events to send: checkout.session.completed, charge.refunded, charge.dispute.created
//
// Env vars required (Netlify → Site settings → Environment variables):
//   STRIPE_SECRET_KEY       sk_live_... (or sk_test_... while testing)
//   STRIPE_WEBHOOK_SECRET   whsec_...   (shown when you create the endpoint above)
//   SUPABASE_URL            https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service_role secret (Project Settings → API)
//   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_ROLE_ID  (optional — only
//     needed if Discord role removal on refund/dispute is set up; the
//     webhook works fine without these, it just skips that step)
//
// Dependencies (package.json):
//   npm install stripe @supabase/supabase-js

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Removes the paid-member Discord role from anyone in the just-updated
// row(s) who has a connected Discord account. Silently does nothing for
// members who never connected Discord — this only affects role access,
// never website/Playbook access, which is handled separately above.
async function removeDiscordRoleIfConnected(updatedRows) {
  const discordIds = (updatedRows || [])
    .map((row) => row.discord_user_id)
    .filter(Boolean);

  if (!discordIds.length) return;
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID || !process.env.DISCORD_ROLE_ID) {
    // Discord integration not configured yet — nothing to do.
    return;
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  const roleId = process.env.DISCORD_ROLE_ID;
  const botAuth = `Bot ${process.env.DISCORD_BOT_TOKEN}`;

  for (const discordUserId of discordIds) {
    try {
      await fetch(
        `https://discord.com/api/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
        { method: 'DELETE', headers: { Authorization: botAuth } }
      );
    } catch (err) {
      console.error('Error removing Discord role for', discordUserId, err);
      // Don't throw — a Discord API hiccup shouldn't fail the whole webhook,
      // since website access has already been correctly revoked above.
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ---- 1. Verify this actually came from Stripe ----
  let stripeEvent;
  try {
    const signature = event.headers['stripe-signature'];
    stripeEvent = stripe.webhooks.constructEvent(
      event.body, // must be the RAW body — see netlify.toml note at bottom
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // ---- 2. Handle the events we care about ----
  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();

        if (!email) {
          console.error('checkout.session.completed with no email on session', session.id);
          break;
        }

        // Free/100%-off orders never get a payment_intent from Stripe — fall
        // back to the checkout session's own ID so we always have a stable,
        // non-null value to store instead of leaving this column empty.
        const paymentReference = session.payment_intent || session.id;

        // Upsert on email: creates the member on first purchase,
        // or updates them if they somehow already had a row.
        const { error } = await supabase
          .from('members')
          .upsert(
            {
              email,
              stripe_customer_id: session.customer,
              stripe_payment_intent_id: paymentReference,
              payment_status: 'active',
            },
            { onConflict: 'email' }
          );

        if (error) throw error;
        break;
      }

      case 'charge.refunded': {
        const charge = stripeEvent.data.object;
        const paymentIntentId = charge.payment_intent;

        if (!paymentIntentId) {
          console.error('charge.refunded with no payment_intent on charge', charge.id);
          break;
        }

        const { data: updated, error } = await supabase
          .from('members')
          .update({ payment_status: 'refunded' })
          .eq('stripe_payment_intent_id', paymentIntentId)
          .select('discord_user_id');

        if (error) throw error;
        await removeDiscordRoleIfConnected(updated);
        break;
      }

      case 'charge.dispute.created': {
        // A chargeback — the customer disputed the charge with their bank
        // rather than requesting a refund from Craig directly. Revoke
        // access immediately; the dispute's eventual outcome (won/lost)
        // isn't tracked here, so restoring access after a won dispute
        // is a manual step in Supabase for now.
        const dispute = stripeEvent.data.object;
        const paymentIntentId = dispute.payment_intent;

        if (!paymentIntentId) {
          console.error('charge.dispute.created with no payment_intent on dispute', dispute.id);
          break;
        }

        const { data: updated, error } = await supabase
          .from('members')
          .update({ payment_status: 'disputed' })
          .eq('stripe_payment_intent_id', paymentIntentId)
          .select('discord_user_id');

        if (error) throw error;
        await removeDiscordRoleIfConnected(updated);
        break;
      }

      default:
        // Ignore anything we didn't ask for.
        break;
    }
  } catch (err) {
    console.error('Error processing Stripe webhook:', err);
    // Return 500 so Stripe retries this event automatically.
    return { statusCode: 500, body: 'Internal error processing webhook' };
  }

  // ---- 3. Tell Stripe we got it ----
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// IMPORTANT — raw body requirement:
// stripe.webhooks.constructEvent needs the *unparsed* request body to
// verify the signature. In netlify.toml, make sure this function isn't
// passed through any body-parsing middleware. Netlify Functions give you
// the raw string in `event.body` by default as long as you don't add a
// bundler step that parses JSON before this handler runs — the standard
// Netlify Functions setup (no framework in front) works out of the box.
