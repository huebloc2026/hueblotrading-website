// netlify/functions/logout.js
//
// GET /.netlify/functions/logout
//
// Clears the hueb_session cookie and redirects to the Client Area.
// This has to be a server-side function rather than plain JS because
// the session cookie is httpOnly — client-side JS can't read or clear
// it directly, only a server response can overwrite it.

exports.handler = async () => {
  const expiredCookie = [
    'hueb_session=',
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0', // tells the browser to delete it immediately
  ].join('; ');

  return {
    statusCode: 302,
    headers: {
      Location: `${process.env.SITE_URL}/client-area.html`,
      'Set-Cookie': expiredCookie,
    },
    body: '',
  };
};
