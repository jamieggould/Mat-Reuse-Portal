# material reuse — Member Portal

A fully branded customer portal for Material Reuse's subscription system.
From 'waste' to worth — members track materials, orders, projects and carbon savings in one place.

## Run it

No installs needed — just Node.js (v16+):

```bash
node backend/server.js
```

Then open **http://localhost:4173** and sign in with email + password.

## Accounts & sign-in

Real authentication: salted PBKDF2 password hashes, session tokens, no self-registration — accounts can only be created by admins on the Members page.

**Admins:**

| Admin | Email | Password |
|---|---|---|
| James Gould | jamesgould@estaraai.com | `MRG-James-2026` |
| Kallie Bell | kallie@material-reuse.co.uk | `MRGKALLIE` |

**Test member (remove before go-live):** James Gould — jamieggould@gmail.com / `JAMESGOULD-2026` — Corporate Reuse Partnership. Committed to `users.json`, so it survives every Render redeploy.

Admins see an **Overview** (totals + member monitor) and a **Members** page: create accounts, edit every personalised field (tier, dashboard stats, account manager, carbon report data), reset passwords, delete accounts.

**Sample members** (all share the temp password `MRG-Member-2026`): Maya Okafor (maya.okafor@example.com, Domestic Free), Tom Hartley (tom.hartley@example.com, Domestic Plus), Priya Nair (priya@peckhamtoolibrary.org, Community Free), Daniel Whitmore (d.whitmore@garnetfieldworkspace.co.uk, Corporate Reuse Partnership).

Tier names, annual prices and the perk matrix come directly from the live membership table; the warehouse inventory is the live marketplace listing.

## What's included

- **Dashboard** — carbon saved, items rehomed, active orders, shopping lists, plus full **carbon reporting** (monthly savings chart, category breakdown, equivalents, WLCA modules for corporate) for tiers that include it
- **Online Warehouse** — the **live Softr marketplace embed** (exact HTML with payment links and reserve rules, Airtable-connected) with the **Join the Wishlist** Airtable form underneath
- **Orders & Collections** — reservations, collection/delivery slots, donation lots
- **Shopping Lists** — per-project lists with live stock checks, cost and carbon totals
- **Projects & Audits** — pre-refurbishment audits, resource management plans, circular economy reports, document library
- **Membership & Billing** — the **live Softr pricing-table embed** (exact HTML incl. payment links) with billing/invoices underneath. Member discount % in orders is a demo assumption — the site lists "Member Discounts" without a figure
- **Account Settings** — profile editing, notification toggles
- **Material Passports** — searchable/filterable library of every recovered material (photos, condition, provenance, carbon, value, QR code), detail view and branded passport PDF. Public deep link: `/passport/<ref>`
- **Offer Materials** — "I have materials" workflow: pick a project (or describe a new one), list materials, location, date, notes, photos → a tracked request (Submitted → Under review → Accepted → Collection arranged → Collected → Rehomed)
- **Project dashboards** — one page per project: site/client/dates, 6-stage lifecycle tracker (Audit → Materials identified → Reuse route → Collection → Rehomed → Impact report), linked passports, upcoming collections, reuse outcomes, impact figures, documents, evidence pack. Deep link: `/project/<id>`
- **Documents & evidence vault** — central document library plus per-project sections; upload (Supabase Storage), categories, dates, project links, and a one-click branded **evidence pack**
- **Impact & ESG Reporting Centre** (Corporate) — filter by project / site / date range: CO₂e avoided, items rehomed, tonnes diverted, reuse & recycling rates, value retained, procurement/disposal savings, monthly and category charts, per-project table, WLCA modules, PDF report and CSV ledger export
- **Admin**: material-request queue (accept → auto-creates the project; arrange → schedules the collection; convert lines to passports), passport editor with photo uploads, carbon & impact editor (verification + manual ledger entries), project lifecycle/site/client editing, collections scheduler, per-member documents

## The impact ledger — one source of truth

