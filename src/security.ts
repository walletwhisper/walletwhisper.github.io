import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Protects the local API from other websites open in the same browser.
 *
 * - Host check: a page on attacker.example can't reach us through DNS rebinding,
 *   because its requests carry `Host: attacker.example`.
 * - Origin check: browsers send Origin on cross-site requests; anything not from
 *   localhost is refused.
 * - Session token: every request that changes data must send X-App-Token, which only
 *   our own page can read (same-origin `GET /api/session`; there is no CORS).
 */
export const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

export function requestGuard(req: Request, res: Response, next: NextFunction) {
  const host = req.headers.host || '';
  if (!LOCAL_HOST.test(host)) {
    return res.status(403).json({ error: 'Forbidden host' });
  }
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const token = req.headers['x-app-token'];
    const ok = typeof token === 'string' && token.length === SESSION_TOKEN.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(SESSION_TOKEN));
    if (!ok) return res.status(403).json({ error: 'Missing or invalid session token. Reload the page.' });
  }
  next();
}

/** Typed confirmation the UI sends for destructive actions. */
export const RESET_CONFIRMATION = 'DELETE ALL';
