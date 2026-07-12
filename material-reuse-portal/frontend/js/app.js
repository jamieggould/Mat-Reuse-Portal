/* =====================================================================
   material reuse — member portal (frontend app)
   ===================================================================== */

const API = '';
let state = { user: null, tier: null, page: 'dashboard' };

const $ = (sel) => document.querySelector(sel);
const fmtGBP = (n) => '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtKg = (n) => n >= 1000 ? (n / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' t' : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' kg';
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg) {
  const root = $('#toastRoot');
  root.innerHTML = `<div class="toast"><span class="dot"></span>${esc(msg)}</div>`;
  clearTimeout(root._t);
  root._t = setTimeout(() => (root.innerHTML = ''), 3200);
}

const statusPill = (s) => {
  const map = {
    'Reserved': 'pill-blue', 'Ready for collection': 'pill-green', 'Awaiting collection': 'pill-yellow',
    'Collected': 'pill-green', 'Delivered': 'pill-green', 'Passports issued': 'pill-navy',
    'Logged — emission assessment': 'pill-orange', 'Paid': 'pill-green', 'Overdue': 'pill-red',
    'Available': 'pill-green', 'Pending': 'pill-yellow',
    'In progress': 'pill-blue', 'Planning': 'pill-yellow', 'Complete': 'pill-green',
  };
  return `<span class="pill ${map[s] || 'pill-blue'}">${esc(s)}</span>`;
};

/* ---------------- login / session ---------------- */
async function initLogin() {
  const { users } = await api('/api/users');
  $('#accountList').innerHTML = users.map((u) => `
    <button class="account-btn" onclick="login('${u.id}')">
      <span class="avatar">${u.avatarInitials}</span>
      <span class="who"><b>${esc(u.name)}</b><span>${esc(u.organisation || u.email)}</span></span>
      <span class="tier-badge tier-${u.tier}">${esc(u.tierName)}</span>
    </button>`).join('');
}

async function login(id) {
  const { user, tier } = await api('/api/users/' + id);
  state.user = user; state.tier = tier;
  $('#login').style.display = 'none';
  $('#shell').classList.add('active');
  $('#topAvatar').textContent = user.avatarInitials;
  $('#tierBadge').textContent = tier.name;
  $('#tierBadge').className = 'tier-badge tier-' + tier.id;
  renderNav();
  go('dashboard');
}

function logout() {
  state = { user: null, tier: null, page: 'dashboard' };
  $('#shell').classList.remove('active');
  $('#login').style.display = 'flex';
}

/* ---------------- navigation ---------------- */
const PAGES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'warehouse', label: 'Online Warehouse' },
  { id: 'orders', label: 'Orders & Collections' },
  { id: 'lists', label: 'Shopping Lists' },
  { id: 'carbon', label: 'Carbon Reporting', gate: (g) => g.carbonReports },
  { id: 'projects', label: 'Projects & Audits', gate: (g) => g.projects },
  { id: 'membership', label: 'Membership & Billing' },
  { id: 'settings', label: 'Account Settings' },
];

function renderNav() {
  const g = state.tier.gates;
  $('#nav').innerHTML = PAGES.map((p) => {
    const locked = p.gate && !p.gate(g);
    return `<button data-page="${p.id}" class="${locked ? 'locked' : ''} ${state.page === p.id ? 'active' : ''}"
      onclick="go('${p.id}')">${p.label}</button>`;
  }).join('');
}

