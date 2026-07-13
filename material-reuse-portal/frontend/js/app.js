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

let TOKEN = localStorage.getItem('mrToken') || null;
function setToken(t) {
  TOKEN = t;
  if (t) localStorage.setItem('mrToken', t); else localStorage.removeItem('mrToken');
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/api/auth/login') {
    setToken(null); showLogin();
    throw new Error('Session expired — please sign in again.');
  }
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
function showLogin() {
  state = { user: null, tier: null, page: 'dashboard' };
  $('#shell').classList.remove('active');
  $('#login').style.display = 'flex';
}

async function doLogin(ev) {
  ev.preventDefault();
  const btn = $('#loginBtn'), err = $('#loginError');
  btn.disabled = true; btn.textContent = 'Signing in…'; err.classList.remove('show');
  try {
    const { token, user, tier } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: $('#loginEmail').value, password: $('#loginPassword').value },
    });
    setToken(token);
    $('#loginPassword').value = '';
    enterApp(user, tier);
  } catch (e) {
    err.textContent = e.message; err.classList.add('show');
  }
  btn.disabled = false; btn.textContent = 'Sign in';
}

function enterApp(user, tier) {
  state.user = user; state.tier = tier;
  $('#login').style.display = 'none';
  $('#shell').classList.add('active');
  const badge = $('#tierBadge');
  if (user.role === 'admin') { badge.textContent = 'Portal admin'; badge.className = 'tier-badge'; }
  else { badge.textContent = tier.name; badge.className = 'tier-badge tier-' + tier.id; }
  renderNav();
  go(user.role === 'admin' ? 'adminOverview' : 'dashboard');
  if (user.mustChange) toast('You’re on a temporary password — change it in Account Settings');
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* already out */ }
  setToken(null);
  showLogin();
}

/* ---------------- navigation ---------------- */
const PAGES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'warehouse', label: 'Online Warehouse' },
  { id: 'orders', label: 'Orders & Collections' },
  { id: 'lists', label: 'Shopping Lists' },
  { id: 'projects', label: 'Projects & Audits', gate: (g) => g.projects },
  { id: 'membership', label: 'Membership & Billing' },
  { id: 'settings', label: 'Account Settings' },
];

const ADMIN_PAGES = [
  { id: 'adminOverview', label: 'Overview' },
  { id: 'adminMembers', label: 'Members' },
  { id: 'warehouse', label: 'Online Warehouse' },
  { id: 'settings', label: 'Account Settings' },
];

const HIDDEN_PAGES = { adminMember: { id: 'adminMember', label: 'Member account' } };

const pagesFor = () => (state.user && state.user.role === 'admin' ? ADMIN_PAGES : PAGES);

function renderNav() {
  const g = state.tier ? state.tier.gates : {};
  $('#nav').innerHTML = pagesFor().map((p) => {
    const locked = p.gate && !p.gate(g);
    return `<button data-page="${p.id}" class="${locked ? 'locked' : ''} ${state.page === p.id ? 'active' : ''}"
      onclick="go('${p.id}')">${p.label}</button>`;
  }).join('');
}

