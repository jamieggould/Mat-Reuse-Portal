/* =====================================================================
   material reuse — portal features (loaded after app.js)
   Impact & ESG reporting · Material passports · Project dashboards ·
   Documents vault · Offer materials · Admin request queue
   Uses the same $/api/esc/toast/go/RENDER plumbing as app.js.
   ===================================================================== */

/* ---------------- navigation ---------------- */
(function wireNav() {
  const after = (arr, id, entries) => { const i = arr.findIndex((p) => p.id === id); arr.splice(i + 1, 0, ...entries); };
  after(PAGES, 'warehouse', [
    { id: 'materials', label: 'Material Passports' },
    { id: 'offer', label: 'Offer Materials' },
  ]);
  ['projects', 'lists'].forEach((id) => { const i = PAGES.findIndex((p) => p.id === id); if (i >= 0) PAGES.splice(i, 1); });
  after(PAGES, 'orders', [
    { id: 'documents', label: 'Documents' },
    { id: 'impact', label: 'Impact & ESG', gate: (g) => g.impactCentre },
  ]);
  Object.assign(HIDDEN_PAGES, { projects: { id: 'projects', label: 'Projects' } });
  after(ADMIN_PAGES, 'adminMembers', [
    { id: 'adminRequests', label: 'Material Requests' },
    { id: 'adminMaterials', label: 'Passports' },
  ]);
  Object.assign(HIDDEN_PAGES, { project: { id: 'project', label: 'Project dashboard' } });
})();

/* ---------- logged-out flows: forgot / reset / public passport / privacy ---------- */
function showForgot(ev) {
  if (ev) ev.preventDefault();
  ['loginForm', 'registerForm', 'resetForm'].forEach((id) => { $('#' + id).style.display = 'none'; });
  $('#forgotForm').style.display = '';
  $('#loginToggleNote').innerHTML = 'Enter the email on your account and we’ll send a link to choose a new password. <a href="#" onclick="showLoginForm(event)">Back to sign in</a>.';
  $('#forgotNote').style.display = 'none';
}
function showLoginForm(ev) {
  if (ev) ev.preventDefault();
  ['registerForm', 'forgotForm', 'resetForm'].forEach((id) => { $('#' + id).style.display = 'none'; });
  $('#loginForm').style.display = '';
  $('#loginToggleNote').innerHTML = 'New to Material Reuse Group? <a href="#" onclick="toggleRegister(event)">Create a free account</a> — Domestic Free Membership, upgrade any time.';
  $('#forgotNote').style.display = '';
}
async function doForgot(ev) {
  ev.preventDefault();
  const btn = $('#fgBtn'), err = $('#fgError'); btn.disabled = true; btn.textContent = 'Sending…'; err.classList.remove('show');
  try {
    const r = await api('/api/auth/forgot', { method: 'POST', body: { email: $('#fgEmail').value } });
    $('#loginToggleNote').innerHTML = esc(r.message) + ' Check your inbox (and spam folder). <a href="#" onclick="showLoginForm(event)">Back to sign in</a>.';
    $('#forgotForm').style.display = 'none';
  } catch (e) { err.textContent = e.message; err.classList.add('show'); }
  btn.disabled = false; btn.textContent = 'Email me a reset link';
}
let RESET_TOKEN = null;
function showReset(token) {
  RESET_TOKEN = token;
  ['loginForm', 'registerForm', 'forgotForm'].forEach((id) => { $('#' + id).style.display = 'none'; });
  $('#resetForm').style.display = '';
  $('#loginToggleNote').innerHTML = 'Choose a new password for your account.';
  $('#forgotNote').style.display = 'none';
}
async function doReset(ev) {
  ev.preventDefault();
  const err = $('#rsError'); err.classList.remove('show');
  if ($('#rsPassword').value !== $('#rsConfirm').value) { err.textContent = 'Passwords don’t match'; err.classList.add('show'); return; }
  const btn = $('#rsBtn'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const { token, user, tier } = await api('/api/auth/reset', { method: 'POST', body: { token: RESET_TOKEN, password: $('#rsPassword').value } });
    setToken(token); history.replaceState(null, '', '/'); enterApp(user, tier); toast('Password updated — you’re signed in');
  } catch (e) { err.textContent = e.message; err.classList.add('show'); }
  btn.disabled = false; btn.textContent = 'Set new password';
}

/* public passport view (QR scans without an account) */
async function showPublicPassport(id) {
  let d; try { d = await api('/api/public/passports/' + id); } catch (e) { return; }
  const x = d.passport, photos = x.photos || [];
  $('#login').style.display = 'none';
  $('#publicRoot').innerHTML = `
  <div class="public-wrap"><div class="public-card">
    <div class="public-head"><img src="/assets/mrg-logo-group-sm.png" alt="Material Reuse Group" style="height:38px;width:auto"><div class="kicker">${x.passportVerified ? 'Verified material passport' : 'Digital material passport'}</div></div>
    ${photos[0] ? `<img class="public-photo" src="${esc(photos[0].url)}" alt="">` : ''}
    <div class="public-body">
      <div class="mp-ref">${esc(x.ref)}</div>
      <h2>${esc(x.name)}</h2>
      <p class="small muted">${esc(x.category)} · ${esc(x.condition || '—')} condition · ${x.quantity} ${esc(x.unit || 'items')}</p>
      ${x.description ? `<p class="small" style="margin-top:8px">${esc(x.description)}</p>` : ''}
      <div class="passport-grid" style="margin-top:14px">
        <div class="f"><b>Origin</b><span>${esc(x.origin)}</span></div>
        <div class="f"><b>Recovered</b><span>${fmtDate(x.dateRecovered)}</span></div>
        <div class="f"><b>Status</b><span>${esc(x.status)}${x.reuseDestination ? ' — ' + esc(x.reuseDestination) : ''}</span></div>
        <div class="f"><b>Carbon saved by reuse</b><span style="color:#1d7a05;font-weight:700">${fmtKg(x.carbonSavedKg || 0)} CO₂e${x.carbonEstimated ? ' (est.)' : ''}</span></div>
        ${x.weightKg ? `<div class="f"><b>Weight diverted</b><span>${fmtT(x.weightKg)}${x.weightEstimated ? ' (est.)' : ''}</span></div>` : ''}
        ${x.listedPrice ? `<div class="f"><b>Listed price</b><span>${fmtGBP(x.listedPrice)} ${esc(x.priceUnit || '')} · ${esc(x.availability || '')}</span></div>` : ''}
      </div>
      <p class="small muted" style="margin-top:16px">Every material Material Reuse Group recovers carries a permanent passport so its provenance and carbon saving can be verified.</p>
      <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
        <a class="btn btn-primary" href="https://www.material-reuse.co.uk" target="_blank" rel="noopener">material-reuse.co.uk</a>
        <button class="btn btn-ghost" onclick="$('#publicRoot').innerHTML='';$('#login').style.display='flex';history.replaceState(null,'','/')">Member sign in</button>
      </div>
    </div>
  </div></div>`;
}

/* privacy & terms (draft — for MRG to review) */
function privacyHTML() {
  return `<div class="card"><h3 style="margin-bottom:8px">Privacy notice</h3>
    <p class="small">Material Reuse Group (“MRG”, “we”) runs this member portal to manage reuse projects, marketplace orders and impact reporting. This notice explains what we hold and why. <b>Draft for MRG review — not legal advice.</b></p>
    <h4 style="margin:14px 0 6px">What we collect</h4>
    <p class="small">Your name, email address, phone number, organisation and address; orders, reservations and collection details; materials you offer us and photos you upload; documents you store in your vault; and the impact figures we calculate from these. If you buy through our online marketplace, the email, name and phone you give at checkout are used to attach the order to your portal account (creating one if you don’t have one).</p>
    <h4 style="margin:14px 0 6px">Why we use it</h4>
    <p class="small">To deliver the membership services you have asked for; to send service emails about your requests, orders and account; to produce carbon and ESG reports for you; and, where you opt in, our newsletter (switch it off in Account Settings).</p>
    <h4 style="margin:14px 0 6px">Where it lives and who sees it</h4>
    <p class="small">Data is stored with Supabase (EU — Ireland) and processed on Render. Marketplace orders are held in Airtable and payments by Stripe. Transactional emails are sent through Resend. MRG staff see your account to run the service. We do not sell your data. Photos and documents you upload are stored at unguessable links; do not upload anything you would not want to share with MRG.</p>
    <h4 style="margin:14px 0 6px">Your rights</h4>
    <p class="small">You can update your details in Account Settings at any time. To access, correct, export or delete your data, or to close your account, email <a href="mailto:kallie@material-reuse.co.uk">kallie@material-reuse.co.uk</a>. Passports and impact figures may be retained in anonymised form for MRG’s own reporting after an account is closed.</p>
  </div>
  <div class="card" style="margin-top:16px"><h3 style="margin-bottom:8px">Terms of use</h3>
    <p class="small">The portal is provided to MRG members and customers for managing reuse services. Impact figures are calculated from product passport data using published embodied-carbon factors; figures marked “estimated” are category averages pending measured values, and independent verification is available on corporate tiers. Marketplace prices, availability and collection arrangements are governed by the terms shown at checkout. Reservations require a deposit via the marketplace; the balance is payable on collection. Keep your sign-in details private; you are responsible for activity on your account. We may suspend accounts used abusively. These terms are governed by the laws of England and Wales.</p>
    <p class="small muted" style="margin-top:10px">Last updated ${fmtDate(todayStr())}. Questions: kallie@material-reuse.co.uk · 01932 867989.</p>
  </div>`;
}
RENDER.privacy = async () => { $('#view').innerHTML = privacyHTML(); };
Object.assign(HIDDEN_PAGES, { privacy: { id: 'privacy', label: 'Privacy & terms' } });
function showPrivacy(ev) {
  if (ev) ev.preventDefault();
  $('#modalRoot').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal modal-lg"><button class="close" onclick="closeModal()">✕</button>${privacyHTML()}</div></div>`;
}

(function loggedOutDeepLinks() { // runs on load, before /me resolves
  const m = location.pathname.match(/^\/(reset|passport)\/([\w-]+)/);
  if (!m) return;
  if (m[1] === 'reset') { showReset(m[2]); return; }
  if (!TOKEN) showPublicPassport(m[2]);
})();

/* deep links: /passport/MP-0001 and /project/PRJ-4001 */
const _enterAppBase = enterApp;
enterApp = function (user, tier) {
  _enterAppBase(user, tier);
  const m = location.pathname.match(/^\/(passport|project)\/([\w-]+)/);
  if (m) {
    history.replaceState(null, '', '/');
    if (m[1] === 'passport') openMaterial(m[2]);
    else openProject(m[2]);
  }
};

/* ---------------- shared helpers ---------------- */
let META = null;
async function meta() { if (!META) META = await api('/api/meta'); return META; }
const fmtT = (kg) => kg >= 1000 ? `${(kg / 1000).toLocaleString('en-GB', { maximumFractionDigits: 2 })} t` : `${Number(kg).toLocaleString('en-GB', { maximumFractionDigits: 1 })} kg`;
const pct = (r) => r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const catTile = (c) => `<div class="mp-tile">${esc((c || '?').slice(0, 2).toUpperCase())}</div>`;
const optList = (arr, sel) => arr.map((x) => `<option value="${esc(x)}" ${x === sel ? 'selected' : ''}>${esc(x)}</option>`).join('');
const qrUrl = (data, size = 240) => `/api/qr?size=${size}&data=${encodeURIComponent(data)}`;
const MRG_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#fff"/><g fill="none" stroke-width="8.6" stroke-linecap="round"><path d="M38.77 21.39 A15 15 0 0 0 27.88 9.51" stroke="#9EFF51"/><path d="M21.40 9.23 A15 15 0 0 0 9.51 20.12" stroke="#6FD53C"/><path d="M9.23 26.60 A15 15 0 0 0 20.12 38.49" stroke="#35A94D"/><path d="M26.60 38.77 A15 15 0 0 0 38.49 27.88" stroke="#0F8A6D"/></g></svg>`;
const MRG_MARK_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(MRG_MARK_SVG);
// QR with the MRG mark in the middle (error-correction H, so the centre 22% can be covered)
const brandedQR = (data, px = 180) => `<span class="qr-wrap" style="width:${px}px;height:${px}px"><img src="${qrUrl(data, Math.max(240, px * 2))}" alt="QR code" width="${px}" height="${px}"><img class="qr-mark" src="${MRG_MARK_URL}" alt=""></span>`;
async function downloadQR(id, ref) {
  try {
    const size = 1200, mark = Math.round(size * 0.22);
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [qr, logo] = await Promise.all([load(qrUrl(passportLink(id), size)), load(MRG_MARK_URL)]);
    const c = document.createElement('canvas'); c.width = size; c.height = size + 120;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(qr, 0, 0, size, size);
    const m = (size - mark) / 2; g.fillStyle = '#fff'; g.fillRect(m - 12, m - 12, mark + 24, mark + 24);
    g.drawImage(logo, m, m, mark, mark);
    g.fillStyle = '#06183F'; g.font = 'bold 46px Geologica, Inter, sans-serif'; g.textAlign = 'center';
    g.fillText(ref, size / 2, size + 60); g.font = '28px Inter, sans-serif'; g.fillStyle = '#5E6B85'; g.fillText('material reuse · scan for this material’s passport', size / 2, size + 100);
    const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `MRG-passport-QR-${ref}.png`; a.click();
  } catch (e) { toast('Could not build the QR image — check your connection and try again'); }
}
const passportLink = (id) => `${location.origin}/passport/${id}`;

