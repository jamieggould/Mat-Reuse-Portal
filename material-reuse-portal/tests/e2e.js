/* End-to-end test of every feature against a THROWAWAY copy of the portal with mock services.
   Run from the repo root:   node tests/e2e.js
   It copies the folder to a temp dir, starts tests/mock-services.js on :4021 and the server on :4022,
   then walks every route as a public visitor, a domestic member, a community member, a corporate member and an admin.
   Nothing real is contacted and the repo's data files are never modified. */
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-e2e-'));
execSync(`cp -R "${ROOT}/backend" "${ROOT}/frontend" "${ROOT}/tests" "${TMP}/"`);
fs.writeFileSync(path.join(TMP, 'backend/data/sessions.json'), '{"sessions":{}}');
const MOCK = 'http://127.0.0.1:4021', B = 'http://127.0.0.1:4022';
const env = { ...process.env, PORT: '4022', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API: MOCK, BREVO_API_KEY: 'b', BREVO_API: MOCK, TWILIO_API: MOCK,
  ANTHROPIC_API_KEY: 'a', ANTHROPIC_API: MOCK, AIRTABLE_TOKEN: 't', AIRTABLE_BASE: 'appX', AIRTABLE_API: MOCK, AIRTABLE_PUSH: 'true', PORTAL_URL: B, ADMIN_EMAIL: 'admin@example.com', KEEP_ALIVE: 'false', TRUST_PROXY: 'true', PBKDF2_ITER: '2000' };
let mock, server; const out = [];
setTimeout(() => { console.log('\nWATCHDOG: test run exceeded 120s'); try { server.kill('SIGKILL'); mock.kill('SIGKILL'); } catch {} process.exit(2); }, 120000).unref();
const start = (cmd, args, cwd) => { const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', (d) => out.push(String(d))); p.stderr.on('data', (d) => out.push('ERR ' + String(d))); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
const ok = (cond, name, extra) => { if (process.env.E2E_VERBOSE) console.error((cond ? '  ✓ ' : '  ✗ ') + name); if (cond) pass++; else { fail++; fails.push(name + (extra ? ' — ' + extra : '')); } };
const good = (r) => r.status >= 200 && r.status < 300;
const T = {}; // tokens
async function api(p, { method = 'GET', body, token, headers = {}, raw = false } = {}) {
  const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, j, text, h: r.headers };
}
const mockLog = async () => (await (await fetch(MOCK + '/__log')).json());
const login = async (email, password, code) => { const r = await api('/api/auth/login', { method: 'POST', body: { email, password, code } }); return r; };

