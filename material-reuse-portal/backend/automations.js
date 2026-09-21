/* =====================================================================
   material reuse — automations
   Things that happen on their own once the portal is running:
     · Stripe balance invoices when a deposit order's slot is confirmed
       (custom-branded, sent by Stripe; paid status polled back)
     · SMS via Twilio for slot confirmations and reminders
     · stale reservations: reminder on day 7, hold released on day 14
     · weekly admin digest (Monday 08:00 London)
     · admin audit log
     · public impact counter + member badges
   Every external service is optional — with no env vars set it logs
   to the console instead, exactly like email.
   ===================================================================== */
'use strict';

const crypto = require('crypto');

const ENV = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_API: (process.env.STRIPE_API || 'https://api.stripe.com').replace(/\/+$/, ''),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM: process.env.TWILIO_FROM || '',
  TWILIO_API: (process.env.TWILIO_API || 'https://api.twilio.com').replace(/\/+$/, ''),
  BREVO_API_KEY: process.env.BREVO_API_KEY || '', // Brevo can send the SMS too (alphanumeric sender, e.g. "MRG")
  BREVO_API: (process.env.BREVO_API || 'https://api.brevo.com').replace(/\/+$/, ''),
  SMS_SENDER: (process.env.SMS_SENDER || 'MRG').slice(0, 11),
  STALE_REMIND_DAYS: Math.max(1, +process.env.STALE_REMIND_DAYS || 7),
  STALE_RELEASE_DAYS: Math.max(2, +process.env.STALE_RELEASE_DAYS || 14),
  BALANCE_DAYS_TO_PAY: Math.max(1, +process.env.BALANCE_DAYS_TO_PAY || 7),
  DIGEST_DAY: process.env.DIGEST_DAY || 'Mon',
  DIGEST_HOUR: Math.min(23, Math.max(0, +process.env.DIGEST_HOUR || 8)),
};

const SLOT_PLACEHOLDER = /to be confirmed/i;
const OPEN_ORDER = ['Reserved', 'Awaiting collection', 'Processing'];
const { num, esc, gbp, daysSince, formEncode } = require('./util');
const slotConfirmed = (o) => !!o.slot && !SLOT_PLACEHOLDER.test(o.slot) && o.slot !== 'Collected';
const london = (d = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: +parts.hour % 24, date: `${parts.year}-${parts.month}-${parts.day}` };
};