function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
async function uploadFile(file, userId) {
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is over 10 MB`);
  const data = await readAsDataURL(file);
  const { file: f } = await api('/api/uploads', { method: 'POST', body: { name: file.name, type: file.type, data, userId } });
  return f;
}
async function downloadBlob(url, filename) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!res.ok) { toast('Download failed'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* Branded print document (same shell as the carbon report) → save-as-PDF dialog */
function brandDoc({ title, kicker, heading, sub, body }) {
  const logoImg = `<img src="${location.origin}/assets/mrg-logo-group-sm.png" alt="Material Reuse Group" style="height:46px;width:auto;display:block">`;
  const w = window.open('', '_blank');
  if (!w) { toast('Please allow pop-ups to download this document'); return null; }
  w.document.write(`<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geologica:wght@400;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --navy:#06183F; --azul:#1653F3; --green:#9EFF51; --hair:#DDE2EC; --mut:#5A6785; }
  * { margin:0; padding:0; box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  html { background:#EDF0F6; } body { font-family:'Inter',sans-serif; color:var(--navy); font-size:12px; }
  h1,h2,h3,.wordmark,.big { font-family:'Geologica',sans-serif; }
  .savebar { background:var(--navy); color:#fff; padding:14px 24px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .savebar p { font-size:13px; } .savebar button { background:var(--green); color:var(--navy); border:0; font-family:'Geologica',sans-serif; font-weight:700; font-size:13px; padding:10px 22px; cursor:pointer; letter-spacing:.04em; text-transform:uppercase; }
  .sheet { width:210mm; min-height:297mm; margin:24px auto; background:#fff; display:flex; flex-direction:column; box-shadow:0 4px 30px rgba(6,24,63,.18); }
  .head { background:var(--navy); color:#fff; padding:11mm 12mm 9mm; display:flex; justify-content:space-between; align-items:center; }
  .lockup { display:flex; align-items:center; gap:11px; } .wordmark { font-size:19px; font-weight:700; line-height:1.02; color:#fff; }
  .head .r { text-align:right; } .head .kicker { font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--green); font-weight:600; }
  .head h1 { font-size:26px; font-weight:800; margin-top:5px; } .head .sub { font-size:10.5px; color:#B9C3D8; margin-top:5px; }
  .band { height:5px; background:var(--green); }
  .inner { padding:9mm 12mm 6mm; display:flex; flex-direction:column; flex:1; }
  .sec-t { font-family:'Geologica',sans-serif; font-size:10.5px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; padding-bottom:7px; border-bottom:2px solid var(--navy); margin:8mm 0 10px; display:flex; align-items:center; gap:8px; }
  .sec-t::before { content:''; width:18px; height:4px; background:var(--green); } .sec-t:first-child { margin-top:0; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; } .stats.three { grid-template-columns:repeat(3,1fr); }
  .stat { border:1px solid var(--hair); border-top:4px solid var(--azul); padding:12px 14px; } .stat:nth-child(1) { border-top-color:var(--green); } .stat:nth-child(3) { border-top-color:#FFED4D; } .stat:nth-child(4) { border-top-color:#FF883A; }
  .stat b { display:block; font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); } .stat .big { font-size:22px; font-weight:800; margin:5px 0 2px; } .stat i { font-style:normal; font-size:9.5px; color:var(--mut); }
  table { width:100%; border-collapse:collapse; } th { text-align:left; font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); padding:6px 8px; border-bottom:2px solid var(--navy); }
  td { padding:6px 8px; border-bottom:1px solid var(--hair); font-size:11.5px; vertical-align:top; } td.num { text-align:right; font-weight:600; white-space:nowrap; }
  .bar { height:8px; background:#EEF1F7; position:relative; min-width:60px; } .bar i { position:absolute; inset:0 auto 0 0; background:var(--azul); }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:10mm; } .cols3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6mm; }
  .kv { display:grid; grid-template-columns:1fr 1fr; gap:6px 14px; } .kv div { border-bottom:1px solid var(--hair); padding:6px 0; } .kv b { display:block; font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); margin-bottom:2px; } .kv span { font-weight:600; font-size:11.5px; }
  .verify { border:1px solid var(--hair); border-left:4px solid var(--green); padding:12px 16px; font-size:11.5px; line-height:1.6; }
  .cert { text-align:center; padding:7mm 6mm; border:1px solid var(--hair); border-top:4px solid var(--green); } .cert .lead { font-size:10px; letter-spacing:.22em; text-transform:uppercase; color:var(--mut); font-weight:600; }
  .cert .name { font-family:'Geologica',sans-serif; font-size:28px; font-weight:800; margin:8px 0 2px; } .cert .bigv { font-family:'Geologica',sans-serif; font-size:40px; font-weight:800; color:var(--azul); margin:6px 0 4px; }
  .cert .capt { font-size:12px; max-width:130mm; margin:0 auto; line-height:1.55; } .cert .period { display:inline-block; margin-top:12px; font-size:10px; letter-spacing:.14em; text-transform:uppercase; font-weight:600; background:var(--navy); color:var(--green); padding:6px 14px; }
  .photo { width:100%; height:62mm; object-fit:cover; border:1px solid var(--hair); background:#F5F6F9; } .photos { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; } .photos img { width:100%; height:38mm; object-fit:cover; border:1px solid var(--hair); }
  .qr { display:flex; gap:14px; align-items:center; border:1px solid var(--hair); padding:12px; } .qr img { width:34mm; height:34mm; } .qr b { font-family:'Geologica',sans-serif; font-size:15px; }
  .stages { display:flex; gap:4px; margin-top:6px; } .stages span { flex:1; text-align:center; font-size:8px; letter-spacing:.06em; text-transform:uppercase; padding:6px 2px; border:1px solid var(--hair); color:var(--mut); } .stages span.on { background:var(--navy); color:var(--green); border-color:var(--navy); }
  .signrow { display:flex; gap:12mm; margin-top:9mm; } .sign { flex:1; } .sign .line { border-bottom:1.5px solid var(--navy); height:30px; } .sign b { display:block; font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); margin-top:6px; } .sign span { font-size:11.5px; font-weight:600; }
  .grow { flex:1; } .small { font-size:10px; color:var(--mut); } .pb { page-break-inside:avoid; }
  .foot { background:var(--navy); color:#fff; border-top:5px solid var(--green); padding:8mm 12mm; display:flex; justify-content:space-between; align-items:center; gap:16px; }
  .foot .tag { font-size:11px; font-weight:600; } .foot .tag small { display:block; font-weight:400; font-size:10px; color:#B9C3D8; margin-top:3px; } .foot .c { text-align:right; font-size:10px; color:#B9C3D8; line-height:1.7; } .foot .c b { color:var(--green); font-size:10.5px; letter-spacing:.08em; }
  @media print { html { background:#fff; } .savebar { display:none; } .sheet { margin:0; width:auto; min-height:100vh; box-shadow:none; } }
  @page { size:A4; margin:0; }
</style></head><body>
<div class="savebar"><p>Your document is ready — choose where to save it as a PDF.</p><button onclick="window.print()">Save as PDF</button></div>
<div class="sheet">
  <div class="head"><div class="lockup">${logoImg}</div>
    <div class="r"><div class="kicker">${esc(kicker)}</div><h1>${esc(heading)}</h1><div class="sub">${sub}</div></div></div>
  <div class="band"></div>
  <div class="inner">${body}<div class="grow"></div></div>
  <div class="foot"><div class="tag">Building a sustainable future, one material at a time.<small>From ‘waste’ to worth — Material Reuse Group</small></div>
    <div class="c"><b>MATERIAL REUSE GROUP</b><br>material-reuse.co.uk · kallie@material-reuse.co.uk · 01932 867989</div></div>
</div></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* closed */ } }, 1100);
  return w;
}
const kpiTiles = (tiles, cls = '') => `<div class="stats ${cls}">${tiles.map(([l, v, s]) => `<div class="stat"><b>${esc(l)}</b><div class="big">${v}</div><i>${esc(s || '')}</i></div>`).join('')}</div>`;

/* =====================================================================
   1. MATERIAL PASSPORT LIBRARY
   ===================================================================== */
const MATF = { search: '', category: 'all', status: 'all', condition: 'all', scope: 'all' };

RENDER.materials = async () => {
  const m = await meta();
  const isAdmin = state.user.role === 'admin';
  const qs = new URLSearchParams({ search: MATF.search, category: MATF.category, status: MATF.status, condition: MATF.condition, scope: MATF.scope });
  const { materials, total } = await api('/api/materials?' + qs);
  $('#view').innerHTML = `
    <div class="tagline-strip">
      <span>Every recovered material carries a permanent digital passport — provenance, condition, carbon and where it went next.</span>
      ${isAdmin ? `<button class="btn btn-green btn-sm" onclick="materialModal()">New passport</button>` : `<button class="btn btn-green btn-sm" onclick="go('offer')">Offer materials</button>`}
    </div>
    <div class="filters" style="margin-top:18px">
      <input id="mfSearch" placeholder="Search name, reference, source…" value="${esc(MATF.search)}" onkeydown="if(event.key==='Enter')matFilter()">
      <select id="mfCat" onchange="matFilter()"><option value="all">All categories</option>${optList(m.categories, MATF.category)}</select>
      <select id="mfStatus" onchange="matFilter()"><option value="all">Any status</option>${optList(m.materialStatuses, MATF.status)}</select>
      <select id="mfCond" onchange="matFilter()"><option value="all">Any condition</option>${optList(['Excellent', 'Good', 'Fair', 'For recycling'], MATF.condition)}</select>
      ${!isAdmin ? `<select id="mfScope" onchange="matFilter()">${optList(['all', 'mine', 'stock'], MATF.scope).replace('>all<', '>All passports<').replace('>mine<', '>My materials<').replace('>stock<', '>MRG warehouse stock<')}</select>` : ''}
      <button class="btn btn-primary btn-sm" onclick="matFilter()">Search</button>
    </div>
    <p class="small muted" style="margin:10px 0 14px">${total} passport${total === 1 ? '' : 's'}</p>
    ${materials.length ? `<div class="mp-grid">${materials.map(mpCard).join('')}</div>`
      : `<div class="card"><div class="empty">No passports match — try clearing a filter${!isAdmin ? ', or offer materials from a strip-out to start your own library' : ''}.</div></div>`}`;
};
function matFilter() {
  MATF.search = $('#mfSearch').value; MATF.category = $('#mfCat').value; MATF.status = $('#mfStatus').value; MATF.condition = $('#mfCond').value;
  if ($('#mfScope')) MATF.scope = $('#mfScope').value;
  go('materials');
}
function mpCard(x) {
  const photo = x.photos && x.photos[0];
  return `<div class="mp-card" onclick="openMaterial('${esc(x.id)}')">
    <div class="mp-photo">${photo ? `<img src="${esc(photo.url)}" alt="">` : catTile(x.category)}<span class="mp-status">${statusPill(x.status)}</span></div>
    <div class="mp-body">
      <div class="mp-ref">${esc(x.ref)}${x.passportVerified ? ' · <span style="color:var(--green-dark)">✓ verified</span>' : ''}</div>
      <h4>${esc(x.name)}</h4>
      <div class="item-meta">${esc(x.category)} · ${x.quantity} ${esc(x.unit || 'items')} · ${esc(x.condition || '—')}</div>
      <div class="mp-foot"><span class="item-carbon">${fmtKg(x.carbonSavedKg || 0)} CO₂e</span>${x.sourceProject ? `<span class="small muted">${esc(x.sourceProject)}</span>` : ''}</div>
    </div></div>`;
}

async function openMaterial(id) {
  let d; try { d = await api('/api/materials/' + id); } catch (e) { return toast(e.message); }
  const x = d.material, isAdmin = state.user.role === 'admin';
  const photos = x.photos || [];
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal modal-lg">
      <button class="close" onclick="closeModal()">✕</button>
      ${statusPill(x.status)} <span class="pill ${x.passportVerified ? 'pill-green' : 'pill-yellow'}">${x.passportVerified ? '✓ Passport verified' : 'Passport being finalised'}</span>
      <div class="passport-head" style="margin-top:14px">
        ${photos[0] ? `<img class="mp-hero" src="${esc(photos[0].url)}" alt="">` : `<div class="passport-tile">${esc(x.category)}</div>`}
        <div><h3 style="font-size:17px;line-height:1.3">${esc(x.name)}</h3>
        <p class="small muted">${esc(x.category)} · Passport ${esc(x.ref)}</p>
        ${x.description ? `<p class="small" style="margin-top:6px">${esc(x.description)}</p>` : ''}</div>
      </div>
      ${photos.length > 1 ? `<div class="mp-thumbs">${photos.map((p) => `<img src="${esc(p.url)}" alt="" onclick="window.open('${esc(p.url)}','_blank')">`).join('')}</div>` : ''}
      <div class="passport-grid">
        <div class="f"><b>Quantity</b><span>${x.quantity} ${esc(x.unit || 'items')}</span></div>
        <div class="f"><b>Condition</b><span>${esc(x.condition || '—')}</span></div>
        <div class="f"><b>Date recovered</b><span>${fmtDate(x.dateRecovered)}</span></div>
        <div class="f"><b>Source project</b><span>${esc(x.sourceProject || (d.project ? d.project.name : '—'))}</span></div>
        <div class="f"><b>Source building / site</b><span>${esc(x.sourceBuilding || (d.project && d.project.site) || '—')}</span></div>
        <div class="f"><b>Reuse destination</b><span>${esc(x.reuseDestination || (x.status === 'Rehomed' ? 'Rehomed via MRG' : 'Not yet rehomed'))}</span></div>
        <div class="f"><b>Carbon saved by reuse</b><span style="color:#1d7a05;font-weight:700">${fmtKg(x.carbonSavedKg || 0)} CO₂e${x.carbonEstimated ? ' <span class="pill pill-yellow" style="font-size:9px">estimated</span>' : ''}</span></div>
        ${x.weightKg ? `<div class="f"><b>Weight diverted</b><span>${fmtT(x.weightKg)}${x.weightEstimated ? ' <span class="pill pill-yellow" style="font-size:9px">estimated</span>' : ''}</span></div>` : ''}
        <div class="f"><b>Indicative value</b><span>${x.valueGBP ? fmtGBP(x.valueGBP) : (x.listedPrice ? `${fmtGBP(x.listedPrice)} ${esc(x.priceUnit || '')}` : '—')}</span></div>
        ${x.savingsGBP ? `<div class="f"><b>Procurement / disposal saving</b><span>${fmtGBP(x.savingsGBP)}</span></div>` : ''}
        ${d.owner ? `<div class="f"><b>Recovered for</b><span>${esc(d.owner.organisation || d.owner.name)}</span></div>` : ''}
      </div>
      <div class="qr-box">${brandedQR(passportLink(x.id), 96)}
        <div><b style="font-family:var(--font-head)">${esc(x.ref)}</b><br>
        <span class="small" style="color:#B9C6E4">Scan on site to open this passport. ${esc(passportLink(x.id))}</span><br>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px;border-color:#fff;color:#fff" onclick="downloadQR('${esc(x.id)}','${esc(x.ref)}')">Download QR label (PNG)</button></div></div>
      <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="passportDoc('${esc(x.id)}')">Download passport (PDF)</button>
        ${x.sku && !isAdmin && x.availability === 'Available' && (x.buyUrl || x.reserveUrl) ? `
          ${x.buyUrl ? `<button class="btn btn-green" onclick="checkoutItem('${esc(x.buyUrl)}')">Buy now · ${fmtGBP(x.listedPrice || 0)}</button>` : ''}
          ${x.reserveUrl && state.tier && state.tier.gates.reservations ? `<button class="btn btn-green" onclick="checkoutItem('${esc(x.reserveUrl)}')">Reserve with a deposit</button>` : ''}` : ''}
        ${x.sku && !isAdmin && x.availability === 'Available' && !(x.buyUrl || x.reserveUrl) ? `<button class="btn btn-green" onclick="closeModal();go('warehouse')">See it in the warehouse</button>` : ''}
        ${x.sku && !isAdmin && x.availability && x.availability !== 'Available' ? `<span class="pill pill-yellow" style="align-self:center">${esc(x.availability)}</span>` : ''}

        ${d.project && !isAdmin ? `<button class="btn btn-ghost" onclick="closeModal();openProject('${esc(d.project.id)}')">Open project</button>` : ''}
        ${isAdmin ? `<button class="btn btn-ghost" onclick="closeModal();materialModal('${esc(x.id)}')">Edit passport</button>` : ''}
      </div>
    </div>
  </div>`;
}

// Buying/reserving always goes through the marketplace checkout (Stripe) with the member's email locked in,
// so the order lands on this account and the deposit is actually taken.
function checkoutItem(url) {
  const u = new URL(url); u.searchParams.set('email', state.user.email);
  window.open(u.toString(), '_blank', 'noopener');
  toast('Opening secure checkout — your order will appear here after payment');
}
async function passportDoc(id) {
  const d = await api('/api/materials/' + id);
  const x = d.material, photos = x.photos || [];
  const chain = [
    ['Recovered', x.dateRecovered, x.sourceProject || (d.project ? d.project.name : 'Strip-out')],
    [x.status === 'Rehomed' || x.status === 'Recycled' ? x.status : 'Current status', x.dateRehomed || null, x.status === 'Rehomed' ? (x.reuseDestination || 'Rehomed via Material Reuse Group') : x.status],
  ];
  brandDoc({
    title: `Material Reuse Group Material Passport — ${x.ref}`, kicker: x.passportVerified ? 'Verified material passport' : 'Digital material passport',
    heading: 'Material Passport', sub: `Reference ${esc(x.ref)} · Issued ${fmtDate(todayStr())}`,
    body: `
      <div class="cols" style="grid-template-columns:1.2fr 1fr;align-items:start">
        <div>${photos[0] ? `<img class="photo" src="${esc(photos[0].url)}" alt="">` : `<div class="photo" style="display:flex;align-items:center;justify-content:center;color:#5A6785;font-size:11px">No photo on file</div>`}
          ${photos.length > 1 ? `<div class="photos" style="margin-top:6px">${photos.slice(1, 4).map((p) => `<img src="${esc(p.url)}" alt="">`).join('')}</div>` : ''}</div>
        <div>
          <div class="sec-t">Identity</div>
          <h2 style="font-size:22px;font-weight:800;line-height:1.2;margin-bottom:4px">${esc(x.name)}</h2>
          <p class="small" style="margin-bottom:10px">${esc(x.category)} · ${esc(x.condition || '—')} condition</p>
          ${x.description ? `<p style="font-size:11.5px;line-height:1.55;margin-bottom:10px">${esc(x.description)}</p>` : ''}
          <div class="qr"><span style="position:relative;display:inline-block;width:34mm;height:34mm"><img src="${qrUrl(passportLink(x.id), 600)}" alt="QR" style="width:34mm;height:34mm"><img src="${MRG_MARK_URL}" alt="" style="position:absolute;left:39%;top:39%;width:22%;height:22%;background:#fff;padding:1px"></span><div><b>${esc(x.ref)}</b><div class="small" style="margin-top:4px">Scan to open the live passport<br>${esc(passportLink(x.id))}</div></div></div>
        </div>
      </div>
      <div class="sec-t">Specification</div>
      <div class="kv">
        <div><b>Quantity</b><span>${x.quantity} ${esc(x.unit || 'items')}</span></div>
        <div><b>Source project</b><span>${esc(x.sourceProject || (d.project ? d.project.name : '—'))}</span></div>
        <div><b>Source building / site</b><span>${esc(x.sourceBuilding || (d.project && d.project.site) || '—')}</span></div>
        <div><b>Date recovered</b><span>${fmtDate(x.dateRecovered)}</span></div>
        <div><b>Status</b><span>${esc(x.status)}</span></div>
        <div><b>Reuse destination</b><span>${esc(x.reuseDestination || '—')}</span></div>
        <div><b>Recovered for</b><span>${d.owner ? esc(d.owner.organisation || d.owner.name) : 'Material Reuse Group warehouse'}</span></div>
      </div>
      <div class="sec-t">Impact & value</div>
      ${kpiTiles([
        ['CO₂e saved by reuse', `${Number(x.carbonSavedKg || 0).toLocaleString('en-GB')} kg`, 'Embodied carbon retained'],
        ['Weight diverted', x.weightKg ? fmtT(x.weightKg) : '—', 'Kept out of the waste stream'],
        ['Indicative value', x.valueGBP ? fmtGBP(x.valueGBP) : '—', 'Value retained through reuse'],
        ['Saving to client', x.savingsGBP ? fmtGBP(x.savingsGBP) : '—', 'Procurement / disposal avoided'],
      ])}
      <div class="sec-t">Chain of custody</div>
      <table><tr><th>Step</th><th>Date</th><th>Detail</th></tr>
        ${chain.map(([s, dt, det]) => `<tr><td><b>${esc(s)}</b></td><td>${dt ? fmtDate(dt) : '—'}</td><td>${esc(det)}</td></tr>`).join('')}</table>
      <div class="verify" style="margin-top:8mm">${x.passportVerified
        ? 'This passport has been checked and verified by Material Reuse Group. Carbon figures use embodied-carbon factors for avoided manufacture and are suitable for inclusion in circular economy and ESG reporting.'
        : 'This passport is being finalised. Figures are indicative until Material Reuse Group marks the passport as verified.'}${x.carbonEstimated || x.weightEstimated ? ' Carbon and/or weight are category-based estimates pending measured figures.' : ''}</div>`,
  });
}

/* ---- admin passports ---- */
const AMF = { search: '', status: 'all' };
RENDER.adminMaterials = async () => {
  const m = await meta();
  const { materials } = await api(`/api/admin/materials?search=${encodeURIComponent(AMF.search)}&status=${AMF.status}`);
  if (!ADMIN.members.length) ADMIN = { ...ADMIN, ...(await api('/api/admin/members')) };
  $('#view').innerHTML = `
    <div class="tagline-strip"><span>${materials.length} material passport${materials.length === 1 ? '' : 's'} — warehouse stock and client recoveries.</span>
      <button class="btn btn-green btn-sm" onclick="materialModal()">New passport</button></div>
    <div class="filters" style="margin-top:18px">
      <input id="amSearch" placeholder="Search name, ref, owner, project…" value="${esc(AMF.search)}" onkeydown="if(event.key==='Enter')amFilter()">
      <select id="amStatus" onchange="amFilter()"><option value="all">Any status</option>${optList(m.materialStatuses, AMF.status)}</select>
      <button class="btn btn-primary btn-sm" onclick="amFilter()">Search</button>
    </div>
    <div class="card" style="margin-top:16px">
      ${materials.length ? `<table><tr><th>Passport</th><th>Category</th><th>Owner / project</th><th>Qty</th><th>Status</th><th>CO₂e</th><th>Value</th><th></th></tr>
        ${materials.map((x) => `<tr>
          <td><b>${esc(x.name)}</b><br><span class="small muted">${esc(x.ref)}${x.passportVerified ? ' · ✓ verified' : ''}</span></td>
          <td class="small">${esc(x.category)}</td>
          <td class="small">${esc(x.ownerName)}${x.projectName ? `<br><span class="muted">${esc(x.projectName)}</span>` : ''}</td>
          <td>${x.quantity}</td><td>${statusPill(x.status)}</td>
          <td>${fmtKg(x.carbonSavedKg || 0)}</td><td>${x.valueGBP ? fmtGBP(x.valueGBP) : '—'}</td>
          <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="openMaterial('${esc(x.id)}')">View</button>
            <button class="btn btn-ghost btn-sm" onclick="materialModal('${esc(x.id)}')">Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="downloadQR('${esc(x.id)}','${esc(x.ref)}')">QR</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteMaterial('${esc(x.id)}')">Delete</button></td></tr>`).join('')}</table>`
        : '<div class="empty">No passports yet.</div>'}
    </div>`;
};
function amFilter() { AMF.search = $('#amSearch').value; AMF.status = $('#amStatus').value; go('adminMaterials'); }

let MAT_PHOTOS = [];
async function materialModal(id, preset = {}) {
  const m = await meta();
  if (!ADMIN.members || !ADMIN.members.length) ADMIN = { ...ADMIN, ...(await api('/api/admin/members')) };
  const x = id ? (await api('/api/materials/' + id)).material : { status: 'Recovered', condition: 'Good', unit: 'items', quantity: 1, dateRecovered: todayStr(), photos: [], ...preset };
  MAT_PHOTOS = (x.photos || []).slice();
  const ownerId = x.userId || '';
  const projects = ownerId ? (await api('/api/projects?userId=' + ownerId)).projects : [];
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal modal-lg">
      <button class="close" onclick="closeModal()">✕</button>
      <h3>${id ? 'Edit passport ' + esc(x.ref) : 'New material passport'}</h3>
      <p class="m-sub">Passports are permanent records. Marking one <b>Rehomed</b> or <b>Recycled</b> adds its carbon, weight and value to the owner’s impact figures automatically.</p>
      <div class="form-grid">
        <div style="grid-column:1/-1"><label>Material / item name</label><input id="mpName" value="${esc(x.name || '')}" placeholder="e.g. Herman Miller Aeron task chairs"></div>
        <div><label>Category</label><input id="mpCat" list="mpCats" value="${esc(x.category || '')}" placeholder="e.g. Seating"><datalist id="mpCats">${m.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div><label>Status</label><select id="mpStatus">${optList(m.materialStatuses, x.status)}</select></div>
        <div><label>Quantity</label><input id="mpQty" type="number" min="0" step="1" value="${x.quantity ?? 1}"></div>
        <div><label>Unit</label><input id="mpUnit" value="${esc(x.unit || 'items')}" placeholder="items, m², tiles, linear m"></div>
        <div><label>Condition</label><select id="mpCond">${optList(['Excellent', 'Good', 'Fair', 'For recycling'], x.condition || 'Good')}</select></div>
        <div><label>Owner (client)</label><select id="mpOwner" onchange="mpOwnerChanged()"><option value="">MRG warehouse stock</option>${ADMIN.members.map((u) => `<option value="${u.id}" ${u.id === ownerId ? 'selected' : ''}>${esc(u.name)}${u.organisation ? ' — ' + esc(u.organisation) : ''}</option>`).join('')}</select></div>
        <div><label>Project</label><select id="mpProject"><option value="">— none —</option>${projects.map((p) => `<option value="${p.id}" ${p.id === x.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div><label>Source project (text)</label><input id="mpSrcP" value="${esc(x.sourceProject || '')}"></div>
        <div><label>Source building / site</label><input id="mpSrcB" value="${esc(x.sourceBuilding || '')}"></div>
        <div><label>Date recovered</label><input id="mpRec" type="date" value="${esc(x.dateRecovered || todayStr())}"></div>
        <div><label>Date rehomed</label><input id="mpReh" type="date" value="${esc(x.dateRehomed || '')}"></div>
        <div style="grid-column:1/-1"><label>Reuse destination</label><input id="mpDest" value="${esc(x.reuseDestination || '')}" placeholder="Where it went — e.g. Community hub, Hackney"></div>
        <div style="grid-column:1/-1"><label>Description</label><input id="mpDesc" value="${esc(x.description || '')}"></div>
      </div>
      <div class="m-section"><h4>Impact & value</h4><span class="m-hint">Leave carbon/weight at 0 and we estimate from the category — shown as “estimated” until you enter real figures</span></div>
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr">
        <div><label>CO₂e saved (kg)${x.carbonEstimated ? ' <span class="pill pill-yellow" style="font-size:9px">estimated</span>' : ''}</label><input id="mpCo2" type="number" step="0.1" min="0" value="${x.carbonSavedKg || 0}"></div>
        <div><label>Weight (kg)${x.weightEstimated ? ' <span class="pill pill-yellow" style="font-size:9px">estimated</span>' : ''}</label><input id="mpW" type="number" step="0.1" min="0" value="${x.weightKg || 0}"></div>
        <div><label>Indicative value (£)</label><input id="mpVal" type="number" step="0.01" min="0" value="${x.valueGBP || 0}"></div>
        <div><label>Client saving (£)</label><input id="mpSav" type="number" step="0.01" min="0" value="${x.savingsGBP || 0}"></div>
      </div>
      <button type="button" class="row-add" onclick="estimateFromCategory()">Estimate carbon & weight from category</button>
      <div class="m-section"><h4>Photos</h4><span class="m-hint">JPG/PNG up to 10 MB each</span></div>
      <div id="mpPhotos" class="mp-thumbs edit">${mpPhotoThumbs()}</div>
      <label class="upload-btn">+ Add photos<input type="file" accept="image/*" multiple onchange="mpAddPhotos(this)"></label>
      <label class="check-line" style="margin-top:14px"><input type="checkbox" id="mpVer" ${x.passportVerified ? 'checked' : ''}> Passport checked and verified by MRG</label>
      <div class="modal-actions">
        <button class="btn btn-primary" onclick="saveMaterial(${id ? `'${id}'` : 'null'})">Save passport</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  </div>`;
}
async function estimateFromCategory() {
  try {
    const e = await api(`/api/admin/factors?category=${encodeURIComponent($('#mpCat').value)}&qty=${parseFloat($('#mpQty').value) || 1}`);
    $('#mpCo2').value = e.carbonSavedKg; $('#mpW').value = e.weightKg;
    toast(`Estimated from ${e.source}: ${e.kgCO2ePerUnit} kg CO₂e and ${e.kgPerUnit} kg per item`);
  } catch (err) { toast(err.message); }
}
function mpPhotoThumbs() { return MAT_PHOTOS.map((p, i) => `<span><img src="${esc(p.url)}" alt=""><button type="button" class="row-del" onclick="MAT_PHOTOS.splice(${i},1);$('#mpPhotos').innerHTML=mpPhotoThumbs()">✕</button></span>`).join('') || '<span class="small muted">No photos yet</span>'; }
async function mpAddPhotos(input) {
  const owner = $('#mpOwner').value || state.user.id;
  for (const f of input.files) {
    try { const up = await uploadFile(f, owner); MAT_PHOTOS.push({ url: up.url, key: up.key, name: up.name }); toast(`Uploaded ${f.name}`); }
    catch (e) { toast(e.message); }
  }
  $('#mpPhotos').innerHTML = mpPhotoThumbs(); input.value = '';
}
async function mpOwnerChanged() {
  const owner = $('#mpOwner').value;
  const projects = owner ? (await api('/api/projects?userId=' + owner)).projects : [];
  $('#mpProject').innerHTML = `<option value="">— none —</option>${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}`;
}
async function saveMaterial(id) {
  const body = {
    name: $('#mpName').value.trim(), category: $('#mpCat').value.trim() || 'Other', status: $('#mpStatus').value,
    quantity: parseFloat($('#mpQty').value) || 0, unit: $('#mpUnit').value.trim() || 'items', condition: $('#mpCond').value,
    userId: $('#mpOwner').value || null, projectId: $('#mpProject').value || null,
    sourceProject: $('#mpSrcP').value.trim(), sourceBuilding: $('#mpSrcB').value.trim(),
    dateRecovered: $('#mpRec').value, dateRehomed: $('#mpReh').value || '', reuseDestination: $('#mpDest').value.trim(),
    description: $('#mpDesc').value.trim(), carbonSavedKg: parseFloat($('#mpCo2').value) || 0, weightKg: parseFloat($('#mpW').value) || 0,
    valueGBP: parseFloat($('#mpVal').value) || 0, savingsGBP: parseFloat($('#mpSav').value) || 0, photos: MAT_PHOTOS, passportVerified: $('#mpVer').checked,
  };
  if (!body.name) return toast('Give the material a name');
  try {
    if (id) await api('/api/admin/materials/' + id, { method: 'PATCH', body });
    else await api('/api/admin/materials', { method: 'POST', body });
    closeModal(); toast('Passport saved'); go(state.page);
  } catch (e) { toast(e.message); }
}
async function deleteMaterial(id) {
  if (!confirm('Delete this passport? Any impact it contributed is removed too.')) return;
  try { await api('/api/admin/materials/' + id, { method: 'DELETE' }); toast('Passport deleted'); go(state.page); } catch (e) { toast(e.message); }
}

/* =====================================================================
   2. PROJECT DASHBOARDS
   ===================================================================== */
function openProject(id) { state.projectId = id; go('project'); }

const stageTracker = (stages, stage, compact = false) => `<div class="stages ${compact ? 'compact' : ''}">${stages.map((s, i) => `
  <div class="stage ${i < stage ? 'done' : ''} ${i === stage ? 'now' : ''}"><i>${i < stage ? '✓' : i + 1}</i><span>${esc(s)}</span></div>`).join('')}</div>`;

RENDER.projects = async () => {
  const g = state.tier.gates;
  if (!g.projects) { $('#view').innerHTML = upgradeNote('Projects & audits', 'Community Free Membership'); return; }
  const m = await meta();
  const { projects } = await api('/api/projects?userId=' + state.user.id);
  $('#view').innerHTML = `
    <div class="tagline-strip">
      <span>Need a pre-refurbishment audit? Your partner rate includes Lawmens strip-out at 5% off.</span>
      <button class="btn btn-green btn-sm" onclick="go('offer')">Offer materials from a project</button>
    </div>
    ${projects.length ? projects.map((p) => `
      <div class="card proj-card" style="margin-top:16px">
        <div class="order-head">
          <div><h4>${esc(p.name)}</h4>
            <div class="meta">${esc(p.type)}${p.site ? ' · ' + esc(p.site) : ''}${p.auditRef ? ' · Audit ref ' + esc(p.auditRef) : ''} · ${fmtDate(p.started)} → ${fmtDate(p.target)}</div></div>
          <div style="display:flex;gap:8px;align-items:center">${statusPill(p.status)}<button class="btn btn-primary btn-sm" onclick="openProject('${p.id}')">Open dashboard</button></div>
        </div>
        ${p.summary ? `<p class="small" style="margin-bottom:12px">${esc(p.summary)}</p>` : ''}
        ${stageTracker(m.stages, p.stage || 0, true)}
        <div class="order-foot" style="margin-top:12px">
          <span><span class="k">Passports</span><b>${p.materialsCount || 0}</b></span>
          <span><span class="k">Documents</span><b>${(p.documents || []).length}</b></span>
          <span><span class="k">CO₂e avoided</span><b>${fmtKg(p.carbonSavedKg || 0)}</b></span>
        </div>
      </div>`).join('')
      : `<div class="card" style="margin-top:16px"><div class="empty">No projects yet — offer materials from a strip-out and we’ll set the project up for you.</div></div>`}`;
};

RENDER.project = async () => {
  const id = state.projectId;
  if (!id) return go('projects');
  const isAdmin = state.user.role === 'admin';
  const d = await api('/api/projects/' + id);
  const p = d.project, t = d.impact.totals;
  $('#pageTitle').textContent = p.name;
  $('#pageCrumb').textContent = `${isAdmin ? 'Admin portal' : 'Member portal'} / Projects & Audits / ${p.name}`;
  const done = (d.materials || []).filter((x) => ['Rehomed', 'Recycled'].includes(x.status)).length;
  $('#view').innerHTML = `
    <div class="tagline-strip">
      <span><b>${esc(p.name)}</b>${p.site ? ' — ' + esc(p.site) : ''} · ${esc(p.type)}</span>
      <button class="btn btn-green btn-sm" onclick="go('${isAdmin ? 'adminMember' : 'orders'}')">Back</button>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="order-head"><h3>Project lifecycle</h3>${statusPill(p.status)}</div>
      ${stageTracker(p.stages, p.stage || 0)}
      <div class="passport-grid" style="margin-top:16px">
        <div class="f"><b>Site</b><span>${esc(p.site || '—')}</span></div>
        <div class="f"><b>Address</b><span>${esc(p.address || '—')}</span></div>
        <div class="f"><b>Client</b><span>${esc(p.client || state.user.organisation || '—')}</span></div>
        <div class="f"><b>Audit reference</b><span>${esc(p.auditRef || '—')}</span></div>
        <div class="f"><b>Started</b><span>${fmtDate(p.started)}</span></div>
        <div class="f"><b>Target completion</b><span>${fmtDate(p.target)}</span></div>
      </div>
      ${p.summary ? `<p class="small" style="margin-top:12px">${esc(p.summary)}</p>` : ''}
    </div>

    <div class="grid cols-4" style="margin-top:18px">
      <div class="card stat"><span class="stripe" style="background:var(--green)"></span><div class="lbl">CO₂e avoided</div><div class="big">${fmtKg(t.kgCO2e)}</div><div class="sub">Feeds your organisation-wide report</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--azul)"></span><div class="lbl">Items rehomed</div><div class="big">${t.items.toLocaleString('en-GB')}</div><div class="sub">${done} of ${d.materials.length} passports rehomed</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--yellow)"></span><div class="lbl">Diverted from waste</div><div class="big">${t.weightKg ? fmtT(t.weightKg) : '—'}</div><div class="sub">${t.reuseRate === null ? 'Weights not yet recorded' : `Reuse rate ${pct(t.reuseRate)}`}</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--orange)"></span><div class="lbl">Value retained</div><div class="big">${t.valueGBP ? fmtGBP(t.valueGBP) : '—'}</div><div class="sub">${t.savingsGBP ? `+ ${fmtGBP(t.savingsGBP)} saved` : 'Indicative material value'}</div></div>
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <div class="card">
        <div class="order-head"><h3>Materials & passports</h3><span class="small muted">${d.materials.length}</span></div>
        ${d.materials.length ? d.materials.slice(0, 12).map((x) => `<div class="doc-row" style="cursor:pointer" onclick="openMaterial('${esc(x.id)}')">
          <span class="t">${esc(x.name)}<span>${esc(x.ref)} · ${x.quantity} ${esc(x.unit || 'items')} · ${fmtKg(x.carbonSavedKg || 0)} CO₂e</span></span>${statusPill(x.status)}</div>`).join('')
          + (d.materials.length > 12 ? `<p class="small muted" style="margin-top:8px">+ ${d.materials.length - 12} more in the passport library</p>` : '')
          : '<div class="empty">No passports linked yet — they appear here once materials from this project are logged.</div>'}
        ${d.outcomes.length ? `<div class="order-foot" style="margin-top:12px">${d.outcomes.map((o) => `<span><span class="k">${esc(o.status)}</span><b>${o.count}</b></span>`).join('')}</div>` : ''}
      </div>
      <div>
        <div class="card">
          <h3 style="margin-bottom:10px">Upcoming collections</h3>
          ${d.upcoming.length ? d.upcoming.map((c) => `<div class="doc-row"><span class="t">${esc(c.type)} — ${fmtDate(c.date)}<span>${esc(c.note || '')}</span></span><span class="pill pill-blue">Scheduled</span></div>`).join('')
            : (d.orders.some((o) => !['Collected', 'Delivered'].includes(o.status)) ? d.orders.filter((o) => !['Collected', 'Delivered'].includes(o.status)).map((o) => `<div class="doc-row"><span class="t">${esc(o.id)}<span>${esc(o.slot)}</span></span>${statusPill(o.status)}</div>`).join('') : '<div class="empty">Nothing scheduled.</div>')}
        </div>
        <div class="card" style="margin-top:16px">
          <h3 style="margin-bottom:10px">Audit & requests</h3>
          ${p.auditRef ? `<div class="doc-row"><span class="t">Audit ${esc(p.auditRef)}<span>${esc(p.type)}</span></span><span class="pill pill-navy">On file</span></div>` : ''}
          ${d.requests.length ? d.requests.map((r) => `<div class="doc-row"><span class="t">${esc(r.id)} — ${r.materials.length} material line${r.materials.length === 1 ? '' : 's'}<span>Requested ${fmtDate(r.createdAt)}${r.desiredDate ? ' · collection ' + fmtDate(r.desiredDate) : ''}</span></span>${statusPill(r.status)}</div>`).join('') : ''}
          ${!p.auditRef && !d.requests.length ? '<div class="empty">No audit or material requests logged.</div>' : ''}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="order-head"><h3>Project documents</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="docModal('${p.id}')">Upload a document</button>
          <button class="btn btn-primary btn-sm" onclick="evidencePack('${p.id}')">Download evidence pack</button></div></div>
      ${d.documents.length ? d.documents.map(docRowHTML).join('') : '<div class="empty">No documents yet — audits, inventories, handover photos and reports will collect here.</div>'}
    </div>

    <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
      ${!isAdmin ? `<button class="btn btn-green" onclick="state.offerProject='${p.id}';go('offer')">Offer materials from this project</button>` : ''}
      <button class="btn btn-primary" onclick="impactDoc({projectId:'${p.id}'})">Download impact report (PDF)</button>
      <button class="btn btn-ghost" onclick="downloadBlob('/api/impact/export.csv?projectId=${p.id}','${esc(p.name.replace(/[^\w]+/g, '-'))}-impact.csv')">Export CSV</button>
    </div>`;
};

/* ---- Orders & Collections now also shows material requests (offered materials) ---- */
const _ordersBase = RENDER.orders;
RENDER.orders = async () => {
  await _ordersBase();
  const { requests, statuses } = await api('/api/requests');
  $('#view').insertAdjacentHTML('afterbegin', `
    <div class="tagline-strip" style="margin-bottom:16px"><span>Warehouse orders, collections and the materials you’ve offered us — all in one place.</span>
      <button class="btn btn-green btn-sm" onclick="go('offer')">Offer materials</button></div>
    ${requests.length ? `<h3 class="section-title">Materials you’ve offered (${requests.length})</h3>${requests.map((r) => requestCard(r, statuses)).join('')}<h3 class="section-title" style="margin-top:24px">Warehouse orders</h3>` : ''}`);
};

/* =====================================================================
   3. DOCUMENTS & EVIDENCE VAULT
   ===================================================================== */
const DOCF = { search: '', category: 'all', projectId: '' };
function docRowHTML(d) {
  const own = state.user.role === 'admin' || d.userId === state.user.id;
  return `<div class="doc-row">
    <span class="t">${esc(d.name)}<span>${esc(d.category)}${d.projectName ? ' · ' + esc(d.projectName) : ''} · ${fmtDate(d.date)}${d.uploadedBy ? ' · ' + esc(d.uploadedBy) : ''}${d.note ? ' · ' + esc(d.note) : ''}</span></span>
    <span style="display:flex;gap:6px">${d.url ? `<a class="btn btn-ghost btn-sm" href="${esc(d.url)}" target="_blank" rel="noopener">Open</a>` : '<span class="pill pill-yellow">On file with MRG</span>'}
    ${own ? `<button class="btn btn-ghost btn-sm" onclick="deleteDoc('${d.id}')">Delete</button>` : ''}</span></div>`;
}
RENDER.documents = async () => {
  const [{ documents, categories }, { projects }] = await Promise.all([
    api(`/api/documents?search=${encodeURIComponent(DOCF.search)}&category=${encodeURIComponent(DOCF.category)}&projectId=${DOCF.projectId}`),
    state.tier.gates.projects ? api('/api/projects?userId=' + state.user.id) : Promise.resolve({ projects: [] }),
  ]);
  const byCat = categories.map((c) => [c, documents.filter((d) => d.category === c).length]).filter(([, n]) => n);
  $('#view').innerHTML = `
    <div class="tagline-strip"><span>Your evidence vault — audits, assessments, inventories, handover photos, invoices and impact reports in one place.</span>
      <button class="btn btn-green btn-sm" onclick="docModal()">Upload a document</button></div>
    <div class="filters" style="margin-top:18px">
      <input id="dfSearch" placeholder="Search documents…" value="${esc(DOCF.search)}" onkeydown="if(event.key==='Enter')docFilter()">
      <select id="dfCat" onchange="docFilter()"><option value="all">All categories</option>${optList(categories, DOCF.category)}</select>
      ${projects.length ? `<select id="dfProj" onchange="docFilter()"><option value="">All projects</option>${projects.map((p) => `<option value="${p.id}" ${p.id === DOCF.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      <button class="btn btn-primary btn-sm" onclick="docFilter()">Search</button>
    </div>
    <div class="grid cols-2" style="margin-top:16px;grid-template-columns:2fr 1fr">
      <div class="card">
        <h3 style="margin-bottom:10px">${documents.length} document${documents.length === 1 ? '' : 's'}</h3>
        ${documents.length ? documents.map(docRowHTML).join('') : '<div class="empty">Nothing here yet. Upload audits, photos or invoices — or they’ll appear as MRG adds them to your projects.</div>'}
      </div>
      <div>
        <div class="card"><h3 style="margin-bottom:10px">By category</h3>
          ${byCat.length ? byCat.map(([c, n]) => `<div class="cat-row"><span class="name">${esc(c)}</span><span class="track"><span class="fill" style="width:${(n / documents.length) * 100}%"></span></span><span class="val">${n}</span></div>`).join('') : '<div class="empty">—</div>'}</div>
        ${projects.length ? `<div class="card" style="margin-top:16px"><h3 style="margin-bottom:10px">Evidence packs</h3>
          <p class="small muted" style="margin-bottom:10px">A complete branded pack per project: summary, lifecycle, impact figures, passports and document index.</p>
          ${projects.map((p) => `<div class="doc-row"><span class="t">${esc(p.name)}<span>${(p.documents || []).length} document${(p.documents || []).length === 1 ? '' : 's'}</span></span><button class="btn btn-ghost btn-sm" onclick="evidencePack('${p.id}')">Download</button></div>`).join('')}</div>` : ''}
      </div>
    </div>`;
};
function docFilter() { DOCF.search = $('#dfSearch').value; DOCF.category = $('#dfCat').value; DOCF.projectId = $('#dfProj') ? $('#dfProj').value : ''; go('documents'); }

async function docModal(projectId = '', forUserId = null) {
  const m = await meta();
  const owner = forUserId || state.user.id;
  const projects = (state.user.role === 'admin' || state.tier.gates.projects) ? (await api('/api/projects?userId=' + owner)).projects : [];
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="close" onclick="closeModal()">✕</button>
      <h3>Upload a document</h3>
      <p class="m-sub">PDFs, images or spreadsheets up to 10 MB. Leave the file empty to log a document MRG holds on your behalf.</p>
      <div class="form-grid">
        <div style="grid-column:1/-1"><label>Document name</label><input id="dmName" placeholder="e.g. Pre-refurbishment audit — Floor 3"></div>
        <div><label>Category</label><select id="dmCat">${optList(m.docCategories, 'Other')}</select></div>
        <div><label>Date</label><input id="dmDate" type="date" value="${todayStr()}"></div>
        ${projects.length ? `<div style="grid-column:1/-1"><label>Project</label><select id="dmProj"><option value="">— not linked to a project —</option>${projects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}
        <div style="grid-column:1/-1"><label>Note</label><input id="dmNote" placeholder="Optional"></div>
        <div style="grid-column:1/-1"><label>File</label><input id="dmFile" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.docx" onchange="if(this.files[0]&&!$('#dmName').value)$('#dmName').value=this.files[0].name.replace(/\\.[^.]+$/,'')"></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary" id="dmSave" onclick="saveDoc('${owner}')">Save document</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  </div>`;
}
async function saveDoc(owner) {
  const name = $('#dmName').value.trim(); if (!name) return toast('Give the document a name');
  const btn = $('#dmSave'); btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    let f = null;
    const file = $('#dmFile').files[0];
    if (file) f = await uploadFile(file, owner);
    await api('/api/documents', { method: 'POST', body: { userId: owner, name, category: $('#dmCat').value, date: $('#dmDate').value,
      projectId: $('#dmProj') ? $('#dmProj').value || null : null, note: $('#dmNote').value, url: f ? f.url : null, key: f ? f.key : null, size: f ? f.size : 0, mime: f ? f.mime : '' } });
    closeModal(); toast('Document saved'); go(state.page);
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Save document'; }
}
async function deleteDoc(id) {
  if (!confirm('Delete this document?')) return;
  try { await api('/api/documents/' + id, { method: 'DELETE' }); toast('Document deleted'); go(state.page); } catch (e) { toast(e.message); }
}

async function evidencePack(pid) {
  const d = await api(`/api/projects/${pid}/pack`);
  const p = d.project, t = d.impact.totals;
  brandDoc({
    title: `Material Reuse Group Evidence Pack — ${p.name}`, kicker: 'Project evidence pack', heading: p.name,
    sub: `${esc(p.site || p.type)} · Generated ${fmtDate(todayStr())}`,
    body: `
      <div class="kv">
        <div><b>Client</b><span>${esc(p.client || (d.owner && (d.owner.organisation || d.owner.name)) || '—')}</span></div>
        <div><b>Project type</b><span>${esc(p.type)}</span></div>
        <div><b>Site / address</b><span>${esc([p.site, p.address].filter(Boolean).join(', ') || '—')}</span></div>
        <div><b>Audit reference</b><span>${esc(p.auditRef || '—')}</span></div>
        <div><b>Dates</b><span>${fmtDate(p.started)} → ${fmtDate(p.target)}</span></div>
        <div><b>Status</b><span>${esc(p.status)} — stage ${(p.stage || 0) + 1} of 6: ${esc(p.stages[p.stage || 0])}</span></div>
      </div>
      <div class="stages">${p.stages.map((s, i) => `<span class="${i <= (p.stage || 0) ? 'on' : ''}">${esc(s)}</span>`).join('')}</div>
      ${p.summary ? `<p style="margin-top:8px;font-size:11.5px;line-height:1.55">${esc(p.summary)}</p>` : ''}
      <div class="sec-t">Impact summary</div>
      ${kpiTiles([['CO₂e avoided', `${t.kgCO2e.toLocaleString('en-GB')} kg`, 'Embodied carbon retained'], ['Items rehomed', t.items.toLocaleString('en-GB'), 'Diverted from waste'],
        ['Weight diverted', t.weightKg ? fmtT(t.weightKg) : '—', `Reuse rate ${pct(t.reuseRate)}`], ['Value retained', t.valueGBP ? fmtGBP(t.valueGBP) : '—', t.savingsGBP ? `+ ${fmtGBP(t.savingsGBP)} saved` : '']])}
      ${d.impact.byCategory.length ? `<table style="margin-top:8px"><tr><th>Material category</th><th></th><th style="text-align:right">Items</th><th style="text-align:right">kg CO₂e</th></tr>
        ${d.impact.byCategory.map((c) => `<tr><td>${esc(c.category)}</td><td style="width:40%"><div class="bar"><i style="width:${Math.max(2, (c.kg / (d.impact.byCategory[0].kg || 1)) * 100)}%"></i></div></td><td class="num">${c.items}</td><td class="num">${c.kg.toLocaleString('en-GB')}</td></tr>`).join('')}</table>` : ''}
      <div class="sec-t">Material passports (${d.materials.length})</div>
      ${d.materials.length ? `<table><tr><th>Ref</th><th>Material</th><th>Category</th><th style="text-align:right">Qty</th><th>Condition</th><th>Status</th><th>Destination</th><th style="text-align:right">kg CO₂e</th></tr>
        ${d.materials.map((x) => `<tr><td>${esc(x.ref)}</td><td>${esc(x.name)}</td><td>${esc(x.category)}</td><td class="num">${x.quantity}</td><td>${esc(x.condition || '—')}</td><td>${esc(x.status)}</td><td>${esc(x.reuseDestination || '—')}</td><td class="num">${(x.carbonSavedKg || 0).toLocaleString('en-GB')}</td></tr>`).join('')}</table>`
        : '<p class="small">No passports linked to this project yet.</p>'}
      <div class="sec-t">Document index (${d.documents.length})</div>
      ${d.documents.length ? `<table><tr><th>Document</th><th>Category</th><th>Date</th><th>Held</th></tr>
        ${d.documents.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.category)}</td><td>${fmtDate(x.date)}</td><td>${x.url ? 'Portal (download)' : 'MRG on file'}</td></tr>`).join('')}</table>` : '<p class="small">No documents logged yet.</p>'}
      ${(p.collections || []).length ? `<div class="sec-t">Collections</div><table><tr><th>Date</th><th>Type</th><th>Note</th><th>Status</th></tr>
        ${p.collections.map((c) => `<tr><td>${fmtDate(c.date)}</td><td>${esc(c.type)}</td><td>${esc(c.note || '')}</td><td>${c.done ? 'Completed' : 'Scheduled'}</td></tr>`).join('')}</table>` : ''}
      ${d.requests.length ? `<div class="sec-t">Material requests</div><table><tr><th>Request</th><th>Submitted</th><th>Lines</th><th>Status</th></tr>
        ${d.requests.map((r) => `<tr><td>${esc(r.id)}</td><td>${fmtDate(r.createdAt)}</td><td>${r.materials.length}</td><td>${esc(r.status)}</td></tr>`).join('')}</table>` : ''}
      <div class="verify" style="margin-top:8mm">${d.carbonMeta.verified
        ? `Impact figures for this client have been independently verified${d.carbonMeta.verifier ? ` by <b>${esc(d.carbonMeta.verifier)}</b>` : ''}. Carbon values use embodied-carbon factors for avoided manufacture, calculated per passport.`
        : 'Impact figures are calculated per material passport using embodied-carbon factors for avoided manufacture. Contact your account manager to arrange independent verification.'}</div>
      <div class="signrow"><div class="sign"><div class="line"></div><span>Material Reuse Group</span><b>Prepared by</b></div><div class="sign"><div class="line"></div><span>${fmtDate(todayStr())}</span><b>Date</b></div></div>`,
  });
}

/* =====================================================================
   4. OFFER MATERIALS / ARRANGE CLEARANCE
   ===================================================================== */
let OFFER_PHOTOS = [];
const CONDITIONS = ['Excellent', 'Good', 'Fair', 'For recycling'];
const offerRow = (cats, x = {}) => `
  <div class="row-line" style="grid-template-columns:1.6fr 1fr 80px 90px 120px 1fr 44px">
    <input class="of-name" value="${esc(x.name || '')}" placeholder="e.g. Task chairs">
    <input class="of-cat" list="ofCats" value="${esc(x.category || '')}" placeholder="Category">
    <input class="of-qty" type="number" min="1" value="${x.qty || 1}">
    <input class="of-unit" value="${esc(x.unit || 'items')}">
    <select class="of-cond">${optList(CONDITIONS, x.condition || 'Good')}</select>
    <input class="of-notes" value="${esc(x.notes || '')}" placeholder="Notes — sizes, quantities per floor…">
    <button type="button" class="row-del" onclick="delRow(this)">✕</button>
  </div>`;
function addOfferRow() { addRowHTML('#ofRows', offerRow(META ? META.categories : [])); }

RENDER.offer = async () => {
  const m = await meta();
  const g = state.tier.gates;
  const [{ projects }, { requests, statuses }] = await Promise.all([
    g.projects ? api('/api/projects?userId=' + state.user.id) : Promise.resolve({ projects: [] }),
    api('/api/requests'),
  ]);
  const pre = state.offerProject || ''; state.offerProject = null;
  const selected = pre && projects.some((p) => p.id === pre) ? pre : (projects.length ? projects[0].id : '__new');
  OFFER_PHOTOS = [];
  $('#view').innerHTML = `
    <div class="tagline-strip"><span>Have materials coming out of a strip-out, refit or clearance? Tell us what’s there and we’ll arrange recovery, passports and rehoming.</span>
      <button class="btn btn-green btn-sm" onclick="document.getElementById('ofForm').scrollIntoView({behavior:'smooth'})">Start a request</button></div>

    ${requests.length ? `<p class="small muted" style="margin-top:14px">You have ${requests.length} request${requests.length === 1 ? '' : 's'} — track them under <a href="#" onclick="go('orders');return false">Orders & Collections</a>.</p>` : ''}

    <div class="card" id="ofForm" style="margin-top:24px">
      <h3 style="margin-bottom:4px">Offer materials / arrange a clearance</h3>
      <p class="small muted" style="margin-bottom:16px">Every request is tracked here from <b>Submitted</b> through to <b>Rehomed</b>. Our team reviews within two working days.</p>
      <div class="form-grid">
        <div style="grid-column:1/-1"><label>Which project?</label>
          <select id="ofProject" onchange="$('#ofNewProj').style.display=this.value==='__new'?'':'none'">
            ${projects.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.site ? ' — ' + esc(p.site) : ''}</option>`).join('')}
            <option value="__new" ${selected === '__new' ? 'selected' : ''}>${projects.length ? '+ A new project / site' : 'A new project / site'}</option>
          </select></div>
        <div id="ofNewProj" style="grid-column:1/-1;display:${selected === '__new' ? '' : 'none'}"><div class="form-grid" style="grid-template-columns:1fr 1fr 1fr">
          <div><label>Project name</label><input id="ofPName" placeholder="e.g. Bishopsgate Level 4 clearance"></div>
          <div><label>Site / building</label><input id="ofPSite" placeholder="e.g. 120 Bishopsgate"></div>
          <div><label>Client / organisation</label><input id="ofPClient" value="${esc(state.user.organisation || '')}"></div></div></div>
        <div style="grid-column:1/-1"><label>Collection location (full address)</label><input id="ofLoc" placeholder="Where the materials are now"></div>
        <div><label>Preferred collection date</label><input id="ofDate" type="date" min="${todayStr()}"></div>
        <div><label>Access / timing notes</label><input id="ofNotes" placeholder="e.g. Goods lift, out-of-hours only"></div>
      </div>

      <div class="m-section"><h4>What’s available</h4><span class="m-hint">One line per material type</span></div>
      <div class="row-head" style="grid-template-columns:1.6fr 1fr 80px 90px 120px 1fr 44px"><span>Material</span><span>Category</span><span>Qty</span><span>Unit</span><span>Condition</span><span>Notes</span><span></span></div>
      <datalist id="ofCats">${m.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="row-editor" id="ofRows">${offerRow(m.categories)}${offerRow(m.categories)}</div>
      <button type="button" class="row-add" onclick="addOfferRow()">+ Add another material</button>

      <div class="m-section"><h4>Photos</h4><span class="m-hint">Helps us assess condition and quantities — up to 10 MB each</span></div>
      <div id="ofPhotos" class="mp-thumbs edit"><span class="small muted">No photos yet</span></div>
      <label class="upload-btn">+ Add photos<input type="file" accept="image/*" multiple onchange="ofAddPhotos(this)"></label>

      <div class="modal-actions" style="margin-top:20px">
        <button class="btn btn-primary" id="ofSubmit" onclick="submitOffer()">Submit request</button>
        <span class="small muted">You’ll see status updates here and on your dashboard.</span>
      </div>
    </div>`;
};
async function ofAddPhotos(input) {
  for (const f of input.files) {
    try { const up = await uploadFile(f); OFFER_PHOTOS.push({ url: up.url, key: up.key, name: up.name }); } catch (e) { toast(e.message); }
  }
  $('#ofPhotos').innerHTML = OFFER_PHOTOS.map((p, i) => `<span><img src="${esc(p.url)}" alt=""><button type="button" class="row-del" onclick="OFFER_PHOTOS.splice(${i},1);ofAddPhotos({files:[],value:''})">✕</button></span>`).join('') || '<span class="small muted">No photos yet</span>';
  input.value = '';
}
async function submitOffer() {
  const rows = Array.from(document.querySelectorAll('#ofRows .row-line')).map((r) => ({
    name: r.querySelector('.of-name').value.trim(), category: r.querySelector('.of-cat').value.trim() || 'Other',
    qty: parseInt(r.querySelector('.of-qty').value, 10) || 1, unit: r.querySelector('.of-unit').value.trim() || 'items',
    condition: r.querySelector('.of-cond').value, notes: r.querySelector('.of-notes').value.trim(),
  })).filter((x) => x.name);
  if (!rows.length) return toast('Add at least one material');
  if (!$('#ofLoc').value.trim()) return toast('Tell us where the materials are');
  const sel = $('#ofProject').value;
  const body = { materials: rows, location: $('#ofLoc').value.trim(), desiredDate: $('#ofDate').value || null, notes: $('#ofNotes').value.trim(), photos: OFFER_PHOTOS };
  if (sel === '__new') {
    if (!$('#ofPName').value.trim()) return toast('Give the new project a name');
    body.newProject = { name: $('#ofPName').value.trim(), site: $('#ofPSite').value.trim(), client: $('#ofPClient').value.trim(), address: $('#ofLoc').value.trim() };
  } else body.projectId = sel;
  const btn = $('#ofSubmit'); btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const { request } = await api('/api/requests', { method: 'POST', body });
    toast(`Request ${request.id} submitted — we’ll be in touch`); go('offer');
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Submit request'; }
}
function requestCard(r, statuses) {
  const steps = statuses.filter((s) => s !== 'Declined');
  const idx = r.status === 'Declined' ? -1 : steps.indexOf(r.status);
  return `<div class="card" style="margin-bottom:12px">
    <div class="order-head">
      <div><h4>${esc(r.id)} — ${esc(r.projectName || 'New project')}</h4>
        <div class="meta">${r.materials.length} material line${r.materials.length === 1 ? '' : 's'} · ${esc(r.location)} · submitted ${fmtDate(r.createdAt)}${r.desiredDate ? ' · collection wanted ' + fmtDate(r.desiredDate) : ''}</div></div>
      ${statusPill(r.status)}
    </div>
    ${r.status === 'Declined' ? '' : `<div class="stages compact">${steps.map((s, i) => `<div class="stage ${i < idx ? 'done' : ''} ${i === idx ? 'now' : ''}"><i>${i < idx ? '✓' : i + 1}</i><span>${esc(s)}</span></div>`).join('')}</div>`}
    <div class="order-lines" style="margin-top:10px">${r.materials.map((x) => `${x.qty} ${esc(x.unit)} × ${esc(x.name)} <span class="muted">(${esc(x.condition)})</span>`).join(' &nbsp;·&nbsp; ')}</div>
    ${r.adminNote ? `<p class="small" style="margin-top:8px"><b>From MRG:</b> ${esc(r.adminNote)}</p>` : ''}
    ${r.projectId ? `<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="openProject('${r.projectId}')">Open project dashboard</button></div>` : ''}
  </div>`;
}

/* ---- admin queue ---- */
RENDER.adminRequests = async () => {
  const { requests, statuses } = await api('/api/admin/requests');
  const open = requests.filter((r) => !['Rehomed', 'Declined'].includes(r.status));
  $('#view').innerHTML = `
    <div class="tagline-strip"><span>${open.length} open material request${open.length === 1 ? '' : 's'} — review, accept, arrange collection, then convert to passports.</span></div>
    ${requests.length ? requests.map((r) => `
      <div class="card" style="margin-top:16px">
        <div class="order-head">
          <div><h4>${esc(r.id)} — ${esc(r.memberName)}${r.memberOrg ? ' · ' + esc(r.memberOrg) : ''}</h4>
            <div class="meta">${esc(r.projectName || 'New project')} · ${esc(r.location)} · submitted ${fmtDate(r.createdAt)}${r.desiredDate ? ' · wants collection ' + fmtDate(r.desiredDate) : ''}</div></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select onchange="setRequestStatus('${r.id}',this.value)">${optList(statuses, r.status)}</select>
            ${r.projectId ? `<button class="btn btn-ghost btn-sm" onclick="openProject('${r.projectId}')">Project</button>` : ''}
            ${!r.passportsCreated && ['Accepted', 'Collection arranged', 'Collected', 'Rehomed'].includes(r.status) ? `<button class="btn btn-primary btn-sm" onclick="createPassports('${r.id}')">Create passports</button>` : (r.passportsCreated ? '<span class="pill pill-green">Passports created</span>' : '')}
          </div>
        </div>
        <table style="margin-top:4px"><tr><th>Material</th><th>Category</th><th>Qty</th><th>Condition</th><th>Notes</th></tr>
          ${r.materials.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.category)}</td><td>${x.qty} ${esc(x.unit)}</td><td>${esc(x.condition)}</td><td class="small">${esc(x.notes || '')}</td></tr>`).join('')}</table>
        ${r.notes ? `<p class="small" style="margin-top:8px"><b>Member notes:</b> ${esc(r.notes)}</p>` : ''}
        ${r.photos.length ? `<div class="mp-thumbs" style="margin-top:10px">${r.photos.map((p) => `<img src="${esc(p.url)}" alt="" onclick="window.open('${esc(p.url)}','_blank')">`).join('')}</div>` : ''}
        <div class="form-grid" style="margin-top:12px;grid-template-columns:1fr auto;align-items:end">
          <div><label>Note to member</label><input id="an-${r.id}" value="${esc(r.adminNote || '')}" placeholder="Shown on their request — e.g. Van booked for Thursday 9am"></div>
          <button class="btn btn-ghost btn-sm" onclick="saveRequestNote('${r.id}')">Save note</button>
        </div>
        <p class="small muted" style="margin-top:8px">History: ${r.history.map((h) => `${esc(h.status)} (${fmtDate(h.date)})`).join(' → ')}</p>
      </div>`).join('') : '<div class="card" style="margin-top:16px"><div class="empty">No material requests yet — they arrive here when members use “Offer Materials”.</div></div>'}`;
};
async function setRequestStatus(id, status) {
  try { await api('/api/admin/requests/' + id, { method: 'PATCH', body: { status } }); toast(`Marked ${status}`); go('adminRequests'); } catch (e) { toast(e.message); }
}
async function saveRequestNote(id) {
  try { await api('/api/admin/requests/' + id, { method: 'PATCH', body: { adminNote: $('#an-' + id).value } }); toast('Note saved'); } catch (e) { toast(e.message); }
}
async function createPassports(id) {
  try { const { materials } = await api(`/api/admin/requests/${id}/passports`, { method: 'POST' }); toast(`${materials.length} passport${materials.length === 1 ? '' : 's'} created — add photos, weights and carbon on the Passports page`); go('adminRequests'); } catch (e) { toast(e.message); }
}

/* =====================================================================
   5. IMPACT & ESG REPORTING CENTRE
   ===================================================================== */
const IMPF = { projectId: '', site: '', from: '', to: '' };
const impQS = (f = IMPF) => new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v))).toString();