async function go(page) {
  state.page = page;
  renderNav();
  const meta = pagesFor().find((p) => p.id === page) || HIDDEN_PAGES[page];
  $('#pageTitle').textContent = meta.label;
  $('#pageCrumb').textContent = `${state.user && state.user.role === 'admin' ? 'Admin portal' : 'Member portal'} / ${meta.label}`;
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
  const [ord, lst, prj, crb] = await Promise.all([
    api('/api/orders?userId=' + u.id),
    api('/api/lists?userId=' + u.id),
    g.projects ? api('/api/projects?userId=' + u.id) : Promise.resolve({ projects: [] }),
    g.carbonReports ? api('/api/carbon?userId=' + u.id) : Promise.resolve(null),
  ]);
  const active = ord.orders.filter((o) => !['Collected', 'Delivered', 'Passports issued'].includes(o.status));

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
    </div>

    ${crb ? carbonSection(crb.report, g) : ''}`;
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

/* ================= CARBON (shown on the dashboard) ================= */
function carbonSection(r, g) {
  const max = Math.max(...r.monthly.map((m) => m.kg), 1);
  const maxCat = Math.max(...r.byCategory.map((c) => c.kg), 1);
  const monthName = (m) => new Date(m + '-01').toLocaleDateString('en-GB', { month: 'short' });

  return `
    <h3 class="section-title" style="margin-top:32px">Carbon reporting</h3>
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
}

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
      <div>
        <div class="card">
          <h3 style="margin-bottom:16px">Profile</h3>
          <div class="form-grid">
            <div><label>Full name</label><input id="sName" value="${esc(u.name)}"></div>
            <div><label>Email (sign-in)</label><input id="sEmail" value="${esc(u.email)}" disabled title="Contact the Material Reuse team to change your sign-in email"></div>
            <div><label>Phone</label><input id="sPhone" value="${esc(u.phone || '')}"></div>
            <div><label>Organisation</label><input id="sOrg" value="${esc(u.organisation || '')}" placeholder="—"></div>
            <div style="grid-column:1/-1"><label>Address</label><input id="sAddr" value="${esc(u.address || '')}"></div>
          </div>
          <button class="btn btn-primary" style="margin-top:16px" onclick="saveProfile()">Save changes</button>
        </div>
        <div class="card" style="margin-top:16px">
          <h3 style="margin-bottom:6px">Password</h3>
          ${u.mustChange ? '<p class="small" style="color:#B42318;margin-bottom:10px">You’re using a temporary password — please set your own now.</p>' : ''}
          <div class="form-grid">
            <div style="grid-column:1/-1"><label>Current password</label><input id="pwCurrent" type="password" autocomplete="current-password"></div>
            <div><label>New password</label><input id="pwNext" type="password" autocomplete="new-password"></div>
            <div><label>Confirm new password</label><input id="pwConfirm" type="password" autocomplete="new-password"></div>
          </div>
          <button class="btn btn-primary" style="margin-top:16px" onclick="changePassword()">Update password</button>
        </div>
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
          <h3 style="margin-bottom:8px">${u.role === 'admin' ? 'Account' : 'Membership'}</h3>
          <p class="small">${u.role === 'admin'
            ? `Portal administrator since <b>${fmtDate(u.memberSince)}</b>.`
            : `Member since <b>${fmtDate(u.memberSince)}</b> on <b>${esc(state.tier.name)}</b>.`}</p>
          <p class="small muted" style="margin-top:6px">Questions? Call 01932 867989 or email hello@material-reuse.co.uk.</p>
        </div>
      </div>
    </div>`;
};

async function saveProfile() {
  const body = { name: $('#sName').value, phone: $('#sPhone').value,
                 organisation: $('#sOrg').value || null, address: $('#sAddr').value };
  const { user } = await api('/api/users/' + state.user.id, { method: 'PATCH', body });
  state.user = { ...state.user, ...user };
  toast('Profile saved');
}

async function changePassword() {
  const current = $('#pwCurrent').value, next = $('#pwNext').value, confirm = $('#pwConfirm').value;
  if (!next || next.length < 8) return toast('New password must be at least 8 characters');
  if (next !== confirm) return toast('New passwords don’t match');
  try {
    await api('/api/auth/password', { method: 'POST', body: { current, next } });
    state.user.mustChange = false;
    toast('Password updated');
    go('settings');
  } catch (e) { toast(e.message); }
}

async function toggleNotif(key, el) {
  el.classList.toggle('on');
  await api('/api/users/' + state.user.id, { method: 'PATCH', body: { notifications: { [key]: el.classList.contains('on') } } });
  toast('Preferences updated');
}

/* ================= ADMIN — OVERVIEW ================= */
let ADMIN = { members: [], admins: [], tiers: [] };

RENDER.adminOverview = async () => {
  ADMIN = await api('/api/admin/members');
  const m = ADMIN.members;
  const totCarbon = m.reduce((s, x) => s + (x.carbonSavedKg || 0), 0);
  const totItems = m.reduce((s, x) => s + (x.itemsRehomed || 0), 0);
  const totOrders = m.reduce((s, x) => s + (x.orders || 0), 0);
  $('#view').innerHTML = `
    <div class="tagline-strip">
      <span>Monitoring ${m.length} member account${m.length === 1 ? '' : 's'} — from ‘waste’ to worth.</span>
      <button class="btn btn-green btn-sm" onclick="go('adminMembers')">Manage members</button>
    </div>

    <div class="grid cols-4" style="margin-top:18px">
      <div class="card stat"><span class="stripe" style="background:var(--azul)"></span>
        <div class="lbl">Member accounts</div><div class="big">${m.length}</div>
        <div class="sub">Across all tiers</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--green)"></span>
        <div class="lbl">Total carbon saved</div><div class="big">${fmtKg(totCarbon)} <span style="font-size:14px">CO₂e</span></div>
        <div class="sub">All members combined</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--yellow)"></span>
        <div class="lbl">Items rehomed</div><div class="big">${totItems.toLocaleString('en-GB')}</div>
        <div class="sub">Diverted from the waste stream</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--orange)"></span>
        <div class="lbl">Orders placed</div><div class="big">${totOrders}</div>
        <div class="sub">Reservations & donation lots</div></div>
    </div>

    <div class="card" style="margin-top:28px">
      <h3 style="margin-bottom:12px">All members</h3>
      ${m.length ? `<table>
        <tr><th>Member</th><th>Tier</th><th>Carbon saved</th><th>Items</th><th>Orders</th><th>Since</th><th></th></tr>
        ${m.map((x) => `<tr>
          <td><b>${esc(x.name)}</b><br><span class="small muted">${esc(x.organisation || x.email)}</span></td>
          <td><span class="tier-badge tier-${esc(x.tier)}" style="font-size:10px;padding:5px 9px">${esc(x.tierName)}</span></td>
          <td>${fmtKg(x.carbonSavedKg || 0)}</td>
          <td>${(x.itemsRehomed || 0).toLocaleString('en-GB')}</td>
          <td>${x.orders}</td>
          <td>${fmtDate(x.memberSince)}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="openMember('${x.id}')">Manage</button></td>
        </tr>`).join('')}</table>` : '<div class="empty">No member accounts yet — create one on the Members page.</div>'}
    </div>

    <div class="card" style="margin-top:16px">
      <h3 style="margin-bottom:12px">Admin accounts</h3>
      ${ADMIN.admins.map((a) => `<div class="doc-row">
        <span class="t">${esc(a.name)}<span>${esc(a.email)}</span></span>
        <span class="pill pill-navy">Admin</span></div>`).join('')}
      <p class="small muted" style="margin-top:10px">Accounts can only be created by admins — there is no public sign-up.</p>
    </div>`;
};

/* ================= ADMIN — MEMBERS ================= */
RENDER.adminMembers = async () => {
  ADMIN = await api('/api/admin/members');
  const tierOpts = ADMIN.tiers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('#view').innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:6px">Create a member account</h3>
      <p class="small muted" style="margin-bottom:14px">This is the only way accounts are created — members can’t register themselves. Share the temporary password securely; they’ll be prompted to change it on first sign-in.</p>
      <div class="form-grid">
        <div><label>Full name</label><input id="nmName"></div>
        <div><label>Email (sign-in)</label><input id="nmEmail" type="email"></div>
        <div><label>Temporary password (min 8 chars)</label><input id="nmPw"></div>
        <div><label>Membership tier</label><select id="nmTier">${tierOpts}</select></div>
        <div><label>Organisation</label><input id="nmOrg" placeholder="Optional"></div>
        <div><label>Phone</label><input id="nmPhone" placeholder="Optional"></div>
        <div style="grid-column:1/-1"><label>Address</label><input id="nmAddr" placeholder="Optional"></div>
      </div>
      <button class="btn btn-primary" style="margin-top:16px" onclick="createMember()">Create account</button>
    </div>

    <h3 class="section-title" style="margin-top:28px">Member accounts</h3>
    ${ADMIN.members.length ? ADMIN.members.map(memberRow).join('') : '<div class="card"><div class="empty">No members yet.</div></div>'}`;
};