module.exports = function install(ctx) {
  const { db, features, integrations, saveOrders, saveUsers, saveInventory, saveSystem } = ctx;
  const setCommerce = (c) => { ctx.commerce = c; };
  const { mail, sendMail, atPatch, atCreate, atFetchAll, atGet, ENV: IENV } = integrations;
  const sys = db.system;
  sys.auditLog = sys.auditLog || [];
  const userById = (id) => db.users.find((u) => u.id === id);
  const admins = () => db.users.filter((u) => u.role === 'admin');
  const tierGates = (u) => (u && db.tiers.find((t) => t.id === u.tier) || {}).gates || {};
  const portalUrl = IENV.PORTAL_URL;

  /* =================================================================
     AUDIT LOG — who changed what, from the admin side
     ================================================================= */
  function audit(actor, action, target, detail) {
    sys.auditLog.unshift({ ts: new Date().toISOString(), by: actor ? actor.name : 'system', byId: actor ? actor.id : null, action, target: target || '', detail: detail ? String(detail).slice(0, 300) : '' });
    if (sys.auditLog.length > 2000) sys.auditLog.length = 2000;
    saveSystem();
  }
  // Called by the server for every admin write request once it has completed.
  function auditRequest(actor, method, pathname, statusCode, body) {
    if (statusCode >= 400) return;
    const p = pathname.replace(/^\/api\/(admin\/)?/, '');
    const verb = { POST: 'created', PATCH: 'updated', PUT: 'updated', DELETE: 'deleted' }[method] || method;
    const keys = body && typeof body === 'object' ? Object.keys(body).filter((k) => !/password|data|photos/i.test(k)).slice(0, 8) : [];
    const summary = keys.map((k) => { const v = body[k]; return `${k}=${typeof v === 'object' ? '…' : String(v).slice(0, 40)}`; }).join(', ');
    audit(actor, verb, p, summary);
  }

  /* =================================================================
     SMS (Twilio) — optional
     ================================================================= */
  const twilioOn = !!(ENV.TWILIO_ACCOUNT_SID && ENV.TWILIO_AUTH_TOKEN && ENV.TWILIO_FROM);
  const smsProvider = twilioOn ? 'twilio' : ENV.BREVO_API_KEY && (process.env.BREVO_SMS || 'true') !== 'false' ? 'brevo' : 'off';
  const smsOn = smsProvider !== 'off';
  const e164 = (phone) => {
    let p = String(phone || '').replace(/[\s()-]/g, '');
    if (/^07\d{9}$/.test(p)) p = '+44' + p.slice(1);
    else if (/^0044/.test(p)) p = '+' + p.slice(2);
    else if (/^44\d{10}$/.test(p)) p = '+' + p;
    return /^\+\d{8,15}$/.test(p) ? p : null;
  };
  async function sendSms(user, text) {
    if (!user || !user.phone) return false;
    if (user.notifications && user.notifications.orderUpdates === false) return false;
    const to = e164(user.phone); if (!to) return false;
    const body = `Material Reuse Group: ${text}`.slice(0, 640);
    if (!smsOn) { console.log(`  [sms not configured] to=${to} "${body}"`); return false; }
    try {
      const res = smsProvider === 'brevo'
        ? await fetch(`${ENV.BREVO_API}/v3/transactionalSMS/sms`, { method: 'POST', headers: { 'api-key': ENV.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ sender: ENV.SMS_SENDER, recipient: to.replace(/^\+/, ''), content: body, type: 'transactional', unicodeEnabled: false }) })
        : await fetch(`${ENV.TWILIO_API}/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Messages.json`, {
            method: 'POST',
            headers: { Authorization: 'Basic ' + Buffer.from(`${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formEncode({ To: to, From: ENV.TWILIO_FROM, Body: body }),
          });
      if (!res.ok) { console.error(`  sms to ${to} failed (${res.status}): ${(await res.text()).slice(0, 200)}`); return false; }
      return true;
    } catch (e) { console.error('  sms error:', e.message); return false; }
  }

  /* =================================================================
     STRIPE — balance invoices for deposit orders
     ================================================================= */
  const stripeOn = !!ENV.STRIPE_SECRET_KEY;
  async function stripe(path, method = 'GET', params) {
    const res = await fetch(`${ENV.STRIPE_API}/v1/${path}`, {
      method, headers: { Authorization: `Bearer ${ENV.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params ? formEncode(params) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || `Stripe ${res.status}`);
    return j;
  }
  async function stripeCustomer(user) {
    const found = await stripe(`customers?email=${encodeURIComponent(user.email)}&limit=1`);
    if (found.data && found.data.length) return found.data[0].id;
    const c = await stripe('customers', 'POST', { email: user.email, name: user.name, phone: user.phone || undefined, metadata: { portalUserId: user.id } });
    return c.id;
  }
  const orderLines = (o) => (o.items || []).map((l) => `${l.qty} × ${l.title || l.sku}`).join(', ');

  // Slot confirmed on a deposit order → Stripe sends a branded invoice for the balance, payable online.
  async function sendBalanceInvoice(order) {
    if (!order || !order.balanceDueGBP || order.balancePaid || order.stripeInvoiceId) return;
    if (!slotConfirmed(order) || !OPEN_ORDER.includes(order.status)) return;
    const u = userById(order.userId); if (!u) return;
    if (!stripeOn) { console.log(`  [stripe not configured] balance invoice for ${order.id} (${gbp(order.balanceDueGBP)}) not sent`); return; }
    try {
      const customer = await stripeCustomer(u);
      await stripe('invoiceitems', 'POST', { customer, currency: 'gbp', amount: Math.round(order.balanceDueGBP * 100),
        description: `Balance for order ${order.id} — ${orderLines(order)} (deposit of ${gbp(order.depositGBP)} already paid)` });
      const inv = await stripe('invoices', 'POST', { customer, collection_method: 'send_invoice', days_until_due: ENV.BALANCE_DAYS_TO_PAY, auto_advance: false,
        description: `Balance payable before collection. Your collection slot: ${order.slot}.`,
        footer: 'Material Reuse Group · material-reuse.co.uk · 01932 867989 · kallie@material-reuse.co.uk\nBuilding a sustainable future, one material at a time.',
        custom_fields: [{ name: 'Order', value: order.id }, { name: 'Collection slot', value: String(order.slot).slice(0, 40) }],
        metadata: { orderId: order.id, source: 'mrg-portal' } });
      await stripe(`invoices/${inv.id}/finalize`, 'POST');
      const sent = await stripe(`invoices/${inv.id}/send`, 'POST');
      order.stripeInvoiceId = inv.id; order.stripeInvoiceUrl = sent.hosted_invoice_url || inv.hosted_invoice_url || ''; order.balanceInvoiceSentAt = new Date().toISOString();
      saveOrders();
      if (order.airtableOrderId) atPatch(order.airtableOrderId, { Notes: `Balance invoice sent via Stripe ${order.balanceInvoiceSentAt.slice(0, 10)}: ${order.stripeInvoiceUrl}` }, IENV.AIRTABLE_ORDERS_TABLE);
      audit(null, 'sent balance invoice', order.id, `${gbp(order.balanceDueGBP)} · ${inv.id}`);
      sendSms(u, `Your collection slot for ${order.id} is confirmed: ${order.slot}. Balance of ${gbp(order.balanceDueGBP)} to pay before pickup: ${order.stripeInvoiceUrl}`);
    } catch (e) { console.error(`  balance invoice for ${order.id} failed:`, e.message); integrations.alertAdmin(`Balance invoice failed for ${order.id}`, e.message); }
  }
  // Every few minutes: has anyone paid?
  async function checkBalanceInvoices() {
    if (!stripeOn) return;
    for (const o of db.orders.filter((x) => x.stripeInvoiceId && !x.balancePaid)) {
      try {
        const inv = await stripe(`invoices/${o.stripeInvoiceId}`);
        if (inv.status === 'paid') {
          o.balancePaid = true; o.balancePaidAt = new Date().toISOString(); saveOrders();
          if (o.airtableOrderId) atPatch(o.airtableOrderId, { 'Balance Due': 0, 'Amount Paid': +(num(o.depositGBP) + num(o.balanceDueGBP)).toFixed(2), Notes: `Balance paid via Stripe ${o.balancePaidAt.slice(0, 10)}` }, IENV.AIRTABLE_ORDERS_TABLE);
          audit(null, 'balance paid', o.id, gbp(o.balanceDueGBP));
          const u = userById(o.userId);
          if (u) sendMail(u.email, `Balance received — ${o.id}`, 'Thanks, your balance is paid', `<p>We’ve received ${gbp(o.balanceDueGBP)} for order <b>${o.id}</b>. Everything is settled — see you at your slot: <b>${esc(o.slot)}</b>.</p>`, { url: portalUrl, label: 'View your order' });
        } else if (inv.status === 'void' || inv.status === 'uncollectible') { o.balanceInvoiceStatus = inv.status; saveOrders(); }
      } catch (e) { console.error(`  invoice check ${o.stripeInvoiceId}:`, e.message); }
    }
  }

  // Every Stripe invoice (checkout receipts, balance invoices) lands in the member's Invoices section automatically.
  let invoiceSyncFrom = Math.floor(Date.now() / 1000) - 30 * 86400; // first run: last 30 days
  async function syncStripeInvoices() {
    if (!stripeOn) return;
    const since = invoiceSyncFrom - 3600; // overlap an hour so nothing is missed
    let starting_after = null, changed = false;
    for (let page = 0; page < 10; page++) {
      const j = await stripe(`invoices?limit=100&created[gte]=${since}${starting_after ? `&starting_after=${starting_after}` : ''}`);
      for (const inv of j.data || []) {
        if (!['paid', 'open', 'void', 'uncollectible'].includes(inv.status) || !inv.customer_email) continue;
        const em = inv.customer_email.toLowerCase();
        const u = db.users.find((x) => x.role !== 'admin' && (x.email.toLowerCase() === em || (x.altEmails || []).includes(em)));
        if (!u) continue;
        u.billing = u.billing || { method: null, nextPayment: null, invoices: [] }; u.billing.invoices = u.billing.invoices || [];
        const status = inv.status === 'paid' ? 'Paid' : inv.status === 'open' ? (inv.due_date && inv.due_date * 1000 < Date.now() ? 'Overdue' : 'Due') : 'Void';
        const desc = (inv.lines && inv.lines.data && inv.lines.data[0] && inv.lines.data[0].description) || inv.description || 'Material Reuse Group';
        const rec = { id: inv.number || inv.id, stripeId: inv.id, date: new Date(inv.created * 1000).toISOString().slice(0, 10), amount: +((inv.total || 0) / 100).toFixed(2),
          status, desc: String(desc).slice(0, 120), url: inv.hosted_invoice_url || '', pdf: inv.invoice_pdf || '' };
        const i = u.billing.invoices.findIndex((x) => x.stripeId === inv.id);
        if (i < 0) { u.billing.invoices.unshift(rec); changed = true; }
        else if (JSON.stringify(u.billing.invoices[i]) !== JSON.stringify(rec)) { u.billing.invoices[i] = rec; changed = true; }
      }
      if (!j.has_more) break; starting_after = j.data[j.data.length - 1].id;
    }
    invoiceSyncFrom = Math.floor(Date.now() / 1000);
    if (changed) saveUsers();
  }

  // Walk-in sale from the scan screen: Kallie types the buyer's email → account + collected, paid order; stock reduced everywhere
  async function walkInSale(mat, { email, name, phone, qty, createAccount = true }, actor) {
    const em = String(email || '').trim().toLowerCase();
    let user = db.users.find((x) => x.email.toLowerCase() === em || (x.altEmails || []).includes(em)) || null, created = false;
    if (!user && createAccount) { const r = await integrations.ensureMember(email, name, phone); user = r.user; created = r.created; if (!user) throw new Error('Could not create an account for that email.'); }
    const inv = mat.sku ? db.inventory.find((i) => i.sku === mat.sku) : null;
    const q = Math.max(1, Math.round(num(qty, 1)));
    const price = inv ? num(inv.price) : num(mat.valueGBP) / Math.max(1, num(mat.quantity, 1));
    const order = { id: `ORD-${new Date().getFullYear()}-${ctx.nextOrderSeq()}`, userId: user ? user.id : null, guest: user ? null : { email: em, name: String(name || '').trim() }, placed: new Date().toISOString().slice(0, 10), status: 'Collected',
      fulfilment: 'Collected from the Material Reuse Group warehouse', slot: 'Collected', items: [{ sku: mat.sku || mat.id, title: mat.name, qty: q, price }],
      total: +(price * q).toFixed(2), carbonSavedKg: +(((inv && inv.carbonSavedKgPerUnit) || num(mat.carbonSavedKg) / Math.max(1, num(mat.quantity, 1))) * q).toFixed(1),
      note: 'Sold at the warehouse — paid in person', paidInPerson: true, source: 'walk-in', loggedBy: actor ? actor.name : 'admin' };
    db.orders.unshift(order);
    if (inv) { inv.quantity = Math.max(0, (inv.quantity || 0) - q); if (inv.quantity === 0) inv.status = 'Sold'; saveInventory(); features.fire('stockChanged', inv); }
    else { mat.quantity = Math.max(0, num(mat.quantity) - q); if (mat.quantity === 0) mat.status = 'Rehomed'; }
    if (user) features.applyOrderStats(order); else { const m2 = mat; features.addHistory(m2, 'Collected', `${q} ${m2.unit || 'items'} sold at the warehouse (${order.id})`); }
    saveOrders(); features.saveMaterialsDirect();
    if (inv && inv.airtableId) {
      const live = await atGet(inv.airtableId).catch(() => null); const cur = live && live.fields ? Math.max(0, num(live.fields.Quantity)) : inv.quantity + q;
      const remaining = Math.max(0, cur - q);
      atPatch(inv.airtableId, remaining === 0 ? { Quantity: 0, Availability: 'Sold' } : { Quantity: remaining });
      const rowId = await atCreate({ 'Order ID': order.id, Item: [inv.airtableId], 'Item Name': inv.title, Quantity: q, 'Unit Price': price, 'Order Total': order.total, 'Amount Paid': order.total, 'Balance Due': 0,
        'Order Type': 'Purchase', 'Buyer Name': user ? user.name : String(name || ''), 'Buyer Email': user ? user.email : em, 'Buyer Phone': (user && user.phone) || '', 'Order Date': new Date().toISOString(), 'Collection Status': 'Collected', Source: 'Portal', Notes: 'Walk-in sale — paid in person' });
      if (rowId) { order.airtableOrderId = rowId; order.airtableId = inv.airtableId; saveOrders(); }
    }
    audit(actor, 'walk-in sale', order.id, `${q} × ${mat.name} → ${user ? user.email : em + ' (no account)'}${created ? ' (account created)' : ''}`);
    return { order, user, created };
  }

  // Slot confirmed (from the portal or from Airtable) → SMS + balance invoice if there is one
  async function onSlotConfirmed(order) {
    if (!slotConfirmed(order) || !OPEN_ORDER.includes(order.status)) return;
    if (order.slotNotified === order.slot) return;
    order.slotNotified = order.slot; saveOrders();
    const u = userById(order.userId); if (!u) return;
    if (order.balanceDueGBP && !order.balancePaid && !order.stripeInvoiceId && stripeOn) return sendBalanceInvoice(order); // that path sends the SMS with the payment link
    sendSms(u, `Your collection slot for ${order.id} (${orderLines(order)}) is confirmed: ${order.slot}. Material Reuse Group warehouse — reply to this text if you need to change it.`);
    sendMail(u.email, `Collection slot confirmed — ${order.id}`, 'Your collection slot is booked',
      `<p>Order <b>${order.id}</b> — ${esc(orderLines(order))}</p><p style="font-family:Geologica,Inter,sans-serif;font-size:20px;font-weight:700;color:#1653F3">${esc(order.slot)}</p><p>${esc(order.fulfilment || 'Collection — Material Reuse Group warehouse')}${order.balanceDueGBP && !order.balancePaid ? `<br>Balance of <b>${gbp(order.balanceDueGBP)}</b> is payable on collection.` : ''}</p>`,
      { url: portalUrl, label: 'View your order' });
  }

  /* =================================================================
     STALE RESERVATIONS — remind day 7, release day 14
     ================================================================= */
  const staleCandidates = () => db.orders.filter((o) => OPEN_ORDER.includes(o.status) && !slotConfirmed(o) && o.placed && daysSince(o.placed) >= ENV.STALE_REMIND_DAYS);
  async function staleSweep() {
    for (const o of staleCandidates()) {
      const u = userById(o.userId); if (!u) continue;
      const age = Math.floor(daysSince(o.placed));
      if (!o.staleRemindedAt) {
        o.staleRemindedAt = new Date().toISOString(); saveOrders();
        const releaseIn = ENV.STALE_RELEASE_DAYS - age;
        sendMail(u.email, `Book your collection — ${o.id}`, 'Your materials are waiting for you',
          `<p>Order <b>${o.id}</b> (${esc(orderLines(o))}) has been held for ${age} days without a collection slot.</p>
           <p>Reply to this email or call 01932 867989 to book a slot. ${o.depositGBP ? 'We’ll keep it held for you — just get in touch.' : `If we don’t hear from you within ${Math.max(1, releaseIn)} days the items go back on sale.`}</p>`,
          { url: portalUrl, label: 'View your order' });
        sendSms(u, `Your order ${o.id} is still waiting for a collection slot. Call 01932 867989 or reply to book${o.depositGBP ? '' : ` — items go back on sale in ${Math.max(1, releaseIn)} days`}.`);
        audit(null, 'stale reminder sent', o.id, `${age} days, no slot`);
        continue;
      }
      if (age >= ENV.STALE_RELEASE_DAYS && !o.depositGBP) await releaseHold(o, u, `No collection slot after ${age} days`);
    }
  }
  async function releaseHold(o, u, reason) {
    o.status = 'Cancelled'; o.releasedAt = new Date().toISOString(); o.note = `${o.note ? o.note + ' · ' : ''}Hold released: ${reason}`; saveOrders();
    for (const l of o.items || []) { // stock goes back on sale
      const item = db.inventory.find((i) => i.sku === l.sku); if (!item) continue;
      const qty = Math.max(1, Math.round(num(l.qty, 1)));
      item.quantity = (item.quantity || 0) + qty; if (item.status !== 'Pending') item.status = 'Available'; saveInventory(); features.fire('stockChanged', item);
      if (item.airtableId) { const live = await atGet(item.airtableId).catch(() => null); const cur = live && live.fields ? num(live.fields.Quantity) : 0; atPatch(item.airtableId, { Quantity: cur + qty, Availability: 'Available' }); }
    }
    if (o.airtableOrderId) atPatch(o.airtableOrderId, { 'Collection Status': 'Cancelled', Notes: `Hold released by the portal: ${reason}` }, IENV.AIRTABLE_ORDERS_TABLE);
    audit(null, 'released hold', o.id, reason);
    if (u) sendMail(u.email, `Reservation released — ${o.id}`, 'We’ve released your reservation', `<p>Order <b>${o.id}</b> (${esc(orderLines(o))}) has been released and the items are back on sale, as we didn’t hear from you about a collection slot.</p><p>Still want them? They may still be available in the warehouse.</p>`, { url: portalUrl, label: 'Open the warehouse' });
  }

  /* =================================================================
     WEEKLY DIGEST — every admin, Monday 08:00 London
     ================================================================= */
  function digestData() {
    const week = (iso) => iso && daysSince(iso) <= 7;
    const members = db.users.filter((u) => u.role !== 'admin');
    const newMembers = members.filter((u) => week(u.memberSince));
    const awaiting = db.orders.filter((o) => OPEN_ORDER.includes(o.status));
    const stale = staleCandidates();
    const balances = db.orders.filter((o) => OPEN_ORDER.includes(o.status) && o.balanceDueGBP && !o.balancePaid);
    const requests = db.requests.filter((r) => !['Rehomed', 'Declined'].includes(r.status));
    const alerts = (sys.alertsSentLog || []).filter((a) => week(a.ts));
    const imp = features.computeImpact({ from: new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10) });
    const sync = integrations.status();
    return { newMembers, awaiting, stale, balances, requests, alerts, imp, sync, members: members.length, auditWeek: sys.auditLog.filter((a) => week(a.ts)).length };
  }
  function digestHtml(d) {
    const name = (id) => (userById(id) || {}).name || '—';
    const row = (k, v) => `<tr><td style="padding:6px 0;color:#5E6B85">${k}</td><td style="padding:6px 0;text-align:right;font-weight:700">${v}</td></tr>`;
    const list = (items, fn) => items.length ? `<ul style="margin:6px 0 0;padding-left:18px">${items.slice(0, 12).map(fn).join('')}${items.length > 12 ? `<li>… and ${items.length - 12} more</li>` : ''}</ul>` : '<p class="small" style="color:#5E6B85;margin:4px 0 0">None</p>';
    return `
      <table width="100%" style="font-size:14px;border-collapse:collapse">${row('Members', `${d.members} (+${d.newMembers.length} this week)`)}${row('Orders awaiting collection', d.awaiting.length)}${row('Needing a slot (7+ days)', d.stale.length)}${row('Balances outstanding', d.balances.length ? `${d.balances.length} · ${gbp(d.balances.reduce((s, o) => s + o.balanceDueGBP, 0))}` : '0')}${row('Open material requests', d.requests.length)}${row('Wishlist alerts sent', d.alerts.length)}${row('CO₂e recorded this week', `${(d.imp.totals.kgCO2e || 0).toLocaleString('en-GB')} kg`)}${row('Admin changes this week', d.auditWeek)}</table>
      <h3 style="margin:18px 0 4px;font-size:15px">New members</h3>${list(d.newMembers, (u) => `<li>${esc(u.name)} — ${esc((db.tiers.find((t) => t.id === u.tier) || {}).name || u.tier)}${u.source === 'marketplace' ? ' (from a purchase)' : ''}</li>`)}
      <h3 style="margin:18px 0 4px;font-size:15px">Awaiting collection</h3>${list(d.awaiting, (o) => `<li>${o.id} — ${esc(name(o.userId))} — ${esc(orderLines(o))} — ${slotConfirmed(o) ? esc(o.slot) : `<b>no slot</b> (${Math.floor(daysSince(o.placed))} d)`}${o.balanceDueGBP && !o.balancePaid ? ` — balance ${gbp(o.balanceDueGBP)} ${o.stripeInvoiceId ? 'invoiced' : 'not invoiced'}` : ''}</li>`)}
      <h3 style="margin:18px 0 4px;font-size:15px">Material requests to action</h3>${list(d.requests, (r) => `<li>${r.id} — ${esc(name(r.userId))} — ${esc(r.status)} — ${r.materials.length} line${r.materials.length === 1 ? '' : 's'}</li>`)}
      <p style="margin-top:18px;font-size:12px;color:#5E6B85">Marketplace sync: ${d.sync.enabled ? `on, last OK ${d.sync.lastOk ? new Date(d.sync.lastOk).toLocaleString('en-GB') : 'never'}${d.sync.lastError ? ` — <span style="color:#B42318">error: ${esc(d.sync.lastError)}</span>` : ''}` : 'not connected'} · Email ${d.sync.mail ? 'on' : 'off'} · SMS ${smsOn ? 'on' : 'off'} · Stripe invoices ${stripeOn ? 'on' : 'off'}</p>`;
  }
  async function sendDigest(force = false) {
    const now = london();
    const weekKey = (() => { const d = new Date(); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); })();
    if (!force && (now.weekday !== ENV.DIGEST_DAY || now.hour !== ENV.DIGEST_HOUR || sys.lastDigestWeek === weekKey)) return false;
    sys.lastDigestWeek = weekKey; sys.lastDigestAt = new Date().toISOString(); saveSystem();
    const html = digestHtml(digestData());
    for (const a of admins()) await sendMail(a.email, `MRG weekly digest — ${now.date}`, `Your week at a glance, ${a.name.split(' ')[0]}`, html, { url: portalUrl, label: 'Open the admin portal' });
    return true;
  }

  /* =================================================================
     PUBLIC IMPACT COUNTER + MEMBER BADGES
     ================================================================= */
  let impactCache = { at: 0, data: null };
  function publicImpact() {
    if (Date.now() - impactCache.at < 60e3 && impactCache.data) return impactCache.data;
    const t = features.computeImpact({}).totals;
    impactCache = { at: Date.now(), data: { kgCO2e: Math.round(t.kgCO2e || 0), tonnesDiverted: +((t.weightKg || 0) / 1000).toFixed(1), itemsRehomed: t.items || 0,
      members: db.users.filter((u) => u.role !== 'admin').length, passports: db.materials.length, carMiles: Math.round((t.kgCO2e || 0) * 2.5), updated: new Date().toISOString() } };
    return impactCache.data;
  }
  function badgeFor(user) {
    if (!user.badgeToken) { user.badgeToken = crypto.randomBytes(12).toString('hex'); saveUsers(); }
    return { token: user.badgeToken, url: `${portalUrl}/api/public/badge/${user.badgeToken}.svg`, page: `${portalUrl}/api/public/badge/${user.badgeToken}` };
  }
  function badgeSvg(user) {
    const kg = num(user.carbonSavedKg), year = new Date().getFullYear();
    const figure = kg >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${Math.round(kg)} kg`;
    const org = esc(user.organisation || user.name);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120" role="img" aria-label="Material Reuse Partner ${year} — ${figure} CO2e avoided">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9EFF51"/><stop offset="1" stop-color="#1D7A05"/></linearGradient></defs>
  <rect width="360" height="120" rx="10" fill="#06183F"/>
  <circle cx="46" cy="60" r="26" fill="none" stroke="url(#g)" stroke-width="9"/><circle cx="46" cy="60" r="26" fill="none" stroke="#06183F" stroke-width="9" stroke-dasharray="14 150" stroke-dashoffset="-40"/>
  <text x="90" y="34" font-family="Geologica,Inter,Helvetica,Arial,sans-serif" font-size="11" font-weight="600" letter-spacing="2" fill="#9EFF51">MATERIAL REUSE PARTNER ${year}</text>
  <text x="90" y="64" font-family="Geologica,Inter,Helvetica,Arial,sans-serif" font-size="24" font-weight="700" fill="#FFFFFF">${figure} CO₂e avoided</text>
  <text x="90" y="86" font-family="Inter,Helvetica,Arial,sans-serif" font-size="12" fill="#B9C6E4">${org}</text>
  <text x="90" y="104" font-family="Inter,Helvetica,Arial,sans-serif" font-size="10" fill="#5E6B85">Verified reuse with Material Reuse Group · material-reuse.co.uk</text>
</svg>`;
  }

  /* =================================================================
     SCHEDULER
     ================================================================= */
  let ticks = 0;
  async function tick() {
    ticks++;
    try { await checkBalanceInvoices(); } catch (e) { console.error('  invoices:', e.message); }
    try { await syncStripeInvoices(); } catch (e) { console.error('  invoice sync:', e.message); }
    try { await sendDigest(); } catch (e) { console.error('  digest:', e.message); }
    if (ticks % 12 === 1) { try { await staleSweep(); } catch (e) { console.error('  stale sweep:', e.message); } } // hourly
  }
  // "Run automations now" from the admin overview: alerts, invoice checks and the stale-hold sweep in one go
  async function runNow() { await checkBalanceInvoices(); await syncStripeInvoices(); await staleSweep(); if (ctx.commerce) await ctx.commerce.runNow(); }
  function start() {
    console.log(`  automations: stripe invoices ${stripeOn ? 'on' : 'off — set STRIPE_SECRET_KEY'} · sms ${smsOn ? `on (${smsProvider})` : 'off — set BREVO_API_KEY or TWILIO_*'} · digest ${ENV.DIGEST_DAY} ${String(ENV.DIGEST_HOUR).padStart(2, '0')}:00 · stale remind ${ENV.STALE_REMIND_DAYS}d / release ${ENV.STALE_RELEASE_DAYS}d`);
    setTimeout(tick, 20e3).unref();
    setInterval(tick, 5 * 60e3).unref();
  }

  // ---- wire into the rest of the portal ----
  features.hooks.slotConfirmed = (o) => onSlotConfirmed(o);

  const status = () => ({ stripe: stripeOn, sms: smsOn, alertsSent: sys.alertsSentTotal || 0, lastDigestAt: sys.lastDigestAt || null,
    staleDue: staleCandidates().length, digest: `${ENV.DIGEST_DAY} ${String(ENV.DIGEST_HOUR).padStart(2, '0')}:00`, staleRemindDays: ENV.STALE_REMIND_DAYS, staleReleaseDays: ENV.STALE_RELEASE_DAYS });

  return { ENV, audit, auditRequest, sendSms, sendBalanceInvoice, checkBalanceInvoices, syncStripeInvoices, walkInSale, onSlotConfirmed, staleSweep, stripe, stripeCustomer, stripeOn, smsOn, london, setCommerce, releaseHold, sendDigest, digestData, publicImpact, badgeFor, badgeSvg, status, start, runNow, slotConfirmed };
};
