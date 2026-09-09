/* Small helpers shared by every backend module. */
'use strict';
const today = () => new Date().toISOString().slice(0, 10);
const num = (v, d = 0) => (v === '' || v === null || v === undefined || isNaN(+v)) ? d : +v;
const r1 = (n) => +(+n || 0).toFixed(1);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const gbp = (n) => `£${num(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 864e5;
// form-encode nested objects the way Stripe / Twilio expect (a[b][0][c]=v)
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out); else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}
module.exports = { today, num, r1, esc, norm, gbp, daysSince, formEncode };
