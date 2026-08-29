// The client library an app loads. This is the whole developer-facing API.
//
//   import { connect } from 'https://<platform>/sdk/app.js';
//   const cc = await connect();
//   const rows = await cc.table('requests').list();
//
// The app never handles a platform session, never sees another app's data, and
// never needs a server of its own. It is a static page with a manifest.

const PARAMS = new URLSearchParams(location.search);

export class AppError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.name = 'AppError';
    this.status = status;
    this.code = body?.error?.code ?? 'unknown';
    this.detail = body?.error?.detail;
  }
}

export async function connect({ platform, code } = {}) {
  const origin = platform ?? PARAMS.get('cc_platform') ?? inferPlatformOrigin();
  const handoffCode = code ?? PARAMS.get('cc_code');
  if (!handoffCode) {
    throw new Error('No handoff code. This page must be opened from the platform, not directly.');
  }
  return new Client(origin, await exchange(origin, handoffCode));
}

async function exchange(origin, code) {
  const response = await fetch(`${origin}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const body = await response.json();
  if (!response.ok) throw new AppError(response.status, body);
  return body;
}

class Client {
  #origin;
  #token;
  #expiresAt;

  constructor(origin, grant) {
    this.#origin = origin;
    this.#token = grant.access_token;
    this.#expiresAt = Date.now() + grant.expires_in * 1000;
    this.context = grant.context;
    this.scope = grant.scope.split(' ').filter(Boolean);
  }

  can(permission) { return this.scope.includes(permission); }

  // A table this app declared in its manifest. No permission is involved —
  // these rows belong to this app.
  table(name) {
    const path = `/v1/app/data/${encodeURIComponent(name)}`;
    return {
      list: (query = {}) => this.#request('GET', `${path}?${new URLSearchParams(query)}`).then(r => r.rows),
      create: values => this.#request('POST', path, values).then(r => r.row),
      update: (id, values) => this.#request('PATCH', `${path}/${id}`, values).then(r => r.row),
      remove: id => this.#request('DELETE', `${path}/${id}`),
    };
  }

  // Shared workspace records. Needs contacts.read / contacts.write.
  contacts = {
    list: (query = {}) => this.#request('GET', `/v1/app/contacts?${new URLSearchParams(query)}`).then(r => r.contacts),
    upsert: contact => this.#request('POST', '/v1/app/contacts', contact).then(r => r.contact),
    remove: id => this.#request('DELETE', `/v1/app/contacts/${id}`),
  };

  workspace() { return this.#request('GET', '/v1/app/workspace').then(r => r.workspace); }
  members() { return this.#request('GET', '/v1/app/members').then(r => r.members); }

  // Announce something. Other installed apps that subscribed will hear it.
  emit(event, payload = {}) { return this.#request('POST', '/v1/app/events', { event, payload }); }

  // Call a capability by name. Which app answers is the owner's business.
  call(capability, payload = {}) {
    return this.#request('POST', `/v1/app/capabilities/${encodeURIComponent(capability)}`, payload);
  }

  // Tell the host how tall this surface is, so an inline card sizes itself.
  resize(height = document.documentElement.scrollHeight) {
    post({ type: 'cc:resize', height });
  }

  // Ask the host to close a modal surface, or to navigate the platform around
  // this frame. Ignored when the app is running standalone.
  close() { post({ type: 'cc:close' }); }
  navigate(to) { post({ type: 'cc:navigate', to }); }

  async #request(method, path, body) {
    if (Date.now() > this.#expiresAt - 30_000) await this.#refresh();

    const response = await fetch(this.#origin + path, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new AppError(response.status, parsed);
    return parsed;
  }

  // A handoff code is single-use, so the app cannot mint itself a new token.
  // It asks the host, which holds the session, for a fresh one.
  async #refresh() {
    if (window.parent === window) throw new Error('Token expired and there is no host to refresh from');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host did not answer a refresh request')), 10_000);
      const listener = event => {
        if (event.data?.type !== 'cc:code') return;
        clearTimeout(timer);
        window.removeEventListener('message', listener);
        resolve(event.data.code);
      };
      window.addEventListener('message', listener);
      post({ type: 'cc:refresh' });
    });
    const grant = await exchange(this.#origin, code);
    this.#token = grant.access_token;
    this.#expiresAt = Date.now() + grant.expires_in * 1000;
  }
}

function post(message) {
  if (window.parent !== window) window.parent.postMessage(message, '*');
}

// The SDK is served by the platform, so the platform's origin is the origin
// this module was loaded from.
function inferPlatformOrigin() {
  return new URL(import.meta.url).origin;
}