RENDER.impact = async () => {
  const g = state.tier.gates;
  if (!g.impactCentre) { $('#view').innerHTML = upgradeNote('The Impact & ESG Reporting Centre', 'Corporate Reuse Partnership'); return; }
  const [imp, { projects }, { sites }] = await Promise.all([api('/api/impact?' + impQS()), api('/api/projects?userId=' + state.user.id), api('/api/sites')]);
  const t = imp.totals, maxM = Math.max(...imp.monthly.map((m) => m.kg), 1), maxC = Math.max(...imp.byCategory.map((c) => c.kg), 1);
  const monthName = (m) => new Date(m + '-01').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  $('#view').innerHTML = `
    <div class="tagline-strip"><span>Board-ready reuse, waste and carbon figures — every number traces back to a passport, order or verified entry.</span>
      <div style="display:flex;gap:8px"><button class="btn btn-green btn-sm" onclick="impactDoc()">PDF report</button><button class="btn btn-ghost btn-sm" style="border-color:#fff;color:#fff" onclick="downloadBlob('/api/impact/export.csv?${impQS()}','mrg-impact.csv')">CSV</button></div></div>
    <div class="filters" style="margin-top:18px">
      <select id="ifProj" onchange="impFilter()"><option value="">All projects</option>${projects.map((p) => `<option value="${p.id}" ${p.id === IMPF.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <select id="ifSite" onchange="impFilter()"><option value="">All sites</option>${optList(sites, IMPF.site)}</select>
      <input id="ifFrom" type="date" value="${IMPF.from}" onchange="impFilter()" title="From">
      <input id="ifTo" type="date" value="${IMPF.to}" onchange="impFilter()" title="To">
      ${(IMPF.projectId || IMPF.site || IMPF.from || IMPF.to) ? `<button class="btn btn-ghost btn-sm" onclick="Object.assign(IMPF,{projectId:'',site:'',from:'',to:''});go('impact')">Clear</button>` : ''}
    </div>
    <div class="grid cols-4" style="margin-top:16px">
      <div class="card stat"><span class="stripe" style="background:var(--green)"></span><div class="lbl">CO₂e avoided</div><div class="big">${fmtKg(t.kgCO2e)}</div><div class="sub">${imp.meta.verified ? `✓ Verified — ${esc(imp.meta.verifier || 'independently')}` : 'From product passport data'}</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--azul)"></span><div class="lbl">Items rehomed</div><div class="big">${t.items.toLocaleString('en-GB')}</div><div class="sub">Materials reused / recovered</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--yellow)"></span><div class="lbl">Diverted from waste</div><div class="big">${t.weightKg ? fmtT(t.weightKg) : '—'}</div><div class="sub">${t.weightKg ? `${t.tonnesDiverted} tonnes by weight` : 'Weights recorded per passport'}</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--orange)"></span><div class="lbl">Value retained</div><div class="big">${t.valueGBP ? fmtGBP(t.valueGBP) : '—'}</div><div class="sub">Indicative material value</div></div>
    </div>
    <div class="grid cols-4" style="margin-top:14px">
      <div class="card stat"><div class="lbl">Reuse rate</div><div class="big">${pct(t.reuseRate)}</div><div class="sub">Share reused vs recycled</div></div>
      <div class="card stat"><div class="lbl">Recycling rate</div><div class="big">${pct(t.recycleRate)}</div><div class="sub">Where reuse wasn’t possible</div></div>
      <div class="card stat"><div class="lbl">Procurement & disposal savings</div><div class="big">${t.savingsGBP ? fmtGBP(t.savingsGBP) : '—'}</div><div class="sub">${t.savingsGBP ? 'Where recorded on passports' : 'No savings data recorded yet'}</div></div>
      <div class="card stat"><div class="lbl">Equivalent to</div><div class="big" style="font-size:20px">${imp.equivalents.carMiles.toLocaleString('en-GB')} car miles</div><div class="sub">${imp.equivalents.treeYears.toLocaleString('en-GB')} tree-years of absorption</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:18px">
      <div class="card"><h3 style="margin-bottom:6px">Monthly CO₂e avoided</h3>
        ${imp.monthly.length ? `<div class="bar-chart">${imp.monthly.slice(-12).map((m) => `<div class="bar"><span>${m.kg ? fmtKg(m.kg) : ''}</span><i style="height:${Math.max(3, (m.kg / maxM) * 100)}%"></i><b>${monthName(m.month)}</b></div>`).join('')}</div>` : '<div class="empty">No activity in this period yet.</div>'}</div>
      <div class="card"><h3 style="margin-bottom:14px">By material category</h3>
        ${imp.byCategory.length ? imp.byCategory.slice(0, 10).map((c) => `<div class="cat-row"><span class="name">${esc(c.category)}</span><span class="track"><span class="fill" style="width:${(c.kg / maxC) * 100}%"></span></span><span class="val">${fmtKg(c.kg)}</span></div>`).join('') : '<div class="empty">Nothing to show yet.</div>'}</div>
    </div>
    <div class="card" style="margin-top:18px"><h3 style="margin-bottom:10px">By project</h3>
      ${imp.byProject.length ? `<table><tr><th>Project</th><th>Site</th><th>Items</th><th>Weight</th><th>CO₂e</th><th>Value</th><th>Savings</th><th></th></tr>
        ${imp.byProject.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="small">${esc(p.site || '—')}</td><td>${p.items.toLocaleString('en-GB')}</td><td>${p.weightKg ? fmtT(p.weightKg) : '—'}</td><td>${fmtKg(p.kg)}</td><td>${p.valueGBP ? fmtGBP(p.valueGBP) : '—'}</td><td>${p.savingsGBP ? fmtGBP(p.savingsGBP) : '—'}</td>
          <td>${p.projectId ? `<button class="btn btn-ghost btn-sm" onclick="openProject('${p.projectId}')">Open</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No project activity in this period.</div>'}</div>
    ${imp.meta.wlcaModules ? `<div class="card" style="margin-top:18px"><h3 style="margin-bottom:10px">WLCA module breakdown (kg CO₂e)</h3>
      <table><tr><th>Module</th><th>Impact</th></tr>${Object.entries(imp.meta.wlcaModules).map(([k, v]) => `<tr><td>${esc(k)}</td><td style="font-weight:700;color:${v < 0 ? '#B42318' : '#1d7a05'}">${v < 0 ? '+' : '−'}${fmtKg(Math.abs(v))}</td></tr>`).join('')}</table>
      <p class="small muted" style="margin-top:10px">A1–A3 manufacture avoided by reuse; A4 transport added; Module D end-of-life benefits. Suitable for BREEAM Mat 06 / GLA circular economy reporting.</p></div>` : ''}
    <p class="small muted" style="margin-top:14px">${t.events} underlying entries in this view. Export the CSV for the line-by-line ledger.</p>`;
};
function impFilter() { IMPF.projectId = $('#ifProj').value; IMPF.site = $('#ifSite').value; IMPF.from = $('#ifFrom').value; IMPF.to = $('#ifTo').value; go('impact'); }

async function impactDoc(filters = IMPF) {
  const imp = await api('/api/impact?' + impQS(filters));
  const t = imp.totals, u = state.user;
  const proj = filters.projectId ? imp.byProject.find((p) => p.projectId === filters.projectId) : null;
  const scope = proj ? proj.name : filters.site ? `${filters.site} (all projects)` : 'All projects';
  const period = filters.from || filters.to ? `${filters.from ? fmtDate(filters.from) : 'Start'} – ${filters.to ? fmtDate(filters.to) : fmtDate(todayStr())}` : (imp.monthly.length ? `${fmtDate(imp.monthly[0].month + '-01')} – ${fmtDate(todayStr())}` : 'To date');
  const maxM = Math.max(...imp.monthly.map((m) => m.kg), 1), maxC = Math.max(...imp.byCategory.map((c) => c.kg), 1);
  const monthLong = (m) => new Date(m + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  brandDoc({
    title: `Material Reuse Group Impact & ESG Report — ${u.organisation || u.name}`, kicker: imp.meta.verified ? 'Independently verified' : 'Impact & ESG reporting',
    heading: 'Impact & ESG Report', sub: `${esc(scope)} · ${esc(period)} · Issued ${fmtDate(todayStr())}`,
    body: `
      <div class="cert"><div class="lead">Reuse impact delivered for</div><div class="name">${esc(u.organisation || u.name)}</div>
        <div class="bigv">${t.kgCO2e.toLocaleString('en-GB')} kg CO₂e</div>
        <p class="capt">of embodied carbon avoided through the reuse and recovery of materials with Material Reuse Group — ${t.items.toLocaleString('en-GB')} items kept in use${t.weightKg ? ` and ${fmtT(t.weightKg)} diverted from the waste stream` : ''}.</p>
        <span class="period">${esc(period)}</span></div>
      <div class="sec-t">Headline figures</div>
      ${kpiTiles([['Items rehomed', t.items.toLocaleString('en-GB'), 'Materials reused / recovered'], ['Diverted from waste', t.weightKg ? fmtT(t.weightKg) : '—', `Reuse rate ${pct(t.reuseRate)} · recycling ${pct(t.recycleRate)}`],
        ['Value retained', t.valueGBP ? fmtGBP(t.valueGBP) : '—', 'Indicative material value'], ['Savings to client', t.savingsGBP ? fmtGBP(t.savingsGBP) : '—', 'Procurement / disposal avoided']])}
      <div class="cols" style="margin-top:8mm">
        <div><div class="sec-t" style="margin-top:0">Monthly CO₂e avoided</div>${imp.monthly.length ? `<table><tr><th>Month</th><th style="width:34%"></th><th style="text-align:right">kg</th></tr>
          ${imp.monthly.slice(-12).map((m) => `<tr><td>${monthLong(m.month)}</td><td><div class="bar"><i style="width:${Math.max(2, (m.kg / maxM) * 100)}%"></i></div></td><td class="num">${m.kg.toLocaleString('en-GB')}</td></tr>`).join('')}</table>` : '<p class="small">No activity in this period.</p>'}</div>
        <div><div class="sec-t" style="margin-top:0">By material category</div>${imp.byCategory.length ? `<table><tr><th>Category</th><th style="width:34%"></th><th style="text-align:right">kg</th></tr>
          ${imp.byCategory.slice(0, 10).map((c) => `<tr><td>${esc(c.category)}</td><td><div class="bar"><i style="width:${Math.max(2, (c.kg / maxC) * 100)}%"></i></div></td><td class="num">${c.kg.toLocaleString('en-GB')}</td></tr>`).join('')}</table>` : '<p class="small">—</p>'}</div>
      </div>
      ${imp.byProject.length > 1 || !proj ? `<div class="sec-t">By project</div><table><tr><th>Project</th><th>Site</th><th style="text-align:right">Items</th><th style="text-align:right">Weight kg</th><th style="text-align:right">kg CO₂e</th><th style="text-align:right">Value £</th></tr>
        ${imp.byProject.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.site || '—')}</td><td class="num">${p.items}</td><td class="num">${p.weightKg || '—'}</td><td class="num">${p.kg.toLocaleString('en-GB')}</td><td class="num">${p.valueGBP ? p.valueGBP.toLocaleString('en-GB') : '—'}</td></tr>`).join('')}</table>` : ''}
      ${imp.meta.wlcaModules ? `<div class="sec-t">Whole-life carbon assessment modules</div><table><tr><th>Module</th><th style="text-align:right">kg CO₂e</th></tr>
        ${Object.entries(imp.meta.wlcaModules).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num" style="color:${v < 0 ? '#B42318' : '#1d7a05'}">${v < 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-GB')}</td></tr>`).join('')}</table>
        <p class="small" style="margin-top:6px">A1–A3 manufacture avoided by reuse; A4 transport added; Module D end-of-life benefits. Suitable for BREEAM Mat 06 / GLA circular economy reporting.</p>` : ''}
      <div class="sec-t">Methodology & assurance</div>
      <div class="verify">${imp.meta.verified ? `These figures have been independently verified${imp.meta.verifier ? ` by <b>${esc(imp.meta.verifier)}</b>` : ''}. ` : ''}Every figure in this report traces to an individual entry in the Material Reuse Group impact ledger — a material passport marked rehomed, a warehouse order collected, or a verified adjustment — using embodied-carbon factors for avoided manufacture. Equivalents: ${imp.equivalents.carMiles.toLocaleString('en-GB')} average petrol-car miles · ${imp.equivalents.treeYears.toLocaleString('en-GB')} tree-years of absorption. ${t.events} ledger entries underpin this report.</div>
      <div class="signrow"><div class="sign"><div class="line"></div><span>${imp.meta.verified && imp.meta.verifier ? esc(imp.meta.verifier) : 'Material Reuse Group'}</span><b>${imp.meta.verified ? 'Independent verifier' : 'Issued by'}</b></div><div class="sign"><div class="line"></div><span>${fmtDate(todayStr())}</span><b>Date of issue</b></div></div>`,
  });
}

