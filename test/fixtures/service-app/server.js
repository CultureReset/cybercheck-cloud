// A service app. No UI, no surfaces, no browser.
//
// It authenticates with the client secret it was given at install, and the
// platform calls it back with a token of its own when another app invokes its
// capability or when an event it subscribed to fires. Ninety lines, and it
// composes with any app on the platform without either of them knowing the
// other exists.

import express from 'express';

// Read at call time rather than at import, so the same module can be pointed
// at a different platform without being reloaded.
const platform = () => process.env.PLATFORM_URL ?? 'http://localhost:4000';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Another app called notify.send. The platform passes a token minted for *this*
// installation, so the work below runs with this app's own permissions.
app.post('/capabilities/notify.send', async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'no token' });

  const { to, body, reason = null } = req.body ?? {};
  if (!to || !body) return res.status(400).json({ error: 'to and body are required' });

  const message = await call(token, 'POST', '/v1/app/data/messages', { to, body, reason });
  console.log(`notifier: → ${to}: ${body}`);
  return res.json({ sent: true, id: message.row.id, calledBy: req.get('x-cybercheck-caller') });
});

// A song was requested somewhere on the platform. This app never asked the
// other one for anything; it subscribed to a name.
app.post('/events/song-request', async (req, res) => {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'no token' });

  const { payload } = req.body ?? {};
  await call(token, 'POST', '/v1/app/data/messages', {
    to: payload?.by ?? 'unknown',
    body: `Heard you: "${payload?.song}" is in the queue.`,
    reason: 'song_request.created',
  });
  res.json({ handled: true });
});

// Used when this app acts on its own schedule rather than in response to a call.
export async function selfToken() {
  const response = await fetch(`${platform()}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      installation_id: process.env.INSTALLATION_ID,
      client_secret: process.env.CLIENT_SECRET,
    }),
  });
  if (!response.ok) throw new Error(`token: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

async function call(token, method, path, body) {
  const response = await fetch(platform() + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

const bearer = req => {
  const header = req.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7) : null;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT ?? 4102;
  app.listen(port, () => console.log(`notifier listening on http://localhost:${port}`));
}

export { app };
