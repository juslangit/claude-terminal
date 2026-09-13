// Access control.
//
// The server runs shells, so two different callers have to be told apart:
// a browser page, and anything else. They need different defences.
//
//   Origin check — a web page cannot forge or omit the Origin header on a
//   cross-origin request, so requiring Origin to match the host the page was
//   served from stops any site the user happens to visit from driving this
//   server. This is the one that matters: `127.0.0.1` is reachable from every
//   page in the browser, and Tailscale cannot help with an attack that starts
//   inside the user's own browser.
//
//   Token — a random per-install secret, required on the API and on the
//   WebSocket upgrade. It covers the case the Origin check cannot see: a
//   request that never came from a browser at all, including one arriving
//   because someone exposed the port beyond loopback by mistake.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function ensureToken(dataDir) {
  const file = path.join(dataDir, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* not created yet */ }

  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

/**
 * True when the request did not come from a web page on another site.
 *
 * A missing Origin is allowed: that is a non-browser caller such as `curl`,
 * which the token still has to satisfy. Browsers always send Origin on the
 * cross-origin requests this is guarding against.
 *
 * A reverse proxy sits in front of this in normal use — `tailscale serve`
 * terminates TLS on the tailnet and forwards to loopback. Whether such a proxy
 * preserves the original Host header or replaces it with the backend's address
 * varies, so the origin is accepted if it matches either the Host header or the
 * forwarded one. Anything else can be named explicitly in CT_ALLOWED_ORIGINS.
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  let originHost;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    originHost = parsed.host;
  } catch { return false; }

  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  if (originHost === req.headers.host) return true;
  if (forwarded && originHost === forwarded) return true;

  return allowedOrigins().some((allowed) => allowed === origin || allowed === originHost);
}

/** Extra origins the operator has vouched for, e.g. a tailnet URL. */
function allowedOrigins() {
  return String(process.env.CT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Constant-time comparison, so the token cannot be guessed a byte at a time. */
export function tokenMatches(token, given) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(given));
}

/** Pull the token from a header or the query string (WebSockets cannot set headers). */
export function tokenFrom(req, url) {
  return req.headers['x-ct-token'] || url?.searchParams.get('token') || '';
}