/* =====================================================================
   DASHBOARD & ADMIN INTEGRATION (wrap existing renderers)
   ===================================================================== */
const _dashboardBase = RENDER.dashboard;
RENDER.dashboard = async () => {
  await _dashboardBase();
  const g = state.tier.gates;
  const [{ requests }, { total }] = await Promise.all([api('/api/requests'), api('/api/materials?scope=mine')]);
  const open = requests.filter((r) => !['Rehomed', 'Declined'].includes(r.status));
  const strip = $('#view .tagline-strip');
  if (!strip) return;
  strip.insertAdjacentHTML('afterend', `
    <div class="grid cols-3" style="margin-top:18px">
      <div class="card cta-card"><h3>Have materials to offer?</h3><p class="small">Strip-out, refit or clearance coming up? Tell us what’s there and we’ll arrange recovery and rehoming.</p>
        <button class="btn btn-green btn-sm" onclick="go('offer')">Offer materials</button></div>
      <div class="card"><h3 style="margin-bottom:8px">Impact & documents</h3>
        <p class="small muted">Audits, reports and handover evidence live in <a href="#" onclick="go('documents');return false">Documents</a>.${g.impactCentre ? ' Board-ready figures are in <a href="#" onclick="go(\'impact\');return false">Impact & ESG</a>.' : ''}</p>
        <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="go('documents')">Open documents</button></div>
      <div class="card"><h3 style="margin-bottom:8px">Your passports</h3>
        <div class="big" style="font-family:var(--font-head);font-size:28px;font-weight:700">${total}</div>
        <p class="small muted">Materials recovered from your projects with a permanent digital passport.</p>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="MATF.scope='mine';go('materials')">Open library</button>
        ${g.impactCentre ? `<button class="btn btn-ghost btn-sm" style="margin-top:8px;margin-left:6px" onclick="go('impact')">Impact & ESG</button>` : ''}</div>
    </div>`);
};

