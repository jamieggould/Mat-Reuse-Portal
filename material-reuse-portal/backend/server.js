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
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const db = {
  tiers: load('tiers.json').tiers,
  users: load('users.json').users,
  inventory: load('inventory.json').items,
  orders: load('orders.json').orders,
  lists: load('lists.json').lists,
  carbon: load('carbon.json').carbon,
  projects: load('projects.json').projects,
};

const save = (f, body) =>
  fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(body, null, 2));
const saveUsers = () => save('users.json', { users: db.users });
const saveCarbon = () => save('carbon.json', { carbon: db.carbon });

let orderSeq = 1300;
let listSeq = 500;
let userSeq = db.users.reduce((m, u) => {
  const n = /^u(\d+)$/.exec(u.id);
  return n ? Math.max(m, +n[1]) : m;
}, 0) + 1;

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

const userById = (id) => db.users.find((u) => u.id === id);
const userByEmail = (e) =>
  db.users.find((u) => u.email.toLowerCase() === String(e || '').trim().toLowerCase());
const tierOf = (user) => db.tiers.find((t) => t.id === user.tier) || null;
const initials = (name) =>
  String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

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

  // ----- everything below requires a valid session -----
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const actorId = SESSIONS.get(bearer);
  const actor = actorId ? userById(actorId) : null;
  if (!actor) return json(res, 401, { error: 'Not signed in.' });
  const isAdmin = actor.role === 'admin';

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
      db.carbon[u.id] = {
        totalSavedKg: +b.carbonSavedKg || 0,
        monthly: [], byCategory: [],
        equivalents: { carMiles: 0, treeYears: 0 },
        verified: false,
      };
      saveUsers(); saveCarbon();
      return json(res, 201, { user: safeUser(u) });
    }

    // Routes on a specific member
    if (parts[2] === 'members' && parts[3]) {
      const u = userById(parts[3]);
      if (!u) return json(res, 404, { error: 'Member not found' });

      // POST /api/admin/members/:id/password { password }
      if (req.method === 'POST' && parts[4] === 'password') {
        const b = await readBody(req);
        if (!b.password || String(b.password).length < 8)
          return json(res, 400, { error: 'Password must be at least 8 characters.' });
        u.auth = makeAuth(b.password);
        saveUsers();
        return json(res, 200, { ok: true });
      }

      // GET /api/admin/members/:id/carbon
      if (req.method === 'GET' && parts[4] === 'carbon') {
        return json(res, 200, { report: db.carbon[u.id] || null });
      }

      // PUT /api/admin/members/:id/carbon — replace the carbon report
      if (req.method === 'PUT' && parts[4] === 'carbon') {
        const b = await readBody(req);
        if (!b || typeof b !== 'object' || Array.isArray(b))
          return json(res, 400, { error: 'Carbon report must be a JSON object.' });
        db.carbon[u.id] = b;
        if (typeof b.totalSavedKg === 'number') u.carbonSavedKg = b.totalSavedKg;
        saveCarbon(); saveUsers();
        return json(res, 200, { report: db.carbon[u.id] });
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
        if (b.carbonSavedKg !== undefined) u.carbonSavedKg = +b.carbonSavedKg || 0;
        if (b.itemsRehomed !== undefined) u.itemsRehomed = Math.round(+b.itemsRehomed) || 0;
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
        for (const [t, uid] of SESSIONS) if (uid === u.id) SESSIONS.delete(t);
        saveUsers(); saveCarbon();
        return json(res, 200, { ok: true });
      }
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
    let items = db.inventory.filter((i) => gates.earlyAccess || !i.earlyAccess);
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
    };
    db.orders.unshift(order);
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
    return json(res, 200, { list });
  }

  // DELETE /api/lists/:id/items/:sku
  if (req.method === 'DELETE' && parts[1] === 'lists' && parts[3] === 'items') {
    const list = db.lists.find((l) => l.id === parts[2]);
    if (!list) return json(res, 404, { error: 'List not found' });
    if (!isAdmin && list.userId !== actor.id) return json(res, 403, { error: 'Forbidden' });
    list.items = list.items.filter((i) => i.sku !== parts[4]);
    return json(res, 200, { list });
  }

  // GET /api/carbon
  if (req.method === 'GET' && url.pathname === '/api/carbon') {
    const uid = scopeUid(q.get('userId'));
    const u = userById(uid);
    if (!u) return json(res, 404, { error: 'User not found' });
    return json(res, 200, {
      report: db.carbon[uid] || { totalSavedKg: 0, monthly: [], byCategory: [], equivalents: { carMiles: 0, treeYears: 0 } },
      level: tierOf(u) ? tierOf(u).gates.carbonReports : 'full',
    });
  }

  // GET /api/projects
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const uid = scopeUid(q.get('userId'));
    return json(res, 200, { projects: db.projects.filter((p) => p.userId === uid) });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---------- static frontend ----------
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
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
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(index);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
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
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => {
  console.log('');
  console.log('  material reuse — member portal');
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
});
