/* =====================================================================
   material reuse — portal features module
   Impact ledger · Material passports · Project dashboards · Documents
   vault · Offer-materials requests · File uploads (Supabase Storage)

   Everything here is driven by ONE ledger: db.impactEvents. Orders that
   get collected, passports that get rehomed and admin manual entries all
   write events; dashboards, project pages, the reporting centre and the
   PDF reports all read from it. No figure lives in two places.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const STAGES = ['Audit', 'Materials identified', 'Reuse route', 'Collection', 'Rehomed', 'Impact report'];
const MATERIAL_STATUSES = ['Recovered', 'In storage', 'Listed', 'Reserved', 'Rehomed', 'Recycled'];
const REQUEST_STATUSES = ['Submitted', 'Under review', 'Accepted', 'Collection arranged', 'Collected', 'Rehomed', 'Declined'];
const DOC_CATEGORIES = ['Pre-refurbishment audit', 'Circular economy report', 'Material inventory', 'Photo',
  'Collection / handover evidence', 'Invoice', 'Carbon report', 'Impact report', 'Other'];
const DONE_ORDER = ['Collected', 'Delivered', 'Completed', 'Complete'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const today = () => new Date().toISOString().slice(0, 10);
const num = (v, d = 0) => (v === '' || v === null || v === undefined || isNaN(+v)) ? d : +v;
const r1 = (n) => +(+n || 0).toFixed(1);

module.exports = function install(ctx) {
  const { db, json, readBody, persist, SUPA, SUPA_URL, supaHeaders, DATA_DIR } = ctx;
  const hooks = {}; // set by integrations.js: requestSubmitted, requestStatus, orderCollected, memberCreated
  const fire = (name, ...a) => { try { if (hooks[name]) Promise.resolve(hooks[name](...a)).catch((e) => console.error(`hook ${name}:`, e.message)); } catch (e) { console.error(`hook ${name}:`, e.message); } };

  // ---- carbon & weight factors (per category) — used to estimate passports that have no figures yet ----
  const FACTORS = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'factors.json'), 'utf8')); } catch (e) { return { categories: {}, default: { kgCO2ePerUnit: 5, kgPerUnit: 5 } }; } })();
  function factorFor(category) {
    const key = Object.keys(FACTORS.categories).find((k) => k.toLowerCase() === String(category || '').toLowerCase());
    const base = key ? FACTORS.categories[key] : null;
    // live average from warehouse data beats the static table for carbon
    const inv = db.inventory.filter((i) => i.category === category && i.carbonSavedKgPerUnit > 0);
    const liveCarbon = inv.length ? inv.reduce((s, i) => s + i.carbonSavedKgPerUnit, 0) / inv.length : null;
    return { kgCO2ePerUnit: liveCarbon ?? (base ? base.kgCO2ePerUnit : FACTORS.default.kgCO2ePerUnit),
      kgPerUnit: base ? base.kgPerUnit : FACTORS.default.kgPerUnit, source: liveCarbon !== null ? 'warehouse average' : (base ? 'category table' : 'default') };
  }
  function estimateMaterial(mat) { // fills in missing carbon / weight, flagged as estimates until an admin types real figures
    const qty = Math.max(1, Math.round(num(mat.quantity, 1)));
    const f = factorFor(mat.category);
    if (!num(mat.carbonSavedKg)) { mat.carbonSavedKg = r1(f.kgCO2ePerUnit * qty); mat.carbonEstimated = true; }
    if (!num(mat.weightKg)) { mat.weightKg = r1(f.kgPerUnit * qty); mat.weightEstimated = true; }
    return f;
  }

  // --------------------------------------------------------------- saves
  const saveMaterials = () => persist('materials', { materials: db.materials });
  const saveDocuments = () => persist('documents', { documents: db.documents });
  const saveRequests = () => persist('requests', { requests: db.requests });
  const saveEvents = () => persist('impactEvents', { impactEvents: db.impactEvents });

  // --------------------------------------------------------------- ids
  const nextId = (arr, prefix, pad, floor = 0) => {
    const re = new RegExp(`^${prefix}(\\d+)$`);
    const max = arr.reduce((m, x) => { const n = re.exec(x.id); return n ? Math.max(m, +n[1]) : m; }, floor);
    return `${prefix}${String(max + 1).padStart(pad, '0')}`;
  };
  const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  const userById = (id) => db.users.find((u) => u.id === id);
  const projectById = (id) => db.projects.find((p) => p.id === id);
  const invBySku = (sku) => db.inventory.find((i) => i.sku === sku);

  // =================================================================
  //  IMPACT ENGINE
  // =================================================================
  function addEvent(e) {
    const ev = {
      id: `IE-${uid()}`,
      userId: e.userId,
      projectId: e.projectId || null,
      materialId: e.materialId || null,
      orderId: e.orderId || null,
      date: e.date || today(),
      category: e.category || 'Uncategorised',
      items: Math.max(0, Math.round(num(e.items))),
      weightKg: r1(num(e.weightKg)),
      kgCO2e: r1(num(e.kgCO2e)),
      valueGBP: +num(e.valueGBP).toFixed(2),
      savingsGBP: +num(e.savingsGBP).toFixed(2),
      route: e.route || 'reuse',      // reuse | recycle
      source: e.source || 'manual',   // order | material | manual | legacy
      note: e.note || '',
      createdAt: new Date().toISOString(),
    };
    db.impactEvents.push(ev);
    return ev;
  }

  const equivalents = (kg) => ({
    carMiles: Math.round(kg * 2.5),
    treeYears: r1(kg / 22),
    flightsLHRtoEDI: r1(kg / 120),
  });

  // filter: { userId, projectId, site, from, to }
  function computeImpact(f = {}) {
    const projSite = (pid) => { const p = pid && projectById(pid); return p ? (p.site || '') : ''; };
    const evs = db.impactEvents.filter((e) =>
      (!f.userId || e.userId === f.userId) &&
      (!f.projectId || e.projectId === f.projectId) &&
      (!f.site || projSite(e.projectId) === f.site) &&
      (!f.from || e.date >= f.from) &&
      (!f.to || e.date <= f.to));

    const sum = (k, pred = () => true) => evs.filter(pred).reduce((s, e) => s + (e[k] || 0), 0);
    const reuseKg = sum('weightKg', (e) => e.route !== 'recycle');
    const recycleKg = sum('weightKg', (e) => e.route === 'recycle');
    const reuseItems = sum('items', (e) => e.route !== 'recycle');
    const recycleItems = sum('items', (e) => e.route === 'recycle');
    const totalW = reuseKg + recycleKg, totalI = reuseItems + recycleItems;
    // rates by weight where we have it, otherwise by item count
    const reuseRate = totalW ? reuseKg / totalW : totalI ? reuseItems / totalI : null;
    const recycleRate = totalW ? recycleKg / totalW : totalI ? recycleItems / totalI : null;

    const group = (keyFn, extra = () => ({})) => {
      const m = new Map();
      evs.forEach((e) => {
        const k = keyFn(e); if (k === undefined) return;
        const g = m.get(k) || { kg: 0, items: 0, weightKg: 0, valueGBP: 0, savingsGBP: 0, ...extra(e) };
        g.kg = r1(g.kg + e.kgCO2e); g.items += e.items; g.weightKg = r1(g.weightKg + e.weightKg);
        g.valueGBP = +(g.valueGBP + e.valueGBP).toFixed(2); g.savingsGBP = +(g.savingsGBP + e.savingsGBP).toFixed(2);
        m.set(k, g);
      });
      return m;
    };
    const monthly = [...group((e) => e.date.slice(0, 7))].map(([month, g]) => ({ month, kg: g.kg, items: g.items }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const byCategory = [...group((e) => e.category)].map(([category, g]) => ({ category, ...g }))
      .sort((a, b) => b.kg - a.kg);
    const byProject = [...group((e) => e.projectId || '__none')].map(([pid, g]) => {
      const p = pid !== '__none' ? projectById(pid) : null;
      return { projectId: p ? p.id : null, name: p ? p.name : 'Unattributed (warehouse orders & historic)', site: p ? (p.site || '') : '', ...g };
    }).sort((a, b) => b.kg - a.kg);

    const kg = r1(sum('kgCO2e'));
    return {
      totals: {
        kgCO2e: kg, tonnesCO2e: +(kg / 1000).toFixed(2),
        items: sum('items'), weightKg: r1(totalW), tonnesDiverted: +(totalW / 1000).toFixed(2),
        valueGBP: +sum('valueGBP').toFixed(2), savingsGBP: +sum('savingsGBP').toFixed(2),
        reuseRate, recycleRate, events: evs.length,
        materialsRecovered: sum('items', (e) => e.source === 'material') || undefined,
      },
      equivalents: equivalents(kg), monthly, byCategory, byProject,
    };
  }

  // Denormalised cache on the user record (used by lists/overview tables)
  function recomputeUser(userId) {
    const u = userById(userId); if (!u) return;
    const t = computeImpact({ userId }).totals;
    u.carbonSavedKg = t.kgCO2e; u.itemsRehomed = t.items;
  }
  function recomputeProject(pid) {
    const p = projectById(pid); if (!p) return;
    p.carbonSavedKg = computeImpact({ projectId: pid }).totals.kgCO2e;
  }
  // The carbon "report" shape the existing dashboard/PDF renderers expect
  function carbonReportFor(userId) {
    const imp = computeImpact({ userId });
    const meta = db.carbon[userId] || {};
    const rep = {
      totalSavedKg: imp.totals.kgCO2e,
      equivalents: imp.equivalents,
      monthly: imp.monthly.map((m) => ({ month: m.month, kg: m.kg })),
      byCategory: imp.byCategory.map((c) => ({ category: c.category, kg: c.kg })),
      verified: !!meta.verified,
    };
    if (meta.verifier) rep.verifier = meta.verifier;
    if (meta.wlcaModules) rep.wlcaModules = meta.wlcaModules;
    return rep;
  }

  // Orders: when collected, each line becomes an event (once per order)
  function applyOrderStats(order) {
    if (order.statsApplied || !DONE_ORDER.includes(order.status)) return;
    const u = userById(order.userId); if (!u || u.role === 'admin') return;
    const items = order.items || [];
    const date = today();
    let kgFromLines = 0;
    items.forEach((l) => {
      const inv = l.sku ? invBySku(l.sku) : null;
      const qty = Math.max(1, Math.round(num(l.qty, 1)));
      const kg = inv ? (inv.carbonSavedKgPerUnit || 0) * qty : 0;
      kgFromLines += kg;
      addEvent({ userId: u.id, projectId: order.projectId || null, orderId: order.id, date,
        category: inv ? inv.category : 'Warehouse order', items: qty, kgCO2e: kg,
        valueGBP: num(l.price) * qty, source: 'order', note: `${order.id}: ${l.title || l.sku}` });
    });
    // admin typed a headline carbon figure that the lines don't account for
    const extra = r1(num(order.carbonSavedKg) - kgFromLines);
    if (extra > 0) addEvent({ userId: u.id, projectId: order.projectId || null, orderId: order.id, date,
      category: 'Warehouse order', items: items.length ? 0 : 1, kgCO2e: extra, source: 'order', note: `${order.id}: carbon adjustment` });
    if (!items.length && !extra) addEvent({ userId: u.id, projectId: order.projectId || null, orderId: order.id, date,
      category: 'Warehouse order', items: 1, kgCO2e: 0, source: 'order', note: order.id });
    order.statsApplied = true;
    recomputeUser(u.id); if (order.projectId) recomputeProject(order.projectId);
    saveEvents(); ctx.saveUsers(); if (order.projectId) ctx.saveProjects();
    fire('orderCollected', order, u, r1(num(order.carbonSavedKg) || kgFromLines));
  }

  // Passports: when rehomed/recycled, one event (once per passport)
  function applyMaterialStats(m) {
    if (m.impactEventId || !['Rehomed', 'Recycled'].includes(m.status) || !m.userId) return;
    const ev = addEvent({ userId: m.userId, projectId: m.projectId || null, materialId: m.id,
      date: m.dateRehomed || today(), category: m.category, items: Math.max(1, Math.round(num(m.quantity, 1))),
      weightKg: m.weightKg, kgCO2e: m.carbonSavedKg, valueGBP: m.valueGBP, savingsGBP: m.savingsGBP,
      route: m.status === 'Recycled' ? 'recycle' : 'reuse', source: 'material', note: `${m.ref}: ${m.name}` });
    m.impactEventId = ev.id;
    recomputeUser(m.userId); if (m.projectId) recomputeProject(m.projectId);
    saveEvents(); ctx.saveUsers(); if (m.projectId) ctx.saveProjects();
  }
  function retractMaterialStats(m) { // status moved back from rehomed, or passport deleted
    if (!m.impactEventId) return;
    db.impactEvents = db.impactEvents.filter((e) => e.id !== m.impactEventId);
    delete m.impactEventId;
    recomputeUser(m.userId); if (m.projectId) recomputeProject(m.projectId);
    saveEvents(); ctx.saveUsers(); if (m.projectId) ctx.saveProjects();
  }

  // =================================================================
  //  MIGRATION (runs on every boot; each step is a no-op once done)
  // =================================================================
  function migrate() {
    const changed = new Set();

    // 1. Seed passports from the warehouse inventory (MRG stock, no owner)
    if (!db.materials.length && db.inventory.length) {
      db.inventory.forEach((i) => db.materials.push({
        id: i.sku, ref: i.sku, sku: i.sku, userId: null, projectId: null,
        name: i.title, category: i.category, description: '',
        quantity: i.quantity, unit: i.unit || 'items', dimensions: '', condition: 'Good',
        sourceProject: '', sourceBuilding: '', dateRecovered: i.dateAdded || today(),
        status: i.status === 'Reserved' ? 'Reserved' : 'Listed', reuseDestination: '',
        carbonSavedKg: r1((i.carbonSavedKgPerUnit || 0) * (i.quantity || 1)), weightKg: 0,
        valueGBP: +((i.price || 0) * (i.quantity || 1)).toFixed(2), savingsGBP: 0,
        photos: [], passportVerified: !!i.passportVerified, createdAt: new Date().toISOString(),
      }));
      changed.add('materials');
    }

    // 2. Move project.documents[] into the central documents collection
    db.projects.forEach((p) => {
      if (!Array.isArray(p.documents)) return;
      p.documents.forEach((d) => {
        if (db.documents.some((x) => x.id === d.id)) return;
        db.documents.push({ id: d.id || `DOC-${uid()}`, userId: p.userId, projectId: p.id, name: d.name,
          category: DOC_CATEGORIES.includes(d.type) ? d.type : (d.type || 'Other'), date: d.date || today(),
          url: d.url || null, size: 0, mime: '', note: '', uploadedBy: 'Material Reuse Group',
          createdAt: new Date().toISOString() });
      });
      delete p.documents;
      changed.add('documents'); changed.add('projects');
    });

    // 3. Projects: lifecycle stage + site fields
    db.projects.forEach((p) => {
      if (p.stage === undefined) {
        p.stage = p.status === 'Complete' ? 5 : Math.min(5, Math.round((num(p.progress) / 100) * 5));
        p.site = p.site || ''; p.address = p.address || ''; p.client = p.client || '';
        p.collections = p.collections || [];
        changed.add('projects');
      }
    });

    // 4. Legacy carbon reports → ledger events (once)
    Object.entries(db.carbon).forEach(([userId, rep]) => {
      if (!rep || !Array.isArray(rep.monthly)) return;
      const u = userById(userId);
      if (u) {
        const legacyTotal = num(rep.totalSavedKg) || rep.monthly.reduce((s, m) => s + num(m.kg), 0);
        const projs = db.projects.filter((p) => p.userId === userId && num(p.carbonSavedKg) > 0);
        const projKg = projs.reduce((s, p) => s + num(p.carbonSavedKg), 0);
        const legacyItems = Math.round(num(u.itemsRehomed));
        // project-attributed slices
        projs.forEach((p) => addEvent({ userId, projectId: p.id, date: p.started || today(),
          category: 'Historic project total', kgCO2e: p.carbonSavedKg, items: 0, source: 'legacy',
          note: `Historic figure for ${p.name}` }));
        // remainder, spread by month × category so charts keep their shape
        const remainder = Math.max(0, legacyTotal - projKg);
        const cats = (rep.byCategory || []).filter((c) => num(c.kg) > 0);
        const catTotal = cats.reduce((s, c) => s + num(c.kg), 0);
        const months = rep.monthly.filter((m) => m.month && num(m.kg) > 0);
        const monthTotal = months.reduce((s, m) => s + num(m.kg), 0);
        let itemsLeft = legacyItems;
        const slices = [];
        (months.length ? months : [{ month: (u.memberSince || today()).slice(0, 7), kg: 1 }]).forEach((m, mi, arr) => {
          const mShare = monthTotal ? num(m.kg) / monthTotal : 1 / arr.length;
          (cats.length ? cats : [{ category: 'Historic', kg: 1 }]).forEach((c, ci, carr) => {
            const cShare = catTotal ? num(c.kg) / catTotal : 1 / carr.length;
            slices.push({ month: m.month, category: c.category, kg: remainder * mShare * cShare });
          });
        });
        const sliceKg = slices.reduce((s, x) => s + x.kg, 0);
        slices.forEach((s, i) => {
          const items = i === slices.length - 1 ? itemsLeft : Math.round(legacyItems * (sliceKg ? s.kg / sliceKg : 1 / slices.length));
          itemsLeft -= items;
          if (s.kg > 0 || items > 0) addEvent({ userId, date: `${s.month}-01`, category: s.category,
            kgCO2e: s.kg, items, source: 'legacy', note: 'Historic figure (pre-ledger)' });
        });
        recomputeUser(userId);
      }
      // strip the migrated figures; keep only verification metadata
      db.carbon[userId] = { verified: !!rep.verified, ...(rep.verifier ? { verifier: rep.verifier } : {}),
        ...(rep.wlcaModules ? { wlcaModules: rep.wlcaModules } : {}) };
      changed.add('impactEvents'); changed.add('carbon'); changed.add('users');
    });

    if (changed.size) {
      db.projects.forEach((p) => recomputeProject(p.id));
      changed.forEach((k) => ({ materials: saveMaterials, documents: saveDocuments, projects: ctx.saveProjects,
        impactEvents: saveEvents, carbon: ctx.saveCarbon, users: ctx.saveUsers })[k]());
      console.log(`  migrated: ${[...changed].join(', ')}`);
    }
  }

  // =================================================================
  //  FILE UPLOADS  (Supabase Storage bucket "portal-files", local fallback)
  // =================================================================
  const UPLOAD_DIR = path.join(DATA_DIR, '..', 'uploads');
  const safeName = (n) => String(n || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);

  async function storeFile(ownerId, name, mime, buf) {
    const key = `${ownerId}/${Date.now()}-${safeName(name)}`;
    if (SUPA) {
      const res = await fetch(`${SUPA_URL}/storage/v1/object/portal-files/${key}`, {
        method: 'POST', headers: { apikey: supaHeaders.apikey, Authorization: supaHeaders.Authorization,
          'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }, body: buf,
      });
      if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return { url: `${SUPA_URL}/storage/v1/object/public/portal-files/${key}`, key };
    }
    fs.mkdirSync(path.join(UPLOAD_DIR, ownerId), { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, key), buf);
    return { url: `/uploads/${key}`, key };
  }
  async function deleteFile(key) {
    if (!key) return;
    try {
      if (SUPA) await fetch(`${SUPA_URL}/storage/v1/object/portal-files/${key}`, { method: 'DELETE',
        headers: { apikey: supaHeaders.apikey, Authorization: supaHeaders.Authorization } });
      else fs.unlinkSync(path.join(UPLOAD_DIR, key));
    } catch (e) { /* best effort */ }
  }
  function serveUpload(res, urlPath) {
    const full = path.join(UPLOAD_DIR, path.normalize(urlPath.replace(/^\/uploads\//, '')));
    if (!full.startsWith(UPLOAD_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(full).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
        '.pdf': 'application/pdf', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime }); res.end(buf);
    });
  }

  // =================================================================
  //  VIEW HELPERS
  // =================================================================
  const materialView = (m) => {
    const inv = m.sku ? invBySku(m.sku) : null;
    return inv ? { ...m, quantity: inv.quantity, status: inv.status === 'Reserved' ? 'Reserved' : m.status,
      valueGBP: m.valueGBP || +((inv.price || 0) * inv.quantity).toFixed(2), listedPrice: inv.price, priceUnit: inv.priceUnit,
      availability: inv.archived ? 'Sold' : inv.status, buyUrl: inv.buyUrl || '', reserveUrl: inv.reserveUrl || '', fulfilment: inv.fulfilment || '' } : m;
  };
  const visibleMaterials = (actor, isAdmin, ownerId) =>
    db.materials.filter((m) => isAdmin ? (!ownerId || m.userId === ownerId || (ownerId === 'stock' && !m.userId))
      : (!m.userId || m.userId === actor.id));

  const projectBundle = (p) => {
    const materials = db.materials.filter((m) => m.projectId === p.id).map(materialView);
    const documents = db.documents.filter((d) => d.projectId === p.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const requests = db.requests.filter((r) => r.projectId === p.id);
    const orders = db.orders.filter((o) => o.projectId === p.id);
    const impact = computeImpact({ projectId: p.id });
    const outcomes = MATERIAL_STATUSES.map((s) => ({ status: s, count: materials.filter((m) => m.status === s).length })).filter((x) => x.count);
    const upcoming = (p.collections || []).filter((c) => !c.done && c.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
    return { project: { ...p, stages: STAGES, progress: Math.round((num(p.stage) / 5) * 100) }, materials, documents, requests, orders, impact, outcomes, upcoming };
  };

  const csvLine = (arr) => arr.map((v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',');

  // =================================================================
  //  ROUTES  — returns true when handled
  // =================================================================
  async function handle(req, res, url, actor, isAdmin) {
    const parts = url.pathname.split('/').filter(Boolean);
    const q = url.searchParams;
    const scope = (requested) => (isAdmin && requested ? requested : actor.id);
    const m = req.method;

    /* ---------- uploads ---------- */
    if (m === 'POST' && url.pathname === '/api/uploads') {
      const b = await readBody(req);
      if (!b.data || !b.name) return json(res, 400, { error: 'name and data (base64) are required.' }), true;
      const buf = Buffer.from(String(b.data).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!buf.length) return json(res, 400, { error: 'Empty file.' }), true;
      if (buf.length > MAX_UPLOAD_BYTES) return json(res, 413, { error: 'Files must be under 10 MB.' }), true;
      try {
        const owner = scope(b.userId);
        const f = await storeFile(owner, b.name, b.type, buf);
        return json(res, 201, { file: { ...f, name: b.name, size: buf.length, mime: b.type || '' } }), true;
      } catch (e) { return json(res, 502, { error: e.message }), true; }
    }

    /* ---------- carbon factor estimate (admin passport editor) ---------- */
    if (m === 'GET' && url.pathname === '/api/admin/factors') {
      if (!isAdmin) return json(res, 403, { error: 'Admin access required.' }), true;
      const f = factorFor(q.get('category')); const qty = Math.max(1, Math.round(num(q.get('qty'), 1)));
      return json(res, 200, { ...f, qty, carbonSavedKg: r1(f.kgCO2ePerUnit * qty), weightKg: r1(f.kgPerUnit * qty) }), true;
    }

    /* ---------- reference lists ---------- */
    if (m === 'GET' && url.pathname === '/api/meta') {
      return json(res, 200, { stages: STAGES, materialStatuses: MATERIAL_STATUSES, requestStatuses: REQUEST_STATUSES,
        docCategories: DOC_CATEGORIES, categories: [...new Set(db.materials.map((x) => x.category).concat(db.inventory.map((i) => i.category)))].sort() }), true;
    }

    /* ---------- material passports ---------- */
    if (m === 'GET' && url.pathname === '/api/materials') {
      let items = visibleMaterials(actor, isAdmin, q.get('owner')).map(materialView);
      const s = (q.get('search') || '').toLowerCase();
      if (s) items = items.filter((x) => `${x.name} ${x.ref} ${x.category} ${x.description} ${x.sourceProject} ${x.sourceBuilding}`.toLowerCase().includes(s));
      ['category', 'status', 'condition', 'projectId'].forEach((k) => { const v = q.get(k); if (v && v !== 'all') items = items.filter((x) => String(x[k] || '') === v); });
      if (q.get('scope') === 'mine') items = items.filter((x) => x.userId === actor.id);
      if (q.get('scope') === 'stock') items = items.filter((x) => !x.userId);
      items.sort((a, b) => (b.dateRecovered || '').localeCompare(a.dateRecovered || ''));
      return json(res, 200, { materials: items, total: items.length }), true;
    }
    if (m === 'GET' && parts[1] === 'materials' && parts[2]) {
      const mat = db.materials.find((x) => x.id === parts[2]);
      if (!mat || (!isAdmin && mat.userId && mat.userId !== actor.id)) return json(res, 404, { error: 'Passport not found' }), true;
      const p = mat.projectId ? projectById(mat.projectId) : null;
      const owner = mat.userId ? userById(mat.userId) : null;
      return json(res, 200, { material: materialView(mat), project: p ? { id: p.id, name: p.name, site: p.site } : null,
        owner: owner ? { id: owner.id, name: owner.name, organisation: owner.organisation } : null }), true;
    }

    /* ---------- documents ---------- */
    if (m === 'GET' && url.pathname === '/api/documents') {
      const owner = scope(q.get('userId'));
      let docs = db.documents.filter((d) => d.userId === owner);
      if (q.get('projectId')) docs = docs.filter((d) => d.projectId === q.get('projectId'));
      if (q.get('category') && q.get('category') !== 'all') docs = docs.filter((d) => d.category === q.get('category'));
      const s = (q.get('search') || '').toLowerCase();
      if (s) docs = docs.filter((d) => `${d.name} ${d.note} ${d.category}`.toLowerCase().includes(s));
      docs = docs.map((d) => ({ ...d, projectName: d.projectId && projectById(d.projectId) ? projectById(d.projectId).name : null }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return json(res, 200, { documents: docs, categories: DOC_CATEGORIES }), true;
    }
    if (m === 'POST' && url.pathname === '/api/documents') {
      const b = await readBody(req);
      const owner = scope(b.userId);
      if (!b.name) return json(res, 400, { error: 'Give the document a name.' }), true;
      if (b.projectId) { const p = projectById(b.projectId); if (!p || p.userId !== owner) return json(res, 400, { error: 'That project doesn’t belong to this account.' }), true; }
      const d = { id: `DOC-${uid()}`, userId: owner, projectId: b.projectId || null, name: String(b.name).trim(),
        category: DOC_CATEGORIES.includes(b.category) ? b.category : 'Other', date: b.date || today(),
        url: b.url || null, key: b.key || null, size: num(b.size), mime: b.mime || '', note: b.note || '',
        uploadedBy: isAdmin ? 'Material Reuse Group' : actor.name, createdAt: new Date().toISOString() };
      db.documents.push(d); saveDocuments();
      return json(res, 201, { document: d }), true;
    }
    if (m === 'DELETE' && parts[1] === 'documents' && parts[2]) {
      const d = db.documents.find((x) => x.id === parts[2]);
      if (!d || (!isAdmin && d.userId !== actor.id)) return json(res, 404, { error: 'Document not found' }), true;
      db.documents = db.documents.filter((x) => x.id !== d.id); saveDocuments();
      await deleteFile(d.key);
      return json(res, 200, { ok: true }), true;
    }

    /* ---------- projects (detail + evidence pack) ---------- */
    if (m === 'GET' && parts[1] === 'projects' && parts[2] && parts[2] !== 'pack') {
      const p = projectById(parts[2]);
      if (!p || (!isAdmin && p.userId !== actor.id)) return json(res, 404, { error: 'Project not found' }), true;
      const bundle = projectBundle(p);
      if (parts[3] === 'pack') {
        const owner = userById(p.userId);
        bundle.owner = owner ? { name: owner.name, organisation: owner.organisation, email: owner.email } : null;
        bundle.generated = new Date().toISOString();
        bundle.carbonMeta = db.carbon[p.userId] || {};
      }
      return json(res, 200, bundle), true;
    }
    if (m === 'GET' && url.pathname === '/api/sites') {
      const owner = scope(q.get('userId'));
      const sites = [...new Set(db.projects.filter((p) => p.userId === owner && p.site).map((p) => p.site))].sort();
      return json(res, 200, { sites }), true;
    }

    /* ---------- impact ---------- */
    if (m === 'GET' && (url.pathname === '/api/impact' || url.pathname === '/api/impact/export.csv')) {
      const tier = db.tiers.find((t) => t.id === actor.tier);
      if (!isAdmin && !(tier && tier.gates.impactCentre)) return json(res, 403, { error: 'The Impact & ESG centre is part of the Corporate Reuse Partnership.' }), true;
      const owner = isAdmin && q.get('userId') === 'all' ? null : scope(q.get('userId'));
      const f = { userId: owner || undefined, projectId: q.get('projectId') || undefined, site: q.get('site') || undefined,
        from: q.get('from') || undefined, to: q.get('to') || undefined };
      if (f.projectId) { const p = projectById(f.projectId); if (!p || (!isAdmin && p.userId !== actor.id)) return json(res, 404, { error: 'Project not found' }), true; }
      if (url.pathname.endsWith('.csv')) {
        const evs = db.impactEvents.filter((e) => (!f.userId || e.userId === f.userId) && (!f.projectId || e.projectId === f.projectId)
          && (!f.site || (projectById(e.projectId) || {}).site === f.site) && (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to))
          .sort((a, b) => a.date.localeCompare(b.date));
        const rows = [csvLine(['Date', 'Project', 'Site', 'Category', 'Route', 'Items', 'Weight (kg)', 'CO2e avoided (kg)', 'Value retained (GBP)', 'Savings (GBP)', 'Source', 'Reference', 'Note'])];
        evs.forEach((e) => { const p = e.projectId ? projectById(e.projectId) : null;
          rows.push(csvLine([e.date, p ? p.name : '', p ? p.site : '', e.category, e.route, e.items, e.weightKg, e.kgCO2e, e.valueGBP, e.savingsGBP, e.source, e.materialId || e.orderId || e.id, e.note])); });
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mrg-impact-${today()}.csv"` });
        res.end(rows.join('\n')); return true;
      }
      const imp = computeImpact(f);
      imp.meta = owner ? (db.carbon[owner] || {}) : {};
      imp.filters = f;
      return json(res, 200, imp), true;
    }

    /* ---------- offer materials / clearance requests ---------- */
    if (m === 'GET' && url.pathname === '/api/requests') {
      const owner = scope(q.get('userId'));
      const list = db.requests.filter((r) => r.userId === owner).map((r) => ({ ...r, projectName: r.projectId && projectById(r.projectId) ? projectById(r.projectId).name : (r.newProject ? r.newProject.name : null) }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { requests: list, statuses: REQUEST_STATUSES }), true;
    }
    if (m === 'POST' && url.pathname === '/api/requests') {
      const b = await readBody(req);
      const owner = scope(b.userId);
      const mats = (b.materials || []).map((x) => ({ name: String(x.name || '').trim(), category: x.category || 'Other',
        qty: Math.max(1, Math.round(num(x.qty, 1))), unit: x.unit || 'items', condition: x.condition || 'Good', notes: x.notes || '' })).filter((x) => x.name);
      if (!mats.length) return json(res, 400, { error: 'Add at least one material.' }), true;
      if (!b.location) return json(res, 400, { error: 'Tell us where the materials are.' }), true;
      let projectId = null, newProject = null;
      if (b.projectId) { const p = projectById(b.projectId); if (!p || p.userId !== owner) return json(res, 400, { error: 'Unknown project.' }), true; projectId = p.id; }
      else if (b.newProject && b.newProject.name) newProject = { name: String(b.newProject.name).trim(), site: b.newProject.site || '', address: b.newProject.address || b.location, client: b.newProject.client || '' };
      const r = { id: nextId(db.requests, 'REQ-', 4), userId: owner, projectId, newProject, materials: mats,
        location: String(b.location).trim(), desiredDate: b.desiredDate || null, notes: b.notes || '',
        photos: (b.photos || []).filter((p) => p && p.url).map((p) => ({ url: p.url, key: p.key || null, name: p.name || 'photo' })),
        status: 'Submitted', adminNote: '', history: [{ status: 'Submitted', date: today(), note: 'Request received' }],
        createdAt: new Date().toISOString() };
      db.requests.push(r); saveRequests();
      fire('requestSubmitted', r, userById(owner));
      return json(res, 201, { request: r }), true;
    }
    if (m === 'GET' && parts[1] === 'requests' && parts[2]) {
      const r = db.requests.find((x) => x.id === parts[2]);
      if (!r || (!isAdmin && r.userId !== actor.id)) return json(res, 404, { error: 'Request not found' }), true;
      return json(res, 200, { request: r, statuses: REQUEST_STATUSES }), true;
    }

    /* ================= ADMIN ================= */
    if (parts[1] === 'admin') {
      if (!isAdmin) return json(res, 403, { error: 'Admin access required.' }), true;

      // ---- requests queue ----
      if (m === 'GET' && url.pathname === '/api/admin/requests') {
        const list = db.requests.map((r) => { const u = userById(r.userId); return { ...r, memberName: u ? u.name : '—', memberOrg: u ? u.organisation : '',
          projectName: r.projectId && projectById(r.projectId) ? projectById(r.projectId).name : (r.newProject ? r.newProject.name : null) }; })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json(res, 200, { requests: list, statuses: REQUEST_STATUSES }), true;
      }
      if (parts[2] === 'requests' && parts[3]) {
        const r = db.requests.find((x) => x.id === parts[3]);
        if (!r) return json(res, 404, { error: 'Request not found' }), true;
        if (m === 'PATCH') {
          const b = await readBody(req);
          if (b.adminNote !== undefined) r.adminNote = b.adminNote;
          if (b.desiredDate !== undefined) r.desiredDate = b.desiredDate;
          if (b.status && REQUEST_STATUSES.includes(b.status) && b.status !== r.status) {
            r.status = b.status;
            r.history.push({ status: b.status, date: today(), note: b.note || '' });
            // Accepting a request that described a new project creates that project
            if (b.status === 'Accepted' && !r.projectId && r.newProject) {
              const p = { id: `PRJ-${ctx.nextProjectSeq()}`, userId: r.userId, name: r.newProject.name, type: 'Strip-out',
                status: 'Planning', site: r.newProject.site || '', address: r.newProject.address || r.location, client: r.newProject.client || '',
                stage: 1, progress: 20, started: today(), target: r.desiredDate || null, summary: `Created from material request ${r.id}.`,
                carbonSavedKg: 0, collections: [] };
              db.projects.push(p); r.projectId = p.id; ctx.saveProjects();
            }
            if (b.status === 'Collection arranged' && r.projectId && r.desiredDate) {
              const p = projectById(r.projectId);
              if (p && !(p.collections || []).some((c) => c.requestId === r.id)) {
                (p.collections = p.collections || []).push({ id: `COL-${uid()}`, requestId: r.id, date: r.desiredDate, type: 'Collection',
                  note: `Collection for ${r.id} — ${r.location}`, done: false });
                if (p.stage < 3) { p.stage = 3; p.progress = 60; }
                ctx.saveProjects();
              }
            }
            if (b.status === 'Collected' && r.projectId) {
              const p = projectById(r.projectId);
              if (p) { (p.collections || []).forEach((c) => { if (c.requestId === r.id) c.done = true; }); if (p.stage < 4) { p.stage = 4; p.progress = 80; } ctx.saveProjects(); }
            }
          }
          saveRequests();
          if (b.status && b.status === r.status && r.history[r.history.length - 1].date === today()) fire('requestStatus', r, userById(r.userId), b.note || '');
          return json(res, 200, { request: r }), true;
        }
        // POST /api/admin/requests/:id/passports — turn the request lines into passports
        if (m === 'POST' && parts[4] === 'passports') {
          if (r.passportsCreated) return json(res, 409, { error: 'Passports were already created for this request.' }), true;
          const created = r.materials.map((x) => {
            const mat = { id: nextId(db.materials, 'MP-', 4), ref: '', sku: null, userId: r.userId, projectId: r.projectId || null,
              name: x.name, category: x.category, description: x.notes || '', quantity: x.qty, unit: x.unit, dimensions: '',
              condition: x.condition, sourceProject: r.projectId && projectById(r.projectId) ? projectById(r.projectId).name : (r.newProject ? r.newProject.name : ''),
              sourceBuilding: r.location, dateRecovered: today(), status: 'Recovered', reuseDestination: '',
              carbonSavedKg: 0, weightKg: 0, valueGBP: 0, savingsGBP: 0, photos: r.photos.slice(0, 3), passportVerified: false,
              requestId: r.id, createdAt: new Date().toISOString() };
            mat.ref = mat.id; estimateMaterial(mat); db.materials.push(mat); return mat;
          });
          r.passportsCreated = true; saveMaterials(); saveRequests();
          return json(res, 201, { materials: created }), true;
        }
      }

      // ---- passports ----
      if (m === 'GET' && url.pathname === '/api/admin/materials') {
        const owners = Object.fromEntries(db.users.map((u) => [u.id, u.name]));
        let items = db.materials.map(materialView).map((x) => ({ ...x, ownerName: x.userId ? owners[x.userId] || '—' : 'MRG stock',
          projectName: x.projectId && projectById(x.projectId) ? projectById(x.projectId).name : null }));
        const s = (q.get('search') || '').toLowerCase();
        if (s) items = items.filter((x) => `${x.name} ${x.ref} ${x.category} ${x.ownerName} ${x.projectName || ''}`.toLowerCase().includes(s));
        if (q.get('status') && q.get('status') !== 'all') items = items.filter((x) => x.status === q.get('status'));
        if (q.get('userId')) items = items.filter((x) => x.userId === q.get('userId'));
        return json(res, 200, { materials: items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) }), true;
      }
      if (m === 'POST' && url.pathname === '/api/admin/materials') {
        const b = await readBody(req);
        if (!b.name) return json(res, 400, { error: 'Give the material a name.' }), true;
        const mat = { id: nextId(db.materials, 'MP-', 4), sku: null, createdAt: new Date().toISOString(), photos: [] };
        mat.ref = mat.id; applyMaterialFields(mat, b);
        db.materials.push(mat); saveMaterials(); applyMaterialStats(mat); saveMaterials();
        return json(res, 201, { material: materialView(mat) }), true;
      }
      if (parts[2] === 'materials' && parts[3]) {
        const mat = db.materials.find((x) => x.id === parts[3]);
        if (!mat) return json(res, 404, { error: 'Passport not found' }), true;
        if (m === 'PATCH') {
          const b = await readBody(req);
          const wasDone = ['Rehomed', 'Recycled'].includes(mat.status);
          applyMaterialFields(mat, b);
          const isDone = ['Rehomed', 'Recycled'].includes(mat.status);
          if (wasDone && !isDone) retractMaterialStats(mat);
          else if (isDone && mat.impactEventId && (b.carbonSavedKg !== undefined || b.weightKg !== undefined || b.valueGBP !== undefined || b.savingsGBP !== undefined || b.projectId !== undefined || b.dateRehomed !== undefined || b.status !== undefined)) {
            retractMaterialStats(mat); applyMaterialStats(mat); // re-issue the event with fresh figures
          } else applyMaterialStats(mat);
          saveMaterials();
          return json(res, 200, { material: materialView(mat) }), true;
        }
        if (m === 'DELETE') {
          retractMaterialStats(mat);
          for (const ph of mat.photos || []) await deleteFile(ph.key);
          db.materials = db.materials.filter((x) => x.id !== mat.id); saveMaterials();
          return json(res, 200, { ok: true }), true;
        }
      }

      // ---- impact ledger admin ----
      if (m === 'GET' && url.pathname === '/api/admin/impact') {
        const imp = computeImpact({});
        return json(res, 200, imp), true;
      }
      if (parts[2] === 'members' && parts[3] && parts[4] === 'impact') {
        const u = userById(parts[3]); if (!u) return json(res, 404, { error: 'Member not found' }), true;
        if (m === 'GET') {
          const events = db.impactEvents.filter((e) => e.userId === u.id).sort((a, b) => b.date.localeCompare(a.date))
            .map((e) => ({ ...e, projectName: e.projectId && projectById(e.projectId) ? projectById(e.projectId).name : null }));
          return json(res, 200, { events, impact: computeImpact({ userId: u.id }), meta: db.carbon[u.id] || {} }), true;
        }
        if (m === 'POST') {
          const b = await readBody(req);
          if (b.projectId) { const p = projectById(b.projectId); if (!p || p.userId !== u.id) return json(res, 400, { error: 'That project isn’t this member’s.' }), true; }
          const ev = addEvent({ ...b, userId: u.id, source: 'manual' });
          recomputeUser(u.id); if (ev.projectId) recomputeProject(ev.projectId);
          saveEvents(); ctx.saveUsers(); if (ev.projectId) ctx.saveProjects();
          return json(res, 201, { event: ev }), true;
        }
        if (m === 'PUT') { // verification metadata only
          const b = await readBody(req);
          const meta = { verified: !!b.verified };
          if (b.verifier) meta.verifier = String(b.verifier);
          if (b.wlcaModules && typeof b.wlcaModules === 'object' && Object.keys(b.wlcaModules).length) meta.wlcaModules = b.wlcaModules;
          db.carbon[u.id] = meta; ctx.saveCarbon();
          return json(res, 200, { meta }), true;
        }
      }
      if (m === 'DELETE' && parts[2] === 'impact' && parts[3]) {
        const ev = db.impactEvents.find((e) => e.id === parts[3]);
        if (!ev) return json(res, 404, { error: 'Entry not found' }), true;
        if (ev.source !== 'manual' && ev.source !== 'legacy') return json(res, 400, { error: 'This entry comes from an order or passport — change that instead.' }), true;
        db.impactEvents = db.impactEvents.filter((e) => e.id !== ev.id);
        recomputeUser(ev.userId); if (ev.projectId) recomputeProject(ev.projectId);
        saveEvents(); ctx.saveUsers(); if (ev.projectId) ctx.saveProjects();
        return json(res, 200, { ok: true }), true;
      }

      // ---- project collections (admin) ----
      if (parts[2] === 'projects' && parts[3] && parts[4] === 'collections') {
        const p = projectById(parts[3]); if (!p) return json(res, 404, { error: 'Project not found' }), true;
        p.collections = p.collections || [];
        if (m === 'POST') {
          const b = await readBody(req);
          if (!b.date) return json(res, 400, { error: 'A date is required.' }), true;
          const c = { id: `COL-${uid()}`, date: b.date, type: b.type || 'Collection', note: b.note || '', done: !!b.done };
          p.collections.push(c); ctx.saveProjects();
          return json(res, 201, { collection: c }), true;
        }
        if (m === 'PATCH' && parts[5]) {
          const c = p.collections.find((x) => x.id === parts[5]); if (!c) return json(res, 404, { error: 'Not found' }), true;
          const b = await readBody(req); ['date', 'type', 'note'].forEach((k) => { if (b[k] !== undefined) c[k] = b[k]; }); if (b.done !== undefined) c.done = !!b.done;
          ctx.saveProjects(); return json(res, 200, { collection: c }), true;
        }
        if (m === 'DELETE' && parts[5]) { p.collections = p.collections.filter((x) => x.id !== parts[5]); ctx.saveProjects(); return json(res, 200, { ok: true }), true; }
      }
    }
    return false;
  }

  function applyMaterialFields(mat, b) {
    ['name', 'category', 'description', 'unit', 'dimensions', 'condition', 'sourceProject', 'sourceBuilding',
      'dateRecovered', 'reuseDestination', 'dateRehomed'].forEach((k) => { if (b[k] !== undefined) mat[k] = b[k] === null ? '' : String(b[k]); });
    if (b.quantity !== undefined) mat.quantity = Math.max(0, num(b.quantity));
    ['carbonSavedKg', 'weightKg', 'valueGBP', 'savingsGBP'].forEach((k) => { if (b[k] !== undefined) mat[k] = num(b[k]); });
    if (b.status !== undefined && MATERIAL_STATUSES.includes(b.status)) {
      mat.status = b.status;
      if (['Rehomed', 'Recycled'].includes(b.status) && !mat.dateRehomed) mat.dateRehomed = today();
    }
    if (b.userId !== undefined) mat.userId = b.userId || null;
    if (b.projectId !== undefined) mat.projectId = b.projectId || null;
    if (mat.projectId && (!mat.userId)) { const p = projectById(mat.projectId); if (p) mat.userId = p.userId; }
    if (Array.isArray(b.photos)) mat.photos = b.photos.filter((p) => p && p.url).map((p) => ({ url: p.url, key: p.key || null, name: p.name || 'photo' }));
    if (b.passportVerified !== undefined) mat.passportVerified = !!b.passportVerified;
    mat.updatedAt = new Date().toISOString();
    if (!mat.category) mat.category = 'Other';
    if (!mat.dateRecovered) mat.dateRecovered = today();
    if (!mat.status) mat.status = 'Recovered';
    if (b.carbonSavedKg !== undefined && num(b.carbonSavedKg) > 0) mat.carbonEstimated = false;
    if (b.weightKg !== undefined && num(b.weightKg) > 0) mat.weightEstimated = false;
    estimateMaterial(mat);
  }

  // Sync the admin project modal's document rows into the documents collection
  function syncProjectDocs(p, rows) {
    const keep = new Set();
    rows.forEach((d) => {
      if (!d.name) return;
      let doc = d.id && db.documents.find((x) => x.id === d.id);
      if (!doc) { doc = { id: d.id || `DOC-${uid()}`, userId: p.userId, projectId: p.id, url: null, key: null, size: 0, mime: '', note: '', uploadedBy: 'Material Reuse Group', createdAt: new Date().toISOString() }; db.documents.push(doc); }
      doc.name = d.name; doc.category = DOC_CATEGORIES.includes(d.type) ? d.type : (d.type || 'Other'); doc.date = d.date || today();
      keep.add(doc.id);
    });
    db.documents = db.documents.filter((x) => x.projectId !== p.id || keep.has(x.id) || x.url); // uploaded files are never removed here
    saveDocuments();
  }
  const projectDocs = (p) => db.documents.filter((d) => d.projectId === p.id).map((d) => ({ id: d.id, name: d.name, type: d.category, date: d.date, url: d.url }));

  return { hooks, storeFile, estimateMaterial, factorFor, addEvent, saveMaterialsDirect: saveMaterials,
    STAGES, MATERIAL_STATUSES, REQUEST_STATUSES, DOC_CATEGORIES, migrate, handle, serveUpload,
    computeImpact, carbonReportFor, applyOrderStats, recomputeUser, recomputeProject, syncProjectDocs, projectDocs,
    saveMaterials, saveDocuments, saveRequests, saveEvents };
};
