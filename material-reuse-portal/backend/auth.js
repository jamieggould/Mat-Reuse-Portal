/* =====================================================================
   material reuse — auth helpers
   Persisted sessions (members 30 days, admins 12 hours), login rate
   limiting, PBKDF2-SHA256 hashing with stored iteration counts (old
   hashes are upgraded on the next successful sign-in), password rules
   that are stricter for admins.
   ===================================================================== */
'use strict';
const crypto = require('crypto');

module.exports = function install({ db, saveSessions }) {
  const SESSION_DAYS = +process.env.SESSION_DAYS || 30;
  const ADMIN_SESSION_HOURS = +process.env.ADMIN_SESSION_HOURS || 12;
  // Sessions are stored by SHA-256 of the bearer token, so a copy of the database (or a backup) can't be used to sign in.
  const sid = (t) => (t ? crypto.createHash('sha256').update(String(t)).digest('hex') : '');
  const SESSIONS = {
    get(t) { const k = sid(t); const s = db.sessions[k]; if (!s) return undefined; if (s.exp < Date.now()) { delete db.sessions[k]; return undefined; } return s.uid; },
    set(t, uid, isAdmin) { db.sessions[sid(t)] = { uid, exp: Date.now() + (isAdmin ? ADMIN_SESSION_HOURS * 3600e3 : SESSION_DAYS * 864e5), at: Date.now() }; SESSIONS.sweep(); saveSessions(); },
    delete(t) { delete db.sessions[sid(t)]; saveSessions(); },
    deleteUser(uid, keep) { const k = sid(keep); for (const t of Object.keys(db.sessions)) if (db.sessions[t].uid === uid && t !== k) delete db.sessions[t]; saveSessions(); },
    sweep() { const now = Date.now(); for (const t of Object.keys(db.sessions)) if (db.sessions[t].exp < now) delete db.sessions[t]; },
    countFor(uid) { return Object.values(db.sessions).filter((s) => s.uid === uid && s.exp > Date.now()).length; },
  };

  // Login lockout: 10 failed attempts per email, or 60 per IP (offices share IPs), in 15 minutes → 429
  const FAILS = new Map();
  const failKey = (k) => { const f = FAILS.get(k); if (!f || f.until < Date.now()) return null; return f; };
  const noteFail = (k) => { const f = FAILS.get(k); if (f && f.until > Date.now()) f.n++; else FAILS.set(k, { n: 1, until: Date.now() + 15 * 60e3 }); };
  const tooMany = (k) => { const f = failKey(k); return f && f.n >= (k.startsWith('ip:') ? 60 : 10); };
  const clientIp = (req) => { const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean); return (hops.length ? hops[hops.length - 1] : req.socket.remoteAddress || '').replace(/^::ffff:/, ''); };

  // Members: 10+ chars with a letter and a number. Admins: 14+ with upper, lower and a number. Obvious words rejected.
  const COMMON = ['password', 'qwerty', 'letmein', 'welcome', 'admin', 'material', 'reuse', 'mrg', '123456', 'iloveyou', 'monkey', 'dragon', 'football'];
  const weakPassword = (pw, isAdmin = false) => {
    const p = String(pw || ''); const low = p.toLowerCase();
    if (p.length > 200) return true;
    if (COMMON.some((c) => low.includes(c)) && p.length < 16) return true;
    if (isAdmin) return p.length < 14 || !/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p);
    return p.length < 10 || !/[a-zA-Z]/.test(p) || !/[0-9]/.test(p);
  };
  const PW_RULE = 'Password must be at least 10 characters with a letter and a number, and not an obvious word.';
  const PW_RULE_ADMIN = 'Admin passwords must be at least 14 characters with upper and lower case letters and a number.';

  // PBKDF2-SHA256. The iteration count is stored with each hash so it can be raised over time; older 60k hashes are re-hashed at the next sign-in.
  const PBKDF2_ITER = +process.env.PBKDF2_ITER || 210000;
  const hashPw = (pw, salt, iter = PBKDF2_ITER) => crypto.pbkdf2Sync(String(pw), salt, iter, 32, 'sha256').toString('hex');
  const makeAuth = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: hashPw(pw, salt), iter: PBKDF2_ITER, mustChange: true }; };
  const checkPw = (u, pw) => {
    if (!u.auth || !u.auth.hash || !u.auth.salt) return false;
    const h = Buffer.from(hashPw(pw, u.auth.salt, u.auth.iter || 60000), 'hex');
    const s = Buffer.from(u.auth.hash, 'hex');
    const ok = h.length === s.length && crypto.timingSafeEqual(h, s);
    if (ok && (u.auth.iter || 60000) < PBKDF2_ITER) { const salt = crypto.randomBytes(16).toString('hex'); u.auth = { ...u.auth, salt, hash: hashPw(pw, salt), iter: PBKDF2_ITER }; }
    return ok;
  };

  const safeUser = (u) => {
    const { auth, reset, totp, devices, ...rest } = u;
    return { ...rest, mustChange: !!(auth && auth.mustChange), totpEnabled: !!(totp && totp.enabled) };
  };

  return { SESSIONS, noteFail, tooMany, clientIp, weakPassword, PW_RULE, PW_RULE_ADMIN, hashPw, makeAuth, checkPw, safeUser, FAILS, PBKDF2_ITER };
};