function memberRow(mm) {
  return `<div class="card" style="margin-bottom:12px">
    <div class="order-head">
      <div><h4>${esc(mm.name)}</h4>
        <div class="meta">${esc(mm.email)}${mm.organisation ? ' · ' + esc(mm.organisation) : ''} · ${esc(mm.tierName)}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="openMember('${mm.id}')">Manage account</button>
        <button class="btn btn-ghost btn-sm" onclick="resetMemberPw('${mm.id}')">Reset password</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteMember('${mm.id}')">Delete</button>
      </div>
    </div>
    <div class="order-foot">
      <span><span class="k">Carbon saved</span><b>${fmtKg(mm.carbonSavedKg || 0)} CO₂e</b></span>
      <span><span class="k">Items rehomed</span><b>${(mm.itemsRehomed || 0).toLocaleString('en-GB')}</b></span>
      <span><span class="k">Orders</span><b>${mm.orders}</b></span>
      <span><span class="k">Lists</span><b>${mm.lists}</b></span>
      <span><span class="k">Member since</span><b>${fmtDate(mm.memberSince)}</b></span>
    </div>
  </div>`;
}

async function createMember() {
  try {
    await api('/api/admin/members', { method: 'POST', body: {
      name: $('#nmName').value, email: $('#nmEmail').value, password: $('#nmPw').value,
      tier: $('#nmTier').value, organisation: $('#nmOrg').value || null,
      phone: $('#nmPhone').value || null, address: $('#nmAddr').value || null,
    } });
    toast('Account created'); go('adminMembers');
  } catch (e) { toast(e.message); }
}

