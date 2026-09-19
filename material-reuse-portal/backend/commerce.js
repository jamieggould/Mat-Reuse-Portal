/* =====================================================================
   material reuse — commerce
   The portal is the source of truth for stock, orders and memberships.
     · Marketplace checkout: GET /api/checkout?sku=&mode=buy|deposit → Stripe
       Checkout (per-item price, quantity picker) → /order-complete records
       the order, creates the account if needed, reduces stock, emails.
       A 5-minute poll of completed sessions catches anything missed.
     · Stock admin: an MRG passport carries its marketplace listing
       (price, delivery, availability) — one form for Kallie.
     · Memberships: Stripe subscriptions (annual). Upgrade = Checkout or
       immediate plan change; downgrade/cancel = at end of the paid year;
       Community = request → admin approves. Tier follows Stripe.
     · Wishlist: members ask for what they need; Kallie is emailed; the
       member is emailed (and texted) when a matching item is listed.
     · Weekly new-stock email to members who opted in.
   Everything Stripe-related is skipped politely when STRIPE_SECRET_KEY
   is unset (checkout returns a friendly message).
   ===================================================================== */
'use strict';
const crypto = require('crypto');
const { today, num, esc, gbp, daysSince } = require('./util');

const ENV = {
  DEPOSIT_PERCENT: Math.max(1, Math.min(100, +process.env.DEPOSIT_PERCENT || 50)),
  CHECKOUT_NOTE: process.env.CHECKOUT_NOTE || 'Use the same email as your Material Reuse Group portal account and this order appears on your dashboard automatically. No account yet? We create one for you at this email.',
  STOCK_MAIL_DAY: process.env.STOCK_MAIL_DAY || 'Fri',
  STOCK_MAIL_HOUR: Math.min(23, Math.max(0, +process.env.STOCK_MAIL_HOUR || 9)),
};
const FREE_TIERS = ['domestic-free', 'community'];
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const isoDate = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