const _adminOverviewBase = RENDER.adminOverview;
RENDER.adminOverview = async () => {
  await _adminOverviewBase();
  const [imp, { requests }] = await Promise.all([api('/api/admin/impact'), api('/api/admin/requests')]);
  const open = requests.filter((r) => !['Rehomed', 'Declined'].includes(r.status));
  const t = imp.totals;
  const strip = $('#view .tagline-strip');
  if (!strip) return;
  const { sync } = await api('/api/admin/sync');
  strip.insertAdjacentHTML('afterend', `
    <div class="card" style="margin-top:18px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
      <div><h3 style="margin-bottom:4px">Marketplace sync (Airtable / Softr)</h3><p class="small" style="margin-bottom:4px">Every listing added to the marketplace gets a passport and QR code here automatically — edit them on the Passports page.</p>
        <p class="small muted">${sync.enabled
          ? `Every ${sync.intervalMinutes} min · last run ${sync.lastOk ? new Date(sync.lastOk).toLocaleString('en-GB') : 'not yet'} · ${sync.records} listings · ${sync.ordersCreated} orders and ${sync.membersCreated} accounts created this session${sync.lastError ? ` · <span style="color:#B42318">last error: ${esc(sync.lastError)}</span>` : ''}`
          : 'Not connected — add AIRTABLE_TOKEN on Render to pull listings, purchases and reservations automatically.'}
          ${sync.mail ? ' · Email notifications on' : ' · Email notifications off (set RESEND_API_KEY)'}</p></div>
      ${sync.enabled ? `<button class="btn btn-primary btn-sm" id="syncBtn" onclick="runSync()">Sync now</button>` : ''}
    </div>
    <div class="grid cols-4" style="margin-top:16px">
      <div class="card stat"><span class="stripe" style="background:var(--green)"></span><div class="lbl">Open material requests</div><div class="big">${open.length}</div><div class="sub"><a href="#" onclick="go('adminRequests');return false">Review the queue</a></div></div>
      <div class="card stat"><span class="stripe" style="background:var(--azul)"></span><div class="lbl">Diverted from waste</div><div class="big">${t.weightKg ? fmtT(t.weightKg) : '—'}</div><div class="sub">All clients, by recorded weight</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--yellow)"></span><div class="lbl">Value retained</div><div class="big">${t.valueGBP ? fmtGBP(t.valueGBP) : '—'}</div><div class="sub">Indicative, all passports</div></div>
      <div class="card stat"><span class="stripe" style="background:var(--orange)"></span><div class="lbl">Ledger entries</div><div class="big">${t.events}</div><div class="sub">Every figure is traceable</div></div>
    </div>`);
};