Every impact figure in the portal comes from `impactEvents`. An event is written when:
- an order is marked **Collected / Delivered** (one event per line, from product-passport carbon data)
- a material passport is marked **Rehomed / Recycled** (carbon, weight, value and savings from the passport)
- an admin adds a **manual entry** (e.g. a verified audit figure)

Dashboards, project pages, the reporting centre, admin totals and all three PDF reports *read* from this ledger — nothing is typed in twice. Moving a passport back out of "Rehomed" retracts its event. The old per-member carbon reports were migrated into the ledger on first boot (project figures attributed to their projects; the remainder spread across the original months/categories so totals and charts are unchanged). `carbon.json` now holds only verification metadata (verified / verifier / WLCA modules).

## Structure

```
material-reuse-portal/
├── backend/
│   ├── server.js          # zero-dependency Node API + static server, auth, orders, lists, members
│   ├── features.js        # impact ledger, passports, documents, requests, uploads, migrations
│   ├── uploads/           # local-only file storage (used when Supabase isn't configured)
│   └── data/              # seed data — see "Data model" below
└── frontend/
    ├── index.html
    ├── css/portal.css     # full brand system
    ├── js/app.js          # core SPA: login, nav, dashboard, warehouse, orders, lists, billing, admin members
    ├── js/features.js     # passports, projects, documents, offer materials, reporting centre, admin extensions
    └── assets/logo.svg
```

## Data model (collections in `backend/data/*.json` / Supabase `portal_data`)

| Collection | What it holds | New / changed |
|---|---|---|
| `users` | accounts, billing, `carbonSavedKg` / `itemsRehomed` (now **derived caches**, recomputed from the ledger) | changed |
| `projects` | + `site`, `address`, `client`, `contact`, `stage` (0–5), `collections[]`; `progress` derived from stage; `carbonSavedKg` derived; `documents[]` **moved out** | changed |
| `materials` | material passports: `id/ref`, `sku` (link to warehouse stock), `userId` (owner, null = MRG stock), `projectId`, name, category, description, quantity/unit, dimensions, condition, sourceProject/Building, dateRecovered, status, reuseDestination, dateRehomed, carbonSavedKg, weightKg, valueGBP, savingsGBP, photos[], passportVerified, impactEventId | **new** (seeded from inventory) |
| `documents` | `id`, `userId`, `projectId`, name, category, date, url/key (storage), size, mime, note, uploadedBy | **new** (project docs migrated in) |
| `requests` | offer-materials requests: materials[], location, desiredDate, notes, photos[], status, history[], adminNote, projectId / newProject, passportsCreated | **new** |
| `impactEvents` | the ledger: userId, projectId, materialId/orderId, date, category, items, weightKg, kgCO2e, valueGBP, savingsGBP, route (reuse/recycle), source (order/material/manual/legacy), note | **new** |
| `carbon` | per-member `{ verified, verifier, wlcaModules }` only | changed |
| `orders` | + optional `projectId`, `statsApplied` | changed |
| `tiers` | + gates `passports`, `documents`, `offerMaterials`, `impactCentre` | changed |

Migrations run automatically on boot (`features.migrate()`), are idempotent, and persist to Supabase when configured.

## API additions

`GET /api/meta` · `GET /api/materials[?search&category&status&condition&scope=mine|stock]` · `GET /api/materials/:id` · `GET/POST /api/documents` · `DELETE /api/documents/:id` · `GET /api/projects/:id` · `GET /api/projects/:id/pack` · `GET /api/sites` · `GET /api/impact[?projectId&site&from&to]` · `GET /api/impact/export.csv` · `GET/POST /api/requests` · `GET /api/requests/:id` · `POST /api/uploads` (base64 JSON, ≤10 MB)
Admin: `GET /api/admin/requests` · `PATCH /api/admin/requests/:id` · `POST /api/admin/requests/:id/passports` · `GET/POST /api/admin/materials` · `PATCH/DELETE /api/admin/materials/:id` · `GET /api/admin/impact` · `GET/POST/PUT /api/admin/members/:id/impact` · `DELETE /api/admin/impact/:id` · `POST/PATCH/DELETE /api/admin/projects/:id/collections[/:cid]`

