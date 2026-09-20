// Local stand-ins for Airtable (items, Orders, Wishlist), Stripe, Twilio and Anthropic — one port, in memory.
// Run:  node tests/mock-services.js   then start the server with *_API env vars pointing at http://127.0.0.1:4021
const http = require('http');
const T = {
  'Table 1': [
    { id: 'recITEM00000001', createdTime: '2026-09-01T00:00:00Z', fields: { Name: 'Chrome plug sockets', Price: 8, Quantity: 10, Availability: 'Available', Category: 'Electrical', 'Item Type': 'Plug Socket', 'Carbon Emissions': '2 kg CO₂e', BuyURL: 'https://material-reselling.vercel.app/api/checkout?mode=buy&recordId=recITEM00000001', ReserveURL: 'https://material-reselling.vercel.app/api/checkout?mode=deposit&recordId=recITEM00000001' } },
    { id: 'recITEM00000002', createdTime: '2026-09-01T00:00:00Z', fields: { Name: 'Oak boardroom chairs', Price: 40, Quantity: 6, Availability: 'Available', Category: 'Seating', 'Carbon Emissions': '30 kg CO₂e', BuyURL: 'https://material-reselling.vercel.app/api/checkout?mode=buy&recordId=recITEM00000002', ReserveURL: 'https://material-reselling.vercel.app/api/checkout?mode=deposit&recordId=recITEM00000002' } },
  ],
  Orders: [
    { id: 'recORDER0000001', createdTime: '2026-08-20T10:00:00Z', fields: { 'Order ID': 'cs_test_1', Item: ['recITEM00000002'], 'Item Name': 'Oak boardroom chairs', Quantity: 2, 'Unit Price': 40, 'Order Total': 80, 'Amount Paid': 40, 'Balance Due': 40, 'Order Type': 'Deposit / Reserve', 'Buyer Name': 'Tom Buyer', 'Buyer Email': 'tom@example.com', 'Buyer Phone': '07700 900123', 'Order Date': '2026-08-20T10:00:00.000Z', 'Collection Status': 'Awaiting Collection', Source: 'Marketplace' } },
    { id: 'recORDER0000002', createdTime: '2026-08-15T10:00:00Z', fields: { 'Order ID': 'cs_test_2', Item: ['recITEM00000001'], 'Item Name': 'Chrome plug sockets', Quantity: 3, 'Unit Price': 8, 'Order Total': 24, 'Amount Paid': 24, 'Balance Due': 0, 'Order Type': 'Purchase', 'Buyer Name': 'Old Buyer', 'Buyer Email': 'old@example.com', 'Order Date': '2026-08-15T10:00:00.000Z', 'Collection Status': 'Awaiting Collection', Source: 'Marketplace' } },
  ],
  Wishlist: [
    { id: 'recWISH000000001', fields: { Name: 'James Gould', Email: 'jamieggould@gmail.com', Category: 'Seating', Status: 'Active' } },
    { id: 'recWISH000000002', fields: { Name: 'Free Fred', Email: 'fred@example.com', 'Item Type': 'Plug Socket', Status: 'Active', 'Looking For': 'sockets' } },
  ],
};
const log = []; const invoices = {}; const sessions = {}; const subs = {};
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    if (p === '/__log') { res.end(JSON.stringify({ log, T, invoices, sessions, subs })); return; }
    if (p.startsWith('/__pay/')) { invoices[p.split('/')[2]].status = 'paid'; res.end('ok'); return; }
    if (p === '/v1/messages') { const j = JSON.parse(b); if (/Reply ONLY with JSON/.test(j.system)) { log.push({ suggest: j.messages[0].content.slice(0, 80) }); res.end(JSON.stringify({ content: [{ type: 'text', text: '{"price":45,"priceLow":40,"priceHigh":50,"carbonKg":70,"retailNew":180,"reason":"Comparable task chairs sell for £38; 18% above that, well under new price."}' }] })); return; } log.push({ claude: j.messages.slice(-1)[0].content, sys: j.system.length }); const last = j.messages.slice(-1)[0].content; res.end(JSON.stringify({ content: [{ type: 'text', text: /refund/i.test(last) ? 'I’ve passed this to the team — they’ll email you. [ESCALATE: refund requested for ORD-2026-1300]' : 'Mock answer: your order is awaiting collection.' }] })); return; }
    if (p.startsWith('/v1/invoices') && req.method === 'GET' && u.searchParams.get('limit')) { res.end(JSON.stringify({ has_more: false, data: [{ id: 'in_recv1', number: 'MRG-0001', status: 'paid', customer_email: 'tom@example.com', created: Math.floor(Date.now() / 1000) - 600, total: 3200, hosted_invoice_url: 'https://invoice.stripe.com/i/in_recv1', invoice_pdf: 'https://pay.stripe.com/invoice/in_recv1/pdf', lines: { data: [{ description: 'Chrome plug sockets × 4' }] } }] })); return; }
    if (p === '/v1/checkout/sessions' && req.method === 'POST') { const id = 'cs_test_' + Object.keys(sessions).length; const params = Object.fromEntries(new URLSearchParams(b)); sessions[id] = { id, url: 'https://checkout.stripe.com/c/pay/' + id, mode: params.mode, metadata: Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])), payment_status: 'unpaid', status: 'open', customer_email: params.customer_email || null, customer: params.customer || null, amount_total: 0, subscription: null }; log.push({ checkout: params }); res.end(JSON.stringify(sessions[id])); return; }
    if (p === '/v1/checkout/sessions' && req.method === 'GET') { res.end(JSON.stringify({ has_more: false, data: Object.values(sessions).filter((s) => s.status === 'complete') })); return; }
    if (/^\/v1\/checkout\/sessions\/[^/]+\/line_items$/.test(p)) { const id = p.split('/')[4]; res.end(JSON.stringify({ data: [{ quantity: sessions[id].qty || 1 }] })); return; }
    if (/^\/v1\/checkout\/sessions\/[^/]+$/.test(p)) { res.end(JSON.stringify(sessions[p.split('/')[4]] || {})); return; }
    if (p.startsWith('/__paysession/')) { const [, , id, qty, email] = p.split('/'); const s = sessions[id]; s.status = 'complete'; s.payment_status = 'paid'; s.qty = +qty || 1; s.customer_details = { email: decodeURIComponent(email || 'buyer@example.com'), name: 'Session Buyer', phone: '+447700900999' }; const unit = +(s.metadata.unitPrice || 10); s.amount_total = Math.round((s.metadata.mode === 'deposit' ? unit / 2 : unit) * s.qty * 100); if (s.mode === 'subscription') { s.subscription = 'sub_test1'; s.customer = 'cus_test'; subs.sub_test1 = { id: 'sub_test1', status: 'active', customer: 'cus_test', current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400, cancel_at_period_end: false, items: { data: [{ id: 'si_1', price: { id: 'price_' + s.metadata.tierId, lookup_key: 'mrg-' + s.metadata.tierId + '-annual' } }] } }; } res.end('ok'); return; }
    if (p.startsWith('/v1/prices') && req.method === 'GET') { const key = decodeURIComponent((u.searchParams.get('lookup_keys[]') || '')); res.end(JSON.stringify({ data: key ? [{ id: 'price_' + key.replace(/^mrg-|-annual$/g, ''), lookup_key: key }] : [] })); return; }
    if (p.startsWith('/v1/subscriptions/') && req.method === 'GET') { res.end(JSON.stringify(subs[p.split('/')[3]] || { status: 'canceled', items: { data: [] } })); return; }
    if (p.startsWith('/v1/subscriptions/') && req.method === 'POST') { const s = subs[p.split('/')[3]]; const params = Object.fromEntries(new URLSearchParams(b)); log.push({ subUpdate: params }); if (params.cancel_at_period_end === 'true') s.cancel_at_period_end = true; if (params.cancel_at_period_end === 'false') s.cancel_at_period_end = false; if (params['items[0][price]']) s.items.data[0].price = { id: params['items[0][price]'], lookup_key: 'mrg-' + params['items[0][price]'].replace('price_', '') + '-annual' }; res.end(JSON.stringify(s)); return; }
    if (p === '/v1/subscription_schedules' && req.method === 'POST') { log.push({ schedule: b }); res.end(JSON.stringify({ id: 'sched_1', phases: [{ start_date: 1, end_date: 2 }] })); return; }
    if (p.startsWith('/v1/subscription_schedules/')) { log.push({ schedule: b }); res.end(JSON.stringify({ id: 'sched_1' })); return; }
    if (p === '/v1/billing_portal/sessions') { res.end(JSON.stringify({ url: 'https://billing.stripe.com/p/session/test' })); return; }
    if (p.startsWith('/v1/')) { // stripe
      const parts = p.split('/').filter(Boolean); log.push({ stripe: req.method + ' ' + p, body: b });
      if (parts[1] === 'customers' && req.method === 'GET') { res.end(JSON.stringify({ data: [] })); return; }
      if (parts[1] === 'customers') { res.end(JSON.stringify({ id: 'cus_test' })); return; }
      if (parts[1] === 'invoiceitems') { res.end(JSON.stringify({ id: 'ii_test' })); return; }
      if (parts[1] === 'invoices' && parts.length === 2) { const id = 'in_' + Object.keys(invoices).length; invoices[id] = { id, status: 'draft', hosted_invoice_url: 'https://invoice.stripe.com/i/' + id }; res.end(JSON.stringify(invoices[id])); return; }
      if (parts[3] === 'finalize') { invoices[parts[2]].status = 'open'; res.end(JSON.stringify(invoices[parts[2]])); return; }
      if (parts[3] === 'send') { res.end(JSON.stringify(invoices[parts[2]])); return; }
      if (parts[1] === 'invoices' && parts[2]) { res.end(JSON.stringify(invoices[parts[2]])); return; }
      res.end('{}'); return;
    }
    if (p.includes('/Messages.json')) { log.push({ sms: b }); res.end('{"sid":"SM1"}'); return; }
    const parts = p.split('/').filter(Boolean); const table = decodeURIComponent(parts[2] || ''); const id = parts[3];
    if (!T[table]) { res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); return; }
    if (req.method === 'GET' && !id) { res.end(JSON.stringify({ records: T[table] })); return; }
    if (req.method === 'GET' && id) { res.end(JSON.stringify(T[table].find((x) => x.id === id))); return; }
    if (req.method === 'PATCH') { const r = T[table].find((x) => x.id === id); Object.assign(r.fields, JSON.parse(b).fields); log.push({ table, id, fields: JSON.parse(b).fields }); res.end(JSON.stringify(r)); return; }
    if (req.method === 'POST') { const rec = { id: 'rec' + Math.random().toString(36).slice(2, 16).padEnd(14, 'x'), createdTime: new Date().toISOString(), fields: JSON.parse(b).records[0].fields }; T[table].push(rec); log.push({ table, create: rec.fields }); res.end(JSON.stringify({ records: [rec] })); return; }
    res.end('{}');
  });
}).listen(4021, () => console.log('mock services on 4021'));
