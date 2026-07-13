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

**Admins** (temporary passwords — change on first sign-in via Account Settings):

| Admin | Email | Temp password |
|---|---|---|
| James Gould | jamesgould@estaraai.com | `MRG-James-2026` |
| Kallie Bell | kallie@material-reuse.co.uk | `MRG-Kallie-2026` |

Admins see an **Overview** (totals + member monitor) and a **Members** page: create accounts, edit every personalised field (tier, dashboard stats, account manager, carbon report data), reset passwords, delete accounts.

**Sample members** (all share the temp password `MRG-Member-2026`): Maya Okafor (maya.okafor@example.com, Domestic Free), Tom Hartley (tom.hartley@example.com, Domestic Plus), Priya Nair (priya@peckhamtoolibrary.org, Community Free), Daniel Whitmore (d.whitmore@garnetfieldworkspace.co.uk, Corporate Reuse Partnership).

Tier names, annual prices and the perk matrix come directly from the live membership table; the warehouse inventory is the live marketplace listing.

## What's included

- **Dashboard** — carbon saved, items rehomed, active orders, shopping lists, plus full **carbon reporting** (monthly savings chart, category breakdown, equivalents, WLCA modules for corporate) for tiers that include it
- **Online Warehouse** — the **live Softr marketplace embed** (exact HTML with payment links and reserve rules, Airtable-connected) with the **Join the Wishlist** Airtable form underneath
- **Orders & Collections** — reservations, collection/delivery slots, donation lots
- **Shopping Lists** — per-project lists with live stock checks, cost and carbon totals
- **Projects & Audits** — GLA pre-demolition audits, resource management plans, circular economy statements, document library
- **Membership & Billing** — the **live Softr pricing-table embed** (exact HTML incl. payment links) with billing/invoices underneath. Member discount % in orders is a demo assumption — the site lists "Member Discounts" without a figure
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
    └── assets/logo.svg    # green segmented ring mark
```

## Branding

- Colours: Ultra Azul `#1653F3`, Navy `#06183F`, Hi-Vis Green `#9EFF51`, Yellow `#FFED4D`, Orange `#FF883A`, Cream `#FFD5BD`, Sage `#E5FFCF`
- Type: **Geologica** (headings) + **Inter** (body); swap in the licensed Urbane Rounded via `--font-body` in `portal.css` if preferred
- Design: flat and sharp to match the main site — navy/white, hairline borders, square corners, uppercase labels, hi-vis green used sparingly as an accent
- Logo: the real MRG logo, hotlinked from material-reuse.co.uk (dark version on the login card, white version in the sidebar, real favicon)

## Notes

- Data lives in `backend/data/*.json`. Account changes (created members, password changes, profile/stat edits, carbon reports) are **saved to disk**; reservations and list edits are in-memory and reset on restart.
- Note for Render's free tier: the filesystem is ephemeral across deploys/restarts, so accounts created in the live app will reset on redeploy — commit important account changes back to `backend/data/users.json`, or move to a database for production.
- API is plain REST behind Bearer-token auth (`/api/auth/*`, `/api/admin/*`, `/api/tiers`, `/api/inventory`, `/api/orders`, `/api/lists`, `/api/carbon`, `/api/projects`) — ready to swap onto a real database later.
