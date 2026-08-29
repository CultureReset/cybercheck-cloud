import { Router } from 'express';
import * as oauth from '../../oauth.js';
import { jwks } from '../../tokens.js';
import { badRequest } from '../../errors.js';

export const router = Router();

// Called from an app's own origin, so it needs CORS. The reply is a token, and
// the Origin header is checked against the app's pinned runtime origin before
// one is issued.
router.options('/token', (req, res) => {
  cors(req, res);
  res.sendStatus(204);
});

router.post('/token', async (req, res, next) => {
  cors(req, res);
  try {
    const grant = req.body?.grant_type;
    if (grant === 'authorization_code') {
      return res.json(await oauth.exchangeCode({
        code: req.body.code,
        codeVerifier: req.body.code_verifier ?? null,
        requestOrigin: req.get('origin') ?? null,
      }));
    }
    if (grant === 'client_credentials') {
      return res.json(await oauth.clientCredentials({
        installationId: req.body.installation_id,
        clientSecret: req.body.client_secret,
      }));
    }
    throw badRequest('grant_type must be authorization_code or client_credentials');
  } catch (e) { next(e); }
});

router.get('/jwks.json', async (req, res, next) => {
  try { res.json(await jwks()); } catch (e) { next(e); }
});

// Any origin may *ask*; only the bound origin gets a token back. Widening this
// header does not widen what a code can do.
function cors(req, res) {
  res.set('access-control-allow-origin', req.get('origin') ?? '*');
  res.set('access-control-allow-headers', 'content-type');
  res.set('access-control-allow-methods', 'POST, OPTIONS');
  res.set('vary', 'origin');
}
