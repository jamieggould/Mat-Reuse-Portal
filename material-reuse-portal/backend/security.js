/* =====================================================================
   material reuse — security layer
   · Rate limits: sliding-window buckets per IP and per user, tuned per
     route class (auth, sign-up, password reset, checkout, chat, uploads,
     public API, everything else). 429 with Retry-After.
   · Request body cap (JSON 256 KB; uploads 14 MB) so nobody can exhaust
     memory with a giant POST.
   · Security headers on every response (CSP, HSTS, frame rules that still
     let the website embed /marketplace and /embed/*, no MIME sniffing,
     referrer policy, permissions policy).
   · CORS: wide open only for /api/public/* and /api/health; nothing else.
   · Photo/document URL allow-list so nobody can store a javascript: or
     third-party URL that an admin later clicks.
   · TOTP (authenticator-app) two-factor for admins — no dependencies.
   ===================================================================== */
'use strict';
const crypto = require('crypto');

const ENV = {
  PORTAL_URL: (process.env.PORTAL_URL || 'https://www.materialreusehub.co.uk').replace(/\/+$/, ''),
  EMBED_ORIGINS: (process.env.EMBED_ORIGINS || 'https://material-reuse.co.uk https://www.material-reuse.co.uk https://www.materialreusehub.co.uk https://materialreusehub.co.uk').split(/\s+/).filter(Boolean),
  TRUST_PROXY: (process.env.TRUST_PROXY || 'true') !== 'false', // Render sits behind a proxy → X-Forwarded-For is the client
  RATE_MULTIPLIER: Math.max(0.1, +process.env.RATE_MULTIPLIER || 1), // raise if a big office shares one IP
};

/* ---------------- rate limiting ---------------- */
// name: [max hits, window seconds]
const LIMITS = {
  global: [600, 60],        // any IP: 600 requests a minute (the SPA loads ~6 per page)
  public: [120, 60],        // /api/public/*, /marketplace, /embed, /api/qr — scraping / QR-relay abuse
  login: [20, 900],         // password attempts per IP per 15 min (on top of the per-email lock)
  register: [5, 3600],      // account creation per IP per hour (stops welcome-email spam)
  forgot: [5, 3600],        // reset emails per IP per hour; also 3 per email per hour below
  forgotEmail: [3, 3600],
  checkout: [30, 3600],     // Stripe sessions per IP per hour
  chat: [60, 3600],         // per user per hour (the model bill)
  suggest: [60, 3600],      // AI pricing per admin per hour
  upload: [40, 3600],       // files per user per hour
  write: [120, 900],        // any other POST/PATCH/DELETE per user per 15 min
  wishlist: [10, 3600],     // wishlist entries per user per hour (each emails Kallie)
  audit: [3, 86400],        // audit requests per user per day
  evidence: [20, 3600],
};
const buckets = new Map(); // key → [timestamps]
setInterval(() => { const cutoff = Date.now() - 86400e3; for (const [k, arr] of buckets) { const keep = arr.filter((t) => t > cutoff); if (keep.length) buckets.set(k, keep); else buckets.delete(k); } }, 10 * 60e3).unref();
function hit(kind, id) {
  const [max0, win] = LIMITS[kind] || LIMITS.write;
  const max = Math.ceil(max0 * ENV.RATE_MULTIPLIER);
  const key = `${kind}:${id}`, now = Date.now(), cutoff = now - win * 1000;
  const arr = (buckets.get(key) || []).filter((t) => t > cutoff);
  if (arr.length >= max) { buckets.set(key, arr); return { ok: false, retry: Math.ceil((arr[0] + win * 1000 - now) / 1000) }; }
  arr.push(now); buckets.set(key, arr); return { ok: true };
}
const clientIp = (req) => {
  const xf = ENV.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '') : '';
  return (xf.split(',')[0] || req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
};
function tooMany(res, r, msg) {
  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(r.retry || 60), 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: msg || `Too many requests — please wait ${r.retry > 90 ? Math.ceil(r.retry / 60) + ' minutes' : (r.retry || 60) + ' seconds'} and try again.` }));
  return false;
}
// Decide which bucket(s) a request falls in. Returns true to continue, false if a 429 was sent.
function gate(req, res, { pathname, method, userId, isAdmin }) {
  const ip = clientIp(req);
  let r = hit('global', ip); if (!r.ok) return tooMany(res, r);
  const p = pathname;
  const perIp = (kind, msg) => { const x = hit(kind, ip); return x.ok ? true : tooMany(res, x, msg); };
  const perUser = (kind, msg) => { const x = hit(kind, userId || ip); return x.ok ? true : tooMany(res, x, msg); };
  if (/^\/api\/public\/|^\/marketplace|^\/embed\/|^\/api\/qr/.test(p)) return perIp('public');
  if (method === 'POST' && p === '/api/auth/login') return perIp('login', 'Too many sign-in attempts from this network — try again in a few minutes.');
  if (method === 'POST' && p === '/api/auth/register') return perIp('register', 'Too many new accounts from this network — try again later.');
  if (method === 'POST' && p === '/api/auth/forgot') return perIp('forgot', 'Too many reset requests — try again later.');
  if (p === '/api/checkout' || p === '/api/orders/checkout' || p.startsWith('/api/membership/')) return perUser('checkout', 'Too many checkout attempts — please wait a few minutes.');
  if (method === 'POST' && p === '/api/chat') return perUser('chat', 'You’ve sent a lot of messages in the last hour — give it a little while.');
  if (method === 'POST' && p === '/api/admin/suggest') return perUser('suggest');
  if (method === 'POST' && p === '/api/uploads') return perUser('upload', 'Upload limit reached for this hour.');
  if (method === 'POST' && p === '/api/wishlist') return perUser('wishlist', 'Wishlist limit reached for this hour.');
  if (method === 'POST' && p === '/api/audit-request') return perUser('audit', 'You’ve already requested an audit today.');
  if (method === 'POST' && /\/evidence$/.test(p)) return perUser('evidence');
  if (method !== 'GET' && method !== 'OPTIONS' && !isAdmin) return perUser('write');
  return true;
}
const forgotEmailOk = (email) => hit('forgotEmail', String(email || '').toLowerCase()).ok;

