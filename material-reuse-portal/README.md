# material reuse — Member Portal

A fully branded customer portal for Material Reuse's subscription system.
From 'waste' to worth — members track materials, orders, projects and carbon savings in one place.

## Run it

No installs needed — just Node.js (v16+):

```bash
node backend/server.js
```

Then open **http://localhost:4173** and pick a demo member account.

## Demo accounts (one per tier)

| Member | Tier | What you'll see |
|---|---|---|
| Maya Okafor | **Domestic Free** | Browse-only warehouse, 1 shopping list, locked carbon/projects |
| Tom Hartley | **Domestic Plus** | Early access stock, reservations, personal carbon dashboard |
| Priya Nair (Peckham Tool Library) | **Community** | Community projects, downloadable carbon reports, 5% discount |
| Daniel Whitmore (Garnetfield Workspace) | **Corporate Reuse Partner** | Pre-demo audits, donation lots, verified carbon (Alphacello), WLCA data, account manager |

## What's included

- **Dashboard** — carbon saved, items rehomed, active orders, new stock
- **Online Warehouse** — live inventory with search/filters, full **product passports** (SKU, condition, source, lifecycle stage, carbon data, QR code), early-access gating
- **Orders & Collections** — reservations, collection/delivery slots, donation lots
- **Shopping Lists** — per-project lists with live stock checks, cost and carbon totals
- **Carbon Reporting** — monthly savings chart, category breakdown, equivalents, WLCA modules (corporate)
- **Projects & Audits** — GLA pre-demolition audits, resource management plans, circular economy statements, document library
- **Membership & Billing** — all four tiers with live switch/upgrade, invoices, payment info
- **Account Settings** — profile editing, notification toggles

## Structure

```
material-reuse-portal/
├── backend/
│   ├── server.js          # zero-dependency Node API + static server
│   └── data/              # demo data (tiers, users, inventory, orders, lists, carbon, projects)
└── frontend/
    ├── index.html
    ├── css/portal.css     # full brand system
    ├── js/app.js          # SPA logic, tier gating, product passports
    └── assets/logo.svg    # recreated ring mark
```

## Branding

- Colours: Ultra Azul `#1653F3`, Navy `#06183F`, Hi-Vis Green `#9EFF51`, Yellow `#FFED4D`, Orange `#FF883A`, Cream `#FFD5BD`, Sage `#E5FFCF`
- Type: **Geologica** (headings) + **Quicksand** (body — free substitute for Urbane Rounded; swap in the licensed font via `--font-body` in `portal.css`)
- Logo: SVG recreation of the segmented green ring mark

## Notes

- Demo data lives in `backend/data/*.json` — edit freely; changes made in the app (reservations, list edits, tier switches) are in-memory and reset on restart.
- API is plain REST (`/api/tiers`, `/api/inventory`, `/api/orders`, `/api/lists`, `/api/carbon`, `/api/projects`, `/api/users`) — ready to swap onto a real database/auth later.
