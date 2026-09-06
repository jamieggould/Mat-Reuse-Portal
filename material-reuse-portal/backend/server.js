/**
 * Material Reuse — Member Portal API
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
const DATA_DIR = path.join(__dirname, 'data');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ---------- load data ----------
// The JSON files in backend/data are the seed data. When SUPABASE_URL and
// SUPABASE_SERVICE_KEY are set (e.g. on Render), every collection is loaded
// from and saved to a Supabase `portal_data` table instead, so nothing is
// lost when the host wipes its disk on redeploy. Locally (no env vars) it
// just uses the files, exactly as before. Requires Node 18+ (global fetch).
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPA = !!(SUPA_URL && SUPA_KEY);

const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const db = {
  tiers: load('tiers.json').tiers, // tiers are config — always ship with the code
  users: load('users.json').users,
  inventory: load('inventory.json').items,
  orders: load('orders.json').orders,
  lists: load('lists.json').lists,
  carbon: load('carbon.json').carbon,
  projects: load('projects.json').projects,
  materials: load('materials.json').materials,
  documents: load('documents.json').documents,
  requests: load('requests.json').requests,
  impactEvents: load('impactEvents.json').impactEvents,
};
const PERSISTED = ['users', 'inventory', 'orders', 'lists', 'carbon', 'projects', 'materials', 'documents', 'requests', 'impactEvents'];

const supaHeaders = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates,return=minimal',
};

async function supaLoad() {
  const res = await fetch(`${SUPA_URL}/rest/v1/portal_data?select=key,body`, { headers: supaHeaders });
  if (!res.ok) throw new Error(`Supabase read failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.body]));
  const seed = [];
  for (const key of PERSISTED) {
    if (byKey[key] !== undefined) db[key] = byKey[key];
    else seed.push({ key, body: db[key] }); // first boot — push the seed data up
  }
  if (seed.length) {
    const up = await fetch(`${SUPA_URL}/rest/v1/portal_data`, {
      method: 'POST', headers: supaHeaders, body: JSON.stringify(seed),
    });
    if (!up.ok) throw new Error(`Supabase seed failed (${up.status}): ${await up.text()}`);
    console.log(`  seeded Supabase with: ${seed.map((s) => s.key).join(', ')}`);
  }
}

function persist(key, fileBody) {
  try { fs.writeFileSync(path.join(DATA_DIR, `${key}.json`), JSON.stringify(fileBody, null, 2)); } catch (e) { /* read-only disk is fine when Supabase is on */ }
  if (SUPA) {
    fetch(`${SUPA_URL}/rest/v1/portal_data`, {
      method: 'POST', headers: supaHeaders,
      body: JSON.stringify([{ key, body: db[key] }]),
    }).then((r) => { if (!r.ok) r.text().then((t) => console.error(`Supabase save '${key}' failed (${r.status}): ${t}`)); })
      .catch((e) => console.error(`Supabase save '${key}' failed:`, e.message));
  }
}
const saveUsers = () => persist('users', { users: db.users });
const saveCarbon = () => persist('carbon', { carbon: db.carbon });
const saveOrders = () => persist('orders', { orders: db.orders });
const saveLists = () => persist('lists', { lists: db.lists });
const saveProjects = () => persist('projects', { projects: db.projects });
const saveInventory = () => persist('inventory', { items: db.inventory });

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

// ---------- auth helpers ----------
const SESSIONS = new Map(); // token -> userId

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
  const { auth, ...rest } = u;
  return { ...rest, mustChange: !!(auth && auth.mustChange) };
};

// ---------- helpers ----------
const json = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

// ---------- features module (impact ledger, passports, documents, requests, uploads) ----------
// All live stats come from the impact ledger inside this module — see backend/features.js
const features = require('./features')({
  db, json, readBody, persist, SUPA, SUPA_URL, supaHeaders, DATA_DIR,
  saveUsers, saveCarbon, saveOrders, saveLists, saveProjects, saveInventory,
  nextProjectSeq: () => projectSeq++,
});
const applyOrderStats = features.applyOrderStats;

const userById = (id) => db.users.find((u) => u.id === id);
const userByEmail = (e) =>
  db.users.find((u) => u.email.toLowerCase() === String(e || '').trim().toLowerCase());
const tierOf = (user) => db.tiers.find((t) => t.id === user.tier) || null;
const initials = (name) =>
  String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ---------- integrations: Airtable ⇄ portal sync + Resend email (backend/integrations.js) ----------
const integrations = require('./integrations')({
  db, features, saveUsers, saveOrders, saveInventory, saveCarbon, makeAuth, initials,
  nextUserId: () => `u${userSeq++}`,
});