/* ---------------- request body cap ---------------- */
const JSON_LIMIT = 256 * 1024, UPLOAD_LIMIT = 14 * 1024 * 1024;
const readBody = (req, limit) =>
  new Promise((resolve) => {
    const max = limit || (req.url.startsWith('/api/uploads') || /\/evidence$/.test(req.url) ? UPLOAD_LIMIT : JSON_LIMIT);
    let raw = '', size = 0, over = false;
    req.on('data', (c) => { size += c.length; if (size > max) { over = true; raw = ''; if (req._res && !req._res.headersSent) { req._res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }); req._res.end(JSON.stringify({ error: 'That request is too large.' })); } req.destroy(); } else raw += c; });
    req.on('end', () => { if (over) { req._body = {}; req._tooLarge = true; return resolve({}); } try { req._body = raw ? JSON.parse(raw) : {}; } catch { req._body = {}; } resolve(req._body); });
    req.on('close', () => { if (over) resolve({}); });
  });

/* ---------------- headers ---------------- */
const isHttps = (req) => ENV.TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' : !!req.socket.encrypted;
function securityHeaders(req, res, pathname) {
  const embeddable = /^\/(marketplace|embed\/)/.test(pathname);
  const frame = embeddable ? `frame-ancestors 'self' ${ENV.EMBED_ORIGINS.join(' ')}` : "frame-ancestors 'none'";
  // Inline handlers are used throughout the SPA, so scripts allow 'unsafe-inline' from self only; no third-party scripts can load.
  const csp = [`default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' data: blob: https:`, `connect-src 'self' https://*.supabase.co`, `frame-src https://checkout.stripe.com https://billing.stripe.com`, `form-action 'self' https://checkout.stripe.com https://billing.stripe.com`,
    `object-src 'none'`, `base-uri 'self'`, frame].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(self "https://checkout.stripe.com")');
  if (!embeddable) res.setHeader('X-Frame-Options', 'DENY');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
}
// CORS only where the data is public anyway
const corsOpen = (pathname) => /^\/api\/(public\/|health)/.test(pathname);

/* ---------------- canonical host ---------------- */
// The old onrender address (and bare domain) redirect to the custom domain so there is one origin for sessions, Stripe and QR links.
function canonicalRedirect(req, res, pathname) {
  const host = String(req.headers.host || '').toLowerCase();
  let canonical; try { canonical = new URL(ENV.PORTAL_URL).host.toLowerCase(); } catch (e) { return false; }
  if (!host || host === canonical || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || pathname === '/api/health') return false;
  if (!/onrender\.com$|materialreusehub\.co\.uk$/.test(host)) return false; // unknown hosts (e.g. preview) are left alone
  res.writeHead(301, { Location: `${ENV.PORTAL_URL}${req.url}` }); res.end(); return true;
}

/* ---------------- URL allow-list for stored photos/documents ---------------- */
function safeFileUrl(u, supaUrl) {
  const s = String(u || '');
  if (/^\/uploads\/[\w\-./]+$/.test(s) && !s.includes('..')) return true;
  if (supaUrl && s.startsWith(`${supaUrl}/storage/v1/object/public/portal-files/`)) return true;
  if (s.startsWith(`${ENV.PORTAL_URL}/uploads/`)) return true;
  return false;
}

/* ---------------- TOTP (RFC 6238) — authenticator apps, no dependencies ---------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) { let bits = 0, value = 0, out = ''; for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(value << (5 - bits)) & 31]; return out; }
function base32Decode(str) { const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = 0, value = 0; const out = []; for (const c of s) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totpCode(secret, counter) {
  const key = base32Decode(secret); const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0); msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(msg).digest(); const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const totpSecret = () => base32Encode(crypto.randomBytes(20));
function totpVerify(secret, code) {
  const c = String(code || '').replace(/\s+/g, ''); if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) { const want = totpCode(secret, now + d); if (want.length === c.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) return true; }
  return false;
}
const totpUri = (secret, label, issuer = 'Material Reuse Group') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

module.exports = { ENV, LIMITS, hit, gate, forgotEmailOk, clientIp, readBody, securityHeaders, corsOpen, canonicalRedirect, safeFileUrl, totpSecret, totpVerify, totpUri, totpCode };
