/* =====================================================================
   material reuse — auth helpers
   Persisted sessions, login rate limiting, PBKDF2 password hashing.
   ===================================================================== */
'use strict';
const crypto = require('crypto');

module.exports = function install({ db, saveSessions }) {
  // Sessions persist (Supabase/disk) so a redeploy or restart doesn't sign everyone out. 30-day expiry.
  const SESSION_DAYS = +process.env.SESSION_DAYS || 30;
  const SESSIONS = {
    get(t) { const s = db.sessions[t]; if (!s) return undefined; if (s.exp < Date.now()) { delete db.sessions[t]; return undefined; } return s.uid; },
    set(t, uid) { db.sessions[t] = { uid, exp: Date.now() + SESSION_DAYS * 864e5 }; SESSIONS.sweep(); saveSessions(); },
    delete(t) { delete db.sessions[t]; saveSessions(); },
    deleteUser(uid) { for (const t of Object.keys(db.sessions)) if (db.sessions[t].uid === uid) delete db.sessions[t]; saveSessions(); },
    sweep() { const now = Date.now(); for (const t of Object.keys(db.sessions)) if (db.sessions[t].exp < now) delete db.sessions[t]; },
  };

  // Login rate limiting: 10 failed attempts per email, or 60 per IP (offices share IPs), in 15 minutes → 429
  const FAILS = new Map();
  const failKey = (k) => { const f = FAILS.get(k); if (!f || f.until < Date.now()) return null; return f; };
  const noteFail = (k) => { const f = FAILS.get(k); if (f && f.until > Date.now()) f.n++; else FAILS.set(k, { n: 1, until: Date.now() + 15 * 60e3 }); };
  const tooMany = (k) => { const f = failKey(k); return f && f.n >= (k.startsWith("ip:") ? 60 : 10); };
  const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  // New passwords: at least 10 characters with a letter and a number (existing passwords keep working)
  const weakPassword = (pw) => { const p = String(pw || ''); return p.length < 10 || !/[a-zA-Z]/.test(p) || !/[0-9]/.test(p); };
  const PW_RULE = 'Password must be at least 10 characters and include a letter and a number.';

  const hashPw = (pw, salt) =>
    crypto.pbkdf2Sync(String(pw), salt, 60000, 32, 'sha256').toString('hex');

  const makeAuth = (pw) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: hashPw(pw, salt), mustChange: true };
  };

  const checkPw = (u, pw) => {
    if (!u.auth) return false;
    const h = Buffer.from(hashPw(pw, u.auth.salt), 'hex');
    const s = Buffer.from(u.auth.hash, 'hex');
    return h.length === s.length && crypto.timingSafeEqual(h, s);
  };

  const safeUser = (u) => {
    const { auth, reset, ...rest } = u;
    return { ...rest, mustChange: !!(auth && auth.mustChange) };
  };


  return { SESSIONS, noteFail, tooMany, clientIp, weakPassword, PW_RULE, hashPw, makeAuth, checkPw, safeUser, FAILS };
};
