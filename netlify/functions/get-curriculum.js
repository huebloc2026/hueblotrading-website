// netlify/functions/get-curriculum.js
//
// GET /.netlify/functions/get-curriculum
//
// Returns the full Playbook curriculum (phases, lessons, videos) PLUS
// the requesting member's own completed-lesson list — but ONLY to
// someone with a valid, active session. This is what keeps the
// curriculum from being a public free-for-all: there's no public
// Supabase policy granting read access (see supabase-schema.sql), so
// the only way to read this data at all is through this function,
// which checks the session cookie first.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ---- 1. Verify the session, same check used to guard the dashboard ----
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

  // ---- 2. Pull the curriculum ----
  try {
    const [{ data: phases, error: phasesErr }, { data: lessons, error: lessonsErr }, { data: videos, error: videosErr }, { data: progress, error: progressErr }] =
      await Promise.all([
        supabase.from('phases').select('*').order('phase_number', { ascending: true }),
        supabase.from('lessons').select('*').order('lesson_number', { ascending: true }),
        supabase.from('phase_videos').select('*').order('part_number', { ascending: true }),
        supabase.from('lesson_progress').select('lesson_id').eq('member_email', email),
      ]);

    if (phasesErr) throw phasesErr;
    if (lessonsErr) throw lessonsErr;
    if (videosErr) throw videosErr;
    if (progressErr) throw progressErr;

    // Nest lessons and videos under their phase, so the frontend doesn't
    // have to do the joining itself.
    const completedLessonIds = (progress || []).map((p) => p.lesson_id);
    const structured = (phases || []).map((phase) => ({
      ...phase,
      lessons: (lessons || [])
        .filter((l) => l.phase_id === phase.id)
        .map((l) => ({ ...l, completed: completedLessonIds.includes(l.id) })),
      videos: (videos || []).filter((v) => v.phase_id === phase.id),
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ phases: structured }),
    };
  } catch (err) {
    console.error('Error fetching curriculum:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong' }) };
  }
};
