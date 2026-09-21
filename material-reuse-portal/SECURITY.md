# Security review — Reuse Hub (www.materialreusehub.co.uk)

Reviewed as an attacker would: every route, every input, every place money or accounts move. Findings below are grouped by what they'd have let someone do, with what was changed. Everything listed as *fixed* is in this build; the *for you* section needs a human.

## What an attacker could have done → what's now in place

| Risk | Before | Now |
|---|---|---|
| **Brute-force / credential stuffing** | Login locked per email (10) and per IP (60) only | Plus a sliding-window limit of 20 sign-in attempts per IP per 15 min (429 with Retry-After); admin sessions 12 h, members 30 days; PBKDF2 raised 60k → 210k iterations, old hashes upgraded transparently on next sign-in; admin passwords must be 14+ chars with upper/lower/number; common words rejected; **all three seeded admins are forced to set a new password at next sign-in**; password change or reset signs out every other device; "Sign out of all devices" button |
| **Admin account takeover** | Password only | **Authenticator-app two-factor (TOTP)** for admins — set up in Account Settings; the secret never leaves the server (no third-party QR service) |
| **Email bombing / account spam** | Register and forgot-password unlimited | Register 5 per IP per hour; forgot 5 per IP per hour and 3 per email per hour (silently dropped — no enumeration); wishlist 10/user/hour; audit requests 3/user/day |
| **Bill inflation (Stripe, Claude, Twilio)** | Checkout and chat unlimited per IP | Checkout/membership 30 per user or IP per hour; chat 60 per user per hour (plus the existing 40 model calls); AI suggestions 60/admin/hour; uploads 40/user/hour |
| **Memory exhaustion (huge POST)** | Body read unbounded | JSON bodies capped at 256 KB, photo/upload bodies at 14 MB → 413; global cap 600 requests/min per IP |
| **Malicious uploads** | Any bytes accepted with a `.jpg` name | Files are sniffed by their bytes — only JPG, PNG, WebP, GIF, HEIC and PDF are stored; names sanitised and length-capped |
| **Stored XSS / phishing via photo URLs** | Members could submit any URL as a "photo" (e.g. `javascript:`) that an admin later clicks | Photo and document URLs must be files uploaded through the portal (own storage or Supabase bucket); everything else rejected. HTML escaping now also covers `'` |
| **Clickjacking / framing** | No frame rules | `X-Frame-Options: DENY` everywhere except `/marketplace` and `/embed/*`, which may only be framed by material-reuse.co.uk / materialreusehub.co.uk |
| **Third-party script injection** | No CSP | Content-Security-Policy: scripts only from this origin; styles/fonts from Google Fonts only; frames only Stripe; no objects; `base-uri 'self'`; `nosniff`; referrer policy; permissions policy |
| **Downgrade to HTTP** | — | HSTS (1 year) on HTTPS responses |
| **Cross-origin API use** | `Access-Control-Allow-Origin: *` on every API response | Only `/api/public/*` and `/api/health` are open; all authenticated routes have no CORS header |
| **Two origins for one site** | onrender.com and the custom domain both served the app (split sessions, mixed Stripe redirects) | Requests to the onrender host 301 to `https://www.materialreusehub.co.uk`; `PORTAL_URL` now defaults to the custom domain |
| **QR relay abuse** | `/api/qr` would encode any text for anyone (free QR service, phishing links) | Only passport URLs are accepted; rate-limited with the public bucket |
| **Session hijack after password leak** | Old sessions survived a password change | Revoked on change/reset (except the device doing the change) |
| **Sensitive fields in API responses** | — | `auth`, `reset`, `totp`, device hashes never leave the server (`safeUser`) |

Already in place from earlier work and re-checked: constant-time password comparison; sessions are 256-bit random tokens; reset links expire in 1 h and are single-use; Stripe prices/quantities are server-side (client can't set amounts); credit can't be double-spent (single-threaded, synchronous write); every admin write is audit-logged; daily Supabase backups (7 kept); errors never leak stack traces to clients; no npm dependencies (no supply-chain surface).

## For you (can't be done in code)

1. **Sign in once as each admin** — you'll be asked for a new strong password, then set up two-factor in Account Settings (do this for James, Kallie and Michaela).
2. **Render**: set `PORTAL_URL=https://www.materialreusehub.co.uk` (Stripe redirects and emails use it). Keep the onrender URL — it now just redirects.
3. **Secrets hygiene**: the admin passwords exchanged in chat should be considered known — the forced change covers it. Never paste `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_KEY` or `ANTHROPIC_API_KEY` anywhere but Render's environment tab. If one ever leaks, rotate it in that provider's dashboard and update Render.
4. **Render account, GitHub, Stripe, Supabase, Resend, Twilio, Anthropic** — turn on 2FA on each of those logins too; the portal is only as safe as the accounts that can redeploy it or read its database.
5. **Supabase**: the service key on Render has full access. Keep RLS on for any table you ever expose with the anon key (the portal only uses the service key server-side). The `portal-files` bucket is public by design — filenames are unguessable, but don't upload anything you'd mind being public.
6. **Backups off-site**: daily snapshots live in the same Supabase project. Once a month, download one (Supabase → Table editor → portal_data → export) to somewhere else.
7. **Rate-limit tuning**: if a big office ever trips the limits legitimately, set `RATE_MULTIPLIER=2` on Render rather than removing limits.
8. **Watch the audit log** (admin Overview) for "walk-in sale", "released hold" and "membership changed" you don't recognise.

## Limits reference (per window; set `RATE_MULTIPLIER` to scale all)

global 600/min/IP · public pages & API 120/min/IP · login 20/15 min/IP (+10 per email lock) · register 5/h/IP · forgot 5/h/IP, 3/h/email · checkout & membership 30/h · chat 60/h/user · AI suggest 60/h/admin · uploads 40/h/user · wishlist 10/h/user · audit requests 3/day/user · other writes 120/15 min/user.
