/**
 * Material Reuse Group — Member Portal API
 * Zero-dependency Node.js server (no npm install needed).
 *
 * Run:  node backend/server.js   (from the project root)
 * Then open http://localhost:4173
 *
 * Real authentication:
 *  - Accounts live in backend/data/users.json (salted PBKDF2 password hashes).
 *  - There is NO self-registration — only admins can create accounts.
 *  - Admins (role: "admin") manage members, their stats and carbon data.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4173;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ---------- data store (backend/store.js: seed JSON → Supabase when configured) ----------
const store = require('./store');
const { DATA_DIR, load, db, PERSISTED, SUPA, SUPA_URL, supaHeaders, supaLoad, persist,
  saveUsers, saveCarbon, saveOrders, saveLists, saveProjects, saveInventory, saveSessions, saveSystem, saveWishlist } = store;

let orderSeq, listSeq, projectSeq, userSeq;
function initSeqs() { // derived from the loaded data, so IDs never collide after a restart
  orderSeq = db.orders.reduce((m, o) => {
    const n = /^ORD-\d+-(\d+)$/.exec(o.id);
    return n ? Math.max(m, +n[1]) : m;
  }, 1299) + 1;
  listSeq = db.lists.reduce((m, l) => {
    const n = /^L-(\d+)$/.exec(l.id);
    return n ? Math.max(m, +n[1]) : m;
  }, 499) + 1;
  projectSeq = db.projects.reduce((m, p) => {
    const n = /^PRJ-(\d+)$/.exec(p.id);
    return n ? Math.max(m, +n[1]) : m;
  }, 5000) + 1;
  userSeq = db.users.reduce((m, u) => {
    const n = /^u(\d+)$/.exec(u.id);
    return n ? Math.max(m, +n[1]) : m;
  }, 0) + 1;
}
initSeqs();

// ---------- auth (backend/auth.js) ----------
const { SESSIONS, FAILS, noteFail, tooMany, clientIp, weakPassword, PW_RULE, PW_RULE_ADMIN, makeAuth, checkPw, safeUser } = require('./auth')({ db, saveSessions });
const security = require('./security');
const { esc } = require('./util');

// ---------- helpers ----------
const json = (res, code, body) => {
  if (res.headersSent) return; // e.g. a 413 was already sent while reading the body
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (res._corsOpen) h['Access-Control-Allow-Origin'] = '*';
  res.writeHead(code, h);
  res.end(JSON.stringify(body));
};

const readBody = security.readBody; // capped: 256 KB JSON, 14 MB for uploads/photos

// ---------- features module (impact ledger, passports, documents, requests, uploads) ----------
// All live stats come from the impact ledger inside this module — see backend/features.js
const features = require('./features')({
  db, json, readBody, persist, SUPA, SUPA_URL, supaHeaders, DATA_DIR,
  saveUsers, saveCarbon, saveOrders, saveLists, saveProjects, saveInventory, saveSystem,
  nextProjectSeq: () => projectSeq++,
});
const applyOrderStats = features.applyOrderStats;

const userById = (id) => db.users.find((u) => u.id === id);
const userByEmail = (e) => {
  const em = String(e || '').trim().toLowerCase();
  return db.users.find((u) => u.email.toLowerCase() === em || (u.altEmails || []).includes(em));
};
const tierOf = (user) => db.tiers.find((t) => t.id === user.tier) || null;
const initials = (name) =>
  String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ---------- integrations: Airtable ⇄ portal sync + Resend email (backend/integrations.js) ----------
const integrations = require('./integrations')({
  db, features, saveUsers, saveOrders, saveInventory, saveCarbon, makeAuth, initials,
  nextUserId: () => `u${userSeq++}`,
});
const automations = require('./automations')({ db, features, integrations, saveOrders, saveUsers, saveInventory, saveSystem, nextOrderSeq: () => orderSeq++ });
function createUser({ name, email, auth, tier }) {
  const u = { id: `u${userSeq++}`, role: 'member', name, email, tier: tier || 'domestic-free', memberSince: new Date().toISOString().slice(0, 10), avatarInitials: initials(name),
    organisation: null, phone: null, address: null, carbonSavedKg: 0, itemsRehomed: 0, notifications: { newStock: true, orderUpdates: true, newsletter: true },
    billing: { method: null, nextPayment: null, invoices: [] }, auth: { ...auth, mustChange: false } };
  db.users.push(u); db.carbon[u.id] = { verified: false }; saveUsers(); saveCarbon();
  return u;
}
const commerce = require('./commerce')({ db, features, integrations, automations, saveOrders, saveUsers, saveInventory, saveSystem, saveWishlist, nextOrderSeq: () => orderSeq++, safeUser, createUser });
automations.setCommerce(commerce);
const chat = require('./chat')({ db, features, integrations, automations, commerce });

// ---------- API routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = url.searchParams;

  /* ============ AUTH (unauthenticated: login, register, forgot/reset, health, public passports) ============ */

  // GET /api/qr?data=... — QR image served from our own origin (so the browser can add the MRG mark and export a PNG)
  if (req.method === 'GET' && url.pathname === '/api/qr') {
    const data = String(q.get('data') || '').slice(0, 500);
    if (!data) return json(res, 400, { error: 'data required' });
    if (!/^https?:\/\/[^/]+\/passport\/[\w-]+$/.test(data) || !data.startsWith(integrations.ENV.PORTAL_URL + '/')) return json(res, 400, { error: 'Only passport QR codes are generated here.' });
    const size = Math.max(120, Math.min(1200, +q.get('size') || 600));
    try {
      const r = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&ecc=H&margin=2&format=png&data=${encodeURIComponent(data)}`);
      if (!r.ok) throw new Error('qr ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
      return res.end(buf);
    } catch (e) { return json(res, 502, { error: 'QR service unavailable' }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, time: new Date().toISOString(), data: SUPA ? 'supabase' : 'local', members: db.users.filter((u) => u.role !== 'admin').length });
  }

  // POST /api/auth/login { email, password }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const emailKey = 'e:' + String(body.email || '').trim().toLowerCase(), ipKey = 'ip:' + clientIp(req);
    if (tooMany(emailKey) || tooMany(ipKey))
      return json(res, 429, { error: 'Too many sign-in attempts. Please wait 15 minutes or use “Forgotten your password?”.' });
    const u = userByEmail(body.email);
    if (!u || !checkPw(u, body.password || '')) {
      noteFail(emailKey); noteFail(ipKey);
      return json(res, 401, { error: 'Incorrect email or password.' });
    }
    // Admins with an authenticator app enrolled must also give the 6-digit code
    if (u.totp && u.totp.enabled) {
      const code = String(body.code || '').trim();
      if (!code) return json(res, 200, { totpRequired: true });
      if (!security.totpVerify(u.totp.secret, code)) { noteFail(emailKey); noteFail(ipKey); return json(res, 401, { error: 'That authenticator code isn’t right — check the app and try again.', totpRequired: true }); }
    }
    FAILS.delete(emailKey);
    saveUsers(); // hash may have been upgraded
    const token = crypto.randomBytes(32).toString('hex');
    SESSIONS.set(token, u.id, u.role === 'admin');
    // new device? (hash of browser signature — no raw user agents stored)
    const ua = String(req.headers['user-agent'] || '');
    const device = crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16);
    u.devices = Array.isArray(u.devices) ? u.devices : [];
    if (!u.devices.includes(device)) {
      const known = u.devices.length > 0;
      u.devices = [device, ...u.devices].slice(0, 12); saveUsers();
      if (known && u.role !== 'admin') integrations.mail.newDevice(u, `${new Date().toUTCString()} · ${ua.replace(/\(.*?\)/g, '').slice(0, 80)} · IP ${clientIp(req)}`);
    }
    return json(res, 200, { token, user: safeUser(u), tier: tierOf(u) });
  }

  // GET /api/public/tiers — the sign-up choices
  if (req.method === 'GET' && url.pathname === '/api/public/tiers') return json(res, 200, { tiers: commerce.publicTiers(), stripe: !!automations.stripeOn });
  // POST /api/auth/register — self-service sign-up to any public tier. Paid tiers pay first (Stripe), then the account is created.
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim();
    if (name.length < 2 || name.length > 120 || email.length > 254) return json(res, 400, { error: 'Please enter your full name and a valid email.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return json(res, 400, { error: 'Please enter a valid email address.' });
    if (weakPassword(b.password)) return json(res, 400, { error: PW_RULE });
    if (userByEmail(email))
      return json(res, 409, { error: 'An account with that email already exists — try signing in.' });
    const tier = db.tiers.find((t) => t.id === b.tier && t.public) || db.tiers.find((t) => t.id === 'domestic-free');
    if (tier.price > 0) {
      try { return json(res, 200, { checkoutUrl: (await commerce.startSignup({ name, email, auth: makeAuth(b.password), tierId: tier.id })).url }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    const u = createUser({ name, email, auth: makeAuth(b.password), tier: tier.id });
    integrations.mail.welcome(u);
    const token = crypto.randomBytes(32).toString('hex');
    SESSIONS.set(token, u.id);
    return json(res, 201, { token, user: safeUser(u), tier: tierOf(u) });
  }

  // POST /api/auth/forgot { email } — always answers OK (no account enumeration); emails a 1-hour reset link
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot') {
    const b = await readBody(req);
    if (!security.forgotEmailOk(b.email)) return json(res, 200, { ok: true }); // silently drop repeats — no enumeration, no email bombing
    const u = userByEmail(b.email);
    if (u) {
      const token = crypto.randomBytes(24).toString('hex');
      u.reset = { token, exp: Date.now() + 60 * 60e3 };
      saveUsers();
      integrations.mail.resetLink(u, token);
    }
    return json(res, 200, { ok: true, message: 'If that email has an account, a reset link is on its way.' });
  }
  // POST /api/auth/reset { token, password }
  if (req.method === 'POST' && url.pathname === '/api/auth/reset') {
    const b = await readBody(req);
    const u = db.users.find((x) => x.reset && x.reset.token === String(b.token || '') && x.reset.exp > Date.now());
    if (!u) return json(res, 400, { error: 'This reset link is invalid or has expired — request a new one.' });
    if (weakPassword(b.password, u.role === 'admin')) return json(res, 400, { error: u.role === 'admin' ? PW_RULE_ADMIN : PW_RULE });
    u.auth = { ...makeAuth(b.password), mustChange: false };
    delete u.reset;
    SESSIONS.deleteUser(u.id); // every other device is signed out
    saveUsers();
    if (u.totp && u.totp.enabled) return json(res, 200, { ok: true, signIn: true }); // 2FA accounts sign in normally (code required)
    const token = crypto.randomBytes(32).toString('hex');
    SESSIONS.set(token, u.id, u.role === 'admin');
    return json(res, 200, { token, user: safeUser(u), tier: tierOf(u) });
  }
  if (req.method === 'GET' && (url.pathname === '/marketplace' || url.pathname === '/marketplace/')) return serveStatic(res, '/marketplace.html');
  // ---- marketplace (public): listings, checkout, completion pages ----
  if (req.method === 'GET' && url.pathname === '/api/public/marketplace') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return json(res, 200, { items: commerce.publicListings(), depositPercent: commerce.ENV.DEPOSIT_PERCENT, checkout: !!automations.stripeOn });
  }
  if (req.method === 'GET' && url.pathname === '/api/checkout') {
    try {
      const to = await commerce.createCheckout({ sku: q.get('sku'), mode: q.get('mode') === 'deposit' ? 'deposit' : 'buy', qty: q.get('qty'), email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.get('email') || '') ? q.get('email') : undefined });
      res.writeHead(303, { Location: to }); return res.end();
    } catch (e) {
      res.writeHead(e.code === 'unavailable' ? 409 : 503, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(commerce.page('Not available', `<h1>${e.code === 'unavailable' ? 'Sorry, that one’s gone' : 'Checkout unavailable'}</h1><p>${esc(e.message)}</p><a class="btn" href="/marketplace">Back to the marketplace</a>`));
    }
  }
  if (req.method === 'GET' && url.pathname === '/order-complete') {
    let r = null; try { r = await commerce.completeSession(q.get('session_id')); } catch (e) { console.error('  order-complete:', e.message); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(commerce.orderCompletePage(r && r.order ? r : null));
  }
  if (req.method === 'GET' && url.pathname === '/signup-complete') {
    let r = null; try { r = await commerce.completeSession(q.get('session_id')); } catch (e) { console.error('  signup-complete:', e.message); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(commerce.signupCompletePage(r && r.signup));
  }
  if (req.method === 'GET' && url.pathname === '/membership-complete') {
    let r = null; try { r = await commerce.completeSession(q.get('session_id')); } catch (e) { console.error('  membership-complete:', e.message); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(commerce.membershipCompletePage(r && r.membership));
  }

  // GET /api/public/impact — live totals for the website counter (no personal data)
  if (req.method === 'GET' && url.pathname === '/api/public/impact') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return json(res, 200, automations.publicImpact());
  }
  // GET /api/public/badge/:token(.svg) — a member's shareable badge
  if (req.method === 'GET' && parts[1] === 'public' && parts[2] === 'badge' && parts[3]) {
    const token = parts[3].replace(/\.svg$/, '');
    const u = db.users.find((x) => x.badgeToken === token);
    if (!u || !(u.carbonSavedKg > 0)) { res.writeHead(404); return res.end('Badge not found'); }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    return res.end(automations.badgeSvg(u));
  }

  // GET /api/public/passports/:id — what a QR scan shows without signing in (no client names, sites or money)
  if (req.method === 'GET' && parts[1] === 'public' && parts[2] === 'passports' && parts[3]) {
    const m = db.materials.find((x) => x.id === parts[3]);
    if (!m) return json(res, 404, { error: 'Passport not found' });
    const pick = ['id', 'ref', 'name', 'category', 'description', 'quantity', 'unit', 'dimensions', 'condition', 'dateRecovered',
      'status', 'reuseDestination', 'dateRehomed', 'carbonSavedKg', 'carbonEstimated', 'weightKg', 'weightEstimated', 'photos', 'passportVerified', 'history'];
    const out = Object.fromEntries(pick.map((k) => [k, m[k]]));
    out.recoveredBy = 'Material Reuse Group';
    out.origin = m.userId ? 'Recovered from a client project' : 'Material Reuse Group warehouse stock';
    if (!m.userId) { const inv = db.inventory.find((i) => i.sku === m.sku); if (inv) { out.listedPrice = inv.price; out.priceUnit = inv.priceUnit; out.availability = inv.status; out.retailNew = inv.retailNew || 0; } }
    return json(res, 200, { passport: out });
  }

  // ----- everything below requires a valid session -----
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const actorId = SESSIONS.get(bearer);
  const actor = actorId ? userById(actorId) : null;
  if (!actor) return json(res, 401, { error: 'Not signed in.' });
  const isAdmin = actor.role === 'admin';

  // Every admin write is recorded in the audit log once the response has gone out
  if (isAdmin && req.method !== 'GET' && !/^\/api\/(uploads|auth|admin\/system|admin\/sync)/.test(url.pathname)) {
    const end = res.end.bind(res);
    res.end = (...a) => { try { automations.auditRequest(actor, req.method, url.pathname, res.statusCode, req._body); } catch (e) { /* never block the response */ } return end(...a); };
  }

  // GET /api/badge — this member's shareable "Material Reuse Partner" badge
  if (req.method === 'GET' && url.pathname === '/api/badge') {
    if (!(actor.carbonSavedKg > 0)) return json(res, 200, { available: false, reason: 'Your badge unlocks after your first collection is recorded.' });
    return json(res, 200, { available: true, ...automations.badgeFor(actor), svg: automations.badgeSvg(actor) });
  }
  // GET /api/admin/scan/:sku — what an admin sees after scanning a passport QR on their phone
  if (req.method === 'GET' && parts[1] === 'admin' && parts[2] === 'scan' && parts[3]) {
    if (!isAdmin) return json(res, 403, { error: 'Admin access required.' });
    const mat = db.materials.find((x) => x.id === parts[3]);
    const sku = mat ? (mat.sku || mat.id) : parts[3];
    const orders = db.orders.filter((o) => (o.items || []).some((l) => l.sku === sku) && !['Collected', 'Delivered', 'Cancelled', 'Completed'].includes(o.status))
      .map((o) => ({ id: o.id, status: o.status, slot: o.slot, member: (userById(o.userId) || {}).name || '—', qty: (o.items.find((l) => l.sku === sku) || {}).qty, balanceDueGBP: o.balanceDueGBP, balancePaid: !!o.balancePaid }));
    return json(res, 200, { material: mat ? { id: mat.id, ref: mat.ref, name: mat.name, status: mat.status } : null, orders });
  }
  // POST /api/admin/scan/:id/sell — walk-in sale: buyer's email → account (auto-created), collected & paid order, stock reduced
  if (req.method === 'POST' && parts[1] === 'admin' && parts[2] === 'scan' && parts[3] && parts[4] === 'sell') {
    if (!isAdmin) return json(res, 403, { error: 'Admin access required.' });
    const mat = db.materials.find((x) => x.id === parts[3]);
    if (!mat) return json(res, 404, { error: 'Passport not found' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter the buyer’s email address.' });
    try { const r = await automations.walkInSale(mat, { email, name: b.name, phone: b.phone, qty: b.qty, createAccount: b.createAccount !== false }, actor); return json(res, 201, { order: r.order, member: r.user ? safeUser(r.user) : null, created: r.created }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  // POST /api/chat — the portal assistant
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const b = await readBody(req);
    try { return json(res, 200, await chat.reply(actor, b.messages)); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/chat') return json(res, 200, { on: chat.on });
  // POST /api/admin/suggest — AI price / carbon / cost-new suggestions for a listing
  if (req.method === 'POST' && url.pathname === '/api/admin/suggest') {
    if (!isAdmin) return json(res, 403, { error: 'Admin access required.' });
    const b = await readBody(req);
    if (!String(b.name || '').trim()) return json(res, 400, { error: 'Give the item a name first.' });
    try { return json(res, 200, await chat.suggestListing(b)); } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // admin: automation status, audit log, digest preview
  if (isAdmin && req.method === 'GET' && url.pathname === '/api/admin/system') {
    return json(res, 200, { status: automations.status(), audit: (db.system.auditLog || []).slice(0, +q.get('limit') || 100), alerts: (db.system.alertsSentLog || []).slice(0, 20), queue: (db.system.alertQueue || []).length, embed: `${integrations.ENV.PORTAL_URL}/embed/impact.html` });
  }
  if (isAdmin && req.method === 'POST' && url.pathname === '/api/admin/system/digest') { await automations.sendDigest(true); return json(res, 200, { ok: true }); }
  if (isAdmin && req.method === 'POST' && url.pathname === '/api/admin/system/run') { await automations.runNow(); return json(res, 200, { ok: true, status: automations.status() }); }
  if (isAdmin && req.method === 'POST' && parts[1] === 'admin' && parts[2] === 'orders' && parts[3] && parts[4] === 'invoice') {
    const o = db.orders.find((x) => x.id === parts[3]); if (!o) return json(res, 404, { error: 'Order not found' });
    await automations.sendBalanceInvoice(o);
    return json(res, o.stripeInvoiceId ? 200 : 409, o.stripeInvoiceId ? { order: o } : { error: automations.ENV.STRIPE_SECRET_KEY ? 'Invoice not sent — needs a confirmed slot and an unpaid balance.' : 'Set STRIPE_SECRET_KEY on Render to send invoices.' });
  }

  // passports · documents · requests · impact · uploads (backend/features.js)
  if (await features.handle(req, res, url, actor, isAdmin)) return;

  // POST /api/auth/logout
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    SESSIONS.delete(bearer);
    return json(res, 200, { ok: true });
  }

  // GET /api/auth/me
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    return json(res, 200, { user: safeUser(actor), tier: tierOf(actor) });
  }

  // POST /api/auth/password { current, next }
  if (req.method === 'POST' && url.pathname === '/api/auth/password') {
    const body = await readBody(req);
    if (!checkPw(actor, body.current || ''))
      return json(res, 403, { error: 'Current password is incorrect.' });
    if (weakPassword(body.next, isAdmin)) return json(res, 400, { error: isAdmin ? PW_RULE_ADMIN : PW_RULE });
    actor.auth = { ...makeAuth(body.next), mustChange: false };
    saveUsers();
    SESSIONS.deleteUser(actor.id, bearer); // other devices are signed out; this one stays
    integrations.mail.passwordChanged(actor);
    return json(res, 200, { ok: true });
  }
  // POST /api/auth/logout-all — sign out everywhere
  if (req.method === 'POST' && url.pathname === '/api/auth/logout-all') { SESSIONS.deleteUser(actor.id); return json(res, 200, { ok: true }); }

  // ---- two-factor (authenticator app) — admins ----
  if (req.method === 'POST' && url.pathname === '/api/auth/totp/setup') {
    if (!isAdmin) return json(res, 403, { error: 'Two-factor is for admin accounts.' });
    if (actor.totp && actor.totp.enabled) return json(res, 400, { error: 'Two-factor is already on — turn it off first (with your password) to set up a new device.' });
    const secret = security.totpSecret();
    actor.totp = { secret, enabled: false }; saveUsers();
    return json(res, 200, { secret: secret.match(/.{1,4}/g).join(' '), uri: security.totpUri(secret, actor.email) });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/totp/enable') {
    const b = await readBody(req);
    if (!actor.totp || !actor.totp.secret) return json(res, 400, { error: 'Start setup first.' });
    if (!security.totpVerify(actor.totp.secret, b.code)) return json(res, 400, { error: 'That code isn’t right — try the next one the app shows.' });
    actor.totp.enabled = true; actor.totp.enabledAt = new Date().toISOString(); saveUsers();
    automations.audit(actor, 'enabled two-factor', actor.id, '');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/totp/disable') {
    const b = await readBody(req);
    if (!checkPw(actor, b.password || '')) return json(res, 403, { error: 'Password is incorrect.' });
    if (actor.totp && actor.totp.enabled && !security.totpVerify(actor.totp.secret, b.code)) return json(res, 400, { error: 'Enter the current authenticator code.' });
    actor.totp = null; saveUsers(); automations.audit(actor, 'disabled two-factor', actor.id, '');
    return json(res, 200, { ok: true });
  }

  // ---- buying from inside the marketplace (quantity chosen here; membership credit applied automatically) ----
  if (req.method === 'POST' && url.pathname === '/api/orders/checkout') {
    const b = await readBody(req);
    if (isAdmin) return json(res, 400, { error: 'Admins can’t buy — use a member account.' });
    try { return json(res, 200, await commerce.memberCheckout(actor, { sku: b.sku, mode: b.mode === 'deposit' ? 'deposit' : 'buy', qty: b.qty })); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // POST /api/orders/:id/evidence — Community: photos of the materials installed at the registered address
  if (req.method === 'POST' && parts[1] === 'orders' && parts[2] && parts[3] === 'evidence') {
    const o = db.orders.find((x) => x.id === parts[2] && (x.userId === actor.id || isAdmin));
    if (!o) return json(res, 404, { error: 'Order not found' });
    const b = await readBody(req);
    const photos = (b.photos || []).filter((p) => p && security.safeFileUrl(p.url, SUPA_URL)).slice(0, 20).map((p) => ({ url: p.url, key: p.key || null, name: String(p.name || 'photo').slice(0, 120) }));
    if (!photos.length) return json(res, 400, { error: 'Add at least one photo (uploaded through the portal).' });
    o.evidence = { photos, note: String(b.note || '').slice(0, 500), at: new Date().toISOString(), status: 'Submitted' }; saveOrders();
    integrations.mail.evidenceReceived(actor, o); automations.audit(actor, 'installation photos uploaded', o.id, `${photos.length} photo(s)`);
    return json(res, 200, { order: o });
  }
  // ---- membership self-service ----
  if (req.method === 'GET' && url.pathname === '/api/membership') return json(res, 200, { membership: commerce.membershipView(actor), tiers: db.tiers });
  if (req.method === 'POST' && url.pathname === '/api/membership/change') {
    const b = await readBody(req);
    try { return json(res, 200, await commerce.changeMembership(actor, String(b.tier || ''), { organisation: b.organisation })); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/membership/portal') {
    try { return json(res, 200, { url: await commerce.billingPortalUrl(actor) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // ---- wishlist ----
  if (req.method === 'GET' && url.pathname === '/api/wishlist') return json(res, 200, { wishlist: db.wishlist.filter((w) => w.userId === actor.id).reverse() });
  if (req.method === 'POST' && url.pathname === '/api/wishlist') {
    const b = await readBody(req);
    if (!String(b.category || '').trim() && !String(b.itemType || '').trim() && !String(b.notes || '').trim()) return json(res, 400, { error: 'Tell us what you’re looking for.' });
    return json(res, 201, { wish: commerce.addWish(actor, b) });
  }
  if (req.method === 'DELETE' && parts[1] === 'wishlist' && parts[2]) {
    const w = db.wishlist.find((x) => x.id === parts[2] && (x.userId === actor.id || isAdmin));
    if (!w) return json(res, 404, { error: 'Not found' });
    w.status = 'Closed'; saveWishlist(); return json(res, 200, { ok: true });
  }

  /* ============ ADMIN — member management ============ */
  if (parts[1] === 'admin') {
    if (!isAdmin) return json(res, 403, { error: 'Admin access required.' });
    if (req.method === 'GET' && url.pathname === '/api/admin/wishlist') return json(res, 200, { wishlist: db.wishlist.slice().reverse().map((w) => ({ ...w, member: (userById(w.userId) || {}).name })) });
    if (req.method === 'POST' && parts[2] === 'orders' && parts[3] && parts[4] === 'evidence') {
      const o = db.orders.find((x) => x.id === parts[3]); if (!o || !o.evidence) return json(res, 404, { error: 'No photos on that order' });
      const b = await readBody(req); o.evidence.status = b.verified === false ? 'Rejected' : 'Verified'; o.evidence.reviewedBy = actor.name; o.evidence.reviewedAt = new Date().toISOString(); saveOrders();
      return json(res, 200, { order: o });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/system/stockmail') { const sent = await commerce.weeklyStockMail(true); return json(res, 200, { ok: true, sent }); }
    if (!isAdmin) return json(res, 403, { error: 'Admin access required.' });

    // GET /api/admin/members
    if (req.method === 'GET' && url.pathname === '/api/admin/members') {
      const members = db.users.filter((u) => u.role !== 'admin').map((u) => ({
        ...safeUser(u),
        tierName: tierOf(u) ? tierOf(u).name : '—',
        orders: db.orders.filter((o) => o.userId === u.id).length,
        lists: db.lists.filter((l) => l.userId === u.id).length,
      }));
      const admins = db.users.filter((u) => u.role === 'admin').map(safeUser);
      return json(res, 200, { members, admins, tiers: db.tiers });
    }

    // POST /api/admin/members — create account (the ONLY way accounts are made)
    if (req.method === 'POST' && url.pathname === '/api/admin/members') {
      const b = await readBody(req);
      if (!b.name || !b.email || !b.password)
        return json(res, 400, { error: 'Name, email and a temporary password are required.' });
      if (weakPassword(b.password)) return json(res, 400, { error: PW_RULE });
      if (userByEmail(b.email))
        return json(res, 409, { error: 'An account with that email already exists.' });
      if (String(b.name).length > 120 || String(b.email).length > 254) return json(res, 400, { error: 'Name or email too long.' });
      const tier = db.tiers.some((t) => t.id === b.tier) ? b.tier : 'domestic-free';
      if (tier === 'community' && !String(b.address || '').trim()) return json(res, 400, { error: 'Community accounts need a registered installation address.' });
      const u = {
        id: `u${userSeq++}`,
        role: 'member',
        name: String(b.name).trim(),
        email: String(b.email).trim(),
        tier,
        memberSince: new Date().toISOString().slice(0, 10),
        avatarInitials: initials(b.name),
        organisation: b.organisation || null,
        phone: b.phone || null,
        address: b.address || null,
        carbonSavedKg: +b.carbonSavedKg || 0,
        itemsRehomed: +b.itemsRehomed || 0,
        notifications: { newStock: true, orderUpdates: true, newsletter: true },
        billing: { method: null, nextPayment: null, invoices: [] },
        auth: makeAuth(b.password),
      };
      db.users.push(u);
      db.carbon[u.id] = { verified: false };
      saveUsers(); saveCarbon();
      return json(res, 201, { user: safeUser(u) });
    }

    // ----- orders (admin can log/edit anything a member sees) -----
    if (parts[2] === 'orders' && parts[3]) {
      const order = db.orders.find((o) => o.id === parts[3]);
      if (!order) return json(res, 404, { error: 'Order not found' });
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        const prevSlot = order.slot;
        ['type', 'placed', 'status', 'fulfilment', 'slot', 'total',
         'deliveryFee', 'carbonSavedKg', 'note', 'projectId'].forEach((k) => {
          if (b[k] !== undefined) order[k] = b[k];
        });
        if (Array.isArray(b.items)) order.items = b.items;
        if (b.status === 'Collected' && !order.collectedAt) order.collectedAt = new Date().toISOString();
        if (b.slot !== undefined && b.slot !== prevSlot && features.hooks.orderSlot) features.hooks.orderSlot(order);
        applyOrderStats(order); // fires once when the order reaches a done status
        saveOrders();
        return json(res, 200, { order });
      }
      if (req.method === 'DELETE') {
        db.orders = db.orders.filter((o) => o.id !== order.id);
        saveOrders();
        return json(res, 200, { ok: true });
      }
    }

    // ----- projects & audits -----
    if (parts[2] === 'projects' && parts[3]) {
      const p = db.projects.find((x) => x.id === parts[3]);
      if (!p) return json(res, 404, { error: 'Project not found' });
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        ['name', 'type', 'status', 'auditRef', 'started', 'target', 'summary', 'linkedList',
         'site', 'address', 'client', 'contact'].forEach((k) => {
          if (b[k] !== undefined) p[k] = b[k];
        });
        if (b.stage !== undefined) { p.stage = Math.max(0, Math.min(5, Math.round(+b.stage || 0))); p.progress = Math.round((p.stage / 5) * 100); }
        else if (b.progress !== undefined) { p.progress = Math.max(0, Math.min(100, +b.progress || 0)); p.stage = Math.round((p.progress / 100) * 5); }
        if (p.stage === 5 && b.status === undefined) p.status = 'Complete';
        if (Array.isArray(b.documents)) features.syncProjectDocs(p, b.documents);
        features.recomputeProject(p.id); // carbon figure is always the ledger total
        saveProjects();
        return json(res, 200, { project: { ...p, documents: features.projectDocs(p) } });
      }
      if (req.method === 'DELETE') {
        db.projects = db.projects.filter((x) => x.id !== p.id);
        db.materials.forEach((mat) => { if (mat.projectId === p.id) mat.projectId = null; });
        db.documents.forEach((d) => { if (d.projectId === p.id) d.projectId = null; });
        db.impactEvents.forEach((e) => { if (e.projectId === p.id) e.projectId = null; });
        saveProjects(); features.saveMaterials(); features.saveDocuments(); features.saveEvents();
        return json(res, 200, { ok: true });
      }
    }

    // Routes on a specific member
    if (parts[2] === 'members' && parts[3]) {
      const u = userById(parts[3]);
      if (!u) return json(res, 404, { error: 'Member not found' });

      // GET /api/admin/members/:id/full — everything visible on their account
      if (req.method === 'GET' && parts[4] === 'full') {
        return json(res, 200, {
          user: safeUser(u),
          tier: tierOf(u),
          orders: db.orders.filter((o) => o.userId === u.id),
          lists: db.lists.filter((l) => l.userId === u.id),
          projects: db.projects.filter((p) => p.userId === u.id).map((p) => ({ ...p, documents: features.projectDocs(p) })),
          materials: db.materials.filter((x) => x.userId === u.id),
          documents: db.documents.filter((d) => d.userId === u.id),
          requests: db.requests.filter((r) => r.userId === u.id),
          report: features.carbonReportFor(u.id),
          impact: features.computeImpact({ userId: u.id }),
        });
      }

      // POST /api/admin/members/:id/orders — log an order / donation lot
      if (req.method === 'POST' && parts[4] === 'orders') {
        const b = await readBody(req);
        const order = {
          id: b.id || `ORD-2026-${orderSeq++}`,
          userId: u.id,
          type: b.type || undefined,
          placed: b.placed || new Date().toISOString().slice(0, 10),
          status: b.status || 'Reserved',
          fulfilment: b.fulfilment || 'Collection — Material Reuse Group warehouse',
          slot: b.slot || 'Slot to be confirmed',
          items: Array.isArray(b.items) ? b.items : [],
          total: b.total !== undefined ? +b.total : undefined,
          memberDiscount: b.memberDiscount !== undefined ? +b.memberDiscount : undefined,
          deliveryFee: b.deliveryFee !== undefined ? +b.deliveryFee : undefined,
          carbonSavedKg: +b.carbonSavedKg || 0,
          note: b.note || undefined,
          projectId: b.projectId || undefined,
        };
        db.orders.unshift(order);
        applyOrderStats(order); // in case it's logged already-collected
        saveOrders();
        return json(res, 201, { order });
      }

      // POST /api/admin/members/:id/projects — log a project / audit
      if (req.method === 'POST' && parts[4] === 'projects') {
        const b = await readBody(req);
        const stage = b.stage !== undefined ? Math.max(0, Math.min(5, Math.round(+b.stage || 0)))
          : Math.round((Math.max(0, Math.min(100, +b.progress || 0)) / 100) * 5);
        const project = {
          id: `PRJ-${projectSeq++}`,
          userId: u.id,
          name: b.name || 'New project',
          type: b.type || 'Pre-refurbishment audit',
          status: b.status || (stage === 5 ? 'Complete' : 'Planning'),
          auditRef: b.auditRef || undefined,
          site: b.site || '', address: b.address || '', client: b.client || '', contact: b.contact || '',
          started: b.started || new Date().toISOString().slice(0, 10),
          target: b.target || null,
          summary: b.summary || '',
          stage, progress: Math.round((stage / 5) * 100),
          carbonSavedKg: 0, // derived from the impact ledger
          collections: [],
        };
        db.projects.push(project);
        if (Array.isArray(b.documents)) features.syncProjectDocs(project, b.documents);
        saveProjects();
        return json(res, 201, { project: { ...project, documents: features.projectDocs(project) } });
      }

      // POST /api/admin/members/:id/merge { intoId } — move everything from this account into another, then delete it
      if (req.method === 'POST' && parts[4] === 'merge') {
        const b = await readBody(req);
        const into = userById(b.intoId) || userByEmail(b.intoEmail);
        if (!into || into.id === u.id || into.role === 'admin' || u.role === 'admin') return json(res, 400, { error: 'Pick a different member account to merge into.' });
        const move = (arr) => arr.forEach((x) => { if (x.userId === u.id) x.userId = into.id; });
        move(db.orders); move(db.lists); move(db.projects); move(db.materials); move(db.documents); move(db.requests); move(db.impactEvents);
        into.altEmails = [...new Set([...(into.altEmails || []), u.email.toLowerCase()])];
        if (!into.phone && u.phone) into.phone = u.phone;
        if (!into.organisation && u.organisation) into.organisation = u.organisation;
        const cm = db.carbon[u.id] || {}; if (cm.verified && !(db.carbon[into.id] || {}).verified) db.carbon[into.id] = cm;
        delete db.carbon[u.id];
        db.users = db.users.filter((x) => x.id !== u.id);
        SESSIONS.deleteUser(u.id);
        features.recomputeUser(into.id);
        saveUsers(); saveCarbon(); saveOrders(); saveLists(); saveProjects();
        features.saveMaterials(); features.saveDocuments(); features.saveRequests(); features.saveEvents();
        return json(res, 200, { user: safeUser(into) });
      }

      // POST /api/admin/members/:id/password { password }
      if (req.method === 'POST' && parts[4] === 'password') {
        const b = await readBody(req);
        if (weakPassword(b.password)) return json(res, 400, { error: PW_RULE });
        u.auth = makeAuth(b.password);
        saveUsers();
        return json(res, 200, { ok: true });
      }

      // GET /api/admin/members/:id/carbon — computed from the impact ledger
      if (req.method === 'GET' && parts[4] === 'carbon') {
        return json(res, 200, { report: features.carbonReportFor(u.id), meta: db.carbon[u.id] || {} });
      }

      // PUT /api/admin/members/:id/carbon — verification metadata only (figures live in the ledger)
      if (req.method === 'PUT' && parts[4] === 'carbon') {
        const b = await readBody(req);
        const meta = { verified: !!b.verified };
        if (b.verifier) meta.verifier = String(b.verifier);
        if (b.wlcaModules && typeof b.wlcaModules === 'object' && Object.keys(b.wlcaModules).length) meta.wlcaModules = b.wlcaModules;
        db.carbon[u.id] = meta;
        saveCarbon();
        return json(res, 200, { report: features.carbonReportFor(u.id), meta });
      }

      // PATCH /api/admin/members/:id — edit anything personalised
      if (req.method === 'PATCH' && !parts[4]) {
        if (u.role === 'admin' && u.id !== actor.id)
          return json(res, 403, { error: 'Admins can only be edited by themselves.' });
        const b = await readBody(req);
        if (b.email !== undefined) { const em = String(b.email || '').trim().toLowerCase(); if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(em)) return json(res, 400, { error: 'Enter a valid email address.' }); if (db.users.some((x) => x.id !== u.id && x.email.toLowerCase() === em)) return json(res, 409, { error: 'Another account already uses that email.' }); u.email = em; }
        ['name', 'phone', 'address', 'organisation', 'memberSince']
          .forEach((k) => { if (b[k] !== undefined) u[k] = String(b[k] ?? '').slice(0, 200).trim(); });
        if (b.name) u.avatarInitials = initials(b.name);
        if (b.tier && db.tiers.some((t) => t.id === b.tier)) u.tier = b.tier;
        if (u.tier === 'community' && !String(u.address || '').trim()) return json(res, 400, { error: 'Community accounts need a registered installation address.' });
        // carbonSavedKg / itemsRehomed are derived from the impact ledger — not editable here
        if (b.accountManager !== undefined) u.accountManager = b.accountManager || undefined;
        if (b.billing) Object.assign(u.billing = u.billing || {}, b.billing);
        if (b.notifications) Object.assign(u.notifications, b.notifications);
        saveUsers();
        return json(res, 200, { user: safeUser(u), tier: tierOf(u) });
      }

      // DELETE /api/admin/members/:id
      if (req.method === 'DELETE' && !parts[4]) {
        if (u.role === 'admin') return json(res, 403, { error: 'Admin accounts can’t be deleted here.' });
        db.users = db.users.filter((x) => x.id !== u.id);
        delete db.carbon[u.id];
        db.materials = db.materials.filter((x) => x.userId !== u.id);
        db.documents = db.documents.filter((x) => x.userId !== u.id);
        db.requests = db.requests.filter((x) => x.userId !== u.id);
        db.impactEvents = db.impactEvents.filter((x) => x.userId !== u.id);
        SESSIONS.deleteUser(u.id);
        saveUsers(); saveCarbon();
        features.saveMaterials(); features.saveDocuments(); features.saveRequests(); features.saveEvents();
        return json(res, 200, { ok: true });
      }
    }

    // Airtable sync: status + run now
    if (url.pathname === '/api/admin/sync') {
      if (req.method === 'POST') await integrations.sync();
      return json(res, 200, { sync: integrations.status() });
    }

    return json(res, 404, { error: 'Not found' });
  }

  /* ============ MEMBER API (scoped to the signed-in user) ============ */
  // Members may only ever act as themselves; admins may act on any userId.
  const scopeUid = (requested) => (isAdmin && requested ? requested : actor.id);

  // GET /api/tiers
  if (req.method === 'GET' && url.pathname === '/api/tiers') {
    return json(res, 200, { tiers: db.tiers });
  }

  // GET /api/users/:id — own profile (or any, for admins)
  if (req.method === 'GET' && parts[1] === 'users' && parts[2]) {
    if (!isAdmin && parts[2] !== actor.id) return json(res, 403, { error: 'Forbidden' });
    const u = userById(parts[2]);
    if (!u) return json(res, 404, { error: 'User not found' });
    return json(res, 200, { user: safeUser(u), tier: tierOf(u) });
  }

  // PATCH /api/users/:id — update own profile / notifications
  if (req.method === 'PATCH' && parts[1] === 'users' && parts[2]) {
    if (!isAdmin && parts[2] !== actor.id) return json(res, 403, { error: 'Forbidden' });
    const u = userById(parts[2]);
    if (!u) return json(res, 404, { error: 'User not found' });
    const body = await readBody(req);
    ['name', 'phone', 'address', 'organisation'].forEach((k) => {
      if (body[k] !== undefined && !(k === 'address' && u.tier === 'community' && !isAdmin)) u[k] = String(body[k] ?? '').slice(0, 200).trim(); // community address is set by MRG only
    });
    if (body.notifications && typeof body.notifications === 'object') { u.notifications = u.notifications || {}; for (const k of ['newStock', 'orderUpdates', 'newsletter', 'sms']) if (k in body.notifications) u.notifications[k] = !!body.notifications[k]; }
    saveUsers();
    return json(res, 200, { user: safeUser(u), tier: tierOf(u) });
  }

  // GET /api/inventory?category=&search=
  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    const u = userById(scopeUid(q.get('userId')));
    let items = db.inventory.filter((i) => !i.archived);
    const cat = q.get('category');
    if (cat && cat !== 'all') items = items.filter((i) => i.category === cat);
    const s = (q.get('search') || '').toLowerCase();
    if (s) items = items.filter((i) =>
      (i.title + i.sku + i.category).toLowerCase().includes(s));
    return json(res, 200, {
      items,
      categories: [...new Set(db.inventory.map((i) => i.category))].sort(),
    });
  }

  // GET /api/inventory/:sku — full product passport
  if (req.method === 'GET' && parts[1] === 'inventory' && parts[2]) {
    const item = db.inventory.find((i) => i.sku === parts[2]);
    if (!item) return json(res, 404, { error: 'Item not found' });
    return json(res, 200, { item });
  }

  // GET /api/orders
  if (req.method === 'GET' && url.pathname === '/api/orders') {
    const uid = scopeUid(q.get('userId'));
    return json(res, 200, { orders: db.orders.filter((o) => o.userId === uid) });
  }

  // POST /api/orders — reserve items { items:[{sku,qty}], fulfilment }
  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const body = await readBody(req);
    const u = userById(scopeUid(body.userId));
    if (!u || !tierOf(u)) return json(res, 400, { error: 'Unknown member' });
    const gates = tierOf(u).gates;
    if (!gates.reservations)
      return json(res, 403, { error: 'Reservations require Domestic Plus Membership or above.' });
    const lines = (body.items || []).map((l) => {
      const item = db.inventory.find((i) => i.sku === l.sku);
      if (!item) return null;
      if (item.status === 'Reserved') return null;
      if (item.status === 'Pending' && !gates.earlyAccess) return null;
      const qty = Math.max(1, Math.min(l.qty || 1, item.quantity));
      item.quantity -= qty;
      return { sku: item.sku, title: item.title, qty, price: item.price,
               carbon: item.carbonSavedKgPerUnit * qty };
    }).filter(Boolean);
    if (!lines.length) return json(res, 400, { error: 'No reservable items — this item may already be reserved.' });
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const order = {
      id: `ORD-2026-${orderSeq++}`,
      userId: u.id,
      placed: new Date().toISOString().slice(0, 10),
      status: 'Reserved',
      fulfilment: body.fulfilment || 'Collection — Material Reuse Group warehouse',
      slot: 'Slot to be confirmed — we’ll be in touch',
      items: lines.map(({ carbon, ...l }) => l),
      total: +subtotal.toFixed(2),
      carbonSavedKg: +lines.reduce((s, l) => s + l.carbon, 0).toFixed(1),
      projectId: body.projectId && db.projects.some((p) => p.id === body.projectId && p.userId === u.id) ? body.projectId : undefined,
    };
    db.orders.unshift(order);
    saveOrders(); saveInventory();
    integrations.reserveInAirtable(order, u);
    return json(res, 201, { order });
  }

  // GET /api/lists
  if (req.method === 'GET' && url.pathname === '/api/lists') {
    const uid = scopeUid(q.get('userId'));
    const lists = db.lists.filter((l) => l.userId === uid).map((l) => ({
      ...l,
      items: l.items.map((li) => {
        const item = db.inventory.find((i) => i.sku === li.sku) || {};
        return { ...li, title: item.title, price: item.price,
                 carbon: (item.carbonSavedKgPerUnit || 0) * li.qty,
                 inStock: (item.quantity || 0) >= li.qty };
      }),
    }));
    return json(res, 200, { lists });
  }

  // POST /api/lists — create { name }
  if (req.method === 'POST' && url.pathname === '/api/lists') {
    const body = await readBody(req);
    const u = userById(scopeUid(body.userId));
    if (!u || !tierOf(u)) return json(res, 400, { error: 'Unknown member' });
    const limit = tierOf(u).gates.shoppingListLimit;
    const count = db.lists.filter((l) => l.userId === u.id).length;
    if (limit !== null && count >= limit)
      return json(res, 403, { error: `Domestic Basic includes ${limit} shopping list. Upgrade for unlimited lists.` });
    const list = { id: `L-${listSeq++}`, userId: u.id,
      name: body.name || 'New project list',
      created: new Date().toISOString().slice(0, 10), items: [] };
    db.lists.push(list);
    saveLists();
    return json(res, 201, { list });
  }

  // POST /api/lists/:id/items — add { sku, qty }
  if (req.method === 'POST' && parts[1] === 'lists' && parts[3] === 'items') {
    const list = db.lists.find((l) => l.id === parts[2]);
    if (!list) return json(res, 404, { error: 'List not found' });
    if (!isAdmin && list.userId !== actor.id) return json(res, 403, { error: 'Forbidden' });
    const body = await readBody(req);
    if (!db.inventory.some((i) => i.sku === body.sku)) return json(res, 404, { error: 'Item not found' });
    const addQty = Math.max(1, Math.min(9999, Math.round(+body.qty || 1)));
    const existing = list.items.find((i) => i.sku === body.sku);
    if (existing) existing.qty = Math.min(9999, existing.qty + addQty);
    else list.items.push({ sku: body.sku, qty: addQty });
    saveLists();
    return json(res, 200, { list });
  }

  // DELETE /api/lists/:id/items/:sku
  if (req.method === 'DELETE' && parts[1] === 'lists' && parts[3] === 'items') {
    const list = db.lists.find((l) => l.id === parts[2]);
    if (!list) return json(res, 404, { error: 'List not found' });
    if (!isAdmin && list.userId !== actor.id) return json(res, 403, { error: 'Forbidden' });
    list.items = list.items.filter((i) => i.sku !== parts[4]);
    saveLists();
    return json(res, 200, { list });
  }

  // GET /api/carbon
  if (req.method === 'GET' && url.pathname === '/api/carbon') {
    const uid = scopeUid(q.get('userId'));
    const u = userById(uid);
    if (!u) return json(res, 404, { error: 'User not found' });
    if (!isAdmin && !(tierOf(u) && tierOf(u).gates.carbonReports)) return json(res, 403, { error: 'Carbon reporting is part of the Corporate Reuse Partnership.' });
    return json(res, 200, {
      report: features.carbonReportFor(uid),
      level: tierOf(u) ? tierOf(u).gates.carbonReports : 'full',
    });
  }

  // POST /api/audit-request — Corporate members ask for a pre-refurbishment audit (emails the team)
  if (req.method === 'POST' && url.pathname === '/api/audit-request') {
    if (!isAdmin && !(tierOf(actor) && tierOf(actor).gates.audits)) return json(res, 403, { error: 'Pre-refurbishment audits are part of the Corporate Reuse Partnership.' });
    const body = await readBody(req);
    integrations.mail.auditRequest(actor, String(body.note || '').slice(0, 2000));
    return json(res, 200, { ok: true });
  }

  // GET /api/projects
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const uid = scopeUid(q.get('userId'));
    return json(res, 200, { projects: db.projects.filter((p) => p.userId === uid).map((p) => ({
      ...p, documents: features.projectDocs(p), progress: Math.round(((p.stage || 0) / 5) * 100),
      materialsCount: db.materials.filter((x) => x.projectId === p.id).length,
    })) });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---------- static frontend ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  if (file === '/favicon.ico' || file === '/apple-touch-icon.png' || file === '/apple-touch-icon-precomposed.png') file = '/assets/' + (file === '/favicon.ico' ? 'favicon.ico' : 'apple-touch-icon.png'); // browsers probe the site root
  const full = path.join(FRONTEND_DIR, path.normalize(file));
  if (!full.startsWith(FRONTEND_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(FRONTEND_DIR, 'index.html'), (e2, index) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(index);
      });
      return;
    }
    const type = MIME[path.extname(full)] || 'application/octet-stream';
    // html/js/css: always revalidate so a deploy is picked up on the next load (no stale app.js)
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': /html|javascript|css/.test(type) ? 'no-cache' : 'public, max-age=86400' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }
  try {
    req._res = res;
    if (security.canonicalRedirect(req, res, url.pathname)) return;
    security.securityHeaders(req, res, url.pathname);
    res._corsOpen = security.corsOpen(url.pathname);
    if (!security.gate(req, res, { pathname: url.pathname, method: req.method, userId: SESSIONS.get((req.headers.authorization || '').replace(/^Bearer\s+/i, '')) })) return;
    if (url.pathname.startsWith('/api/files/')) return await features.serveSignedFile(req, res, url); // signed, short-lived document links
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/uploads/')) return features.serveUpload(res, url.pathname);
    if (/^\/(order-complete|membership-complete|signup-complete|marketplace)\/?$/.test(url.pathname)) return await api(req, res, url); // commerce pages
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    if (res.headersSent) { try { res.end(); } catch (e) { /* already closed */ } return; } // never leave a request hanging
    return json(res, 500, { error: 'Server error' });
  }
});

(async () => {
  if (SUPA) {
    try {
      await supaLoad();
      initSeqs(); // re-derive from the data we actually loaded
      console.log('  data store: Supabase');
    } catch (e) {
      console.error('  ⚠ Supabase unavailable, using bundled data:', e.message);
    }
  }
  // Admin accounts listed in backend/data/users.json always exist — add any that are missing (by email).
  // So adding an admin = add them to users.json and redeploy; existing accounts are never overwritten.
  try {
    const seedAdmins = load('users.json').users.filter((u) => u.role === 'admin');
    const added = seedAdmins.filter((a) => !db.users.some((u) => u.email.toLowerCase() === a.email.toLowerCase()));
    if (added.length) {
      added.forEach((a) => { if (db.users.some((u) => u.id === a.id)) a.id = `a${Date.now().toString(36)}`; db.users.push(a); });
      saveUsers(); console.log(`  admins added from seed: ${added.map((a) => a.email).join(', ')}`);
    }
    // one-off: admins still on a seeded / pre-hardening password must choose a new strong one at next sign-in
    let forced = 0;
    db.users.filter((u) => u.role === 'admin' && u.auth && !u.auth.iter && !u.auth.mustChange).forEach((u) => { u.auth.mustChange = true; forced++; });
    if (forced) { saveUsers(); console.log(`  ${forced} admin(s) will be asked for a new password`); }
  } catch (e) { console.error('  admin seed check:', e.message); }
  features.migrate(); // one-time data upgrades (no-ops once done)
  initSeqs();
  SESSIONS.sweep();

  // ---- resilience ----
  process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); integrations.alertAdmin('Portal error (uncaught)', e.stack || String(e)); });
  process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); integrations.alertAdmin('Portal error (promise)', (e && e.stack) || String(e)); });
  // Keep the Render free instance awake so the Airtable sync keeps running (set KEEP_ALIVE=false to disable)
  const selfUrl = (process.env.PORTAL_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (selfUrl && (process.env.KEEP_ALIVE || 'true') !== 'false')
    setInterval(() => fetch(selfUrl + '/api/health').catch(() => {}), 10 * 60 * 1000).unref();
  store.startBackups();
  server.listen(PORT, () => {
    console.log('');
    console.log('  material reuse — member portal');
    console.log(`  → http://localhost:${PORT}  (data: ${SUPA ? 'Supabase' : 'local JSON files'})`);
    integrations.start();
    automations.start();
    commerce.start();
    console.log('');
  });
})();