// ---------- API routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = url.searchParams;

  /* ============ AUTH (the only unauthenticated route is login) ============ */

  // POST /api/auth/login { email, password }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const u = userByEmail(body.email);
    if (!u || !checkPw(u, body.password || ''))
      return json(res, 401, { error: 'Incorrect email or password.' });
    const token = crypto.randomBytes(32).toString('hex');
    SESSIONS.set(token, u.id);
    return json(res, 200, { token, user: safeUser(u), tier: tierOf(u) });
  }

  // POST /api/auth/register — self-service signup. ALWAYS the free tier:
  // paid tiers are only ever set by admins or via the membership enquiry.
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim();
    if (name.length < 2) return json(res, 400, { error: 'Please enter your full name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return json(res, 400, { error: 'Please enter a valid email address.' });
    if (!b.password || String(b.password).length < 8)
      return json(res, 400, { error: 'Password must be at least 8 characters.' });
    if (userByEmail(email))
      return json(res, 409, { error: 'An account with that email already exists — try signing in.' });
    const u = {
      id: `u${userSeq++}`,
      role: 'member',
      name,
      email,
      tier: 'domestic-free',
      memberSince: new Date().toISOString().slice(0, 10),
      avatarInitials: initials(name),
      organisation: null, phone: null, address: null,
      carbonSavedKg: 0, itemsRehomed: 0,
      notifications: { newStock: true, orderUpdates: true, newsletter: true },
      billing: { method: null, nextPayment: null, invoices: [] },
      auth: { ...makeAuth(b.password), mustChange: false },
    };
    db.users.push(u);
    db.carbon[u.id] = { verified: false };
    saveUsers(); saveCarbon();
    integrations.mail.welcome(u);
    const token = crypto.randomBytes(32).toString('hex');
    SESSIONS.set(token, u.id);
    return json(res, 201, { token, user: safeUser(u), tier: tierOf(u) });
  }

  // ----- everything below requires a valid session -----
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const actorId = SESSIONS.get(bearer);
  const actor = actorId ? userById(actorId) : null;
  if (!actor) return json(res, 401, { error: 'Not signed in.' });
  const isAdmin = actor.role === 'admin';

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
    if (!body.next || String(body.next).length < 8)
      return json(res, 400, { error: 'New password must be at least 8 characters.' });
    actor.auth = { ...makeAuth(body.next), mustChange: false };
    saveUsers();
    return json(res, 200, { ok: true });
  }

  /* ============ ADMIN — member management ============ */
  if (parts[1] === 'admin') {
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
      if (String(b.password).length < 8)
        return json(res, 400, { error: 'Password must be at least 8 characters.' });
      if (userByEmail(b.email))
        return json(res, 409, { error: 'An account with that email already exists.' });
      const tier = db.tiers.some((t) => t.id === b.tier) ? b.tier : 'domestic-free';
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
        ['type', 'placed', 'status', 'fulfilment', 'slot', 'total', 'memberDiscount',
         'deliveryFee', 'carbonSavedKg', 'note', 'projectId'].forEach((k) => {
          if (b[k] !== undefined) order[k] = b[k];
        });
        if (Array.isArray(b.items)) order.items = b.items;
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
          fulfilment: b.fulfilment || 'Collection — Material Reuse warehouse',
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

      // POST /api/admin/members/:id/password { password }
      if (req.method === 'POST' && parts[4] === 'password') {
        const b = await readBody(req);
        if (!b.password || String(b.password).length < 8)
          return json(res, 400, { error: 'Password must be at least 8 characters.' });
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
        ['name', 'email', 'phone', 'address', 'organisation', 'memberSince']
          .forEach((k) => { if (b[k] !== undefined) u[k] = b[k]; });
        if (b.name) u.avatarInitials = initials(b.name);
        if (b.tier && db.tiers.some((t) => t.id === b.tier)) u.tier = b.tier;
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
        for (const [t, uid] of SESSIONS) if (uid === u.id) SESSIONS.delete(t);
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
      if (body[k] !== undefined) u[k] = body[k];
    });
    if (body.notifications) Object.assign(u.notifications, body.notifications);
    saveUsers();
    return json(res, 200, { user: safeUser(u), tier: tierOf(u) });
  }

  // GET /api/inventory?category=&search=
  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    const u = userById(scopeUid(q.get('userId')));
    const gates = u && tierOf(u) ? tierOf(u).gates : { earlyAccess: true };
    let items = db.inventory.filter((i) => !i.archived && (gates.earlyAccess || !i.earlyAccess));
    const cat = q.get('category');
    if (cat && cat !== 'all') items = items.filter((i) => i.category === cat);
    const s = (q.get('search') || '').toLowerCase();
    if (s) items = items.filter((i) =>
      (i.title + i.sku + i.category).toLowerCase().includes(s));
    return json(res, 200, {
      items,
      categories: [...new Set(db.inventory.map((i) => i.category))].sort(),
      earlyAccessVisible: !!gates.earlyAccess,
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
    const discount = gates.memberDiscount ? subtotal * gates.memberDiscount / 100 : 0;
    const order = {
      id: `ORD-2026-${orderSeq++}`,
      userId: u.id,
      placed: new Date().toISOString().slice(0, 10),
      status: 'Reserved',
      fulfilment: body.fulfilment || 'Collection — Material Reuse warehouse',
      slot: 'Slot to be confirmed — we’ll be in touch',
      items: lines.map(({ carbon, ...l }) => l),
      total: +(subtotal - discount).toFixed(2),
      memberDiscount: +discount.toFixed(2) || undefined,
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
      return json(res, 403, { error: `Domestic Free Membership includes ${limit} shopping list. Upgrade for unlimited lists.` });
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
    const existing = list.items.find((i) => i.sku === body.sku);
    if (existing) existing.qty += body.qty || 1;
    else list.items.push({ sku: body.sku, qty: body.qty || 1 });
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
    return json(res, 200, {
      report: features.carbonReportFor(uid),
      level: tierOf(u) ? tierOf(u).gates.carbonReports : 'full',
    });
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
  const full = path.join(FRONTEND_DIR, path.normalize(file));
  if (!full.startsWith(FRONTEND_DIR)) { res.writeHead(403); return res.end(); }
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
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/uploads/')) return features.serveUpload(res, url.pathname);
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
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
  features.migrate(); // one-time data upgrades (no-ops once done)
  initSeqs();
  server.listen(PORT, () => {
    console.log('');
    console.log('  material reuse — member portal');
    console.log(`  → http://localhost:${PORT}  (data: ${SUPA ? 'Supabase' : 'local JSON files'})`);
    integrations.start();
    console.log('');
  });
})();
