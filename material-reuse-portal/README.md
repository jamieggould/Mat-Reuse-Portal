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
- **Orders & Collections** — warehouse orders (synced from the marketplace, with deposit/balance and collection slot) plus the materials the member has offered
- **Project dashboards** (reached from requests, documents and impact — no separate tab) — audits and reports live in Documents
- **Membership & Billing** — the **live Softr pricing-table embed** (exact HTML incl. payment links) with billing/invoices underneath. Member discount % in orders is a demo assumption — the site lists "Member Discounts" without a figure
- **Account Settings** — profile editing, notification toggles
- **Material Passports** — searchable/filterable library of every recovered material (photos, condition, provenance, carbon, value, QR code), detail view and branded passport PDF. Public deep link: `/passport/<ref>`
- **Offer Materials** — "I have materials" workflow: pick a project (or describe a new one), list materials, location, date, notes, photos → a tracked request (Submitted → Under review → Accepted → Collection arranged → Collected → Rehomed)
- **Project dashboards** — one page per project: site/client/dates, 6-stage lifecycle tracker (Audit → Materials identified → Reuse route → Collection → Rehomed → Impact report), linked passports, upcoming collections, reuse outcomes, impact figures, documents, evidence pack. Deep link: `/project/<id>`
- **Documents & evidence vault** — central document library plus per-project sections; upload (Supabase Storage), categories, dates, project links, and a one-click branded **evidence pack**
- **Impact & ESG Reporting Centre** (Corporate) — filter by project / site / date range: CO₂e avoided, items rehomed, tonnes diverted, reuse & recycling rates, value retained, procurement/disposal savings, monthly and category charts, per-project table, WLCA modules, PDF report and CSV ledger export
- **Admin**: material-request queue (accept → auto-creates the project; arrange → schedules the collection; convert lines to passports), passport editor with photo uploads, carbon & impact editor (verification + manual ledger entries), project lifecycle/site/client editing, collections scheduler, per-member documents

## Security & resilience

- Sessions persist in the database (30 days) — a redeploy no longer signs everyone out. Sign-in is rate-limited (10 failed tries per email / 60 per IP in 15 min). New passwords need 10+ characters with a letter and a number (existing passwords keep working).
- **Forgotten password**: link on the sign-in page → 1-hour reset email → `/reset/<token>`.
- **Public passports**: `/passport/<ref>` works without signing in (QR scans) and shows no client names, sites or money. Every passport has a downloadable **QR label** (PNG, MRG mark in the centre) from the passport view and the admin Passports table.
- Crash handlers email `ADMIN_EMAIL` (max one alert per 10 min); `/api/health` for uptime checks; the server pings itself every 10 min so a free Render instance stays awake for the sync (`KEEP_ALIVE=false` to disable); a daily snapshot of all data is written to Supabase (`backup-YYYY-MM-DD`, last 7 kept).
- Buying/reserving from the portal always goes through the marketplace's Stripe checkout with the member's email locked in — no free in-portal reservations for marketplace stock. Deposit reservations show deposit paid / balance due (`DEPOSIT_PERCENT`, default 50, must match the Vercel checkout).
- Admin **Merge into another account** moves everything from a duplicate account (e.g. bought with a different email) into the right one; the old email keeps working for sign-in and marketplace matching.
- Privacy notice & terms: draft text at the foot of every page — **for MRG to review before go-live**.

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
│   ├── integrations.js    # Airtable ⇄ portal sync, Resend email
│   ├── uploads/           # local-only file storage (used when Supabase isn't configured)
│   └── data/              # seed data + factors.json (carbon/weight estimates) — see "Data model" below
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
| `sessions` | sign-in sessions `{ token: { uid, exp } }` | **new** |
| `users` | + `altEmails[]` (merged accounts), `reset` (pending password reset) | changed |

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

### Marketplace sync: Airtable ⇄ portal (one-off)

The Softr marketplace lives in the Airtable base "Demolition Salvage Marketplace". With a token set, the portal:
- pulls every listing (name, category, price, quantity, carbon, photos, availability) every 5 minutes — the Online Warehouse, shopping lists and passports always match Softr
- turns every Softr purchase/reservation into an order on the buyer's account; **buyers without an account get one created automatically** and receive a welcome email with a temporary password (set `AIRTABLE_AUTO_CREATE_MEMBERS=false` to switch this off)
- when Airtable's Collection Status becomes **Collected**, the order is marked collected and the member's impact updates
- writes back: a reservation made in the portal marks the Airtable record Reserved with the buyer's details; marking an order collected in the portal sets Airtable to Collected / Sold

Setup:
1. Airtable → your profile picture → **Developer hub** → **Personal access tokens** → Create token. Scopes: `data.records:read` and `data.records:write`. Access: only the "Demolition Salvage Marketplace" base. Copy the token (starts `pat…`).
2. Render → Environment → add `AIRTABLE_TOKEN` = that token. (Base and table default to the marketplace base / "Table 1"; override with `AIRTABLE_BASE` / `AIRTABLE_TABLE` if it ever moves.)
3. Redeploy. The admin Overview shows sync status and a **Sync now** button.

Airtable photo links expire, so the sync copies each photo into your storage bucket once (`warehouse/…`).

### Email notifications: Resend (one-off)

Emails: welcome on signup (and for auto-created marketplace buyers), new material request → Kallie, request status changes → member, order collected → member.

1. [resend.com](https://resend.com) → sign up (free: 3,000 emails/month) → **Domains** → Add `material-reuse.co.uk` → it shows 3 DNS records (TXT/MX) — add them wherever the domain's DNS is managed (the same place as the website) → wait for "Verified".
2. **API Keys** → Create → copy (starts `re_…`).
3. Render → Environment → `RESEND_API_KEY` = the key. Also set `PORTAL_URL` to the portal address (used in email links and the keep-alive ping). Optional: `MAIL_FROM` (default `Material Reuse Group <portal@material-reuse.co.uk>`), `ADMIN_EMAIL` (default kallie@material-reuse.co.uk), `PORTAL_URL` (default the Render URL — change when you add a custom domain).

Until the domain is verified you can test with Resend's onboarding sender: `MAIL_FROM=onboarding@resend.dev` (delivers only to your own Resend login email).

### Carbon & weight estimates

New passports with no carbon/weight figure are estimated from `backend/data/factors.json` (per-category kg CO₂e and kg per item; the live warehouse average overrides the carbon figure where MRG already stocks that category). Estimates are labelled **estimated** everywhere until an admin enters measured figures. Edit the JSON to tune the factors.

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
