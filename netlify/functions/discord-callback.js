// netlify/functions/discord-callback.js
//
// GET /.netlify/functions/discord-callback?code=...
//
// This is where Discord redirects the member back to after they click
// "Connect Discord" and authorize the app. It:
//   1. Verifies the member is logged in and has active access
//   2. Exchanges Discord's temporary code for an access token
//   3. Looks up the member's Discord user ID
//   4. Adds them to the server (or no-ops if already a member)
//   5. Assigns the paid member role
//   6. Saves their Discord ID so future refunds can remove the role
//
// Env vars required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET  (existing)
//   DISCORD_CLIENT_ID       from the Discord Developer Portal
//   DISCORD_CLIENT_SECRET   from the Discord Developer Portal
//   DISCORD_BOT_TOKEN       from the bot you added to the application
//   DISCORD_GUILD_ID        Craig's Discord server ID
//   DISCORD_ROLE_ID         the paid-member role ID in that server
//   SITE_URL                already set — used to build the redirect URI

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const redirectBase = process.env.SITE_URL;

  // ---- 1. Confirm the member is logged in and active ----
  const cookieHeader = event.headers.cookie || '';
  const sessionToken = cookieHeader.match(/hueb_session=([^;]+)/)?.[1];
  if (!sessionToken) {
    return redirectTo(`${redirectBase}/client-area.html?error=session_required`);
  }

  let email;
  try {
    ({ email } = jwt.verify(sessionToken, process.env.JWT_SECRET));
  } catch {
    return redirectTo(`${redirectBase}/client-area.html?error=session_required`);
  }

  const { data: member } = await supabase
    .from('members')
    .select('email, payment_status')
    .eq('email', email)
    .maybeSingle();

  if (!member || member.payment_status !== 'active') {
    return redirectTo(`${redirectBase}/dashboard.html?discord=inactive`);
  }

  // ---- 2. Exchange the Discord code for an access token ----
  const code = event.queryStringParameters?.code;
  if (!code) {
    return redirectTo(`${redirectBase}/dashboard.html?discord=error`);
  }

  const redirectUri = `${redirectBase}/.netlify/functions/discord-callback`;

  let discordAccessToken;
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token in Discord response');
    discordAccessToken = tokenData.access_token;
  } catch (err) {
    console.error('Error exchanging Discord code:', err);
    return redirectTo(`${redirectBase}/dashboard.html?discord=error`);
  }

  // ---- 3. Get the member's Discord user ID ----
  let discordUser;
  try {
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${discordAccessToken}` },
    });
    discordUser = await userRes.json();
    if (!discordUser.id) throw new Error('No user ID in Discord response');
  } catch (err) {
    console.error('Error fetching Discord user:', err);
    return redirectTo(`${redirectBase}/dashboard.html?discord=error`);
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  const roleId = process.env.DISCORD_ROLE_ID;
  const botAuth = `Bot ${process.env.DISCORD_BOT_TOKEN}`;

  // ---- 4. Add them to the server ----
  // Returns 201 if newly added, 204 if already a member — both are fine.
  // Pre-assigning the role here only takes effect on a fresh 201 join,
  // so step 5 explicitly assigns the role too, covering existing members.
  try {
    await fetch(`https://discord.com/api/guilds/${guildId}/members/${discordUser.id}`, {
      method: 'PUT',
      headers: { Authorization: botAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: discordAccessToken, roles: [roleId] }),
    });
  } catch (err) {
    console.error('Error adding member to Discord guild:', err);
    // Continue anyway — they may already be a member, which is fine.
  }

  // ---- 5. Explicitly assign the role (covers members who already joined) ----
  try {
    const roleRes = await fetch(
      `https://discord.com/api/guilds/${guildId}/members/${discordUser.id}/roles/${roleId}`,
      { method: 'PUT', headers: { Authorization: botAuth } }
    );
    if (!roleRes.ok && roleRes.status !== 204) {
      const errBody = await roleRes.text();
      console.error('Error assigning Discord role:', roleRes.status, errBody);
      return redirectTo(`${redirectBase}/dashboard.html?discord=error`);
    }
  } catch (err) {
    console.error('Error assigning Discord role:', err);
    return redirectTo(`${redirectBase}/dashboard.html?discord=error`);
  }

  // ---- 6. Save their Discord ID so refunds/disputes can remove the role later ----
  const { error: updateError } = await supabase
    .from('members')
    .update({ discord_user_id: discordUser.id, discord_username: discordUser.username })
    .eq('email', email);

  if (updateError) {
    console.error('Error saving Discord connection:', updateError);
    // Role is already assigned at this point, so don't block success on this.
  }

  return redirectTo(`${redirectBase}/dashboard.html?discord=connected`);
};

function redirectTo(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}