const _adminMemberBase = RENDER.adminMember;
RENDER.adminMember = async () => {
  await _adminMemberBase();
  const d = ADMIN.full; if (!d) return;
  const u = d.user;
  $('#view').insertAdjacentHTML('beforeend', `
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <div class="order-head"><h3>Material passports</h3><button class="btn btn-primary btn-sm" onclick="materialModal(null,{userId:'${u.id}'})">New passport</button></div>
        ${d.materials.length ? d.materials.slice(0, 10).map((x) => `<div class="doc-row"><span class="t">${esc(x.name)}<span>${esc(x.ref)} · ${x.quantity} ${esc(x.unit || 'items')} · ${fmtKg(x.carbonSavedKg || 0)}</span></span>
          <span style="display:flex;gap:6px;align-items:center">${statusPill(x.status)}<button class="btn btn-ghost btn-sm" onclick="materialModal('${x.id}')">Edit</button></span></div>`).join('')
          + (d.materials.length > 10 ? `<p class="small muted" style="margin-top:8px">+ ${d.materials.length - 10} more on the Passports page</p>` : '')
          : '<div class="empty">No passports for this member yet.</div>'}
      </div>
      <div class="card">
        <div class="order-head"><h3>Documents</h3><button class="btn btn-primary btn-sm" onclick="docModal('', '${u.id}')">Upload for member</button></div>
        ${d.documents.length ? d.documents.slice(0, 10).map((x) => `<div class="doc-row"><span class="t">${esc(x.name)}<span>${esc(x.category)} · ${fmtDate(x.date)}</span></span>
          <span style="display:flex;gap:6px">${x.url ? `<a class="btn btn-ghost btn-sm" href="${esc(x.url)}" target="_blank" rel="noopener">Open</a>` : ''}<button class="btn btn-ghost btn-sm" onclick="deleteDoc('${x.id}')">Delete</button></span></div>`).join('') : '<div class="empty">No documents yet.</div>'}
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <div class="order-head"><h3>Material requests</h3><div style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="mergeMember('${u.id}')">Merge into another account</button><button class="btn btn-ghost btn-sm" onclick="go('adminRequests')">Open queue</button></div></div>
        ${d.requests.length ? d.requests.map((r) => `<div class="doc-row"><span class="t">${esc(r.id)} — ${r.materials.length} line${r.materials.length === 1 ? '' : 's'}<span>${esc(r.location)} · ${fmtDate(r.createdAt)}</span></span>${statusPill(r.status)}</div>`).join('') : '<div class="empty">No requests from this member.</div>'}
      </div>
      <div class="card">
        <div class="order-head"><h3>Project dashboards</h3></div>
        ${d.projects.length ? d.projects.map((p) => `<div class="doc-row"><span class="t">${esc(p.name)}<span>${esc(p.site || p.type)} · stage ${(p.stage || 0) + 1}/6</span></span>
          <span style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="openProject('${p.id}')">Open</button><button class="btn btn-ghost btn-sm" onclick="collectionModal('${p.id}')">Collections</button></span></div>`).join('') : '<div class="empty">No projects.</div>'}
      </div>
    </div>`);
};

