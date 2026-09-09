/* =====================================================================
   material reuse — data store
   The JSON files in backend/data are the seed data. When SUPABASE_URL and
   SUPABASE_SERVICE_KEY are set (e.g. on Render), every collection is loaded
   from and saved to a Supabase `portal_data` table instead, so nothing is
   lost when the host wipes its disk on redeploy. Locally (no env vars) it
   just uses the files. Requires Node 18+ (global fetch).
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
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
  sessions: (() => { try { return load('sessions.json').sessions; } catch (e) { return {}; } })(),
  system: (() => { try { return load('system.json').system; } catch (e) { return {}; } })(), // automation state: alert queue, audit log, digest marker
};
const PERSISTED = ['users', 'inventory', 'orders', 'lists', 'carbon', 'projects', 'materials', 'documents', 'requests', 'impactEvents', 'sessions', 'system'];

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
const saveSessions = () => persist('sessions', { sessions: db.sessions });
const saveSystem = () => persist('system', { system: db.system });


// Daily snapshot of every collection into Supabase (backup-YYYY-MM-DD), keeps the last 7
function startBackups() {
  if (!SUPA) return;
  const snapshot = async () => {
    try {
      const key = 'backup-' + new Date().toISOString().slice(0, 10);
      const body = Object.fromEntries(PERSISTED.filter((k) => k !== 'sessions').map((k) => [k, db[k]]));
      await fetch(`${SUPA_URL}/rest/v1/portal_data`, { method: 'POST', headers: supaHeaders, body: JSON.stringify([{ key, body }]) });
      const res = await fetch(`${SUPA_URL}/rest/v1/portal_data?select=key&key=like.backup-*&order=key.desc`, { headers: supaHeaders });
      const rows = res.ok ? await res.json() : [];
      for (const r of rows.slice(7)) await fetch(`${SUPA_URL}/rest/v1/portal_data?key=eq.${encodeURIComponent(r.key)}`, { method: 'DELETE', headers: supaHeaders });
    } catch (e) { console.error('  backup failed:', e.message); }
  };
  snapshot(); setInterval(snapshot, 24 * 60 * 60 * 1000).unref();
}

module.exports = { DATA_DIR, load, db, PERSISTED, SUPA, SUPA_URL, supaHeaders, supaLoad, persist,
  saveUsers, saveCarbon, saveOrders, saveLists, saveProjects, saveInventory, saveSessions, saveSystem, startBackups };
