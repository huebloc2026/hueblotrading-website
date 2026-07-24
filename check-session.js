// netlify/functions/check-session.js
//
// GET /.netlify/functions/check-session
//
// Reads the hueb_session cookie, verifies it, and confirms the member
// is still active (in case their access was revoked after the cookie
// was issued). Called by dashboard.html on page load — if this returns
// 401, the page redirects to client-area.html instead of showing content.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const cookieHeader = event.headers.cookie || '';
  const token = cookieHeader.match(/hueb_session=([^;]+)/)?.[1];

  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ authenticated: false }) };
  }

  let email;
  try {
    ({ email } = jwt.verify(token, process.env.JWT_SECRET));
  } catch {
    return { statusCode: 401, body: JSON.stringify({ authenticated: false }) };
  }

  // Re-check they're still active — access could have been refunded/disputed
  // since this session cookie was issued up to 7 days ago.
  const { data: member } = await supabase
    .from('members')
    .select('email, payment_status')
    .eq('email', email)
    .maybeSingle();

  if (!member || member.payment_status !== 'active') {
    return { statusCode: 401, body: JSON.stringify({ authenticated: false }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ authenticated: true, email: member.email }),
  };
};