async function runSync() {
  const b = $('#syncBtn'); b.disabled = true; b.textContent = 'Syncing…';
  try { const { sync } = await api('/api/admin/sync', { method: 'POST' }); toast(sync.lastError ? 'Sync failed: ' + sync.lastError : `Synced ${sync.records} listings`); go('adminOverview'); }
  catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Sync now'; }
}

async function mergeMember(id) {
  const mm = (ADMIN.members || []).find((x) => x.id === id) || ADMIN.full.user;
  const email = prompt(`Merge ${mm.name} (${mm.email}) INTO which account? Enter that account's email.\n\nAll orders, projects, passports, documents, requests and impact move across; ${mm.email} is kept as an alternative email and this account is deleted.`);
  if (!email) return;
  if (!confirm(`Merge ${mm.email} into ${email}? This can't be undone.`)) return;
  try { const { user } = await api(`/api/admin/members/${id}/merge`, { method: 'POST', body: { intoEmail: email } }); toast(`Merged into ${user.name}`); openMember(user.id); }
  catch (e) { toast(e.message); }
}

/* ---- admin: project collections ---- */
async function collectionModal(pid) {
  const d = await api('/api/projects/' + pid);
  const cols = d.project.collections || [];
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal">
    <button class="close" onclick="closeModal()">✕</button>
    <h3>Collections — ${esc(d.project.name)}</h3>
    <p class="m-sub">Scheduled collections and deliveries appear on the member’s project dashboard.</p>
    ${cols.length ? cols.map((c) => `<div class="doc-row"><span class="t">${esc(c.type)} — ${fmtDate(c.date)}<span>${esc(c.note || '')}</span></span>
      <span style="display:flex;gap:6px;align-items:center">${c.done ? '<span class="pill pill-green">Done</span>' : `<button class="btn btn-ghost btn-sm" onclick="api('/api/admin/projects/${pid}/collections/${c.id}',{method:'PATCH',body:{done:true}}).then(()=>collectionModal('${pid}'))">Mark done</button>`}
      <button class="btn btn-ghost btn-sm" onclick="api('/api/admin/projects/${pid}/collections/${c.id}',{method:'DELETE'}).then(()=>collectionModal('${pid}'))">✕</button></span></div>`).join('') : '<div class="empty">Nothing scheduled.</div>'}
    <div class="m-section"><h4>Add a collection</h4></div>
    <div class="form-grid" style="grid-template-columns:150px 140px 1fr">
      <div><label>Date</label><input id="clDate" type="date" value="${todayStr()}"></div>
      <div><label>Type</label><select id="clType">${optList(['Collection', 'Delivery', 'Site visit', 'Audit'], 'Collection')}</select></div>
      <div><label>Note</label><input id="clNote" placeholder="e.g. Floors 3–5, goods lift booked"></div>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="api('/api/admin/projects/${pid}/collections',{method:'POST',body:{date:$('#clDate').value,type:$('#clType').value,note:$('#clNote').value}}).then(()=>{toast('Collection added');collectionModal('${pid}')}).catch(e=>toast(e.message))">Add</button>
      <button class="btn btn-ghost" onclick="closeModal();go(state.page)">Close</button></div>
  </div></div>`;
}

/* ---- admin: member editor without derived stats ---- */
editMember = function (id) {
  const mm = ADMIN.members.find((x) => x.id === id); if (!mm) return;
  const tierOpts = ADMIN.tiers.map((t) => `<option value="${t.id}" ${mm.tier === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const am = mm.accountManager || {};
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal">
    <button class="close" onclick="closeModal()">✕</button>
    <h3 style="margin-bottom:6px">Edit ${esc(mm.name)}</h3>
    <p class="m-sub">Carbon saved and items rehomed are worked out automatically from passports and orders — use “Carbon & impact” to add verified entries.</p>
    <div class="form-grid">
      <div><label>Full name</label><input id="emName" value="${esc(mm.name)}"></div>
      <div><label>Email (sign-in)</label><input id="emEmail" value="${esc(mm.email)}"></div>
      <div><label>Membership tier</label><select id="emTier">${tierOpts}</select></div>
      <div><label>Member since</label><input id="emSince" type="date" value="${esc(mm.memberSince || '')}"></div>
      <div><label>Organisation</label><input id="emOrg" value="${esc(mm.organisation || '')}"></div>
      <div><label>Phone</label><input id="emPhone" value="${esc(mm.phone || '')}"></div>
      <div style="grid-column:1/-1"><label>Address</label><input id="emAddr" value="${esc(mm.address || '')}"></div>
      <div><label>Account manager name</label><input id="emAmName" value="${esc(am.name || '')}" placeholder="Corporate tier only"></div>
      <div><label>Account manager email</label><input id="emAmEmail" value="${esc(am.email || '')}"></div>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="saveMember('${mm.id}')">Save changes</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
  </div></div>`;
};
saveMember = async function (id) {
  const amName = $('#emAmName').value.trim();
  const body = { name: $('#emName').value, email: $('#emEmail').value, tier: $('#emTier').value, memberSince: $('#emSince').value,
    organisation: $('#emOrg').value || null, phone: $('#emPhone').value || null, address: $('#emAddr').value || null,
    accountManager: amName ? { name: amName, email: $('#emAmEmail').value || 'kallie@material-reuse.co.uk', phone: '01932 867989' } : null };
  try { await api('/api/admin/members/' + id, { method: 'PATCH', body }); closeModal(); toast('Member updated'); go(state.page); } catch (e) { toast(e.message); }
};

/* ---- admin: carbon & impact editor (verification + ledger) ---- */
editCarbon = async function (id) {
  const mm = ADMIN.members.find((x) => x.id === id); if (!mm) return;
  const [{ events, impact, meta: cm }, { projects }] = await Promise.all([api(`/api/admin/members/${id}/impact`), api('/api/projects?userId=' + id)]);
  const wlca = cm.wlcaModules ? Object.entries(cm.wlcaModules) : [];
  const srcLabel = { order: 'Order', material: 'Passport', manual: 'Manual', legacy: 'Historic' };
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal modal-lg">
    <button class="close" onclick="closeModal()">✕</button>
    <h3>Carbon & impact — ${esc(mm.name)}</h3>
    <p class="m-sub">Their dashboard shows <b>${fmtKg(impact.totals.kgCO2e)} CO₂e</b> and <b>${impact.totals.items.toLocaleString('en-GB')} items</b>, worked out from the entries below. Orders and passports add entries automatically; add a manual entry for anything else (e.g. a verified audit figure).</p>

    <div class="m-section"><h4>Verification</h4><span class="m-hint">Shown on their dashboard and every report</span></div>
    <label class="check-line"><input type="checkbox" id="crVerified" ${cm.verified ? 'checked' : ''}> Figures independently verified</label>
    <div class="form-grid"><div style="grid-column:1/-1"><label>Verified by</label><input id="crVerifier" value="${esc(cm.verifier || '')}" placeholder="e.g. Alphacello — carbon traceability partner"></div></div>
    <div class="m-section"><h4>Whole-life carbon (corporate only)</h4><span class="m-hint">Optional WLCA module lines</span></div>
    <div class="row-editor" id="crWlca">${wlca.map(([k, v]) => wlcaRow(k, v)).join('')}</div>
    <button type="button" class="row-add" onclick="addWlcaRow()">+ Add a WLCA line</button>
    <div class="modal-actions" style="border-top:0;padding-top:8px"><button class="btn btn-primary btn-sm" onclick="saveCarbonMeta('${id}')">Save verification</button></div>

    <div class="m-section"><h4>Add a manual impact entry</h4><span class="m-hint">Counts immediately in their figures</span></div>
    <div class="form-grid" style="grid-template-columns:140px 1fr 1fr">
      <div><label>Date</label><input id="ieDate" type="date" value="${todayStr()}"></div>
      <div><label>Project</label><select id="ieProj"><option value="">— unattributed —</option>${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>Category</label><input id="ieCat" list="ieCats" placeholder="e.g. Office & IT"><datalist id="ieCats">${(META ? META.categories : []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
    </div>
    <div class="form-grid" style="grid-template-columns:repeat(6,1fr)">
      <div><label>CO₂e (kg)</label><input id="ieKg" type="number" step="0.1" min="0" value="0"></div>
      <div><label>Items</label><input id="ieItems" type="number" step="1" min="0" value="0"></div>
      <div><label>Weight (kg)</label><input id="ieW" type="number" step="0.1" min="0" value="0"></div>
      <div><label>Value (£)</label><input id="ieVal" type="number" step="0.01" min="0" value="0"></div>
      <div><label>Savings (£)</label><input id="ieSav" type="number" step="0.01" min="0" value="0"></div>
      <div><label>Route</label><select id="ieRoute"><option value="reuse">Reuse</option><option value="recycle">Recycle</option></select></div>
    </div>
    <div class="form-grid"><div style="grid-column:1/-1"><label>Note</label><input id="ieNote" placeholder="e.g. Verified figure from Q2 audit"></div></div>
    <button type="button" class="row-add" onclick="addImpactEntry('${id}')">+ Add entry</button>

    <div class="m-section"><h4>Impact ledger (${events.length})</h4><span class="m-hint">Manual and historic entries can be removed</span></div>
    ${events.length ? `<div style="max-height:260px;overflow:auto"><table><tr><th>Date</th><th>Source</th><th>Project</th><th>Category</th><th>kg CO₂e</th><th>Items</th><th></th></tr>
      ${events.slice(0, 200).map((e) => `<tr><td class="small">${fmtDate(e.date)}</td><td class="small">${srcLabel[e.source] || e.source}</td><td class="small">${esc(e.projectName || '—')}</td><td class="small">${esc(e.category)}</td><td>${e.kgCO2e}</td><td>${e.items}</td>
        <td>${['manual', 'legacy'].includes(e.source) ? `<button class="btn btn-ghost btn-sm" onclick="deleteImpactEntry('${e.id}','${id}')">✕</button>` : ''}</td></tr>`).join('')}</table></div>` : '<div class="empty">No entries yet.</div>'}
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal();go(state.page)">Close</button></div>
  </div></div>`;
};
async function saveCarbonMeta(id) {
  const wlcaRows = Array.from(document.querySelectorAll('#crWlca .row-line')).map((r) => [r.querySelector('.cw-k').value.trim(), parseFloat(r.querySelector('.cw-v').value) || 0]).filter(([k]) => k);
  const body = { verified: $('#crVerified').checked, verifier: $('#crVerifier').value.trim() || undefined, wlcaModules: wlcaRows.length ? Object.fromEntries(wlcaRows) : undefined };
  try { await api(`/api/admin/members/${id}/carbon`, { method: 'PUT', body }); toast('Verification saved'); } catch (e) { toast(e.message); }
}
async function addImpactEntry(id) {
  const body = { date: $('#ieDate').value, projectId: $('#ieProj').value || null, category: $('#ieCat').value.trim() || 'Manual entry',
    kgCO2e: parseFloat($('#ieKg').value) || 0, items: parseInt($('#ieItems').value, 10) || 0, weightKg: parseFloat($('#ieW').value) || 0,
    valueGBP: parseFloat($('#ieVal').value) || 0, savingsGBP: parseFloat($('#ieSav').value) || 0, route: $('#ieRoute').value, note: $('#ieNote').value.trim() };
  if (!body.kgCO2e && !body.items && !body.weightKg && !body.valueGBP) return toast('Enter at least one figure');
  try { await api(`/api/admin/members/${id}/impact`, { method: 'POST', body }); toast('Entry added'); editCarbon(id); } catch (e) { toast(e.message); }
}
async function deleteImpactEntry(eid, id) {
  try { await api('/api/admin/impact/' + eid, { method: 'DELETE' }); toast('Entry removed'); editCarbon(id); } catch (e) { toast(e.message); }
}

/* ---- admin: project modal with site / client / lifecycle stage ---- */
projectModal = async function (pid) {
  const m = await meta();
  const p = (pid && ADMIN.full.projects.find((x) => x.id === pid)) || {};
  const typeOpts = PROJECT_TYPES.map((t) => `<option ${p.type === t ? 'selected' : ''}>${t}</option>`).join('') + (p.type && !PROJECT_TYPES.includes(p.type) ? `<option selected>${esc(p.type)}</option>` : '');
  $('#modalRoot').innerHTML = `
  <div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal modal-lg">
    <button class="close" onclick="closeModal()">✕</button>
    <h3>${pid ? 'Edit ' + esc(p.name) : 'Log a project / audit'}</h3>
    <p class="m-sub">This becomes the member’s project dashboard. Carbon and impact figures come from the passports and orders linked to it.</p>
    <div class="form-grid">
      <div style="grid-column:1/-1"><label>Project name</label><input id="pjName" value="${esc(p.name || '')}" placeholder="e.g. HQ office strip-out — Floor 3"></div>
      <div><label>Type</label><select id="pjType">${typeOpts}</select></div>
      <div><label>Status</label><select id="pjStatus">${['Planning', 'In progress', 'Complete'].map((s) => `<option ${p.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Site / building</label><input id="pjSite" value="${esc(p.site || '')}" placeholder="e.g. 88 Leadenhall Street"></div>
      <div><label>Address</label><input id="pjAddr" value="${esc(p.address || '')}"></div>
      <div><label>Client</label><input id="pjClient" value="${esc(p.client || '')}" placeholder="Organisation name"></div>
      <div><label>Audit reference</label><input id="pjRef" value="${esc(p.auditRef || '')}" placeholder="Optional — e.g. AUD-2026-101"></div>
      <div><label>Started</label><input id="pjStart" type="date" value="${esc(p.started || todayStr())}"></div>
      <div><label>Target date</label><input id="pjTarget" type="date" value="${esc(p.target || '')}"></div>
      <div style="grid-column:1/-1"><label>Lifecycle stage</label><select id="pjStage">${m.stages.map((s, i) => `<option value="${i}" ${(p.stage || 0) === i ? 'selected' : ''}>${i + 1}. ${esc(s)}</option>`).join('')}</select></div>
      <div style="grid-column:1/-1"><label>Summary (shown to member)</label><input id="pjSummary" value="${esc(p.summary || '')}" placeholder="One or two sentences about the project"></div>
    </div>
    <div class="m-section"><h4>Documents held by MRG</h4><span class="m-hint">Listed in the member’s vault — upload actual files from the member’s page</span></div>
    <div class="row-head" style="grid-template-columns:1fr 180px 160px 44px"><span>Document name</span><span>Category</span><span>Date</span><span></span></div>
    <div class="row-editor" id="pjDocs">${(p.documents || []).filter((d) => !d.url).map((d) => docRow(d)).join('')}</div>
    <button type="button" class="row-add" onclick="addDocRow()">+ Add a document</button>
    <div class="modal-actions"><button class="btn btn-primary" onclick="saveProject(${pid ? `'${pid}'` : 'null'})">Save project</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
  </div></div>`;
};
saveProject = async function (pid) {
  const documents = Array.from(document.querySelectorAll('#pjDocs .row-line')).map((r, i) => ({
    id: r.dataset.id || `DOC-${Date.now()}-${i}`, name: r.querySelector('.dc-name').value.trim(),
    type: r.querySelector('.dc-type').value.trim() || 'Other', date: r.querySelector('.dc-date').value || todayStr() })).filter((d) => d.name);
  const body = { name: $('#pjName').value, type: $('#pjType').value, status: $('#pjStatus').value, site: $('#pjSite').value, address: $('#pjAddr').value,
    client: $('#pjClient').value, auditRef: $('#pjRef').value || undefined, started: $('#pjStart').value, target: $('#pjTarget').value || null,
    stage: parseInt($('#pjStage').value, 10) || 0, summary: $('#pjSummary').value, documents };
  try {
    if (pid) await api('/api/admin/projects/' + pid, { method: 'PATCH', body });
    else await api(`/api/admin/members/${ADMIN.currentId}/projects`, { method: 'POST', body });
    closeModal(); toast('Project saved'); go('adminMember');
  } catch (e) { toast(e.message); }
};
