/* =====================================================================
   material reuse — integrations
   1. Airtable  ⇄  portal  (the Softr marketplace lives in Airtable)
      - warehouse inventory, prices, photos and availability come from Airtable
      - Softr purchases / reservations become orders on the buyer's account
        (accounts are created automatically for new buyers)
      - portal actions write back: reservations and collections update Airtable
   2. Resend email notifications (branded)
   Both are optional: with no env vars set they log to the console instead.
   ===================================================================== */
'use strict';

const crypto = require('crypto');

const ENV = {
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN || '',
  AIRTABLE_BASE: process.env.AIRTABLE_BASE || 'appiHCw9vidbsic9y',
  AIRTABLE_TABLE: process.env.AIRTABLE_TABLE || 'Table 1',
  AIRTABLE_API: (process.env.AIRTABLE_API || 'https://api.airtable.com').replace(/\/+$/, ''),
  AIRTABLE_SYNC_MINUTES: Math.max(1, +process.env.AIRTABLE_SYNC_MINUTES || 5),
  AIRTABLE_AUTO_CREATE_MEMBERS: (process.env.AIRTABLE_AUTO_CREATE_MEMBERS || 'true') !== 'false',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  RESEND_API: (process.env.RESEND_API || 'https://api.resend.com').replace(/\/+$/, ''),
  MAIL_FROM: process.env.MAIL_FROM || 'Material Reuse Group <portal@material-reuse.co.uk>',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'kallie@material-reuse.co.uk',
  PORTAL_URL: (process.env.PORTAL_URL || 'https://mat-reuse-portal.onrender.com').replace(/\/+$/, ''),
};

const today = () => new Date().toISOString().slice(0, 10);
const num = (v, d = 0) => (v === '' || v === null || v === undefined || isNaN(+v)) ? d : +v;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

