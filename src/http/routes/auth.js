import { Router } from 'express';
import * as identity from '../../identity.js';
import { requireUser, sessionToken, SESSION_COOKIE } from '../auth.js';

export const router = Router();

const setSessionCookie = (res, session) =>
  res.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    expires: new Date(session.expiresAt),
  });

router.post('/register', async (req, res, next) => {
  try {
    const { user, workspace } = await identity.register(req.body ?? {});
    const session = await identity.createSession(user.id);
    setSessionCookie(res, session);
    res.status(201).json({ user, workspace, session: { token: session.token, expiresAt: session.expiresAt } });
  } catch (e) { next(e); }
});

router.post('/sign-in', async (req, res, next) => {
  try {
    const { user, session } = await identity.signIn(req.body ?? {});
    setSessionCookie(res, session);
    res.json({ user, session: { token: session.token, expiresAt: session.expiresAt } });
  } catch (e) { next(e); }
});

router.post('/sign-out', async (req, res, next) => {
  try {
    await identity.signOut(sessionToken(req));
    res.clearCookie(SESSION_COOKIE);
    res.json({ signedOut: true });
  } catch (e) { next(e); }
});

router.get('/me', requireUser, async (req, res, next) => {
  try {
    res.json({ user: req.user, workspaces: await identity.workspacesFor(req.user.id) });
  } catch (e) { next(e); }
});
