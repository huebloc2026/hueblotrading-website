// netlify/functions/mark-lesson-complete.js
//
// POST /.netlify/functions/mark-lesson-complete   { lessonId }
//
// Records that the logged-in member has completed a lesson. Same
// session-checking pattern as get-curriculum.js.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const cookieHeader = event.headers.cookie || '';
  const token = cookieHeader.match(/hueb_session=([^;]+)/)?.[1];
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  let email;
  try {
    ({ email } = jwt.verify(token, process.env.JWT_SECRET));
  } catch {
    return { statusCode: 401, body: JSON.stringify({ error: 'Session invalid or expired' }) };
  }

  const { data: member } = await supabase
    .from('members')
    .select('email, payment_status')
    .eq('email', email)
    .maybeSingle();

  if (!member || member.payment_status !== 'active') {
    return { statusCode: 401, body: JSON.stringify({ error: 'Membership not active' }) };
  }

  let lessonId;
  try {
    ({ lessonId } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!lessonId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'lessonId is required' }) };
  }

  const { error } = await supabase
    .from('lesson_progress')
    .upsert(
      { member_email: email, lesson_id: lessonId },
      { onConflict: 'member_email,lesson_id' }
    );

  if (error) {
    console.error('Error marking lesson complete:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