async function go(page) {
  state.page = page;
  renderNav();
  const meta = PAGES.find((p) => p.id === page);
  $('#pageTitle').textContent = meta.label;
  $('#pageCrumb').textContent = `Member portal / ${meta.label}`;
  $('#view').innerHTML = '<div class="empty">Loading…</div>';
  try { await RENDER[page](); } catch (e) { $('#view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}

function upgradeNote(feature, needed) {
  return `<div class="upgrade-note">
    <h3>${esc(feature)} is a ${esc(needed)} feature</h3>
    <p>Upgrade your membership to unlock ${esc(feature.toLowerCase())} — and keep more materials moving from ‘waste’ to worth.</p>
    <button class="btn btn-green" onclick="go('membership')">View membership options</button>
  </div>`;
}

/* ================= DASHBOARD ================= */
const RENDER = {};

RENDER.dashboard = async () => {
  const u = state.user, g = state.tier.gates;
  const [inv, ord, lst, prj] = await Promise.all([
    api('/api/inventory?userId=' + u.id),
    api('/api/orders?userId=' + u.id),
    api('/api/lists?userId=' + u.id),
    g.projects ? api('/api/projects?userId=' + u.id) : Promise.resolve({ projects: [] }),
  ]);
  const active = ord.orders.filter((o) => !['Collected', 'Delivered', 'Passports issued'].includes(o.status));
  const newest = [...inv.items].sort((a, b) => b.dateAdded.localeCompare(a.dateAdded)).slice(0, 4);

  $('#view').innerHTML = `
    <div class="tagline-strip">
      <span>Welcome back, ${esc(u.name.split(' ')[0])} — from ‘waste’ to worth.</span>
      <button class="btn btn-green btn-sm" onclick="go('warehouse')">Browse the warehouse</button>
    </div>

    <div class="grid cols-4" style="margin-top:18px">
      <div class="card stat"><span class="stripe" style="background:var(--green)"></span>
        <div class="lbl">Carbon saved</div><div class="big">${fmtKg(u.carbonSavedKg)} <span style="font-size:14px">CO₂e</span></div>
        <div class="sub">${g.carbonReports === 'verified' ? 'Verified by Alphacello' : 'Estimated from product passports'}</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--azul)"></span>
        <div class="lbl">Items rehomed</div><div class="big">${u.itemsRehomed.toLocaleString('en-GB')}</div>
        <div class="sub">Diverted from the waste stream</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--yellow)"></span>
        <div class="lbl">Active orders</div><div class="big">${active.length}</div>
        <div class="sub">${active[0] ? esc(active[0].slot) : 'No upcoming slots'}</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--orange)"></span>
        <div class="lbl">Shopping lists</div><div class="big">${lst.lists.length}</div>
        <div class="sub">${g.shoppingListLimit === null ? 'Unlimited on your plan' : `${lst.lists.length} of ${g.shoppingListLimit} on Domestic Free Membership`}</div></div>
    </div>

    <h3 class="section-title">New in the warehouse ${inv.earlyAccessVisible ? '<span class="pill pill-green">Priority stock access active</span>' : ''}</h3>
    <div class="item-grid">${newest.map(itemCard).join('')}</div>

    <div class="grid cols-2" style="margin-top:28px">
      <div class="card">
        <h3 style="margin-bottom:12px">Next collections & deliveries</h3>
        ${active.length ? active.slice(0, 3).map((o) => `
          <div class="doc-row">
            <span class="t">${esc(o.id)} — ${esc(o.fulfilment)}<span>${esc(o.slot)}</span></span>
            ${statusPill(o.status)}</div>`).join('') : '<div class="empty">Nothing scheduled — browse the warehouse to get started.</div>'}
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px">${g.projects ? 'Your projects' : 'Why membership matters'}</h3>
        ${g.projects
          ? (prj.projects.length ? prj.projects.slice(0, 3).map((p) => `
              <div class="doc-row">
                <span class="t">${esc(p.name)}<span>${esc(p.type)} · target ${fmtDate(p.target)}</span></span>
                ${statusPill(p.status)}</div>`).join('') : '<div class="empty">No projects yet.</div>')
          : `<p class="small muted" style="margin-bottom:14px">Every reused item keeps embodied carbon locked in and materials out of landfill. Upgrade to unlock carbon reports, project workspaces and more.</p>
             <button class="btn btn-primary btn-sm" onclick="go('membership')">Explore membership tiers</button>`}
      </div>
    </div>`;
};

/* ================= WAREHOUSE ================= */
function itemCard(i) {
  return `<div class="item-card">
    <div class="item-thumb"><span class="thumb-cat">${esc(i.category)}</span>
      <span class="early">${statusPill(i.status)}</span>
      <span class="qty">×${i.quantity.toLocaleString('en-GB')}</span>
    </div>
    <div class="item-body">
      <h4>${esc(i.title)}</h4>
      <div class="item-meta">${esc(i.category)} · ${esc(i.fulfilment)}</div>
      <div class="item-carbon">${i.carbonSavedKgPerUnit} kg CO₂e saved</div>
      <div class="item-foot">
        <div class="item-price">${fmtGBP(i.price)} <span>${esc(i.priceUnit)}</span></div>
        <button class="btn btn-ghost btn-sm" onclick="openPassport('${i.sku}')">Passport</button>
      </div>
    </div>
  </div>`;
}

RENDER.warehouse = async () => {
  $('#view').innerHTML = `
    <h3 class="section-title">Online warehouse</h3>
    <div style="position:relative;">
  <iframe src="https://mariela66454.softr.app"
          width="100%" height="1300" frameborder="0"
          style="border:none; display:block;"></iframe>
  <div style="position:absolute; bottom:0; left:0;
              width:210px; height:64px; background:#ffffff;"></div>
</div>
    <div class="card" style="margin-top:28px">
      <h3 style="margin-bottom:6px">Can’t see what you need? Join the wishlist</h3>
      <p class="small muted" style="margin-bottom:14px">Tell us what you’re after and we’ll let you know when it comes through a strip-out.</p>
      <iframe class="airtable-embed" src="https://airtable.com/embed/appiHCw9vidbsic9y/pagMtURovTN6nNryp/form?prefill_Status=Active&hide_Status=true" frameborder="0" onmousewheel="" width="100%" height="720" style="background: transparent; border: 1px solid #ccc;"></iframe>
    </div>`;
};

/* ---- product passport modal ---- */
function fakeQR() {
  let cells = '';
  for (let i = 0; i < 49; i++) cells += `<i class="${Math.random() > 0.52 ? '' : 'w'}"></i>`;
  return `<span class="qr-grid">${cells}</span>`;
}

async function openPassport(sku) {
  const { item: i } = await api('/api/inventory/' + sku);
  const g = state.tier.gates;
  const reservable = i.status === 'Available' || (i.status === 'Pending' && g.earlyAccess);
  const canReserve = g.reservations && reservable && i.quantity > 0;
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="close" onclick="closeModal()">✕</button>
      ${statusPill(i.status)} <span class="pill ${i.passportVerified ? 'pill-green' : 'pill-yellow'}">${i.passportVerified ? '✓ Product passport verified' : 'Passport being finalised'}</span>
      <div class="passport-head" style="margin-top:14px">
        <div class="passport-tile">${esc(i.category)}</div>
        <div><h3 style="font-size:17px;line-height:1.3">${esc(i.title)}</h3>
        <p class="small muted">${esc(i.category)} · SKU ${esc(i.sku)}</p></div>
      </div>
      <div class="passport-grid">
        <div class="f"><b>Availability</b><span>${esc(i.status)}</span></div>
        <div class="f"><b>Quantity</b><span>${i.quantity.toLocaleString('en-GB')}</span></div>
        <div class="f"><b>Price</b><span>${fmtGBP(i.price)} ${esc(i.priceUnit)}</span></div>
        <div class="f"><b>Fulfilment</b><span>${esc(i.fulfilment)}</span></div>
        <div class="f"><b>Category</b><span>${esc(i.category)}</span></div>
        <div class="f"><b>Carbon saved by reuse</b><span style="color:#1d7a05;font-weight:700">${i.carbonSavedKgPerUnit} kg CO₂e</span></div>
      </div>
      ${i.status === 'Pending' ? '<p class="small muted">Pending — this item is from a recent strip-out and is being processed into the warehouse. Visible early thanks to Priority Stock Access.</p>' : ''}
      ${i.status === 'Reserved' ? '<p class="small muted">Reserved — this item is already reserved by another member.</p>' : ''}
      <div class="qr-box">${fakeQR()}
        <div><b style="font-family:var(--font-head)">${esc(i.qrCode)}</b><br>
        <span class="small" style="color:#B9C6E4">Scan on site to trace this item’s full material lifecycle.</span></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
        <button class="btn btn-primary" ${canReserve ? '' : 'disabled'} onclick="reserveItem('${i.sku}')">
          ${!g.reservations ? 'Reserving requires Domestic Plus' : reservable ? 'Reserve this item' : 'Not currently reservable'}</button>
        <button class="btn btn-green" onclick="addToListPrompt('${i.sku}')">Add to shopping list</button>
      </div>
    </div>
  </div>`;
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

async function reserveItem(sku) {
  const qty = parseInt(prompt('How many would you like to reserve?', '1'), 10);
  if (!qty || qty < 1) return;
  try {
    const { order } = await api('/api/orders', { method: 'POST', body: { userId: state.user.id, items: [{ sku, qty }] } });
    closeModal();
    toast(`Reserved — order ${order.id} created`);
  } catch (e) { toast(e.message); }
}

async function addToListPrompt(sku) {
  const { lists } = await api('/api/lists?userId=' + state.user.id);
  if (!lists.length) { toast('Create a shopping list first'); go('lists'); closeModal(); return; }
  const names = lists.map((l, n) => `${n + 1}. ${l.name}`).join('\n');
  const pick = parseInt(prompt(`Add to which list?\n${names}`, '1'), 10);
  const list = lists[pick - 1];
  if (!list) return;
  const qty = parseInt(prompt('Quantity?', '1'), 10) || 1;
  await api(`/api/lists/${list.id}/items`, { method: 'POST', body: { sku, qty } });
  closeModal();
  toast(`Added to “${list.name}”`);
}

/* ================= ORDERS ================= */
RENDER.orders = async () => {
  const { orders } = await api('/api/orders?userId=' + state.user.id);
  const buys = orders.filter((o) => o.type !== 'donation');
  const dons = orders.filter((o) => o.type === 'donation');
  const orderBlock = (o) => `
    <div class="card order-card">
      <div class="order-head">
        <div><h4>${esc(o.id)}</h4>
          <div class="meta">Placed ${fmtDate(o.placed)} · ${esc(o.fulfilment)}</div></div>
        ${statusPill(o.status)}
      </div>
      <div class="order-lines">${o.items.map((l) => `${l.qty} × ${esc(l.title)}`).join(' &nbsp;·&nbsp; ')}</div>
      <div class="order-foot">
        <span><span class="k">Slot</span><b>${esc(o.slot)}</b></span>
        ${o.total ? `<span><span class="k">Total</span><b>${fmtGBP(o.total)}</b>${o.deliveryFee ? ` <span class="muted small">(+${fmtGBP(o.deliveryFee)} delivery)</span>` : ''}</span>` : ''}
        ${o.memberDiscount ? `<span class="pill pill-green">member discount −${fmtGBP(o.memberDiscount)}</span>` : ''}
        <span><span class="k">Carbon saved</span><b>${fmtKg(o.carbonSavedKg)} CO₂e</b></span>
      </div>
      ${o.note ? `<p class="small muted" style="margin-top:8px">${esc(o.note)}</p>` : ''}
    </div>`;

  $('#view').innerHTML = `
    ${buys.length ? buys.map(orderBlock).join('') : '<div class="card"><div class="empty">No orders yet — reserve items from the online warehouse.</div></div>'}
    ${dons.length ? `<h3 class="section-title">Donation lots (materials you’ve sent us)</h3>${dons.map(orderBlock).join('')}` : ''}
    <div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:8px">Collections</h3>
      <p class="small muted">All collections are from our central London facility. Bring your order reference and QR codes will be scanned on handover. Need a hand loading? Call 01932 867989.</p>
    </div>`;
};

/* ================= SHOPPING LISTS ================= */
RENDER.lists = async () => {
  const { lists } = await api('/api/lists?userId=' + state.user.id);
  const g = state.tier.gates;
  const canAdd = g.shoppingListLimit === null || lists.length < g.shoppingListLimit;
  $('#view').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <p class="small muted">Plan each project’s materials, check live stock and see the carbon you’ll save.</p>
      <button class="btn btn-primary" ${canAdd ? '' : 'disabled'} onclick="newList()">New project list</button>
    </div>
    ${g.shoppingListLimit !== null ? `<p class="small" style="margin-bottom:14px"><span class="pill pill-yellow">Domestic Free</span> includes ${g.shoppingListLimit} list — upgrade for unlimited.</p>` : ''}
    ${lists.length ? lists.map((l) => {
      const total = l.items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
      const carbon = l.items.reduce((s, i) => s + (i.carbon || 0), 0);
      return `<div class="card" style="margin-bottom:16px">
        <div class="order-head">
          <div><h4>${esc(l.name)}</h4><div class="meta">Created ${fmtDate(l.created)} · ${l.items.length} line${l.items.length === 1 ? '' : 's'}</div></div>
          <div style="text-align:right"><b style="font-family:var(--font-head)">${fmtGBP(total)}</b><br><span class="small" style="color:var(--green-dark)">${fmtKg(carbon)} CO₂e saved</span></div>
        </div>
        ${l.items.length ? `<table><tr><th>Item</th><th>Qty</th><th>Est. cost</th><th>Stock</th><th></th></tr>
          ${l.items.map((i) => `<tr>
            <td>${esc(i.title || i.sku)}</td>
            <td>${i.qty}</td>
            <td>${fmtGBP((i.price || 0) * i.qty)}</td>
            <td>${i.inStock ? '<span class="pill pill-green">In stock</span>' : '<span class="pill pill-red">Short</span>'}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="removeFromList('${l.id}','${i.sku}')">Remove</button></td>
          </tr>`).join('')}</table>` : '<div class="empty">Empty list — add items from the warehouse.</div>'}
      </div>`;
    }).join('') : '<div class="card"><div class="empty">No lists yet.</div></div>'}`;
};

async function newList() {
  const name = prompt('Name your project list:', 'My reuse project');
  if (!name) return;
  try {
    await api('/api/lists', { method: 'POST', body: { userId: state.user.id, name } });
    toast('List created'); go('lists');
  } catch (e) { toast(e.message); }
}

async function removeFromList(listId, sku) {
  await api(`/api/lists/${listId}/items/${sku}`, { method: 'DELETE' });
  go('lists');
}

/* ================= CARBON ================= */
RENDER.carbon = async () => {
  const g = state.tier.gates;
  if (!g.carbonReports) {
    $('#view').innerHTML = upgradeNote('Carbon reporting', 'Domestic Plus Membership');
    return;
  }
  const { report: r } = await api('/api/carbon?userId=' + state.user.id);
  const max = Math.max(...r.monthly.map((m) => m.kg), 1);
  const maxCat = Math.max(...r.byCategory.map((c) => c.kg), 1);
  const monthName = (m) => new Date(m + '-01').toLocaleDateString('en-GB', { month: 'short' });

  $('#view').innerHTML = `
    <div class="grid cols-3">
      <div class="card stat"><span class="stripe" style="background:var(--green)"></span>
        <div class="lbl">Total CO₂e avoided</div><div class="big">${fmtKg(r.totalSavedKg)}</div>
        <div class="sub">${r.verified ? `✓ Verified — ${esc(r.verifier)}` : 'Estimated from product passport data'}</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--azul)"></span>
        <div class="lbl">Equivalent car miles</div><div class="big">${r.equivalents.carMiles.toLocaleString('en-GB')}</div>
        <div class="sub">Average petrol car emissions</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--yellow)"></span>
        <div class="lbl">Tree-years of absorption</div><div class="big">${r.equivalents.treeYears.toLocaleString('en-GB')}</div>
        <div class="sub">Mature broadleaf equivalent</div></div>
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <div class="card">
        <h3 style="margin-bottom:6px">Monthly savings (kg CO₂e)</h3>
        <div class="bar-chart">
          ${r.monthly.map((m) => `<div class="bar">
            <span>${m.kg ? fmtKg(m.kg) : ''}</span>
            <i style="height:${Math.max(3, (m.kg / max) * 100)}%"></i>
            <b>${monthName(m.month)}</b></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:14px">Savings by material category</h3>
        ${r.byCategory.map((c) => `<div class="cat-row">
          <span class="name">${esc(c.category)}</span>
          <span class="track"><span class="fill" style="width:${(c.kg / maxCat) * 100}%"></span></span>
          <span class="val">${fmtKg(c.kg)}</span></div>`).join('')}
      </div>
    </div>

    ${r.wlcaModules ? `<div class="card" style="margin-top:18px">
      <h3 style="margin-bottom:10px">WLCA module breakdown (kg CO₂e)</h3>
      <table><tr><th>Module</th><th>Impact</th></tr>
        ${Object.entries(r.wlcaModules).map(([k, v]) => `<tr><td>${esc(k)}</td>
          <td style="font-weight:700;color:${v < 0 ? '#B42318' : '#1d7a05'}">${v < 0 ? '+' : '−'}${fmtKg(Math.abs(v))}</td></tr>`).join('')}</table>
      <p class="small muted" style="margin-top:10px">A1–A3 manufacture avoided by reuse; A4 transport added; Module D end-of-life benefits. Suitable for BREEAM Mat 06 / GLA circular economy reporting.</p>
    </div>` : ''}

    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
      ${g.carbonReports === 'full' || g.carbonReports === 'verified'
        ? `<button class="btn btn-primary" onclick="toast('Report queued — a PDF will land in your inbox shortly')">Download ${g.carbonReports === 'verified' ? 'verified' : ''} carbon report (PDF)</button>`
        : `<button class="btn btn-ghost" disabled>Downloadable reports — Community tier and above</button>`}
    </div>`;
};

/* ================= PROJECTS & AUDITS ================= */
RENDER.projects = async () => {
  const g = state.tier.gates;
  if (!g.projects) {
    $('#view').innerHTML = upgradeNote('Projects & audits', 'Community Free Membership');
    return;
  }
  const { projects } = await api('/api/projects?userId=' + state.user.id);
  $('#view').innerHTML = `
    ${g.audits ? `<div class="tagline-strip" style="margin-bottom:18px">
      <span>Need a GLA-compliant pre-demolition audit? Your partner rate includes Lawmens strip-out at 5% off.</span>
      <button class="btn btn-green btn-sm" onclick="toast('Request sent — your account manager will be in touch within one working day')">Request an audit</button>
    </div>` : ''}
    ${projects.length ? projects.map((p) => `
      <div class="card proj-card">
        <div class="order-head">
          <div><h4>${esc(p.name)}</h4>
            <div class="meta">${esc(p.type)}${p.auditRef ? ` · Audit ref ${esc(p.auditRef)}` : ''} · ${fmtDate(p.started)} → ${fmtDate(p.target)}</div></div>
          ${statusPill(p.status)}
        </div>
        <p class="small" style="margin:6px 0 2px">${esc(p.summary)}</p>
        <div class="progress"><i style="width:${p.progress}%"></i></div>
        <div class="small muted">${p.progress}% complete ${p.carbonSavedKg ? ` · ${fmtKg(p.carbonSavedKg)} CO₂e saved so far` : ''}</div>
        ${p.documents.length ? `<h4 style="font-size:13px;margin:14px 0 4px">Documents</h4>
          ${p.documents.map((d) => `<div class="doc-row">
            <span class="t">${esc(d.name)}<span>${esc(d.type)} · ${fmtDate(d.date)}</span></span>
            <button class="btn btn-ghost btn-sm" onclick="toast('Downloading ${esc(d.name)}…')">Download</button></div>`).join('')}` : ''}
      </div>`).join('') : '<div class="card"><div class="empty">No projects yet.</div></div>'}`;
};

/* ================= MEMBERSHIP & BILLING ================= */
RENDER.membership = async () => {
  const u = state.user;
  $('#view').innerHTML = `
    <h3 class="section-title">Membership plans</h3>
<!-- ============================================================
     Material Reuse — Softr pricing embed
     Paste this whole block into a WordPress "Custom HTML" block.
     HOW TO TUNE (only one number usually matters):
     - --crop  = how tall the visible area is. Raise/lower this so
                 it ends just after the "Enquire" buttons with a
                 neat gap. Everything below (incl. the Softr badge)
                 is hidden.
     - The white mask at bottom-left is a belt-and-braces cover for
       the "Made with softr" logo in case it ever peeks through.
     ============================================================ -->
<div class="mr-embed">
  <iframe
    class="mr-embed__frame"
    src="https://jonah4725.softr.app/"
    title="Membership pricing and enquiry"
    loading="lazy"
    allow="clipboard-write"
    referrerpolicy="strict-origin-when-cross-origin">
  </iframe>
  <!-- white block that hides the "Made with softr" badge (bottom-left) -->
  <div class="mr-embed__mask"></div>
</div>
<style>
  .mr-embed {
    --crop: 1020px;      /* <-- MAIN DIAL: ends just after the Enquire buttons */
    position: relative;
    width: 100%;
    max-width: 1200px;   /* overall width on desktop */
    height: var(--crop);
    margin: 0 auto;
    overflow: hidden;    /* crops off the whitespace + Softr badge below */
  }
  .mr-embed__frame {
    width: 100%;
    height: 1400px;      /* taller than --crop so the buttons fully render */
    border: 0;
    display: block;
  }
  .mr-embed__mask {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 240px;        /* covers the bottom-left Softr logo */
    height: 80px;
    background: #ffffff;
    pointer-events: none;
  }
  @media (max-width: 600px) {
    .mr-embed { --crop: 1750px; }   /* columns stack, so it's taller on mobile */
    .mr-embed__frame { height: 1800px; }
  }
</style>
    <h3 class="section-title" style="margin-top:32px">Billing</h3>
    <div class="grid cols-2">
      <div class="card">
        <h3 style="margin-bottom:10px">Payment</h3>
        <p><b>Method:</b> ${esc(u.billing.method || 'None — free plan')}</p>
        <p><b>Next payment:</b> ${u.billing.nextPayment ? fmtDate(u.billing.nextPayment) : '—'}</p>
        ${state.user.accountManager ? `<p style="margin-top:10px"><b>Account manager:</b> ${esc(u.accountManager.name)} · <a href="mailto:${esc(u.accountManager.email)}">${esc(u.accountManager.email)}</a> · ${esc(u.accountManager.phone)}</p>` : ''}
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px">Invoices</h3>
        ${u.billing.invoices.length ? `<table><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th></tr>
          ${u.billing.invoices.map((i) => `<tr><td>${esc(i.id)}<br><span class="small muted">${esc(i.desc)}</span></td>
            <td>${fmtDate(i.date)}</td><td>${fmtGBP(i.amount)}</td><td>${statusPill(i.status)}</td></tr>`).join('')}</table>`
          : '<div class="empty">No invoices — you’re on the free plan.</div>'}
      </div>
    </div>`;
};

/* ================= SETTINGS ================= */
RENDER.settings = async () => {
  const u = state.user;
  const n = u.notifications;
  $('#view').innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3 style="margin-bottom:16px">Profile</h3>
        <div class="form-grid">
          <div><label>Full name</label><input id="sName" value="${esc(u.name)}"></div>
          <div><label>Email</label><input id="sEmail" value="${esc(u.email)}"></div>
          <div><label>Phone</label><input id="sPhone" value="${esc(u.phone || '')}"></div>
          <div><label>Organisation</label><input id="sOrg" value="${esc(u.organisation || '')}" placeholder="—"></div>
          <div style="grid-column:1/-1"><label>Address</label><input id="sAddr" value="${esc(u.address || '')}"></div>
        </div>
        <button class="btn btn-primary" style="margin-top:16px" onclick="saveProfile()">Save changes</button>
      </div>
      <div>
        <div class="card">
          <h3 style="margin-bottom:6px">Notifications</h3>
          ${[['newStock', 'New stock alerts', 'Be first to know when materials land'],
             ['orderUpdates', 'Order & collection updates', 'Slot confirmations and reminders'],
             ['newsletter', 'Monthly reuse newsletter', 'Impact stories and member offers']]
            .map(([k, t, s]) => `<div class="toggle-row">
              <span class="t"><b>${t}</b><span>${s}</span></span>
              <button class="switch ${n[k] ? 'on' : ''}" onclick="toggleNotif('${k}',this)"></button>
            </div>`).join('')}
        </div>
        <div class="card" style="margin-top:16px">
          <h3 style="margin-bottom:8px">Membership</h3>
          <p class="small">Member since <b>${fmtDate(u.memberSince)}</b> on <b>${esc(state.tier.name)}</b>.</p>
          <p class="small muted" style="margin-top:6px">Questions? Call 01932 867989 or email hello@material-reuse.co.uk.</p>
        </div>
      </div>
    </div>`;
};

async function saveProfile() {
  const body = { name: $('#sName').value, email: $('#sEmail').value, phone: $('#sPhone').value,
                 organisation: $('#sOrg').value || null, address: $('#sAddr').value };
  const { user } = await api('/api/users/' + state.user.id, { method: 'PATCH', body });
  state.user = user;
  $('#topAvatar').textContent = user.avatarInitials;
  toast('Profile saved');
}

async function toggleNotif(key, el) {
  el.classList.toggle('on');
  await api('/api/users/' + state.user.id, { method: 'PATCH', body: { notifications: { [key]: el.classList.contains('on') } } });
  toast('Preferences updated');
}

/* ---------------- boot ---------------- */
initLogin();
