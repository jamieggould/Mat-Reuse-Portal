/**
 * Material Reuse — Member Portal API
 * Zero-dependency Node.js server (no npm install needed).
 *
 * Run:  node backend/server.js   (from the project root)
 * Then open http://localhost:4173
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4173;
const DATA_DIR = path.join(__dirname, 'data');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// ---------- load demo data (mutations kept in memory) ----------
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

let orderSeq = 1300;
let listSeq = 500;

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
const tierOf = (user) => db.tiers.find((t) => t.id === user.tier);

// ---------- API routes ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = url.searchParams;

  // GET /api/tiers
  if (req.method === 'GET' && url.pathname === '/api/tiers') {
    return json(res, 200, { tiers: db.tiers });
  }

  // GET /api/users  (demo login list — no passwords in demo mode)
  if (req.method === 'GET' && url.pathname === '/api/users') {
    return json(res, 200, {
      users: db.users.map((u) => ({
        id: u.id, name: u.name, email: u.email, tier: u.tier,
        tierName: tierOf(u).name, organisation: u.organisation,
        avatarInitials: u.avatarInitials,
      })),
    });
  }

  // GET /api/users/:id — full profile + tier
  if (req.method === 'GET' && parts[1] === 'users' && parts[2]) {
    const u = userById(parts[2]);
    if (!u) return json(res, 404, { error: 'User not found' });
    return json(res, 200, { user: u, tier: tierOf(u) });
  }

  // PATCH /api/users/:id — update profile / notifications
  if (req.method === 'PATCH' && parts[1] === 'users' && parts[2]) {
    const u = userById(parts[2]);
    if (!u) return json(res, 404, { error: 'User not found' });
    const body = await readBody(req);
    ['name', 'email', 'phone', 'address', 'organisation'].forEach((k) => {
      if (body[k] !== undefined) u[k] = body[k];
    });
    if (body.notifications) Object.assign(u.notifications, body.notifications);
    if (body.tier && db.tiers.some((t) => t.id === body.tier)) u.tier = body.tier;
    return json(res, 200, { user: u, tier: tierOf(u) });
  }

  // GET /api/inventory?userId=&category=&search=
  if (req.method === 'GET' && url.pathname === '/api/inventory') {
    const u = q.get('userId') ? userById(q.get('userId')) : null;
    const gates = u ? tierOf(u).gates : { earlyAccess: false };
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

  // GET /api/orders?userId=
  if (req.method === 'GET' && url.pathname === '/api/orders') {
    const uid = q.get('userId');
    return json(res, 200, { orders: db.orders.filter((o) => o.userId === uid) });
  }

  // POST /api/orders — reserve items { userId, items:[{sku,qty}], fulfilment }
  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const body = await readBody(req);
    const u = userById(body.userId);
    if (!u) return json(res, 400, { error: 'Unknown user' });
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

  // GET /api/lists?userId=
  if (req.method === 'GET' && url.pathname === '/api/lists') {
    const uid = q.get('userId');
    const lists = db.lists.filter((l) => l.userId === uid).map((l) => ({
      ...l,
      items: l.items.map((li) => {
        const item = db.inventory.find((i) => i.sku === li.sku) || {};
        return { ...li, title: item.title, price: item.price, emoji: item.emoji,
                 carbon: (item.carbonSavedKgPerUnit || 0) * li.qty,
                 inStock: (item.quantity || 0) >= li.qty };
      }),
    }));
    return json(res, 200, { lists });
  }

  // POST /api/lists — create { userId, name }
  if (req.method === 'POST' && url.pathname === '/api/lists') {
    const body = await readBody(req);
    const u = userById(body.userId);
    if (!u) return json(res, 400, { error: 'Unknown user' });
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
    list.items = list.items.filter((i) => i.sku !== parts[4]);
    return json(res, 200, { list });
  }

  // GET /api/carbon?userId=
  if (req.method === 'GET' && url.pathname === '/api/carbon') {
    const uid = q.get('userId');
    const u = userById(uid);
    if (!u) return json(res, 404, { error: 'User not found' });
    return json(res, 200, {
      report: db.carbon[uid] || { totalSavedKg: 0, monthly: [], byCategory: [] },
      level: tierOf(u).gates.carbonReports,
    });
  }

  // GET /api/projects?userId=
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const uid = q.get('userId');
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
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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
