// Renders every page for admin / corporate / free accounts against a running server, using a tiny fake DOM.
// Run:  node tests/smoke-render.js   (server on http://127.0.0.1:4022, or set B)
const vm = require('vm'), fs = require('fs'), path = require('path');
const B = process.env.B || 'http://127.0.0.1:4022';
function el(id) { const e = { id, innerHTML: '', textContent: '', value: '', style: {}, className: '', disabled: false, files: [],
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  insertAdjacentHTML(_, h) { e.innerHTML += h; }, querySelector() { return el('x'); }, querySelectorAll() { return []; }, addEventListener() {}, scrollIntoView() {}, select() {}, getContext() { return { drawImage() {} }; }, toDataURL() { return ''; }, click() {}, appendChild() {}, remove() {}, focus() {}, setAttribute() {}, getAttribute() { return null; }, parentElement: null }; return e; }
const els = {}; const $ = (sel) => { const k = String(sel); if (!els[k]) els[k] = el(k); return els[k]; };
const XFF = process.env.XFF || '';
const ctx = { console, URLSearchParams, fetch: (u, o = {}) => fetch(u.startsWith('http') ? u : B + u, XFF ? { ...o, headers: { ...(o.headers || {}), 'x-forwarded-for': XFF } } : o), URL, setTimeout, clearTimeout, Image: function () { setTimeout(() => this.onload && this.onload(), 1); }, XMLSerializer: function () { return { serializeToString() { return ''; } }; },
  document: { getElementById: (i) => $('#' + i), querySelector: $, querySelectorAll: () => [], createElement: (t) => el(t), body: el('body'), addEventListener() {} },
  window: { open() {}, addEventListener() {} }, location: { pathname: '/', origin: B, href: B + '/' }, history: { replaceState() {}, pushState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: { clipboard: { writeText: async () => {} } }, prompt: () => null, alert() {}, confirm: () => true, JSON, Math, Date, Object, Array, Promise, Number, String, RegExp, Error, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, Intl, Blob: function () {}, Map, Set, requestAnimationFrame: (f) => setTimeout(f, 0), addEventListener() {} };
ctx.window.location = ctx.location; ctx.window.document = ctx.document; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
const fe = path.join(__dirname, '..', 'frontend', 'js');
vm.runInContext(fs.readFileSync(path.join(fe, 'app.js'), 'utf8') + '\n' + fs.readFileSync(path.join(fe, 'features.js'), 'utf8'), ctx);
const ev = (c) => vm.runInContext(c, ctx); const ST = ev('state'); const R = ev('RENDER');
(async () => {
  const login = async (email, password) => { const r = await (await fetch(B + '/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }), headers: { 'content-type': 'application/json', ...(XFF ? { 'x-forwarded-for': XFF } : {}) } })).json(); ev('setToken')(r.token); ST.user = r.user; ST.tier = r.tier; return r; };
  const accounts = [['jamesgould@estaraai.com', 'MRG-James-2026', ['adminOverview', 'adminMembers', 'adminMaterials', 'adminRequests', 'settings']],
    ['jamieggould@gmail.com', 'JAMESGOULD-2026', ['dashboard', 'materials', 'orders', 'projects', 'documents', 'impact', 'membership', 'settings']],
    ['fran@example.com', 'newfranpass123', ['dashboard', 'materials', 'orders', 'membership', 'settings']],
    ['sam@example.com', 'sampass123', ['dashboard', 'materials', 'orders', 'membership', 'settings']],
    ['cara@example.com', 'carapass1234', ['dashboard', 'materials', 'orders', 'projects', 'documents', 'membership', 'settings']]];
  let fails = 0;
  for (const [e, p, pages] of accounts) {
    const r = await login(e, p); if (!r.token) { console.log('login failed', e); fails++; continue; }
    for (const pg of pages) {
      $('#view').innerHTML = '';
      try { await R[pg](); await new Promise((r) => setTimeout(r, 300)); const html = $('#view').innerHTML; const bad = /undefined|NaN|\[object|Offer materials/.test(html) || (/fran@|sam@/.test(e) && /Corporate|Community|LOCKED|kallie@/i.test(html)); console.log(`  ${e.split('@')[0].padEnd(12)} ${pg.padEnd(14)} ${String(html.length).padStart(6)} chars${bad ? '  ⚠ undefined/NaN in output' : ''}`); if (bad) fails++; }
      catch (err) { console.log(`  ${e} ${pg}: ERROR ${err.message}`); fails++; }
    }
    try { await ev('openMaterial')('MR-0001'); await new Promise((r) => setTimeout(r, 400)); const h = $('#modalRoot').innerHTML + $('#scanActions').innerHTML; console.log(`  ${e.split('@')[0]} passport modal: ${/Provenance/.test(h) ? 'history ✓' : 'no history'} ${/>Buy</.test(h) ? 'buy ✓' : ''} ${/Walk-in sale/.test(h) ? 'walk-in ✓' : ''}`); } catch (err) { console.log('  openMaterial ERROR', err.message); fails++; }
    try { ev('mountChat')(); ev('toggleChat')(true); console.log(`  chat panel ${$('#chatPanel').innerHTML.length} chars`); } catch (err) { console.log('  chat ERROR', err.message); fails++; }
  }
  ev('setToken')(null); await ev('showPublicPassport')('MR-0001'); console.log('  public passport', $('#publicRoot').innerHTML.length, 'chars', /Provenance/.test($('#publicRoot').innerHTML) ? '(history shown)' : '');
  console.log(fails ? `FAILS: ${fails}` : 'ALL RENDERS OK');
})();