## Branding

- Colours: Ultra Azul `#1653F3`, Navy `#06183F`, Hi-Vis Green `#9EFF51`, Yellow `#FFED4D`, Orange `#FF883A`, Cream `#FFD5BD`, Sage `#E5FFCF`
- Type: **Geologica** (headings) + **Inter** (body); swap in the licensed Urbane Rounded via `--font-body` in `portal.css` if preferred
- Design: flat and sharp to match the main site — navy/white, hairline borders, square corners, uppercase labels, hi-vis green used sparingly as an accent
- Logo: the real MRG logo, hotlinked from material-reuse.co.uk (dark version on the login card, white version in the sidebar, real favicon)

## Going live: Supabase (permanent data)

Without this, Render's free tier wipes all signups/orders on every redeploy. With it, everything lives in a free Supabase Postgres database and survives forever.

1. **Create the project** — [supabase.com](https://supabase.com) → New project (free tier is fine). Pick a strong database password and keep it safe.
2. **Create the table** — in your project: SQL Editor → paste and run:

   ```sql
   create table portal_data (
     key text primary key,
     body jsonb not null,
     updated_at timestamptz default now()
   );
   alter table portal_data enable row level security;
   -- no policies on purpose: only the service key (the server) can touch it
   ```

3. **Get the two values** — Project Settings → API:
   - **Project URL** (like `https://abcdefgh.supabase.co`)
   - **service_role key** (under "Project API keys" — the SECRET one, not anon)
4. **Set them on Render** — your service → Environment → add:
   - `SUPABASE_URL` = the project URL
   - `SUPABASE_SERVICE_KEY` = the service_role key
5. **Redeploy.** First boot seeds Supabase from the bundled JSON files (log says `seeded Supabase with: …`). From then on all reads/writes go to Supabase — accounts, orders, stats and stock survive every deploy. You can browse/edit the data any time in Supabase → Table Editor → `portal_data`.

The service key is like a master password — only ever put it in Render's environment settings, never in the code or the repo.

### File uploads: Supabase Storage bucket (one-off)

Photos and documents upload to a Supabase Storage bucket. Create it once:

1. Supabase → **Storage** → **New bucket** → name it exactly `portal-files` → switch **Public bucket** ON → Save.
2. That's it — the server uses the service key to upload/delete, and files are served from the bucket's public URLs.

Without Supabase configured (local dev), files are written to `backend/uploads/` and served from `/uploads/…`.

### Other external bits

- **QR codes** on passports are generated by the free `api.qrserver.com` image service (no key needed). To remove that dependency later, swap `qrUrl()` in `frontend/js/features.js` for a local generator.
- **PDFs** (passport, impact report, evidence pack, carbon report) open as branded print-ready documents with the browser's save-as-PDF dialog — no server PDF library.

## How it all connects

- **Self-signup** on the login page creates **Domestic Free** accounts only (enforced server-side) — paid tiers still come through you/Kallie or the membership enquiry.
- **Live stats**: when an order is marked **Collected/Delivered/Completed**, the member's carbon saved, items rehomed, monthly chart, category breakdown and equivalents all update automatically from product passport data — once per order. Reservations don't count until they're collected.
- Admins can still set/verify any figure manually — manual edits sit on top of the automatic ones.

## Notes

- Data lives in `backend/data/*.json`. **Everything is saved to disk**: accounts, password changes, profile/stat edits, carbon reports, orders, reservations, stock levels, shopping lists, projects and billing all survive a server restart. Sign-in sessions are in-memory, so a restart signs everyone out (they just log back in).
- Note for Render's free tier: the filesystem is ephemeral across deploys/restarts, so accounts created in the live app will reset on redeploy — commit important account changes back to `backend/data/users.json`, or move to a database for production.
- API is plain REST behind Bearer-token auth (`/api/auth/*`, `/api/admin/*`, `/api/tiers`, `/api/inventory`, `/api/orders`, `/api/lists`, `/api/carbon`, `/api/projects`) — ready to swap onto a real database later.
