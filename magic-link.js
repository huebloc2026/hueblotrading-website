// netlify/functions/magic-link.js
//
// Handles BOTH halves of passwordless login from one endpoint:
//   POST /.netlify/functions/magic-link   { email }   → sends the login email
//   GET  /.netlify/functions/magic-link?token=...      → verifies + logs in
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY        from resend.com (or swap in Postmark — see note below)
//   JWT_SECRET             any long random string, e.g. `openssl rand -hex 32`
//   SITE_URL                https://huebloc.com (no trailing slash)
//
// Dependencies (package.json):
//   npm install @supabase/supabase-js resend jsonwebtoken

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

const TOKEN_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 7;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'POST') return handleRequestLink(event);
  if (event.httpMethod === 'GET') return handleVerifyLink(event);
  return { statusCode: 405, body: 'Method Not Allowed' };
};

// ============================================================
// STEP 1 — Member submits their email, we send the link
// ============================================================
async function handleRequestLink(event) {
  let email;
  try {
    ({ email } = JSON.parse(event.body || '{}'));
    email = (email || '').trim().toLowerCase();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A valid email is required' }) };
  }

  // Always return the same generic response whether or not the email
  // exists/has active access — this avoids leaking who is a member.
  const genericResponse = {
    statusCode: 200,
    body: JSON.stringify({
      message: 'If that email has an active membership, a sign-in link is on its way.',
    }),
  };

  const { data: member, error: memberError } = await supabase
    .from('members')
    .select('email, payment_status')
    .eq('email', email)
    .maybeSingle();

  if (memberError) {
    console.error('Error looking up member:', memberError);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong' }) };
  }

  // No account, or membership isn't active (unpaid/refunded) — say nothing.
  if (!member || member.payment_status !== 'active') {
    return genericResponse;
  }

  // Rate limit: if a link was already requested for this email in the
  // last 60 seconds, don't send another one. Prevents someone spamming
  // the endpoint for a given address (their own or someone else's).
  const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
  const { data: recentLink } = await supabase
    .from('magic_links')
    .select('id')
    .eq('email', email)
    .gte('created_at', oneMinuteAgo)
    .limit(1)
    .maybeSingle();

  if (recentLink) {
    return genericResponse;
  }

  // Generate the token: raw version goes in the email, only the hash is stored.
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000).toISOString();

  const { error: insertError } = await supabase
    .from('magic_links')
    .insert({ email, token_hash: tokenHash, expires_at: expiresAt });

  if (insertError) {
    console.error('Error creating magic link:', insertError);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong' }) };
  }

  const loginUrl = `${process.env.SITE_URL}/.netlify/functions/magic-link?token=${rawToken}`;

  try {
    await resend.emails.send({
      from: 'HUEBLOC Trading <access@mail.huebloc.com>', // must match the subdomain verified in Resend
      to: email,
      subject: 'Your HUEBLOC sign-in link',
      html: `
        <p>Click below to sign in to your HUEBLOC account. This link expires in ${TOKEN_TTL_MINUTES} minutes and can only be used once.</p>
        <p><a href="${loginUrl}">Sign in to HUEBLOC Trading</a></p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });
  } catch (emailError) {
    console.error('Error sending magic link email:', emailError);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong sending the email' }) };
  }

  return genericResponse;
}

// ============================================================
// STEP 2 — Member clicks the link, we verify + log them in
// ============================================================
async function handleVerifyLink(event) {
  const rawToken = event.queryStringParameters?.token;
  const redirectBase = process.env.SITE_URL;

  if (!rawToken) {
    return redirectTo(`${redirectBase}/client-area.html?error=missing_token`);
  }

  const tokenHash = hashToken(rawToken);

  const { data: link, error: linkError } = await supabase
    .from('magic_links')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (linkError || !link) {
    return redirectTo(`${redirectBase}/client-area.html?error=invalid_link`);
  }
  if (link.used_at) {
    return redirectTo(`${redirectBase}/client-area.html?error=link_already_used`);
  }
  if (new Date(link.expires_at) < new Date()) {
    return redirectTo(`${redirectBase}/client-area.html?error=link_expired`);
  }

  // Re-check membership is still active — it may have lapsed since the email was sent.
  const { data: member, error: memberError } = await supabase
    .from('members')
    .select('email, payment_status')
    .eq('email', link.email)
    .maybeSingle();

  if (memberError || !member || member.payment_status !== 'active') {
    return redirectTo(`${redirectBase}/client-area.html?error=membership_inactive`);
  }

  // Burn the token so it can't be used again.
  await supabase
    .from('magic_links')
    .update({ used_at: new Date().toISOString() })
    .eq('id', link.id);

  // Issue a session as a signed, httpOnly cookie.
  const sessionToken = jwt.sign(
    { email: member.email },
    process.env.JWT_SECRET,
    { expiresIn: `${SESSION_TTL_DAYS}d` }
  );

  const cookie = [
    `hueb_session=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}`,
  ].join('; ');

  return {
    statusCode: 302,
    headers: {
      Location: `${redirectBase}/dashboard.html`,
      'Set-Cookie': cookie,
    },
    body: '',
  };
}

function redirectTo(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

// ------------------------------------------------------------
// Reading the session on protected pages/functions later:
//   const jwt = require('jsonwebtoken');
//   const cookie = event.headers.cookie || '';
//   const token = cookie.match(/hueb_session=([^;]+)/)?.[1];
//   try {
//     const { email } = jwt.verify(token, process.env.JWT_SECRET);
//     // email is verified — safe to use to fetch dashboard data
//   } catch {
//     // missing/expired/invalid — redirect to /client-area.html
//   }
//
// Swapping Resend for Postmark: replace the `resend.emails.send(...)` call
// with Postmark's `client.sendEmail({...})` — everything else (token
// generation, hashing, expiry) stays the same.
// ------------------------------------------------------------
