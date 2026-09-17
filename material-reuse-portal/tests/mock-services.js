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
const log = []; const invoices = {};
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    if (p === '/__log') { res.end(JSON.stringify({ log, T, invoices })); return; }
    if (p.startsWith('/__pay/')) { invoices[p.split('/')[2]].status = 'paid'; res.end('ok'); return; }
    if (p === '/v1/messages') { const j = JSON.parse(b); log.push({ claude: j.messages.slice(-1)[0].content, sys: j.system.length }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'Mock answer: your order is awaiting collection.' }] })); return; }
    if (p.startsWith('/v1/invoices') && req.method === 'GET' && u.searchParams.get('limit')) { res.end(JSON.stringify({ has_more: false, data: [{ id: 'in_recv1', number: 'MRG-0001', status: 'paid', customer_email: 'tom@example.com', created: Math.floor(Date.now() / 1000) - 600, total: 3200, hosted_invoice_url: 'https://invoice.stripe.com/i/in_recv1', invoice_pdf: 'https://pay.stripe.com/invoice/in_recv1/pdf', lines: { data: [{ description: 'Chrome plug sockets × 4' }] } }] })); return; }
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