module.exports = function install(ctx) {
  const { db, features, saveUsers, saveOrders, saveInventory, makeAuth, initials, nextUserId } = ctx;

  /* =================================================================
     EMAIL
     ================================================================= */
  const mailOn = !!ENV.RESEND_API_KEY;
  function template(title, bodyHtml, cta) {
    return `<!DOCTYPE html><html><body style="margin:0;background:#F5F6F9;font-family:Inter,Helvetica,Arial,sans-serif;color:#06183F">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F9;padding:28px 12px"><tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;background:#fff;border:1px solid #DDE2EC">
  <tr><td style="background:#06183F;padding:26px 32px"><span style="font-family:Geologica,Inter,Helvetica,sans-serif;font-size:20px;font-weight:700;color:#fff;letter-spacing:.01em">material reuse</span><br><span style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9EFF51;font-weight:600">Member portal</span></td></tr>
  <tr><td style="height:5px;background:#9EFF51;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:30px 32px 8px"><h1 style="margin:0 0 14px;font-family:Geologica,Inter,Helvetica,sans-serif;font-size:22px;font-weight:700;line-height:1.25">${esc(title)}</h1>
    <div style="font-size:14px;line-height:1.6;color:#2A3655">${bodyHtml}</div>
    ${cta ? `<p style="margin:24px 0 8px"><a href="${esc(cta.url)}" style="display:inline-block;background:#1653F3;color:#fff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:13px 22px">${esc(cta.label)}</a></p>` : ''}
  </td></tr>
  <tr><td style="padding:18px 32px 26px;font-size:11px;color:#5E6B85;border-top:1px solid #DDE2EC;margin-top:20px">Building a sustainable future, one material at a time.<br>Material Reuse Group · material-reuse.co.uk · kallie@material-reuse.co.uk · 01932 867989</td></tr>
</table></td></tr></table></body></html>`;
  }
  async function sendMail(to, subject, title, bodyHtml, cta) {
    if (!to) return;
    if (!mailOn) { console.log(`  [mail not configured] to=${to} subject="${subject}"`); return; }
    try {
      const res = await fetch(`${ENV.RESEND_API}/emails`, {
        method: 'POST', headers: { Authorization: `Bearer ${ENV.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: ENV.MAIL_FROM, to: [to], subject, html: template(title, bodyHtml, cta) }),
      });
      if (!res.ok) console.error(`  mail to ${to} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    } catch (e) { console.error('  mail error:', e.message); }
  }
  const portalLink = (label = 'Open the portal') => ({ url: ENV.PORTAL_URL, label });

  const mail = {
    welcome: (u, tempPassword) => sendMail(u.email, 'Welcome to the Material Reuse member portal', `Welcome, ${u.name.split(' ')[0]}`,
      `<p>Your <b>${esc(db.tiers.find((t) => t.id === u.tier)?.name || 'membership')}</b> is live. Browse the online warehouse, keep shopping lists, offer materials from your own projects and watch your carbon savings build.</p>
       ${tempPassword ? `<p>We created your account from your marketplace purchase so everything is in one place. Sign in with:</p><p style="background:#F5F6F9;padding:12px 16px;font-family:monospace;font-size:13px"><b>Email:</b> ${esc(u.email)}<br><b>Temporary password:</b> ${esc(tempPassword)}</p><p>You'll be asked to choose your own password on first sign-in.</p>` : ''}`,
      portalLink('Sign in')),
    requestSubmitted: (r, u) => Promise.all([
      sendMail(ENV.ADMIN_EMAIL, `New material request ${r.id} — ${u ? u.name : 'member'}`, `New material request ${r.id}`,
        `<p><b>${esc(u ? u.name : '')}</b>${u && u.organisation ? ` (${esc(u.organisation)})` : ''} has offered materials${r.projectId ? ' from an existing project' : r.newProject ? ` for a new project: <b>${esc(r.newProject.name)}</b>` : ''}.</p>
         <p><b>Location:</b> ${esc(r.location)}<br><b>Preferred collection:</b> ${r.desiredDate || 'not specified'}<br><b>Photos:</b> ${r.photos.length}</p>
         <ul>${r.materials.map((x) => `<li>${x.qty} ${esc(x.unit)} × ${esc(x.name)} — ${esc(x.condition)}${x.notes ? ` (${esc(x.notes)})` : ''}</li>`).join('')}</ul>
         ${r.notes ? `<p><b>Notes:</b> ${esc(r.notes)}</p>` : ''}`,
        { url: `${ENV.PORTAL_URL}/`, label: 'Review in the admin queue' }),
      u && sendMail(u.email, `We've received your material request ${r.id}`, 'Thanks — we’ve got your request',
        `<p>Your request <b>${r.id}</b> is with the team. We review every request within two working days and you'll get an email at each step: under review, accepted, collection arranged, collected, rehomed.</p>
         <ul>${r.materials.map((x) => `<li>${x.qty} ${esc(x.unit)} × ${esc(x.name)}</li>`).join('')}</ul>`, portalLink('Track your request')),
    ]),
    requestStatus: (r, u, note) => u && sendMail(u.email, `${r.id}: ${r.status}`, `Your request is now “${r.status}”`,
      `<p>Request <b>${r.id}</b>${r.projectId ? ` (${esc((db.projects.find((p) => p.id === r.projectId) || {}).name || '')})` : ''} has moved to <b>${esc(r.status)}</b>.</p>
       ${note ? `<p><b>From the team:</b> ${esc(note)}</p>` : ''}${r.adminNote && r.adminNote !== note ? `<p>${esc(r.adminNote)}</p>` : ''}
       ${r.status === 'Collection arranged' && r.desiredDate ? `<p>Collection is planned for <b>${r.desiredDate}</b>.</p>` : ''}
       ${r.status === 'Rehomed' ? '<p>Your materials have found their next life. The carbon and impact figures are now on your dashboard and in your reports.</p>' : ''}`,
      portalLink('View in the portal')),
    orderCollected: (o, u, kg) => u && sendMail(u.email, `Collected: ${o.id}`, 'Your materials are on their way to a second life',
      `<p>Order <b>${o.id}</b> has been marked collected.</p><ul>${(o.items || []).map((l) => `<li>${l.qty} × ${esc(l.title || l.sku)}</li>`).join('')}</ul>
       <p style="font-family:Geologica,Inter,sans-serif;font-size:22px;font-weight:700;color:#1653F3;margin:16px 0 4px">${Number(kg || 0).toLocaleString('en-GB')} kg CO₂e avoided</p><p>That's now counted in your dashboard and impact reports. Thank you for choosing reuse.</p>`,
      portalLink('See your impact')),
  };

  /* =================================================================
     AIRTABLE
     ================================================================= */
  const atOn = !!ENV.AIRTABLE_TOKEN;
  const atUrl = () => `${ENV.AIRTABLE_API}/v0/${ENV.AIRTABLE_BASE}/${encodeURIComponent(ENV.AIRTABLE_TABLE)}`;
  const atHeaders = { Authorization: `Bearer ${ENV.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
  const status = { enabled: atOn, lastRun: null, lastOk: null, lastError: null, records: 0, ordersCreated: 0, membersCreated: 0, running: false };
  const sel = (v) => (v && typeof v === 'object') ? (v.name || '') : (v || '');
  const parseKg = (s) => { const m = /([\d.]+)/.exec(String(s || '')); return m ? +m[1] : 0; };

  async function atFetchAll() {
    const out = []; let offset;
    do {
      const u = new URL(atUrl()); u.searchParams.set('pageSize', '100'); if (offset) u.searchParams.set('offset', offset);
      const res = await fetch(u, { headers: atHeaders });
      if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json(); out.push(...(j.records || [])); offset = j.offset;
    } while (offset);
    return out;
  }
  async function atPatch(recordId, fields) {
    if (!atOn || !recordId) return false;
    const res = await fetch(`${atUrl()}/${recordId}`, { method: 'PATCH', headers: atHeaders, body: JSON.stringify({ fields, typecast: true }) });
    if (!res.ok) { console.error(`  Airtable write-back failed (${res.status}): ${(await res.text()).slice(0, 200)}`); return false; }
    return true;
  }

  // Attachment URLs from Airtable expire, so we copy each photo into our own storage once.
  async function cachePhotos(item, attachments) {
    const keep = (item.photos || []).filter((p) => attachments.some((a) => a.id === p.attId));
    for (const a of attachments.slice(0, 4)) {
      if (keep.some((p) => p.attId === a.id)) continue;
      try {
        const src = (a.thumbnails && a.thumbnails.large && a.thumbnails.large.url) || a.url;
        const res = await fetch(src); if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const f = await features.storeFile('warehouse', `${a.id}-${(a.filename || 'photo').replace(/\.heic$/i, '.jpg')}`, a.type === 'image/heic' ? 'image/jpeg' : (a.type || 'image/jpeg'), buf);
        keep.push({ attId: a.id, url: f.url, key: f.key, name: a.filename || 'photo' });
      } catch (e) { console.error('  photo cache:', e.message); }
    }
    item.photos = keep;
  }

  function nextSku() {
    const max = db.inventory.reduce((m, i) => { const n = /^MR-(\d+)$/.exec(i.sku); return n ? Math.max(m, +n[1]) : m; }, 0);
    return `MR-${String(max + 1).padStart(4, '0')}`;
  }

  async function ensureMember(email, name, phone) {
    let u = db.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (u) return { user: u, created: false };
    if (!ENV.AIRTABLE_AUTO_CREATE_MEMBERS) return { user: null, created: false };
    const temp = `MRG-${crypto.randomBytes(4).toString('hex')}`;
    u = { id: nextUserId(), role: 'member', name: (name || email.split('@')[0]).trim(), email: email.trim(), tier: 'domestic-free',
      memberSince: today(), avatarInitials: initials(name || email), organisation: null, phone: phone || null, address: null,
      carbonSavedKg: 0, itemsRehomed: 0, notifications: { newStock: true, orderUpdates: true, newsletter: true },
      billing: { method: null, nextPayment: null, invoices: [] }, auth: makeAuth(temp), source: 'marketplace' };
    db.users.push(u); db.carbon[u.id] = { verified: false }; saveUsers(); ctx.saveCarbon();
    status.membersCreated++;
    mail.welcome(u, temp);
    return { user: u, created: true };
  }

  async function sync() {
    if (!atOn || status.running) return status;
    status.running = true; status.lastRun = new Date().toISOString();
    try {
      const records = await atFetchAll();
      status.records = records.length;
      const seen = new Set();
      let invChanged = false, matChanged = false, ordChanged = false;

      for (const rec of records) {
        const f = rec.fields || {};
        const title = String(f.Name || '').trim(); if (!title) continue;
        seen.add(rec.id);
        // ---- inventory item ----
        let item = db.inventory.find((i) => i.airtableId === rec.id)
          || db.inventory.find((i) => !i.airtableId && norm(i.title) === norm(title));
        if (!item) { item = { sku: nextSku(), qrCode: '', passportVerified: true, dateAdded: (rec.createdTime || '').slice(0, 10) || today() }; item.qrCode = `QR-${item.sku}`; db.inventory.push(item); }
        const avail = sel(f.Availability) || 'Available';
        const next = {
          airtableId: rec.id, title, category: sel(f.Category) || item.category || 'Other', itemType: sel(f['Item Type']) || '',
          quantity: Math.max(0, Math.round(num(f.Quantity, item.quantity ?? 1))), unit: item.unit || 'items',
          price: num(f.Price, item.price || 0), priceUnit: item.priceUnit || 'each',
          carbonSavedKgPerUnit: parseKg(f['Carbon Emissions']) || item.carbonSavedKgPerUnit || 0,
          fulfilment: sel(f['Delivery Available']) || item.fulfilment || 'Collection Only',
          status: ['Available', 'Reserved', 'Sold', 'Pending'].includes(avail) ? avail : 'Available',
          earlyAccess: avail === 'Pending', source: f['Where its from'] || item.source || '', endLocation: f['End Location'] || '',
          buyUrl: f.BuyURL || '', reserveUrl: f.ReserveURL || '', archived: false,
        };
        if (Object.keys(next).some((k) => JSON.stringify(item[k]) !== JSON.stringify(next[k]))) { Object.assign(item, next); invChanged = true; }
        if (Array.isArray(f.Attachments)) { const before = JSON.stringify(item.photos || []); await cachePhotos(item, f.Attachments); if (JSON.stringify(item.photos) !== before) invChanged = true; }

        // ---- passport for this stock item ----
        let mat = db.materials.find((x) => x.sku === item.sku);
        if (!mat) {
          mat = { id: item.sku, ref: item.sku, sku: item.sku, userId: null, projectId: null, description: '', dimensions: '', condition: 'Good',
            sourceProject: '', sourceBuilding: '', reuseDestination: '', savingsGBP: 0, weightKg: 0, passportVerified: true, createdAt: new Date().toISOString() };
          db.materials.push(mat); matChanged = true;
        }
        const mnext = { name: item.title, category: item.category, quantity: item.quantity, unit: item.unit, dateRecovered: mat.dateRecovered || item.dateAdded,
          sourceBuilding: mat.sourceBuilding || item.source || '', carbonSavedKg: +((item.carbonSavedKgPerUnit || 0) * (item.quantity || 1)).toFixed(1),
          valueGBP: +((item.price || 0) * (item.quantity || 1)).toFixed(2),
          status: avail === 'Sold' ? (mat.status === 'Rehomed' ? 'Rehomed' : 'Rehomed') : avail === 'Reserved' ? 'Reserved' : (['Rehomed', 'Recycled'].includes(mat.status) ? mat.status : 'Listed'),
          reuseDestination: mat.reuseDestination || item.endLocation || '' };
        if (!(mat.photos || []).length && (item.photos || []).length) mnext.photos = item.photos.map((p) => ({ url: p.url, key: null, name: p.name }));
        if (Object.keys(mnext).some((k) => JSON.stringify(mat[k]) !== JSON.stringify(mnext[k]))) { Object.assign(mat, mnext); matChanged = true; }

        // ---- Softr purchase / reservation → order on the buyer's account ----
        const email = String(f['Buyer Email'] || '').trim();
        const isOrder = ['Reserved', 'Sold'].includes(avail) || !!sel(f['Collection Status']);
        if (email && /@/.test(email) && isOrder) {
          const { user, created } = await ensureMember(email, f['Buyer Name'], f['Buyer Phone']);
          if (user) {
            const oid = `ORD-AT-${rec.id.slice(3, 11).toUpperCase()}`;
            let order = db.orders.find((o) => o.airtableId === rec.id || o.id === oid);
            const collected = sel(f['Collection Status']) === 'Collected';
            const type = sel(f['Order Type']);
            const wantStatus = collected ? 'Collected' : (type === 'Purchase' ? 'Awaiting collection' : 'Reserved');
            if (!order) {
              order = { id: oid, airtableId: rec.id, userId: user.id, placed: (f['Order Date'] || rec.createdTime || '').slice(0, 10) || today(),
                status: wantStatus, fulfilment: item.fulfilment === 'Available For Delivery' ? 'Delivery available — arrange with the team' : 'Collection — Material Reuse warehouse',
                slot: collected ? 'Collected' : 'Slot to be confirmed — we’ll be in touch', items: [{ sku: item.sku, title: item.title, qty: item.quantity || 1, price: item.price || 0 }],
                total: +((item.price || 0) * (item.quantity || 1)).toFixed(2), carbonSavedKg: +((item.carbonSavedKgPerUnit || 0) * (item.quantity || 1)).toFixed(1),
                note: type === 'Deposit / Reserve' ? 'Reserved via the online marketplace — balance payable on collection' : 'Purchased via the online marketplace', source: 'airtable' };
              db.orders.unshift(order); ordChanged = true; status.ordersCreated++;
            } else if (order.userId !== user.id) { order.userId = user.id; ordChanged = true; }
            const slot = String(f['Collection Slot'] || '').trim();
            if (slot && slot !== order.slot && slot !== order.slotFromPortal) { order.slot = slot; order.slotFromAirtable = slot; ordChanged = true; }
            if (collected && order.status !== 'Collected') { order.status = 'Collected'; if (!slot) order.slot = 'Collected'; ordChanged = true; }
            else if (!collected && order.status !== wantStatus && !['Collected', 'Delivered'].includes(order.status)) { order.status = wantStatus; ordChanged = true; }
            if (order.status === 'Collected' && !order.statsApplied) { order.syncedCollected = true; features.applyOrderStats(order); ordChanged = true; }
            if (created) { /* welcome mail already sent by ensureMember */ }
          }
        }
      }
      // items that vanished from Airtable are hidden from the warehouse (never deleted — orders reference them)
      db.inventory.forEach((i) => { const gone = !i.airtableId || !seen.has(i.airtableId); if (gone && !i.archived) { i.archived = true; invChanged = true; } else if (!gone && i.archived) { i.archived = false; invChanged = true; } });

      if (invChanged) saveInventory();
      if (matChanged) features.saveMaterialsDirect();
      if (ordChanged) saveOrders();
      status.lastOk = new Date().toISOString(); status.lastError = null;
      console.log(`  Airtable sync: ${records.length} records${invChanged ? ', inventory updated' : ''}${ordChanged ? ', orders updated' : ''}`);
    } catch (e) {
      status.lastError = e.message; console.error('  Airtable sync failed:', e.message);
    } finally { status.running = false; }
    return status;
  }

  // ---- write-backs from portal actions ----
  async function reserveInAirtable(order, user) { // member reserved in the portal → mark in Airtable so Softr shows it
    for (const l of order.items || []) {
      const item = db.inventory.find((i) => i.sku === l.sku);
      if (!item || !item.airtableId) continue;
      const ok = await atPatch(item.airtableId, { Availability: 'Reserved', 'Buyer Name': user.name, 'Buyer Email': user.email, 'Buyer Phone': user.phone || '',
        'Order Date': new Date().toISOString(), 'Order Type': 'Deposit / Reserve', 'Collection Status': 'Awaiting Collection' });
      if (ok && !order.airtableId) { order.airtableId = item.airtableId; saveOrders(); }
    }
  }
  async function slotInAirtable(order) { // admin typed/changed the slot in the portal → Airtable follows
    const ids = new Set([order.airtableId, ...(order.items || []).map((l) => (db.inventory.find((i) => i.sku === l.sku) || {}).airtableId)].filter(Boolean));
    for (const id of ids) await atPatch(id, { 'Collection Slot': order.slot || '' });
  }
  async function collectedInAirtable(order) { // admin marked collected in the portal → Airtable follows
    const ids = new Set([order.airtableId, ...(order.items || []).map((l) => (db.inventory.find((i) => i.sku === l.sku) || {}).airtableId)].filter(Boolean));
    for (const id of ids) await atPatch(id, { 'Collection Status': 'Collected', Availability: 'Sold' });
  }

  // ---- wire hooks into the features module ----
  features.hooks.requestSubmitted = (r, u) => mail.requestSubmitted(r, u);
  features.hooks.requestStatus = (r, u, note) => mail.requestStatus(r, u, note);
  features.hooks.orderCollected = (o, u, kg) => { mail.orderCollected(o, u, kg); if (!o.syncedCollected) collectedInAirtable(o); };

  features.hooks.orderSlot = (o) => { o.slotFromPortal = o.slot; slotInAirtable(o); };

  function start() {
    console.log(`  integrations: airtable ${atOn ? `on (every ${ENV.AIRTABLE_SYNC_MINUTES} min)` : 'off — set AIRTABLE_TOKEN'} · email ${mailOn ? 'on' : 'off — set RESEND_API_KEY'}`);
    if (atOn) { sync(); setInterval(sync, ENV.AIRTABLE_SYNC_MINUTES * 60 * 1000).unref(); }
  }

  return { ENV, mail, sync, status: () => ({ ...status, autoCreateMembers: ENV.AIRTABLE_AUTO_CREATE_MEMBERS, intervalMinutes: ENV.AIRTABLE_SYNC_MINUTES, mail: mailOn, adminEmail: ENV.ADMIN_EMAIL }),
    reserveInAirtable, collectedInAirtable, slotInAirtable, start };
};
