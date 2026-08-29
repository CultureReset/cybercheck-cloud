// Two ways to be authenticated, and they never overlap.
//
//   requireUser   a human with a platform session — the store, the dashboard
//   requireApp    an installation with a scoped token — everything under /v1/app
//
// A session cannot call an app route and an app token cannot call a user route.
// That is not a convention; it is two different middlewares that read two
// different credentials and set two different properties on the request.

import { verify } from '../tokens.js';
import { resolveSession, requireWorkspace } from '../identity.js';
import { liveScope } from '../oauth.js';
import { unauthorized, forbidden } from '../errors.js';

export const SESSION_COOKIE = 'cc_session';

export function sessionToken(req) {
  const header = req.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7);
  const cookie = req.get('cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function requireUser(req, res, next) {
  resolveSession(sessionToken(req))
    .then(({ user, sessionId }) => { req.user = user; req.sessionId = sessionId; next(); })
    .catch(next);
}

// The workspace id in the URL is a claim until this has checked it against
// membership. Handlers read req.workspace, never req.params.
export function requireWorkspaceRole(roles) {
  return (req, res, next) => {
    requireWorkspace(req.user.id, req.params.workspaceId, roles)
      .then(workspace => { req.workspace = workspace; next(); })
      .catch(next);
  };
}

export function requireApp(req, res, next) {
  const header = req.get('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return next(unauthorized('A bearer token is required'));

  verify(header.slice(7))
    .then(async claims => {
      if (!claims.inst) throw unauthorized('This token is not an app token');
      req.app_ctx = {
        installationId: claims.inst,
        appId: claims.aud,
        workspaceId: claims.ws,
        namespace: claims.ns,
        userId: claims.sub?.startsWith('installation:') ? null : claims.sub,
        surfaceId: claims.surface ?? null,
        anonymous: claims.anon === true,
      };
      // Read the grants now rather than trusting the ones baked into the token.
      // A permission revoked after the token was minted stops working at once,
      // instead of at the end of its fifteen minutes.
      // A public token's scope was narrowed when it was minted and must not be
      // re-widened here; every other token reads the grants as they stand now,
      // so a revocation takes effect at once rather than in fifteen minutes.
      req.app_ctx.scope = new Set(
        claims.anon === true ? (claims.scope ?? []) : await liveScope(claims.inst)
      );
      next();
    })
    .catch(next);
}

export function requireScope(...permissions) {
  return (req, res, next) => {
    const missing = permissions.filter(p => !req.app_ctx.scope.has(p));
    if (missing.length) {
      return next(forbidden(`This app has not been granted ${missing.join(', ')}`, { missing }));
    }
    next();
  };
}