function editMember(id) {
  const mm = ADMIN.members.find((x) => x.id === id);
  if (!mm) return;
  const tierOpts = ADMIN.tiers.map((t) => `<option value="${t.id}" ${mm.tier === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const am = mm.accountManager || {};
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="close" onclick="closeModal()">✕</button>
      <h3 style="margin-bottom:16px">Edit ${esc(mm.name)}</h3>
      <div class="form-grid">
        <div><label>Full name</label><input id="emName" value="${esc(mm.name)}"></div>
        <div><label>Email (sign-in)</label><input id="emEmail" value="${esc(mm.email)}"></div>
        <div><label>Membership tier</label><select id="emTier">${tierOpts}</select></div>
        <div><label>Member since</label><input id="emSince" value="${esc(mm.memberSince || '')}" placeholder="YYYY-MM-DD"></div>
        <div><label>Organisation</label><input id="emOrg" value="${esc(mm.organisation || '')}"></div>
        <div><label>Phone</label><input id="emPhone" value="${esc(mm.phone || '')}"></div>
        <div style="grid-column:1/-1"><label>Address</label><input id="emAddr" value="${esc(mm.address || '')}"></div>
        <div><label>Carbon saved (kg CO₂e)</label><input id="emCarbon" type="number" step="0.1" value="${mm.carbonSavedKg || 0}"></div>
        <div><label>Items rehomed</label><input id="emItems" type="number" value="${mm.itemsRehomed || 0}"></div>
        <div><label>Account manager name</label><input id="emAmName" value="${esc(am.name || '')}" placeholder="Corporate tier only"></div>
        <div><label>Account manager email</label><input id="emAmEmail" value="${esc(am.email || '')}"></div>
      </div>
      <button class="btn btn-primary" style="margin-top:18px" onclick="saveMember('${mm.id}')">Save changes</button>
    </div>
  </div>`;
}

async function saveMember(id) {
  const amName = $('#emAmName').value.trim();
  const body = {
    name: $('#emName').value, email: $('#emEmail').value, tier: $('#emTier').value,
    memberSince: $('#emSince').value, organisation: $('#emOrg').value || null,
    phone: $('#emPhone').value || null, address: $('#emAddr').value || null,
    carbonSavedKg: parseFloat($('#emCarbon').value) || 0,
    itemsRehomed: parseInt($('#emItems').value, 10) || 0,
    accountManager: amName ? { name: amName, email: $('#emAmEmail').value || 'hello@material-reuse.co.uk', phone: '01932 867989' } : null,
  };
  try {
    await api('/api/admin/members/' + id, { method: 'PATCH', body });
    closeModal(); toast('Member updated'); go(state.page);
  } catch (e) { toast(e.message); }
}

async function editCarbon(id) {
  const mm = ADMIN.members.find((x) => x.id === id);
  if (!mm) return;
  const { report } = await api(`/api/admin/members/${id}/carbon`);
  const r = report || { totalSavedKg: 0, monthly: [], byCategory: [], equivalents: { carMiles: 0, treeYears: 0 }, verified: false };
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="close" onclick="closeModal()">✕</button>
      <h3 style="margin-bottom:8px">Carbon report — ${esc(mm.name)}</h3>
      <p class="small muted" style="margin-bottom:12px">This drives the member’s dashboard: <b>totalSavedKg</b>, <b>monthly</b> [{"month":"2026-01","kg":0}], <b>byCategory</b> [{"category":"…","kg":0}], <b>equivalents</b> {"carMiles":0,"treeYears":0}, <b>verified</b>, <b>verifier</b> and optional <b>wlcaModules</b>.</p>
      <textarea id="carbonJson" style="width:100%;height:320px;font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--line);border-radius:2px;padding:12px">${esc(JSON.stringify(r, null, 2))}</textarea>
      <button class="btn btn-primary" style="margin-top:14px" onclick="saveCarbonReport('${id}')">Save carbon report</button>
    </div>
  </div>`;
}

async function saveCarbonReport(id) {
  let body;
  try { body = JSON.parse($('#carbonJson').value); } catch { return toast('Invalid JSON — check the format'); }
  try {
    await api(`/api/admin/members/${id}/carbon`, { method: 'PUT', body });
    closeModal(); toast('Carbon report saved'); go(state.page);
  } catch (e) { toast(e.message); }
}

/* ================= ADMIN — SINGLE MEMBER (log everything they see) ================= */
function openMember(id) { ADMIN.currentId = id; go('adminMember'); }

RENDER.adminMember = async () => {
  const id = ADMIN.currentId;
  if (!id) return go('adminMembers');
  const [list, d] = await Promise.all([
    api('/api/admin/members'),
    api(`/api/admin/members/${id}/full`),
  ]);
  ADMIN = { ...list, currentId: id, full: d };
  const u = d.user, t = d.tier;

  $('#view').innerHTML = `
    <div class="tagline-strip">
      <span><b>${esc(u.name)}</b> — ${esc(u.email)}${u.organisation ? ' · ' + esc(u.organisation) : ''} · ${t ? esc(t.name) : '—'}</span>
      <button class="btn btn-green btn-sm" onclick="go('adminMembers')">Back to members</button>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
      <button class="btn btn-primary btn-sm" onclick="editMember('${u.id}')">Edit details & stats</button>
      <button class="btn btn-ghost btn-sm" onclick="editCarbon('${u.id}')">Carbon report data</button>
      <button class="btn btn-ghost btn-sm" onclick="editBilling()">Billing & invoices</button>
      <button class="btn btn-ghost btn-sm" onclick="resetMemberPw('${u.id}')">Reset password</button>
      <button class="btn btn-ghost btn-sm" onclick="deleteMember('${u.id}')">Delete account</button>
    </div>

    <div class="grid cols-4" style="margin-top:18px">
      <div class="card stat"><span class="stripe" style="background:var(--green)"></span>
        <div class="lbl">Carbon saved</div><div class="big">${fmtKg(u.carbonSavedKg || 0)}</div>
        <div class="sub">Shown on their dashboard</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--azul)"></span>
        <div class="lbl">Items rehomed</div><div class="big">${(u.itemsRehomed || 0).toLocaleString('en-GB')}</div>
        <div class="sub">Shown on their dashboard</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--yellow)"></span>
        <div class="lbl">Orders logged</div><div class="big">${d.orders.length}</div>
        <div class="sub">Incl. donation lots</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--orange)"></span>
        <div class="lbl">Projects & audits</div><div class="big">${d.projects.length}</div>
        <div class="sub">Visible on their Projects tab</div></div>
    </div>

    <div class="card" style="margin-top:28px">
      <div class="order-head">
        <h3>Orders & collections</h3>
        <button class="btn btn-primary btn-sm" onclick="orderModal()">Log an order</button>
      </div>
      ${d.orders.length ? `<table>
        <tr><th>Order</th><th>Type</th><th>Status</th><th>Slot</th><th>Total</th><th>Carbon</th><th></th></tr>
        ${d.orders.map((o) => `<tr>
          <td><b>${esc(o.id)}</b><br><span class="small muted">${fmtDate(o.placed)}</span></td>
          <td>${o.type === 'donation' ? 'Donation lot' : 'Order'}</td>
          <td>${statusPill(o.status)}</td>
          <td class="small">${esc(o.slot || '—')}</td>
          <td>${o.total !== undefined && o.total !== null ? fmtGBP(o.total) : '—'}</td>
          <td>${fmtKg(o.carbonSavedKg || 0)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" onclick="orderModal('${o.id}')">Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteOrder('${o.id}')">Delete</button></td>
        </tr>`).join('')}</table>` : '<div class="empty">No orders logged for this member.</div>'}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="order-head">
        <h3>Projects & audits</h3>
        <button class="btn btn-primary btn-sm" onclick="projectModal()">Log a project / audit</button>
      </div>
      ${d.projects.length ? `<table>
        <tr><th>Project</th><th>Type</th><th>Status</th><th>Progress</th><th>Target</th><th>Carbon</th><th></th></tr>
        ${d.projects.map((p) => `<tr>
          <td><b>${esc(p.name)}</b>${p.auditRef ? `<br><span class="small muted">Audit ref ${esc(p.auditRef)}</span>` : ''}</td>
          <td class="small">${esc(p.type)}</td>
          <td>${statusPill(p.status)}</td>
          <td>${p.progress || 0}%</td>
          <td>${fmtDate(p.target)}</td>
          <td>${fmtKg(p.carbonSavedKg || 0)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" onclick="projectModal('${p.id}')">Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteProject('${p.id}')">Delete</button></td>
        </tr>`).join('')}</table>` : '<div class="empty">No projects or audits logged — these appear on the member’s Projects & Audits tab.</div>'}
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <h3 style="margin-bottom:10px">Billing (what they see)</h3>
        <p><b>Method:</b> ${esc((u.billing && u.billing.method) || 'None — free plan')}</p>
        <p><b>Next payment:</b> ${u.billing && u.billing.nextPayment ? fmtDate(u.billing.nextPayment) : '—'}</p>
        <p><b>Invoices:</b> ${u.billing && u.billing.invoices ? u.billing.invoices.length : 0}</p>
        ${u.accountManager ? `<p style="margin-top:8px"><b>Account manager:</b> ${esc(u.accountManager.name)}</p>` : ''}
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="editBilling()">Edit billing & invoices</button>
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px">Shopping lists (member-managed)</h3>
        ${d.lists.length ? d.lists.map((l) => `<div class="doc-row">
          <span class="t">${esc(l.name)}<span>${l.items.length} line${l.items.length === 1 ? '' : 's'} · created ${fmtDate(l.created)}</span></span>
        </div>`).join('') : '<div class="empty">No lists yet.</div>'}
      </div>
    </div>`;
};

/* ---- order modal ---- */
const ORDER_STATUSES = ['Reserved', 'Awaiting collection', 'Ready for collection', 'Collected', 'Delivered', 'Passports issued', 'Logged — emission assessment'];

function orderModal(oid) {
  const o = (oid && ADMIN.full.orders.find((x) => x.id === oid)) || {};
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="close" onclick="closeModal()">✕</button>
      <h3 style="margin-bottom:16px">${oid ? 'Edit ' + esc(o.id) : 'Log an order'}</h3>
      <div class="form-grid">
        <div><label>Type</label><select id="odType">
          <option value="order" ${o.type !== 'donation' ? 'selected' : ''}>Order / reservation</option>
          <option value="donation" ${o.type === 'donation' ? 'selected' : ''}>Donation lot</option></select></div>
        <div><label>Status</label><select id="odStatus">
          ${ORDER_STATUSES.map((s) => `<option ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>Date placed</label><input id="odPlaced" value="${esc(o.placed || new Date().toISOString().slice(0, 10))}" placeholder="YYYY-MM-DD"></div>
        <div><label>Slot</label><input id="odSlot" value="${esc(o.slot || '')}" placeholder="e.g. 2026-07-20, 14:00–16:00"></div>
        <div style="grid-column:1/-1"><label>Fulfilment</label><input id="odFulfil" value="${esc(o.fulfilment || 'Collection — Material Reuse warehouse')}"></div>
        <div><label>Total (£)</label><input id="odTotal" type="number" step="0.01" value="${o.total ?? ''}"></div>
        <div><label>Member discount (£)</label><input id="odDisc" type="number" step="0.01" value="${o.memberDiscount ?? ''}"></div>
        <div><label>Delivery fee (£)</label><input id="odFee" type="number" step="0.01" value="${o.deliveryFee ?? ''}"></div>
        <div><label>Carbon saved (kg CO₂e)</label><input id="odCarbon" type="number" step="0.1" value="${o.carbonSavedKg || 0}"></div>
        <div style="grid-column:1/-1"><label>Note (shown to member)</label><input id="odNote" value="${esc(o.note || '')}"></div>
        <div style="grid-column:1/-1"><label>Items — JSON [{"title":"…","qty":1,"price":0,"sku":"…"}]</label>
          <textarea id="odItems" style="width:100%;height:110px;font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--line);border-radius:2px;padding:10px">${esc(JSON.stringify(o.items || [], null, 2))}</textarea></div>
      </div>
      <button class="btn btn-primary" style="margin-top:18px" onclick="saveOrder(${oid ? `'${oid}'` : 'null'})">Save order</button>
    </div>
  </div>`;
}

async function saveOrder(oid) {
  let items;
  try { items = JSON.parse($('#odItems').value || '[]'); } catch { return toast('Items must be valid JSON'); }
  if (!Array.isArray(items)) return toast('Items must be a JSON array');
  const num = (id) => { const v = $(id).value; return v === '' ? undefined : parseFloat(v) || 0; };
  const body = {
    type: $('#odType').value, status: $('#odStatus').value,
    placed: $('#odPlaced').value, slot: $('#odSlot').value,
    fulfilment: $('#odFulfil').value, note: $('#odNote').value || undefined,
    total: num('#odTotal'), memberDiscount: num('#odDisc'), deliveryFee: num('#odFee'),
    carbonSavedKg: parseFloat($('#odCarbon').value) || 0, items,
  };
  try {
    if (oid) await api('/api/admin/orders/' + oid, { method: 'PATCH', body });
    else await api(`/api/admin/members/${ADMIN.currentId}/orders`, { method: 'POST', body });
    closeModal(); toast('Order saved'); go('adminMember');
  } catch (e) { toast(e.message); }
}

async function deleteOrder(oid) {
  if (!confirm(`Delete ${oid}? The member will no longer see it.`)) return;
  try {
    await api('/api/admin/orders/' + oid, { method: 'DELETE' });
    toast('Order deleted'); go('adminMember');
  } catch (e) { toast(e.message); }
}

/* ---- project / audit modal ---- */
function projectModal(pid) {
  const p = (pid && ADMIN.full.projects.find((x) => x.id === pid)) || {};
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="close" onclick="closeModal()">✕</button>
      <h3 style="margin-bottom:16px">${pid ? 'Edit ' + esc(p.name) : 'Log a project / audit'}</h3>
      <div class="form-grid">
        <div style="grid-column:1/-1"><label>Project name</label><input id="pjName" value="${esc(p.name || '')}"></div>
        <div><label>Type</label><input id="pjType" value="${esc(p.type || '')}" placeholder="e.g. Pre-demolition audit + donation"></div>
        <div><label>Status</label><select id="pjStatus">
          ${['Planning', 'In progress', 'Complete'].map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div><label>Audit ref</label><input id="pjRef" value="${esc(p.auditRef || '')}" placeholder="Optional"></div>
        <div><label>Progress (%)</label><input id="pjProg" type="number" min="0" max="100" value="${p.progress || 0}"></div>
        <div><label>Started</label><input id="pjStart" value="${esc(p.started || new Date().toISOString().slice(0, 10))}" placeholder="YYYY-MM-DD"></div>
        <div><label>Target date</label><input id="pjTarget" value="${esc(p.target || '')}" placeholder="YYYY-MM-DD"></div>
        <div><label>Carbon saved (kg CO₂e)</label><input id="pjCarbon" type="number" step="0.1" value="${p.carbonSavedKg || 0}"></div>
        <div style="grid-column:1/-1"><label>Summary (shown to member)</label><input id="pjSummary" value="${esc(p.summary || '')}"></div>
        <div style="grid-column:1/-1"><label>Documents — JSON [{"name":"report.pdf","type":"Carbon report","date":"2026-07-01"}]</label>
          <textarea id="pjDocs" style="width:100%;height:100px;font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--line);border-radius:2px;padding:10px">${esc(JSON.stringify(p.documents || [], null, 2))}</textarea></div>
      </div>
      <button class="btn btn-primary" style="margin-top:18px" onclick="saveProject(${pid ? `'${pid}'` : 'null'})">Save project</button>
    </div>
  </div>`;
}

async function saveProject(pid) {
  let documents;
  try { documents = JSON.parse($('#pjDocs').value || '[]'); } catch { return toast('Documents must be valid JSON'); }
  if (!Array.isArray(documents)) return toast('Documents must be a JSON array');
  const body = {
    name: $('#pjName').value, type: $('#pjType').value, status: $('#pjStatus').value,
    auditRef: $('#pjRef').value || undefined, progress: parseInt($('#pjProg').value, 10) || 0,
    started: $('#pjStart').value, target: $('#pjTarget').value || null,
    carbonSavedKg: parseFloat($('#pjCarbon').value) || 0,
    summary: $('#pjSummary').value, documents,
  };
  try {
    if (pid) await api('/api/admin/projects/' + pid, { method: 'PATCH', body });
    else await api(`/api/admin/members/${ADMIN.currentId}/projects`, { method: 'POST', body });
    closeModal(); toast('Project saved'); go('adminMember');
  } catch (e) { toast(e.message); }
}

async function deleteProject(pid) {
  if (!confirm('Delete this project? The member will no longer see it.')) return;
  try {
    await api('/api/admin/projects/' + pid, { method: 'DELETE' });
    toast('Project deleted'); go('adminMember');
  } catch (e) { toast(e.message); }
}

/* ---- billing modal ---- */
function editBilling() {
  const u = ADMIN.full.user;
  const b = u.billing || { method: null, nextPayment: null, invoices: [] };
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="close" onclick="closeModal()">✕</button>
      <h3 style="margin-bottom:16px">Billing — ${esc(u.name)}</h3>
      <div class="form-grid">
        <div><label>Payment method</label><input id="blMethod" value="${esc(b.method || '')}" placeholder="e.g. Visa •••• 4821 / Invoice — 30 day terms"></div>
        <div><label>Next payment</label><input id="blNext" value="${esc(b.nextPayment || '')}" placeholder="YYYY-MM-DD"></div>
        <div style="grid-column:1/-1"><label>Invoices — JSON [{"id":"INV-2026-0001","date":"2026-07-01","amount":500,"status":"Paid","desc":"…"}]</label>
          <textarea id="blInvoices" style="width:100%;height:160px;font-family:ui-monospace,monospace;font-size:12px;border:1px solid var(--line);border-radius:2px;padding:10px">${esc(JSON.stringify(b.invoices || [], null, 2))}</textarea></div>
      </div>
      <button class="btn btn-primary" style="margin-top:18px" onclick="saveBilling()">Save billing</button>
    </div>
  </div>`;
}

async function saveBilling() {
  let invoices;
  try { invoices = JSON.parse($('#blInvoices').value || '[]'); } catch { return toast('Invoices must be valid JSON'); }
  if (!Array.isArray(invoices)) return toast('Invoices must be a JSON array');
  const body = { billing: {
    method: $('#blMethod').value || null,
    nextPayment: $('#blNext').value || null,
    invoices,
  } };
  try {
    await api('/api/admin/members/' + ADMIN.currentId, { method: 'PATCH', body });
    closeModal(); toast('Billing saved'); go('adminMember');
  } catch (e) { toast(e.message); }
}

async function resetMemberPw(id) {
  const mm = ADMIN.members.find((x) => x.id === id);
  const pw = prompt(`New temporary password for ${mm ? mm.name : 'member'} (min 8 characters):`);
  if (!pw) return;
  try {
    await api(`/api/admin/members/${id}/password`, { method: 'POST', body: { password: pw } });
    toast('Password reset — share it securely');
  } catch (e) { toast(e.message); }
}

async function deleteMember(id) {
  const mm = ADMIN.members.find((x) => x.id === id);
  if (!confirm(`Delete ${mm ? mm.name : 'this member'}’s account? This can’t be undone.`)) return;
  try {
    await api('/api/admin/members/' + id, { method: 'DELETE' });
    toast('Account deleted'); go(state.page);
  } catch (e) { toast(e.message); }
}

/* ---------------- boot ---------------- */
async function boot() {
  if (!TOKEN) return showLogin();
  try {
    const { user, tier } = await api('/api/auth/me');
    enterApp(user, tier);
  } catch (e) { showLogin(); }
}
boot();
