// Access tokens for apps.
//
// The platform session and an app token are different things and must never be
// interchangeable. A session says "this human is logged in". An app token says
// "this installation, in this workspace, may do exactly these things, for the
// next few minutes". An app only ever receives the second kind.

import crypto from 'node:crypto';
import { q, one } from './db.js';
import { unauthorized } from './errors.js';
import { config } from './config.js';

let cached = null;

export async function signingKey() {
  if (cached) return cached;
  const live = await one(
    'select * from platform.signing_keys where retired_at is null order by created_at desc limit 1'
  );
  if (live) {
    cached = live;
    return live;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(8).toString('hex');
  cached = await one(
    `insert into platform.signing_keys (kid, public_pem, private_pem) values ($1, $2, $3) returning *`,
    [kid,
     publicKey.export({ type: 'spki', format: 'pem' }),
     privateKey.export({ type: 'pkcs8', format: 'pem' })]
  );
  return cached;
}

const b64url = buffer => Buffer.from(buffer).toString('base64url');

export async function sign(claims, { ttlSeconds = config.accessTokenTtlSeconds } = {}) {
  const key = await signingKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: key.kid };
  const payload = { ...claims, iat: now, exp: now + ttlSeconds, iss: 'cybercheck-platform' };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(body), key.private_pem);
  return { token: `${body}.${b64url(signature)}`, expiresIn: ttlSeconds, payload };
}

export async function verify(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) throw unauthorized('Malformed token');

  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  } catch {
    throw unauthorized('Malformed token');
  }
  if (header.alg !== 'RS256') throw unauthorized('Unsupported token algorithm');

  // Retired keys still verify until their tokens expire, so a rotation does not
  // log every app out at once.
  const key = await one('select * from platform.signing_keys where kid = $1', [header.kid]);
  if (!key) throw unauthorized('Unknown signing key');

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key.public_pem,
    Buffer.from(parts[2], 'base64url')
  );
  if (!ok) throw unauthorized('Bad token signature');

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (payload.exp * 1000 < Date.now()) throw unauthorized('Token expired');
  return payload;
}

export async function jwks() {
  const keys = await q('select kid, public_pem from platform.signing_keys');
  return {
    keys: keys.map(k => ({
      ...crypto.createPublicKey(k.public_pem).export({ format: 'jwk' }),
      kid: k.kid, use: 'sig', alg: 'RS256',
    })),
  };
}

export const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// PKCE. The code is useless to whoever intercepts it without the verifier that
// never left the app.
export const challengeFor = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');