(async () => {
  mock = start('node', ['tests/mock-services.js'], TMP); await sleep(500);
  server = start('node', ['backend/server.js'], TMP); await sleep(1800);
  try {
    /* ---------- public ---------- */
    let r = await api('/api/health'); ok(r.status === 200 && r.j.ok !== false, 'health');
    r = await api('/'); ok(r.status === 200 && /Material Reuse Hub/.test(r.text) && /favicon\.ico/.test(r.text), 'index served with title + favicon');
    ok(/frame-ancestors 'none'/.test(r.h.get('content-security-policy') || '') && r.h.get('x-content-type-options') === 'nosniff', 'security headers on index');
    r = await api('/favicon.ico'); ok(r.status === 200 && /x-icon/.test(r.h.get('content-type')), 'root favicon.ico');
    r = await api('/marketplace'); ok(r.status === 200 && /frame-ancestors 'self' https:/.test(r.h.get('content-security-policy')), 'marketplace embeddable');
    r = await api('/api/public/marketplace'); ok(r.status === 200 && Array.isArray(r.j.items) && r.j.items.length > 0 && r.h.get('access-control-allow-origin') === '*', 'public marketplace + CORS');
    const item = r.j.items.find((i) => i.buyUrl) || r.j.items[0];
    ok(item.carbonSavedKgPerUnit >= 0 && !('userId' in item), 'listing shape (per-unit carbon, no private fields)');
    r = await api('/api/public/tiers'); ok(r.status === 200 && r.j.tiers.length === 3 && r.j.tiers.every((t) => /^domestic-/.test(t.id)), 'public tiers = 3 domestic');
    r = await api('/api/public/impact'); ok(r.status === 200 && 'kgCO2e' in r.j, 'public impact');
    r = await api('/api/auth/me'); ok(r.status === 401, 'me without token 401');
    r = await api('/api/admin/members'); ok(r.status === 401, 'admin route without token 401');
    r = await api('/api/qr?data=https://evil.example/passport/x'); ok(r.status === 400, 'qr rejects foreign host');
    r = await api('/api/auth/login', { method: 'POST', body: 'null' }); ok(r.status === 401 || r.status === 400, 'null JSON body handled');
    r = await api('/api/auth/login', { method: 'POST', body: '[1,2]' }); ok(r.status === 401 || r.status === 400, 'array JSON body handled');
    r = await api('/api/uploads', { method: 'POST', body: 'x'.repeat(300 * 1024) }); ok(r.status === 413 || r.status === 401, 'oversize body capped', String(r.status));

    /* ---------- login / lockout / XFF ---------- */
    r = await login('jamesgould@estaraai.com', 'wrong'); ok(r.status === 401, 'bad password 401');
    r = await login('jamesgould@estaraai.com', 'MRG-James-2026'); ok(r.status === 200 && r.j.token && r.j.user.role === 'admin', 'admin login'); T.admin = r.j.token;
    ok(!('auth' in r.j.user) && !('totp' in r.j.user) && !('reset' in r.j.user), 'safeUser strips secrets');
    r = await login('jamieggould@gmail.com', 'JAMESGOULD-2026'); ok(r.status === 200 && r.j.tier && r.j.tier.id === 'corporate-reuse-partner', 'corporate member login'); T.corp = r.j.token; const corpId = r.j.user.id;
    // per-IP login limit cannot be dodged by prepending X-Forwarded-For
    let blocked = false;
    for (let i = 0; i < 25; i++) { const x = await api('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'x' }, headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` } }); if (x.status === 429) { blocked = true; break; } }
    ok(blocked, 'login rate limit holds with spoofed X-Forwarded-For (last hop used)');

    /* ---------- register (free) + forgot/reset ---------- */
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Free Fran', email: 'fran@example.com', password: 'franpass123', tier: 'domestic-free' }, headers: { 'x-forwarded-for': '198.51.100.1' } });
    ok(good(r) && r.j.token && r.j.user.tier === 'domestic-free', 'free sign-up', r.status + ' ' + JSON.stringify(r.j).slice(0, 100)); T.free = r.j.token; const freeId = r.j.user.id;
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Xavier Test', email: 'fran@example.com', password: 'franpass123', tier: 'domestic-free' }, headers: { 'x-forwarded-for': '198.51.100.1' } }); ok(r.status === 409, 'duplicate email 409', r.status + ' ' + JSON.stringify(r.j));
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Xavier Test', email: 'x@example.com', password: 'weak', tier: 'domestic-free' }, headers: { 'x-forwarded-for': '198.51.100.1' } }); ok(r.status === 400, 'weak password rejected');
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Xavier Test', email: 'x2@example.com', password: 'goodpass123', tier: 'corporate-reuse-partner' }, headers: { 'x-forwarded-for': '198.51.100.1' } }); ok((r.status === 400) || (r.status === 201 && r.j.user.tier === 'domestic-free'), 'self-register onto a managed tier falls back to Basic', String(r.status));
    r = await api('/api/auth/forgot', { method: 'POST', body: { email: 'fran@example.com' } }); ok(r.status === 200, 'forgot ok');
    await sleep(800); let lg = await mockLog(); const resetMail = lg.log.filter((l) => l.brevoMail).map((l) => l.brevoMail).reverse().find((m) => /reset/i.test(m.subject));
    const resetToken = resetMail && (resetMail.htmlContent.match(/\/reset\/([\w-]+)/) || [])[1];
    ok(!!resetToken, 'reset email sent via Brevo with link', JSON.stringify(lg.log.filter((l) => l.brevoMail).map((l) => l.brevoMail.subject)) + ' ' + JSON.stringify(lg.log.slice(-3)).slice(0, 300));
    r = await api('/api/auth/reset', { method: 'POST', body: { token: resetToken, password: 'newfranpass123' } }); ok(r.status === 200 && r.j.token, 'reset sets password + signs in', r.status + ' ' + JSON.stringify(r.j).slice(0, 100) + ' token=' + resetToken); T.free = r.j.token;
    r = await api('/api/auth/reset', { method: 'POST', body: { token: resetToken, password: 'newfranpass1234' } }); ok(r.status === 400, 'reset token single-use');
    r = await login('fran@example.com', 'newfranpass123'); ok(r.status === 200, 'login with new password'); T.free = r.j.token;

    /* ---------- domestic member: what they can and can't see ---------- */
    r = await api('/api/auth/me', { token: T.free }); ok(r.status === 200 && r.j.tier.gates.documents === false && r.j.tier.gates.passports === false, 'basic tier gates');
    r = await api('/api/materials', { token: T.free }); ok(r.status === 200 && r.j.materials.length > 0 && r.j.materials.every((m) => m.buyUrl !== undefined), 'basic member sees marketplace listings');
    r = await api('/api/impact', { token: T.free }); ok(r.status === 403, 'basic member cannot use impact centre');
    r = await api('/api/admin/members', { token: T.free }); ok(r.status === 403, 'member blocked from admin');
    r = await api('/api/admin/wishlist', { token: T.free }); ok(r.status === 403, 'member blocked from admin wishlist');
    r = await api('/api/admin/suggest', { method: 'POST', token: T.free, body: { name: 'x' } }); ok(r.status === 403, 'member blocked from AI suggest');
    r = await api('/api/users/' + corpId, { token: T.free }); ok(r.status === 403, 'IDOR: cannot read another user');
    r = await api('/api/users/' + freeId, { method: 'PATCH', token: T.free, body: { name: { evil: 1 }, phone: 12345, notifications: { __proto__: { polluted: 1 }, newStock: false, bogus: true } } });
    ok(r.status === 200 && typeof r.j.user.name === 'string' && r.j.user.phone === '12345' && r.j.user.notifications.newStock === false && !('bogus' in r.j.user.notifications) && !({}.polluted), 'profile fields coerced, notifications whitelisted');
    r = await api('/api/users/' + freeId, { method: 'PATCH', token: T.free, body: { name: 'Free Fran' } });
    r = await api('/api/membership', { token: T.free }); ok(r.status === 200 && r.j.membership && r.j.membership.tier, 'membership view');
    r = await api('/api/wishlist', { method: 'POST', token: T.free, body: { category: 'Seating', notes: 'chairs' } }); ok(good(r), 'wishlist add', r.status + ' ' + JSON.stringify(r.j).slice(0, 100)); const wishId = (r.j.wish || r.j.entry || (r.j.wishlist && r.j.wishlist[0]) || {}).id;
    r = await api('/api/wishlist', { token: T.free }); ok(r.status === 200 && r.j.wishlist.length === 1, 'wishlist list');
    r = await api('/api/chat', { method: 'POST', token: T.free, body: { messages: [{ role: 'user', content: 'What can I buy?' }] } }); ok(r.status === 200 && r.j.reply, 'chat works for basic tier');
    r = await api('/api/documents', { method: 'POST', token: T.free, body: { name: 'evil', key: '../server.js' } });
    ok(good(r) ? r.j.document.key === null : r.status === 403, 'traversal key discarded', r.status + ' key=' + JSON.stringify(r.j.document && r.j.document.key));
    if (good(r)) { const d = await api('/api/documents/' + r.j.document.id, { method: 'DELETE', token: T.free }); ok(d.status === 200 && fs.existsSync(path.join(TMP, 'backend/server.js')), 'delete with bad key is harmless'); }

    /* ---------- buy / reserve with credit (domestic standard via paid signup) ---------- */
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Std Sam', email: 'sam@example.com', password: 'sampass123', tier: 'domestic-standard' }, headers: { 'x-forwarded-for': '198.51.100.2' } });
    ok(r.status === 200 && r.j.checkoutUrl, 'paid sign-up returns Stripe checkout'); const csSignup = (r.j.checkoutUrl.match(/cs_test_\d+/) || [])[0];
    // C1: unpaid session must NOT create the account
    r = await api('/signup-complete?session_id=' + csSignup); ok(!/Welcome/.test(r.text), 'unpaid signup session does not create account');
    r = await login('sam@example.com', 'sampass123'); ok(r.status === 401, 'no account before payment');
    await fetch(`${MOCK}/__paysession/${csSignup}/1/sam@example.com`);
    r = await api('/signup-complete?session_id=' + csSignup); ok(/Welcome/.test(r.text), 'paid signup completes');
    r = await login('sam@example.com', 'sampass123'); ok(r.status === 200 && r.j.tier.id === 'domestic-standard', 'standard member created on paid tier'); T.std = r.j.token; const stdId = r.j.user.id;
    r = await api('/api/membership', { token: T.std }); ok(r.j.membership.credit && r.j.membership.credit.remaining === 100, 'standard has £100 credit', JSON.stringify(r.j.membership.credit));
    r = await api('/api/materials', { token: T.std }); const cheap = r.j.materials.filter((m) => m.listedPrice > 0 && m.listedPrice <= 60 && m.quantity >= 2).sort((a, b) => a.listedPrice - b.listedPrice)[0];
    ok(!!cheap, 'a cheap in-stock item exists for credit test');
    r = await api('/api/orders/checkout', { method: 'POST', token: T.std, body: { sku: cheap.sku, mode: 'buy', qty: 1 } });
    ok(good(r) && r.j.order && r.j.order.creditApplied === cheap.listedPrice, 'buy fully covered by credit → instant order', r.status + ' ' + JSON.stringify(r.j).slice(0, 160));
    r = await api('/api/membership', { token: T.std }); ok(r.j.membership.credit.remaining === +(100 - cheap.listedPrice).toFixed(2), 'credit reduced');
    r = await api('/api/orders', { token: T.std }); ok(r.j.orders.length === 1 && r.j.orders[0].carbonSavedKg >= 0, 'order visible with carbon');
    // qty above stock clamped / rejected
    r = await api('/api/orders/checkout', { method: 'POST', token: T.std, body: { sku: cheap.sku, mode: 'buy', qty: 99999 } }); ok(r.status === 200 || r.status === 400, 'huge qty handled');
    // H1: credit double spend — open two partial-credit sessions, pay both; second must not re-apply credit
    r = await api('/api/materials', { token: T.std }); const dear = r.j.materials.filter((m) => m.listedPrice >= 60 && m.quantity >= 5).sort((a, b) => b.listedPrice - a.listedPrice)[0];
    const mem = (await api('/api/membership', { token: T.std })).j.membership.credit.remaining;
    const s1 = await api('/api/orders/checkout', { method: 'POST', token: T.std, body: { sku: dear.sku, mode: 'buy', qty: 1 } });
    const s2 = await api('/api/orders/checkout', { method: 'POST', token: T.std, body: { sku: dear.sku, mode: 'buy', qty: 1 } });
    ok(s1.j.url && s2.j.url, 'two partial-credit checkouts opened');
    const cs1 = (s1.j.url.match(/cs_test_\d+/) || [])[0], cs2 = (s2.j.url.match(/cs_test_\d+/) || [])[0];
    await fetch(`${MOCK}/__paysession/${cs1}/1/sam@example.com`); await fetch(`${MOCK}/__paysession/${cs2}/1/sam@example.com`);
    await api('/order-complete?session_id=' + cs1); await api('/order-complete?session_id=' + cs2);
    r = await api('/api/orders', { token: T.std }); const o1 = r.j.orders.find((o) => o.stripeSessionId === cs1), o2 = r.j.orders.find((o) => o.stripeSessionId === cs2);
    ok(o1 && o2 && (o1.creditApplied || 0) + (o2.creditApplied || 0) <= mem + 0.001, 'credit cannot be double-spent across sessions', `${o1 && o1.creditApplied} + ${o2 && o2.creditApplied} vs ${mem}`);
    ok(o2 && /shortfall/i.test(o2.note || ''), 'second order flagged with credit shortfall');
    r = await api('/order-complete?session_id=' + cs1); r = await api('/api/orders', { token: T.std }); ok(r.j.orders.filter((o) => o.stripeSessionId === cs1).length === 1, 'order-complete idempotent');
    // reserve (deposit)
    r = await api('/api/orders/checkout', { method: 'POST', token: T.std, body: { sku: dear.sku, mode: 'deposit', qty: 1 } }); ok(good(r) && (r.j.url || r.j.order), 'reserve with deposit', r.status + ' ' + JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/wishlist/' + wishId, { method: 'DELETE', token: T.std }); ok(r.status === 403 || r.status === 404, 'IDOR: cannot delete another member\'s wish');
    r = await api('/api/wishlist/' + wishId, { method: 'DELETE', token: T.free }); ok(r.status === 200, 'own wish closed');

    /* ---------- admin ---------- */
    r = await api('/api/admin/members', { token: T.admin }); ok(r.status === 200 && r.j.members.some((m) => m.id === stdId), 'admin members list');
    r = await api('/api/admin/members', { method: 'POST', token: T.admin, body: { name: 'Comm Cara', email: 'cara@example.com', password: 'carapass123', tier: 'community', address: '12 High St, London' } });
    ok(good(r) && r.j.user, 'admin creates community member', r.status + ' ' + JSON.stringify(r.j).slice(0, 100)); const caraId = r.j.user && r.j.user.id;
    r = await api('/api/admin/members', { method: 'POST', token: T.admin, body: { name: 'No Addr', email: 'noaddr@example.com', password: 'carapass123', tier: 'community' } }); ok(r.status === 400, 'community needs address');
    r = await api('/api/admin/members/' + caraId, { method: 'PATCH', token: T.admin, body: { email: 'sam@example.com' } }); ok(r.status === 409, 'admin cannot give a duplicate email');
    r = await api('/api/admin/members/' + caraId, { method: 'PATCH', token: T.admin, body: { email: 'not-an-email' } }); ok(r.status === 400, 'admin email validated');
    r = await login('cara@example.com', 'carapass123'); ok(r.status === 200 && r.j.user.mustChange === true, 'temp password flagged mustChange'); T.comm = r.j.token;
    r = await api('/api/auth/password', { method: 'POST', token: T.comm, body: { current: 'carapass123', next: 'carapass1234' } }); ok(r.status === 200, 'community changes password', JSON.stringify(r.j).slice(0, 80));
    r = await login('cara@example.com', 'carapass1234'); T.comm = r.j.token; ok(r.status === 200 && r.j.user.mustChange === false, 'mustChange cleared');
    // community buys → evidence required
    r = await api('/api/orders/checkout', { method: 'POST', token: T.comm, body: { sku: cheap.sku, mode: 'buy', qty: 1 } }); ok(good(r) && (r.j.url || r.j.order), 'community can buy with address', r.status + ' ' + JSON.stringify(r.j).slice(0, 100));
    // admin passport create with stock + AI suggest
    r = await api('/api/admin/suggest', { method: 'POST', token: T.admin, body: { name: 'Oak flooring boards', category: 'Flooring', condition: 'Good', quantity: 20 } }); ok(r.status === 200 && r.j.price > 0 && r.j.carbonKg >= 0 && r.j.retailNew > 0, 'AI suggest price/carbon/new', JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/meta', { token: T.admin }); ok(r.j.categories.includes('Flooring'), 'Flooring in categories');
    r = await api('/api/admin/materials', { method: 'POST', token: T.admin, body: { name: 'Oak flooring boards', category: 'Flooring', condition: 'Good', quantity: 20, unit: 'm²', status: 'Listed', carbonSavedKg: 120, stock: { price: 12, retailNew: 40, fulfilment: 'Collection Only', availability: 'Available' } } });
    ok(good(r) && r.j.material && r.j.material.sku, 'admin creates MRG passport with listing', r.status + ' ' + JSON.stringify(r.j).slice(0, 120)); const matId = r.j.material && r.j.material.id;
    await sleep(4600); lg = await mockLog(); ok(lg.log.some((l) => l.table === 'Table 1' || (l.stripe === undefined && l.fields && l.fields.Name === 'Oak flooring boards')) || lg.T['Table 1'].some((x) => x.fields.Name === 'Oak flooring boards'), 'listing pushed to Airtable');
    r = await api('/api/public/marketplace'); const fl = r.j.items.find((i) => i.title === 'Oak flooring boards'); ok(fl && fl.carbonSavedKgPerUnit === 6 && fl.retailNew === 40 && fl.category === 'Flooring', 'new listing public with per-unit carbon 6', JSON.stringify(fl).slice(0, 120));
    r = await api('/api/public/passports/' + matId); ok(r.status === 200 && !/"userId"/.test(r.text), 'public passport', r.status + ' ' + r.text.slice(0, 80));
    r = await api('/api/admin/materials/' + matId, { method: 'PATCH', token: T.admin, body: { quantity: 15, stock: { price: 14 } } }); ok(r.status === 200, 'admin edits passport');
    r = await api('/api/public/marketplace'); ok(r.j.items.find((i) => i.title === 'Oak flooring boards').price === 14, 'price change live in marketplace');
    // member cannot offer back MRG passport
    r = await api('/api/requests', { method: 'POST', token: T.corp, body: { materials: [{ name: 'Chairs', qty: 2 }], location: 'Site A', passportIds: [matId], desiredDate: { x: 1 } } });
    ok(good(r) && r.j.request && (!r.j.request.passportIds || r.j.request.passportIds.length === 0) && r.j.request.desiredDate === null, 'request: foreign passport ignored, bad date dropped', r.status + ' ' + JSON.stringify(r.j).slice(0, 160));
    // walk-in sale both ways
    r = await api(`/api/admin/scan/${matId}/sell`, { method: 'POST', token: T.admin, body: { email: 'walkin@example.com', name: 'Walk In', qty: 2, createAccount: true } }); ok(good(r) && r.j.order, 'walk-in sale creates account', r.status + ' ' + JSON.stringify(r.j).slice(0, 100));
    r = await api(`/api/admin/scan/${matId}/sell`, { method: 'POST', token: T.admin, body: { email: 'guest@example.com', qty: 1, createAccount: false } }); ok(good(r) && r.j.order, 'walk-in guest sale', r.status + ' ' + JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/admin/members', { token: T.admin }); ok(r.j.members.some((m) => m.email === 'walkin@example.com') && !r.j.members.some((m) => m.email === 'guest@example.com'), 'account only when asked');
    // orders admin: slot + collect → balance invoice + impact
    // reserve (deposit) session from earlier: pay it and complete, then admin confirms a slot → SMS + balance invoice
    const resvUrl = (await api('/api/orders/checkout', { method: 'POST', token: T.std, body: { sku: dear.sku, mode: 'deposit', qty: 1 } })).j.url;
    const csR = resvUrl && (resvUrl.match(/cs_test_\d+/) || [])[0]; ok(!!csR, 'deposit checkout session', JSON.stringify((await api('/api/orders/checkout', { method: 'POST', token: T.std, body: { sku: dear.sku, mode: 'deposit', qty: 1 } })).j).slice(0, 200) + ' dear=' + JSON.stringify({ sku: dear.sku, q: dear.quantity, p: dear.listedPrice }));
    
    await fetch(`${MOCK}/__paysession/${csR}/1/sam@example.com`); await api('/order-complete?session_id=' + csR);
    r = await api('/api/orders?userId=' + stdId, { token: T.admin }); ok(r.status === 200 && r.j.orders.length > 3, 'admin reads member orders', r.status + ' ' + r.text.slice(0, 100));
    const resv = r.j.orders.find((o) => o.status === 'Reserved'); ok(!!resv && resv.depositGBP > 0 && resv.balanceDueGBP > 0, 'reserved order carries deposit + balance', JSON.stringify(resv).slice(0, 160));
    await api('/api/users/' + stdId, { method: 'PATCH', token: T.std, body: { phone: '+447700900123' } });
    if (resv) { r = await api('/api/admin/orders/' + resv.id, { method: 'PATCH', token: T.admin, body: { slot: '2026-10-01 10:00', status: 'Awaiting collection' } }); ok(r.status === 200, 'slot confirmed'); await sleep(800); lg = await mockLog(); ok(lg.log.some((l) => l.brevoSms || l.sms), 'slot SMS sent'); ok(Object.keys(lg.invoices).length > 0, 'balance invoice raised'); }
    /* ---------- membership changes ---------- */
    r = await api('/api/membership/change', { method: 'POST', token: T.std, body: { tier: 'domestic-plus' } }); ok(good(r) && (r.j.checkoutUrl || r.j.message || r.j.membership), 'upgrade path', r.status + ' ' + JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/membership/change', { method: 'POST', token: T.std, body: { tier: 'corporate-reuse-partner' } }); ok(r.status === 400, 'cannot self-move to managed tier');
    r = await api('/api/membership/change', { method: 'POST', token: T.std, body: { tier: 'domestic-free' } }); ok(good(r), 'downgrade scheduled', r.status + ' ' + JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/membership/portal', { method: 'POST', token: T.std }); ok(r.status === 200 && /stripe/.test(r.j.url || ''), 'billing portal url');

    const stdOrder = (await api('/api/orders', { token: T.std })).j.orders[0];
    r = await api('/api/admin/orders/' + stdOrder.id, { method: 'PATCH', token: T.admin, body: { status: 'Collected' } }); ok(r.status === 200, 'order collected');
    r = await api('/api/auth/me', { token: T.std }); ok(r.j.user.carbonSavedKg > 0 && r.j.user.itemsRehomed > 0, 'member stats updated after collection', JSON.stringify({ c: r.j.user.carbonSavedKg, i: r.j.user.itemsRehomed }));
    r = await api('/api/admin/impact', { token: T.admin }); ok(r.status === 200, 'admin impact');
    r = await api('/api/admin/system', { token: T.admin }); ok(r.status === 200 && r.j.audit && r.j.audit.length > 0, 'audit log');
    r = await api('/api/admin/system/run', { method: 'POST', token: T.admin }); ok(r.status === 200, 'automations run-now');
    r = await api('/api/admin/system/digest', { method: 'POST', token: T.admin }); ok(r.status === 200, 'digest');
    r = await api('/api/admin/system/stockmail', { method: 'POST', token: T.admin }); ok(r.status === 200, 'weekly stock mail');
    r = await api('/api/admin/wishlist', { token: T.admin }); ok(r.status === 200, 'admin wishlist');
    r = await api('/api/admin/factors', { token: T.admin }); ok(r.status === 200, 'factors');
    r = await api('/api/impact/export.csv?userId=all', { token: T.admin }); ok(r.status === 200 && !/\n=|,=|^=/.test(r.text.replace(/'=/g, '')), 'csv export');
    // every page rendered for every role with a fake DOM (catches JS errors, 'undefined' text, domestic tiers seeing managed-tier copy)
    const sr = await new Promise((resolve) => { const p = spawn('node', ['tests/smoke-render.js'], { cwd: TMP, env: { ...env, B, XFF: '192.0.2.77' } }); let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d)); p.on('close', () => resolve(o)); });
    ok(/ALL RENDERS OK/.test(sr), 'every page renders for every role', sr.split('\n').filter((l) => /ERROR|failed|✗|suspicious|FAILS/.test(l)).join(' | ').slice(0, 600));
    if (process.env.E2E_VERBOSE) console.error(sr);
    // 2FA: setup/enable/disable, and login requires code; brute-force lock counts
    r = await api('/api/auth/totp/setup', { method: 'POST', token: T.admin }); ok(r.status === 200 && r.j.secret && !r.j.qr, 'totp setup returns secret only'); const secret = r.j.secret.replace(/\s/g, '');
    const totp = (sec) => { const { totpCode } = require(path.join(TMP, 'backend/security.js')); return totpCode ? totpCode(sec, Math.floor(Date.now() / 30000)) : null; };
    let code = totp(secret);
    if (!code) { // compute locally (RFC 6238) if the module doesn't export a generator
      const crypto = require('crypto'); const b32 = (s) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '', out = []; for (const c of s.toUpperCase()) { const v = a.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); } for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
      const key = b32(secret); const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const h = crypto.createHmac('sha1', key).update(ctr).digest(); const off = h[19] & 0xf; code = String(((h.readUInt32BE(off) & 0x7fffffff) % 1e6)).padStart(6, '0');
    }
    r = await api('/api/auth/totp/enable', { method: 'POST', token: T.admin, body: { code } }); ok(r.status === 200, 'totp enabled', JSON.stringify(r.j));
    r = await api('/api/auth/totp/setup', { method: 'POST', token: T.admin }); ok(r.status === 400, 'cannot overwrite enabled totp');
    r = await login('jamesgould@estaraai.com', 'MRG-James-2026'); ok(r.status === 200 && r.j.totpRequired && !r.j.token, 'login asks for code');
    let locked = false; for (let i = 0; i < 12; i++) { const x = await login('jamesgould@estaraai.com', 'MRG-James-2026', '000000'); if (x.status === 429) { locked = true; break; } }
    ok(locked, 'wrong codes lock the account (no reset of the counter)');
    // reset for 2FA user never issues a session
    r = await api('/api/auth/forgot', { method: 'POST', body: { email: 'jamesgould@estaraai.com' } }); await sleep(800); lg = await mockLog();
    const rm = lg.log.filter((l) => l.brevoMail).map((l) => l.brevoMail).reverse().find((m) => /reset/i.test(m.subject) && /estaraai/.test(JSON.stringify(m.to)));
    const rt = rm && (rm.htmlContent.match(/\/reset\/([\w-]+)/) || [])[1];
    r = await api('/api/auth/reset', { method: 'POST', body: { token: rt, password: 'NewAdminPassw0rd!!' } }); ok(r.status === 200 && r.j.signIn === true && !r.j.token, 'reset on 2FA account does not sign in');
    r = await api('/api/auth/me', { token: T.admin }); ok(r.status === 401, 'reset revoked old admin session');
    // sessions stored hashed
    const sess = JSON.parse(fs.readFileSync(path.join(TMP, 'backend/data/sessions.json'), 'utf8')).sessions;
    ok(!Object.keys(sess).includes(T.std) && Object.keys(sess).length > 0, 'session tokens stored hashed');
    // logout
    r = await api('/api/auth/logout', { method: 'POST', token: T.std }); r = await api('/api/auth/me', { token: T.std }); ok(r.status === 401, 'logout kills session');
    // checkout error page escapes
    r = await api('/api/checkout?sku=nope&mode=buy'); ok(r.status >= 400 && !/<script/.test(r.text), 'checkout error page safe');
    // uploads: bad file type rejected, real png accepted
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    r = await api('/api/uploads', { method: 'POST', token: T.corp, body: { name: 'a.png', mime: 'image/png', data: png.toString('base64') } }); ok(good(r) && r.j.file && /^[\w-]+\/\d+-/.test(r.j.file.key), 'png upload ok', r.status + ' ' + JSON.stringify(r.j).slice(0, 100));
    r = await api('/api/uploads', { method: 'POST', token: T.corp, body: { name: 'a.png', mime: 'image/png', data: Buffer.from('<script>').toString('base64') } }); ok(r.status === 415 || r.status === 400, 'fake png rejected');
    // private documents: stored out of public reach, opened only through signed, expiring links
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    r = await api('/api/uploads', { method: 'POST', token: T.corp, body: { name: 'audit.pdf', mime: 'application/pdf', data: pdf.toString('base64'), private: true } });
    ok(good(r) && r.j.file.private === true && /^private\//.test(r.j.file.key) && /^\/api\/files\//.test(r.j.file.url), 'private upload', r.status + ' ' + JSON.stringify(r.j).slice(0, 120));
    const pkey = r.j.file.key;
    r = await api('/uploads/' + pkey); ok(r.status === 403 || r.status === 404, 'private file not on the public uploads path', String(r.status));
    r = await api('/api/files/' + pkey); ok(r.status === 403, 'private file without signature refused', String(r.status));
    r = await api('/api/documents', { method: 'POST', token: T.corp, body: { name: 'Audit 2026', category: 'Pre-refurbishment audit', url: '/api/files/' + pkey, key: pkey, mime: 'application/pdf', size: pdf.length } });
    ok(good(r) && /exp=\d+&sig=/.test(r.j.document.url), 'document returned with a signed link', r.status + ' ' + JSON.stringify(r.j).slice(0, 160)); const docId = r.j.document.id;
    r = await api('/api/documents', { token: T.corp }); const doc = r.j.documents.find((d) => d.id === docId); ok(doc && /exp=\d+&sig=/.test(doc.url), 'document list carries signed links');
    r = await api(doc.url); ok(r.status === 200 && /pdf/.test(r.h.get('content-type')) && /^%PDF/.test(r.text), 'signed link opens the file', r.status + ' ' + r.h.get('content-type'));
    r = await api(doc.url.replace(/sig=\w+/, 'sig=0000000000000000000000000000000000000000')); ok(r.status === 403, 'tampered signature refused');
    r = await api(doc.url.replace(/exp=\d+/, 'exp=1')); ok(r.status === 403, 'expired link refused');
    r = await api('/api/documents', { token: T.free }); ok(r.status === 200 && !r.j.documents.some((d) => d.id === docId), 'other member cannot list it');
    r = await api('/api/documents/' + docId, { method: 'DELETE', token: T.free }); ok(r.status === 403 || r.status === 404, 'other member cannot delete it');
    r = await api('/api/documents/' + docId, { method: 'DELETE', token: T.corp }); ok(r.status === 200, 'owner deletes document'); r = await api(doc.url); ok(r.status === 404, 'file gone after delete', String(r.status));
    r = await api('/api/admin/members/' + caraId + '/community', { method: 'POST', token: T.admin, body: { approve: true } }); ok([400, 401, 403, 404, 405].includes(r.status) && !(r.j && r.j.user), 'community-request route removed', String(r.status));
  } catch (e) { fail++; fails.push('EXCEPTION ' + e.stack); }
  finally { if (process.env.E2E_VERBOSE) console.error('  (tests finished, stopping services)'); server.kill('SIGKILL'); mock.kill('SIGKILL'); }
  const errs = out.filter((l) => /ERR |TypeError|ReferenceError|Unhandled/.test(l));
  console.log(`\n${pass} passed, ${fail} failed`); fails.forEach((f) => console.log('  ✗ ' + f));
  if (errs.length) { console.log('\nserver stderr:'); errs.slice(0, 10).forEach((l) => console.log('  ' + l.trim().slice(0, 300))); }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