module.exports = function install(ctx) {
  const { db, features, integrations, automations, saveOrders, saveUsers, saveInventory, saveSystem, saveWishlist, nextOrderSeq, safeUser } = ctx;
  const { mail, ENV: IENV, ensureMember } = integrations;
  const { stripe, stripeCustomer, stripeOn, audit, sendSms, london } = automations;
  const portal = IENV.PORTAL_URL;
  const sys = db.system;
  const userById = (id) => db.users.find((u) => u.id === id);
  const tierById = (id) => db.tiers.find((t) => t.id === id) || null;
  const invBySku = (sku) => db.inventory.find((i) => i.sku === sku);
  const matBySku = (sku) => db.materials.find((m) => m.sku === sku || m.id === sku);

  /* =================================================================
     LISTINGS (public shape) + checkout links
     ================================================================= */
  const buyUrl = (sku, mode) => `${portal}/api/checkout?sku=${encodeURIComponent(sku)}&mode=${mode}`;
  const onSale = (i) => i && !i.archived && i.status === 'Available' && (i.quantity || 0) > 0 && num(i.price) > 0;
  function listing(i) {
    const m = matBySku(i.sku);
    return { sku: i.sku, passportId: m ? m.id : i.sku, title: i.title, category: i.category, itemType: i.itemType || '', quantity: i.quantity, unit: i.unit || 'items',
      price: i.price, priceUnit: i.priceUnit || 'each', retailNew: i.retailNew || 0, carbonSavedKgPerUnit: i.carbonSavedKgPerUnit || 0, fulfilment: i.fulfilment || 'Collection Only',
      condition: m ? m.condition : '', description: m ? m.description : '', photos: (i.photos || []).map((p) => ({ url: p.url })), status: i.status,
      dateAdded: i.dateAdded, buyUrl: onSale(i) ? buyUrl(i.sku, 'buy') : '', reserveUrl: onSale(i) ? buyUrl(i.sku, 'deposit') : '', passportUrl: `${portal}/passport/${m ? m.id : i.sku}` };
  }
  const publicListings = () => db.inventory.filter((i) => !i.archived && i.status !== 'Sold' && (i.quantity || 0) > 0).map(listing)
    .sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''));

  /* =================================================================
     STOCK ADMIN — an MRG passport carries its listing
     ================================================================= */
  // Called after an admin creates/edits a passport. `stock` = { price, fulfilment, availability } (only for MRG stock, i.e. no owner).
  function upsertStock(mat, stock, actor) {
    if (mat.userId) return null; // client-owned material is never for sale here
    let inv = mat.sku ? invBySku(mat.sku) : null;
    const wasOnSale = onSale(inv);
    if (!inv) {
      mat.sku = mat.sku || mat.id;
      inv = { sku: mat.sku, qrCode: `QR-${mat.sku}`, dateAdded: mat.dateRecovered || today(), passportVerified: !!mat.passportVerified, source: mat.sourceBuilding || '' };
      db.inventory.push(inv);
    }
    const qty = Math.max(0, Math.round(num(mat.quantity, 0)));
    Object.assign(inv, { title: mat.name, category: mat.category, itemType: inv.itemType || '', quantity: qty, unit: mat.unit || 'items',
      priceUnit: 'each', carbonSavedKgPerUnit: qty ? +((num(mat.carbonSavedKg) / qty).toFixed(2)) : inv.carbonSavedKgPerUnit || 0,
      photos: (mat.photos || []).map((p) => ({ url: p.url, key: p.key || null, name: p.name || 'photo' })), passportVerified: !!mat.passportVerified, archived: false, earlyAccess: false });
    if (stock) {
      if (stock.price !== undefined) inv.price = Math.max(0, num(stock.price));
      if (stock.retailNew !== undefined) inv.retailNew = Math.max(0, num(stock.retailNew)); // what it would cost new
      if (stock.fulfilment) inv.fulfilment = stock.fulfilment === 'Available For Delivery' ? 'Available For Delivery' : 'Collection Only';
      if (stock.availability) inv.status = stock.availability === 'Sold' ? 'Sold' : 'Available';
    }
    if (!inv.status || inv.status === 'Pending') inv.status = 'Available';
    if (inv.status === 'Available' && qty === 0) inv.status = 'Sold';
    if (['Rehomed', 'Recycled'].includes(mat.status)) inv.status = 'Sold';
    if (mat.status === 'Listed' && inv.status === 'Sold' && qty > 0) inv.status = 'Available';
    if (inv.status === 'Available' && !['Reserved'].includes(mat.status)) mat.status = 'Listed';
    saveInventory(); features.fire('stockChanged', inv);
    if (onSale(inv) && !wasOnSale) { features.addHistory(mat, 'Listed', 'Listed on the Material Reuse Group marketplace'); features.saveMaterialsDirect(); matchWishes(inv); }
    return inv;
  }

  /* =================================================================
     MEMBERSHIP CREDIT (Standard £100 / Plus £2,500 a year, resets at renewal)
     ================================================================= */
  function creditInfo(u) {
    const t = tierById(u.tier); const allowance = t ? num(t.credit) : 0;
    const period = u.tierRenews || u.memberSince || 'none';
    if (u.creditPeriod !== period) { u.creditPeriod = period; u.creditUsed = 0; saveUsers(); } // new paid year → fresh credit
    const used = num(u.creditUsed);
    return { allowance, used, remaining: Math.max(0, +(allowance - used).toFixed(2)), resets: u.tierRenews || null };
  }
  const isCommunity = (u) => u && u.tier === 'community';
  // Community accounts must send installation photos for every collected order before buying again
  const evidenceOutstanding = (u) => db.orders.filter((o) => o.userId === u.id && o.evidenceRequired && !(o.evidence && o.evidence.photos && o.evidence.photos.length));

  // Signed-in member buys/reserves a chosen quantity. Credit is applied automatically; a fully-covered order is claimed without Stripe.
  async function memberCheckout(u, { sku, mode, qty }) {
    const inv = invBySku(sku);
    if (!onSale(inv)) throw new Error('This item is no longer available.');
    if (isCommunity(u)) {
      if (!u.address) throw new Error('Your registered installation address hasn’t been set yet — please contact Kallie (kallie@material-reuse.co.uk).');
      const due = evidenceOutstanding(u);
      if (due.length) throw new Error(`Please upload installation photos for ${due.map((o) => o.id).join(', ')} before buying again.`);
    }
    const quantity = Math.min(Math.max(1, Math.floor(num(qty, 1))), inv.quantity);
    const deposit = mode === 'deposit';
    const total = +(inv.price * quantity).toFixed(2);
    const credit = creditInfo(u);
    const creditApplied = Math.min(credit.remaining, total);
    const remaining = +(total - creditApplied).toFixed(2);
    if (remaining <= 0) { // fully covered by membership credit
      const r = recordOrder({ inv, quantity, user: u, deposit: false, unitPrice: inv.price, paid: 0, creditApplied, source: 'credit' });
      return { order: r.order };
    }
    if (!stripeOn) throw new Error('Online payment isn’t switched on yet — email kallie@material-reuse.co.uk to buy this item.');
    const charge = deposit ? Math.round(remaining * ENV.DEPOSIT_PERCENT) / 100 : remaining;
    const photo = inv.photos && inv.photos[0] ? (/^https?:\/\//.test(inv.photos[0].url) ? inv.photos[0].url : portal + inv.photos[0].url) : null;
    const customer = await stripeCustomer(u);
    const session = await stripe('checkout/sessions', 'POST', {
      mode: 'payment', customer,
      line_items: [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: Math.round(charge * 100),
        product_data: { name: `${quantity} × ${inv.title}${deposit ? ` — ${ENV.DEPOSIT_PERCENT}% deposit` : ''}`,
          description: `${gbp(inv.price)} each${creditApplied ? ` · ${gbp(creditApplied)} membership credit applied` : ''}${deposit ? ` · balance ${gbp(remaining - charge)} payable before collection` : ''}`, ...(photo ? { images: [photo] } : {}) } } }],
      success_url: `${portal}/order-complete?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${portal}/?cancelled=1`,
      phone_number_collection: { enabled: u.phone ? 'false' : 'true' },
      invoice_creation: { enabled: 'true', invoice_data: { description: `${quantity} × ${inv.title}${creditApplied ? ` (less ${gbp(creditApplied)} membership credit)` : ''}`,
        footer: 'Material Reuse Group · material-reuse.co.uk · 01932 867989 · kallie@material-reuse.co.uk', custom_fields: [{ name: 'Item', value: String(inv.title).slice(0, 40) }, { name: 'Order type', value: deposit ? 'Deposit / Reserve' : 'Purchase' }] } },
      metadata: { source: 'mrg-portal', kind: 'order', sku: inv.sku, mode: deposit ? 'deposit' : 'buy', unitPrice: String(inv.price), qty: String(quantity), creditApplied: String(creditApplied), userId: u.id },
    });
    return { url: session.url };
  }

  // Shared order writer (checkout sessions, credit claims)
  function recordOrder({ inv, quantity, user, deposit, unitPrice, paid, creditApplied = 0, sessionId = null, customerId = null, source = 'marketplace' }) {
    const total = +(unitPrice * quantity).toFixed(2);
    const remaining = +(total - creditApplied).toFixed(2);
    const mat = matBySku(inv.sku);
    const order = { id: `ORD-${new Date().getFullYear()}-${nextOrderSeq()}`, userId: user.id, placed: today(), status: deposit ? 'Reserved' : 'Awaiting collection',
      fulfilment: isCommunity(user) ? `To be installed at ${user.address}` : (inv.fulfilment === 'Available For Delivery' ? 'Delivery available — arrange with the team' : 'Collection — Material Reuse Group warehouse'),
      slot: 'Slot to be confirmed — we’ll be in touch', items: [{ sku: inv.sku, title: inv.title, qty: quantity, price: unitPrice }], total,
      carbonSavedKg: +((inv.carbonSavedKgPerUnit || 0) * quantity).toFixed(1), stripeSessionId: sessionId, stripeCustomerId: customerId, source,
      note: creditApplied && remaining <= 0 ? `Claimed with membership credit (${gbp(creditApplied)})` : deposit ? `Reserved online — ${ENV.DEPOSIT_PERCENT}% deposit paid, balance payable before collection` : 'Purchased online — paid in full' };
    if (creditApplied) { order.creditApplied = creditApplied; user.creditUsed = +(num(user.creditUsed) + creditApplied).toFixed(2); }
    if (deposit) { order.depositGBP = paid; order.balanceDueGBP = +(remaining - paid).toFixed(2); }
    if (isCommunity(user)) { order.installAddress = user.address; order.evidenceRequired = true; }
    db.orders.unshift(order);
    inv.quantity = Math.max(0, (inv.quantity || 0) - quantity);
    if (inv.quantity === 0) inv.status = deposit ? 'Reserved' : 'Sold';
    saveInventory(); saveOrders(); saveUsers(); features.fire('stockChanged', inv);
    if (mat) { features.addHistory(mat, deposit ? 'Reserved' : 'Sold', `${quantity} ${inv.unit || 'items'} ${deposit ? 'reserved' : 'bought'} by a member (${order.id})`); if (inv.quantity === 0) mat.status = deposit ? 'Reserved' : 'Rehomed'; features.saveMaterialsDirect(); }
    audit(null, deposit ? 'reservation' : 'purchase', order.id, `${quantity} × ${inv.title} · paid ${gbp(paid)}${creditApplied ? ` · credit ${gbp(creditApplied)}` : ''} · ${user.email}`);
    mail.orderConfirmed(order, user, inv);
    sendSms(user, `Thanks — order ${order.id} (${quantity} × ${inv.title}) is confirmed. We'll text you when your collection slot is booked.`);
    return { order, user };
  }

  /* =================================================================
     CHECKOUT (marketplace)
     ================================================================= */
  async function createCheckout({ sku, mode, qty, email }) {
    const inv = invBySku(sku);
    if (!onSale(inv)) throw Object.assign(new Error('This item is no longer available.'), { code: 'unavailable' });
    if (!stripeOn) throw new Error('Online payment isn’t switched on yet — email kallie@material-reuse.co.uk to buy this item.');
    const deposit = mode === 'deposit';
    const unit = deposit ? Math.round(inv.price * ENV.DEPOSIT_PERCENT) / 100 : inv.price;
    const quantity = Math.min(Math.max(1, Math.floor(num(qty, 1))), inv.quantity);
    const photo = inv.photos && inv.photos[0] && /^https?:\/\//.test(inv.photos[0].url) ? inv.photos[0].url : (inv.photos && inv.photos[0] ? portal + inv.photos[0].url : null);
    const params = {
      mode: 'payment',
      line_items: [{ quantity, adjustable_quantity: inv.quantity > 1 ? { enabled: 'true', minimum: 1, maximum: inv.quantity } : { enabled: 'false' },
        price_data: { currency: 'gbp', unit_amount: Math.round(unit * 100),
          product_data: { name: deposit ? `Deposit (${ENV.DEPOSIT_PERCENT}%) to reserve: ${inv.title}` : inv.title,
            description: deposit ? `${gbp(unit)} deposit per item (full price ${gbp(inv.price)} each — balance payable before collection). ${inv.quantity} in stock.` : `${gbp(inv.price)} each · ${inv.quantity} in stock · ${inv.fulfilment || 'Collection from the MRG warehouse'}`,
            ...(photo ? { images: [photo] } : {}) } } }],
      success_url: `${portal}/order-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${portal}/marketplace?cancelled=1`,
      phone_number_collection: { enabled: 'true' },
      custom_text: { submit: { message: ENV.CHECKOUT_NOTE } },
      invoice_creation: { enabled: 'true', invoice_data: { description: `${inv.title} — ${deposit ? `${ENV.DEPOSIT_PERCENT}% deposit; balance payable before collection` : 'reclaimed material, collection from the Material Reuse Group warehouse'}`,
        footer: 'Material Reuse Group · material-reuse.co.uk · 01932 867989 · kallie@material-reuse.co.uk\nBuilding a sustainable future, one material at a time.',
        custom_fields: [{ name: 'Item', value: String(inv.title).slice(0, 40) }, { name: 'Order type', value: deposit ? 'Deposit / Reserve' : 'Purchase' }] } },
      metadata: { source: 'mrg-portal', kind: 'order', sku: inv.sku, mode: deposit ? 'deposit' : 'buy', unitPrice: String(inv.price) },
    };
    if (email) params.customer_email = email;
    const session = await stripe('checkout/sessions', 'POST', params);
    return session.url;
  }

  // Turn a paid Checkout Session into an order (idempotent — safe to call from the redirect and from the poll)
  async function recordOrderSession(session) {
    const existing = db.orders.find((o) => o.stripeSessionId === session.id);
    if (existing) return { order: existing, user: userById(existing.userId), created: false, duplicate: true };
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return null;
    const md = session.metadata || {};
    const inv = invBySku(md.sku); if (!inv) return null;
    const lines = await stripe(`checkout/sessions/${session.id}/line_items?limit=1`);
    const qty = Math.max(1, num(lines.data && lines.data[0] && lines.data[0].quantity, 1));
    const cd = session.customer_details || {};
    const email = (cd.email || session.customer_email || '').toLowerCase();
    if (!email) return null;
    const known = md.userId ? userById(md.userId) : null;
    const { user, created } = known ? { user: known, created: false } : await ensureMember(email, cd.name, cd.phone);
    if (!user) return null;
    const quantity = md.qty ? Math.max(1, num(md.qty, 1)) : qty; // member checkouts fix the quantity server-side
    const r = recordOrder({ inv, quantity, user, deposit: md.mode === 'deposit', unitPrice: num(md.unitPrice, inv.price), paid: +((session.amount_total || 0) / 100).toFixed(2),
      creditApplied: num(md.creditApplied), sessionId: session.id, customerId: session.customer || null });
    if (created) audit(null, 'account created at checkout', user.id, user.email);
    return { order: r.order, user, created };
  }

  async function completeSession(sessionId) {
    if (!stripeOn || !/^cs_/.test(String(sessionId || ''))) return null;
    const session = await stripe(`checkout/sessions/${sessionId}`);
    if (!session || (session.metadata || {}).source !== 'mrg-portal') return null;
    if ((session.metadata || {}).kind === 'signup') return { signup: await applySignupSession(session) };
    if (session.mode === 'subscription') return { membership: await applyMembershipSession(session) };
    return recordOrderSession(session);
  }

  // Poll: anything completed in the last while that we haven't recorded (covers a buyer who closed the tab before the redirect)
  let pollFrom = Math.floor(Date.now() / 1000) - 3 * 86400;
  async function pollSessions() {
    if (!stripeOn) return;
    let starting_after = null;
    for (let page = 0; page < 5; page++) {
      const j = await stripe(`checkout/sessions?status=complete&limit=100&created[gte]=${pollFrom - 600}${starting_after ? `&starting_after=${starting_after}` : ''}`);
      for (const s of j.data || []) {
        if ((s.metadata || {}).source !== 'mrg-portal') continue;
        try { if ((s.metadata || {}).kind === 'signup') await applySignupSession(s); else if (s.mode === 'subscription') await applyMembershipSession(s); else await recordOrderSession(s); } catch (e) { console.error(`  session ${s.id}:`, e.message); }
      }
      if (!j.has_more) break; starting_after = j.data[j.data.length - 1].id;
    }
    pollFrom = Math.floor(Date.now() / 1000);
  }

  /* =================================================================
     MEMBERSHIPS — Stripe subscriptions, annual
     ================================================================= */
  const paidTiers = () => db.tiers.filter((t) => t.price > 0 && t.public);
  const publicTiers = () => db.tiers.filter((t) => t.public).map((t) => ({ id: t.id, name: t.name, price: t.price, billing: t.billing, credit: num(t.credit), tagline: t.tagline, features: t.features }));

  /* ---- sign-up to a paid tier: pay first, account created when Stripe confirms ---- */
  sys.pendingSignups = sys.pendingSignups || {};
  async function startSignup({ name, email, auth, tierId }) {
    const t = tierById(tierId);
    if (!t || !t.public) throw new Error('Unknown membership.');
    if (!stripeOn) throw new Error('Online membership payments aren’t switched on yet — choose Domestic Basic for now or email kallie@material-reuse.co.uk.');
    await ensurePrices();
    const token = crypto.randomBytes(12).toString('hex');
    for (const k of Object.keys(sys.pendingSignups)) if (daysSince(sys.pendingSignups[k].at) > 2) delete sys.pendingSignups[k];
    sys.pendingSignups[token] = { name, email, auth, tierId, at: new Date().toISOString() }; saveSystem();
    const session = await stripe('checkout/sessions', 'POST', { mode: 'subscription', customer_email: email, line_items: [{ price: sys.stripePrices[tierId], quantity: 1 }],
      success_url: `${portal}/signup-complete?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${portal}/?signup=cancelled`, allow_promotion_codes: 'true',
      metadata: { source: 'mrg-portal', kind: 'signup', signup: token, tierId }, subscription_data: { metadata: { tierId } } });
    return { url: session.url };
  }
  async function applySignupSession(session) {
    const md = session.metadata || {}; const p = sys.pendingSignups[md.signup];
    const existing = db.users.find((x) => x.email.toLowerCase() === String((p && p.email) || (session.customer_details || {}).email || '').toLowerCase());
    if (existing) { // account already made (poll + redirect both ran) — make sure it's on the paid tier
      if (existing.stripeSubscriptionId !== session.subscription) { existing.stripeSubscriptionId = session.subscription; existing.stripeCustomerId = session.customer; existing.tier = md.tierId; saveUsers(); }
      delete sys.pendingSignups[md.signup]; saveSystem(); return { user: existing, created: false };
    }
    if (!p) return null;
    const u = ctx.createUser({ name: p.name, email: p.email, auth: p.auth, tier: p.tierId });
    u.stripeSubscriptionId = session.subscription || null; u.stripeCustomerId = session.customer || null;
    try { const sub = await stripe(`subscriptions/${session.subscription}`); u.tierRenews = isoDate(sub.current_period_end); } catch (e) { /* poll fills it in */ }
    u.billing = { method: 'Card (Stripe)', nextPayment: u.tierRenews || null, invoices: [] };
    delete sys.pendingSignups[md.signup]; saveSystem(); saveUsers();
    mail.welcome(u); audit(null, 'paid sign-up', u.id, `${u.email} → ${p.tierId}`);
    return { user: u, created: true };
  }
  const lookupKey = (tierId) => `mrg-${tierId}-annual`;
  sys.stripePrices = sys.stripePrices || {};
  async function ensurePrices() {
    if (!stripeOn) return;
    for (const t of paidTiers()) {
      if (sys.stripePrices[t.id]) continue;
      const found = await stripe(`prices?lookup_keys[]=${encodeURIComponent(lookupKey(t.id))}&limit=1`);
      let price = found.data && found.data[0];
      if (!price) {
        const product = await stripe('products', 'POST', { name: `${t.name} — Material Reuse Group`, metadata: { tierId: t.id } });
        price = await stripe('prices', 'POST', { product: product.id, currency: 'gbp', unit_amount: Math.round(t.price * 100), recurring: { interval: 'year' }, lookup_key: lookupKey(t.id), metadata: { tierId: t.id } });
      }
      sys.stripePrices[t.id] = price.id; saveSystem();
    }
  }
  const tierFromPrice = (price) => { const key = price && (price.lookup_key || ''); const m = /^mrg-(.+)-annual$/.exec(key); return m ? m[1] : (price && price.metadata && price.metadata.tierId) || null; };

  function membershipView(u) {
    const t = tierById(u.tier);
    return { tier: u.tier, tierName: t ? t.name : u.tier, public: !!(t && t.public), renews: u.tierRenews || null, pendingTier: u.pendingTier || null, pendingAt: u.pendingAt || null,
      subscription: !!u.stripeSubscriptionId, paymentIssue: !!u.paymentIssue, stripe: stripeOn, credit: creditInfo(u), installAddress: isCommunity(u) ? u.address || null : undefined,
      evidenceOutstanding: isCommunity(u) ? evidenceOutstanding(u).map((o) => o.id) : [] };
  }

  // Member asked to move to `tierId`
  async function changeMembership(u, tierId, opts = {}) {
    const target = tierById(tierId); if (!target) throw new Error('Unknown membership.');
    if (u.tier === tierId && !u.pendingTier) throw new Error('You’re already on that plan.');
    const current = tierById(u.tier) || { price: 0 };
    // undo a scheduled change
    if (tierId === u.tier && u.pendingTier) { await cancelPending(u); return { ok: true, message: 'Scheduled change cancelled — you stay on your current plan.' }; }
    if (!target.public || !(tierById(u.tier) || {}).public) throw new Error('Your membership is managed by the Material Reuse Group team — email kallie@material-reuse.co.uk or call 01932 867989 to change it.');
    if (target.price === 0) { // → Domestic Free
      if (u.stripeSubscriptionId) {
        const sub = await stripe(`subscriptions/${u.stripeSubscriptionId}`, 'POST', { cancel_at_period_end: 'true' });
        u.pendingTier = tierId; u.pendingAt = isoDate(sub.current_period_end); saveUsers();
        mail.membershipPending(u, target, fmtDate(u.pendingAt)); audit(u, 'scheduled downgrade', u.id, `→ ${target.name} on ${u.pendingAt}`);
        return { ok: true, message: `You’ll move to ${target.name} on ${fmtDate(u.pendingAt)}. Until then nothing changes.` };
      }
      setTier(u, tierId, 'Switched to the free plan'); return { ok: true, message: `You’re now on ${target.name}.` };
    }
    // paid target
    if (!stripeOn) throw new Error('Online membership payments aren’t switched on yet — email kallie@material-reuse.co.uk to upgrade.');
    await ensurePrices();
    const priceId = sys.stripePrices[tierId];
    if (!u.stripeSubscriptionId) { // Checkout
      const customer = await stripeCustomer(u);
      const session = await stripe('checkout/sessions', 'POST', { mode: 'subscription', customer, line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${portal}/membership-complete?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${portal}/?membership=cancelled`,
        allow_promotion_codes: 'true', metadata: { source: 'mrg-portal', kind: 'membership', tierId, userId: u.id }, subscription_data: { metadata: { tierId, userId: u.id } } });
      return { ok: true, checkoutUrl: session.url };
    }
    const sub = await stripe(`subscriptions/${u.stripeSubscriptionId}`);
    const item = sub.items.data[0];
    if (target.price > current.price) { // upgrade now, pay the difference
      await stripe(`subscriptions/${sub.id}`, 'POST', { items: [{ id: item.id, price: priceId }], proration_behavior: 'always_invoice', cancel_at_period_end: 'false', metadata: { tierId, userId: u.id } });
      if (sub.schedule) await stripe(`subscription_schedules/${sub.schedule}/release`, 'POST');
      u.pendingTier = null; u.pendingAt = null;
      setTier(u, tierId, 'Upgraded — the difference for the rest of the year has been charged to your card'); return { ok: true, message: `You’re now on ${target.name}.` };
    }
    // downgrade to a cheaper paid plan at the end of the paid year → subscription schedule
    let schedule = sub.schedule ? await stripe(`subscription_schedules/${sub.schedule}`) : await stripe('subscription_schedules', 'POST', { from_subscription: sub.id });
    await stripe(`subscription_schedules/${schedule.id}`, 'POST', { end_behavior: 'release', phases: [
      { items: [{ price: item.price.id, quantity: 1 }], start_date: schedule.phases[0].start_date, end_date: sub.current_period_end },
      { items: [{ price: priceId, quantity: 1 }], metadata: { tierId } }] });
    u.pendingTier = tierId; u.pendingAt = isoDate(sub.current_period_end); saveUsers();
    mail.membershipPending(u, target, fmtDate(u.pendingAt)); audit(u, 'scheduled downgrade', u.id, `→ ${target.name} on ${u.pendingAt}`);
    return { ok: true, message: `You’ll move to ${target.name} on ${fmtDate(u.pendingAt)}. Until then you keep everything you’ve paid for.` };
  }
  async function cancelPending(u) {
    if (u.stripeSubscriptionId && stripeOn) {
      const sub = await stripe(`subscriptions/${u.stripeSubscriptionId}`);
      if (sub.cancel_at_period_end) await stripe(`subscriptions/${sub.id}`, 'POST', { cancel_at_period_end: 'false' });
      if (sub.schedule) await stripe(`subscription_schedules/${sub.schedule}/release`, 'POST');
    }
    u.pendingTier = null; u.pendingAt = null; saveUsers(); audit(u, 'cancelled scheduled change', u.id, '');
  }
  function setTier(u, tierId, note) {
    const t = tierById(tierId); if (!t) return;
    const prev = u.tier; u.tier = tierId;
    if (FREE_TIERS.includes(tierId)) { u.tierRenews = null; u.billing = u.billing || { method: null, nextPayment: null, invoices: [] }; u.billing.method = null; u.billing.nextPayment = null; }
    saveUsers(); if (prev !== tierId) { mail.membershipChanged(u, t, note); audit(null, 'membership changed', u.id, `${prev} → ${tierId}`); }
  }
  async function applyMembershipSession(session) {
    const md = session.metadata || {}; const u = userById(md.userId); if (!u || !session.subscription) return null;
    if (u.stripeSubscriptionId === session.subscription) return membershipView(u);
    u.stripeSubscriptionId = session.subscription; u.stripeCustomerId = session.customer || u.stripeCustomerId; u.pendingTier = null; u.pendingAt = null; u.paymentIssue = false;
    const sub = await stripe(`subscriptions/${session.subscription}`);
    u.tierRenews = isoDate(sub.current_period_end);
    u.billing = u.billing || { invoices: [] }; u.billing.method = 'Card (Stripe)'; u.billing.nextPayment = u.tierRenews;
    setTier(u, md.tierId, 'Thanks for upgrading — your invoice is in Membership & Billing');
    return membershipView(u);
  }
  // Keep every subscriber's tier in step with Stripe (renewals, scheduled downgrades, cancellations, failed payments, renewal notices)
  async function syncSubscriptions() {
    if (!stripeOn) return;
    for (const u of db.users.filter((x) => x.stripeSubscriptionId)) {
      try {
        const sub = await stripe(`subscriptions/${u.stripeSubscriptionId}`);
        const t = tierById(u.tier) || { name: u.tier, price: 0 };
        if (['canceled', 'incomplete_expired', 'unpaid'].includes(sub.status)) {
          const next = u.pendingTier || (u.tier === 'community' ? 'community' : 'domestic-free');
          u.stripeSubscriptionId = null; u.pendingTier = null; u.pendingAt = null; u.paymentIssue = false;
          setTier(u, next, sub.status === 'canceled' ? 'Your paid membership has ended as scheduled' : 'Your paid membership ended because payment could not be taken'); continue;
        }
        const tierNow = tierFromPrice(sub.items.data[0] && sub.items.data[0].price);
        if (tierNow && tierNow !== u.tier && u.tier !== 'community') { if (u.pendingTier === tierNow) { u.pendingTier = null; u.pendingAt = null; } setTier(u, tierNow, 'Your scheduled plan change has taken effect'); }
        const renews = isoDate(sub.current_period_end);
        if (u.tierRenews !== renews) { u.tierRenews = renews; u.billing = u.billing || { invoices: [] }; u.billing.method = 'Card (Stripe)'; u.billing.nextPayment = renews; saveUsers(); }
        if (sub.status === 'past_due' && !u.paymentIssue) { u.paymentIssue = true; saveUsers(); mail.paymentFailed(u, t); }
        if (sub.status === 'active' && u.paymentIssue) { u.paymentIssue = false; saveUsers(); }
        const daysToRenew = (sub.current_period_end * 1000 - Date.now()) / 864e5;
        if (daysToRenew <= 14 && daysToRenew > 0 && !sub.cancel_at_period_end && u.renewalNoticeFor !== renews) { u.renewalNoticeFor = renews; saveUsers(); mail.renewalDue(u, t, fmtDate(renews), t.price); }
      } catch (e) { console.error(`  subscription ${u.stripeSubscriptionId}:`, e.message); }
    }
  }
  async function billingPortalUrl(u) {
    if (!stripeOn) throw new Error('Not available yet.');
    const customer = u.stripeCustomerId || await stripeCustomer(u);
    const s = await stripe('billing_portal/sessions', 'POST', { customer, return_url: `${portal}/` });
    return s.url;
  }
  async function decideCommunity(u, approve, note, actor) {
    if (!u.communityRequest) throw new Error('No pending request.');
    u.communityRequest = null;
    if (approve) {
      if (u.stripeSubscriptionId && stripeOn) { try { await stripe(`subscriptions/${u.stripeSubscriptionId}`, 'POST', { cancel_at_period_end: 'true' }); } catch (e) { console.error('  community cancel sub:', e.message); } }
      u.pendingTier = null; u.pendingAt = null; setTier(u, 'community', 'Approved by the Material Reuse Group team');
    } else saveUsers();
    mail.communityDecision(u, approve, note); audit(actor, approve ? 'approved community membership' : 'declined community membership', u.id, note || '');
  }

  /* =================================================================
     WISHLIST — portal-native
     ================================================================= */
  const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  function wishMatches(w, item) {
    if (w.category && item.category && w.category.toLowerCase() === item.category.toLowerCase()) return true;
    const want = words(`${w.itemType || ''} ${w.notes || ''}`), have = words(`${item.title} ${item.itemType || ''} ${item.category}`);
    return want.some((x) => have.includes(x));
  }
  function addWish(u, b) {
    const w = { id: `WL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, userId: u.id, email: u.email, name: u.name, category: String(b.category || '').trim() || 'Any',
      itemType: String(b.itemType || '').trim().slice(0, 80), quantity: Math.max(0, Math.round(num(b.quantity, 0))) || null, notes: String(b.notes || '').trim().slice(0, 500),
      status: 'Active', createdAt: new Date().toISOString() };
    db.wishlist.push(w); saveWishlist(); mail.wishAdded(w, u); audit(u, 'wishlist request', w.id, `${w.category}${w.itemType ? ' · ' + w.itemType : ''}`);
    // anything already in stock?
    for (const inv of db.inventory.filter(onSale)) if (wishMatches(w, inv)) { notifyWish(w, inv); break; }
    return w;
  }
  function notifyWish(w, inv) {
    const u = userById(w.userId); if (!u) return;
    w.status = 'Matched'; w.matchedSku = inv.sku; w.notifiedAt = new Date().toISOString(); saveWishlist();
    mail.wishMatched(w, u, inv, `${portal}/passport/${(matBySku(inv.sku) || {}).id || inv.sku}`);
    sendSms(u, `From your wishlist: ${inv.title}${inv.price ? ` — ${gbp(inv.price)} each` : ''}, ${inv.quantity} available. ${portal}/passport/${(matBySku(inv.sku) || {}).id || inv.sku}`);
    sys.alertsSentTotal = (sys.alertsSentTotal || 0) + 1; sys.alertsSentLog = [{ ts: new Date().toISOString(), email: u.email, item: inv.title }, ...(sys.alertsSentLog || [])].slice(0, 200); saveSystem();
  }
  function matchWishes(inv) { if (!onSale(inv)) return; for (const w of db.wishlist.filter((x) => x.status === 'Active')) if (wishMatches(w, inv)) notifyWish(w, inv); }

  /* =================================================================
     WEEKLY NEW-STOCK EMAIL (members who opted in)
     ================================================================= */
  async function weeklyStockMail(force = false) {
    const now = london();
    const weekKey = new Date().toISOString().slice(0, 10);
    if (!force && (now.weekday !== ENV.STOCK_MAIL_DAY || now.hour !== ENV.STOCK_MAIL_HOUR || sys.lastStockMail === weekKey)) return false;
    const items = db.inventory.filter((i) => onSale(i) && i.dateAdded && daysSince(i.dateAdded) <= 7);
    sys.lastStockMail = weekKey; saveSystem();
    if (!items.length) return false;
    for (const u of db.users.filter((x) => x.role !== 'admin' && !(x.notifications && x.notifications.newStock === false))) await mail.weeklyStock(u, items);
    return true;
  }

  /* =================================================================
     SCHEDULER + PAGES
     ================================================================= */
  // Community: installation photos due 30 days after collection — reminders at 14 and 28 days
  async function evidenceReminders() {
    for (const o of db.orders.filter((x) => x.evidenceRequired && x.status === 'Collected' && !(x.evidence && x.evidence.photos && x.evidence.photos.length) && x.collectedAt)) {
      const u = userById(o.userId); if (!u) continue;
      const age = Math.floor(daysSince(o.collectedAt));
      for (const day of [14, 28]) if (age >= day && !(o.evidenceReminded || []).includes(day)) {
        o.evidenceReminded = [...(o.evidenceReminded || []), day]; saveOrders();
        mail.evidenceReminder(u, o, Math.max(0, 30 - age));
        sendSms(u, `Reminder: please upload photos of ${o.id} installed at your registered address (${Math.max(0, 30 - age)} days left) — Orders & Collections in the marketplace.`);
      }
    }
  }
  async function runNow() {
    try { await pollSessions(); } catch (e) { console.error('  checkout poll:', e.message); }
    try { await evidenceReminders(); } catch (e) { console.error('  evidence reminders:', e.message); }
    try { await syncSubscriptions(); } catch (e) { console.error('  subscriptions:', e.message); }
    try { await weeklyStockMail(); } catch (e) { console.error('  stock mail:', e.message); }
  }
  features.hooks.stock = (mat, stock, actor) => upsertStock(mat, stock, actor);
  features.hooks.buyUrl = buyUrl;
  function start() {
    // Pending → Available (priority access is gone) and every stock item gets its passport's listing state
    let changed = false;
    db.inventory.forEach((i) => { if (i.status === 'Pending') { i.status = 'Available'; changed = true; } if (i.earlyAccess) { i.earlyAccess = false; changed = true; } });
    if (changed) saveInventory();
    console.log(`  commerce: checkout ${stripeOn ? 'on' : 'off — set STRIPE_SECRET_KEY'} · memberships ${stripeOn ? 'on (Stripe subscriptions)' : 'requests only'} · wishlist ${db.wishlist.length} entries`);
    if (stripeOn) ensurePrices().catch((e) => console.error('  stripe prices:', e.message));
    setTimeout(runNow, 40e3).unref();
    setInterval(runNow, 5 * 60e3).unref();
  }
  const page = (title, body) => `<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Material Reuse Group</title>
<link href="https://fonts.googleapis.com/css2?family=Geologica:wght@600;700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>body{margin:0;background:#06183F;font-family:Inter,Helvetica,Arial,sans-serif;color:#06183F;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box}
.card{background:#fff;border-radius:10px;max-width:520px;width:100%;overflow:hidden}.head{background:#06183F;padding:26px 32px;border-bottom:5px solid #9EFF51}.head img{height:44px}.body{padding:28px 32px}
h1{font-family:Geologica,Inter,sans-serif;font-size:22px;margin:0 0 12px}p{font-size:14px;line-height:1.6;color:#2A3655}.btn{display:inline-block;background:#1653F3;color:#fff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:13px 22px;border-radius:6px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 0;border-bottom:1px solid #DDE2EC}td:last-child{text-align:right}.foot{font-size:11px;color:#5E6B85;padding:0 32px 24px}</style></head>
<body><div class="card"><div class="head"><img src="/assets/mrg-logo-group-sm.png" alt="Material Reuse Group"></div><div class="body">${body}</div><div class="foot">Material Reuse Group · material-reuse.co.uk · 01932 867989</div></div></body></html>`;
  function orderCompletePage(r) {
    if (!r) return page('Payment received', `<h1>Payment received</h1><p>Thanks — Stripe has confirmed your payment. Your order will appear on your account within a few minutes, and you’ll get a confirmation email.</p><a class="btn" href="/">Open the portal</a>`);
    const o = r.order;
    return page('Order confirmed', `<h1>${o.depositGBP ? 'Reservation confirmed' : 'Order confirmed'}</h1><p>Thanks ${esc(r.user.name.split(' ')[0])} — order <b>${o.id}</b> is on your account.</p>
      <table>${o.items.map((l) => `<tr><td>${l.qty} × ${esc(l.title)}</td><td>${gbp(l.price * l.qty)}</td></tr>`).join('')}${o.depositGBP ? `<tr><td>Deposit paid</td><td>${gbp(o.depositGBP)}</td></tr><tr><td>Balance before collection</td><td>${gbp(o.balanceDueGBP)}</td></tr>` : `<tr><td>Paid</td><td>${gbp(o.total)}</td></tr>`}</table>
      <p>We’ll email${r.user.phone ? ' and text' : ''} you a collection slot. ${r.created ? `<b>We’ve created your portal account</b> — a welcome email with a temporary password is on its way to ${esc(r.user.email)}.` : ''}</p><a class="btn" href="/">Open the portal</a>`);
  }
  function signupCompletePage(r) {
    return page('Account created', r && r.user ? `<h1>Welcome to the Reuse Hub, ${esc(r.user.name.split(' ')[0])}</h1><p>Your <b>${esc((tierById(r.user.tier) || {}).name || '')}</b> is live and paid. Sign in with the email and password you chose.</p><a class="btn" href="/">Sign in</a>`
      : `<h1>Payment received</h1><p>Your account will be ready within a few minutes — sign in with the email and password you chose.</p><a class="btn" href="/">Sign in</a>`);
  }
  function membershipCompletePage(m) {
    return page('Membership updated', m ? `<h1>Welcome to ${esc(m.tierName)}</h1><p>Your membership is live${m.renews ? ` and renews on ${fmtDate(m.renews)}` : ''}. Your invoice is in Membership & Billing.</p><a class="btn" href="/">Open the portal</a>`
      : `<h1>Payment received</h1><p>Your membership will update within a few minutes.</p><a class="btn" href="/">Open the portal</a>`);
  }

  return { ENV, listing, publicListings, publicTiers, onSale, buyUrl, upsertStock, createCheckout, memberCheckout, creditInfo, isCommunity, evidenceOutstanding, startSignup, applySignupSession, signupCompletePage, completeSession, pollSessions, recordOrderSession,
    membershipView, changeMembership, cancelPending, decideCommunity, billingPortalUrl, syncSubscriptions, ensurePrices,
    addWish, matchWishes, notifyWish, weeklyStockMail, runNow, start, orderCompletePage, membershipCompletePage, page };
};
