# Lusibane One

The Lusibane website, customer portal and staff console in one small Node.js app.
**Zero third-party packages**: it uses only what ships with Node 22 (including its built-in SQLite),
so there is no supply-chain risk from hundreds of dependencies.

## What it does
**Website:** all your marketing pages, the contact/quote form, and a **photo and video gallery** (Our Work).

**Joining (no accounts):** nobody creates an account or password. A visitor opens `/join`, fills in one form
(name, phone/WhatsApp, area, plan, how to contact them, POPIA consent) and sends it. At that moment:
1. it is saved in the **admin console under Join requests** (with a count badge on the tab), and
2. it is **emailed to info@lusibaneprojects.co.za** (see "Email" below).

The admin then presses **Acknowledge**, contacts the person (call, WhatsApp or email links are on the card), and can press
**Add as client** to turn them into a client record (no login) so jobs, plans and invoices can be managed for them.
Fixed-price plans start with their first invoice; quote-based plans (Church, Business) wait for you to set the price under Plans.

**Crew** (created by admin, sign in at `/staff`): see only their own jobs, start trip, mark done with a proof note, route view.
**Admin** (`/staff`): join requests, overview, jobs, routes, clients, plans, monthly billing (also automatic), invoices, quotes, contracts, tenders, team, audit log.

## Email for joining forms
The form is always saved first, so nothing is lost if email fails. To make the email to info@ actually send, put your mailbox
details in `/etc/lusibane.env` (see `.env.example`): `SMTP_HOST`, `SMTP_PORT` (465 or 587), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.
Until that is set, each form shows "Email not set up" in the console. If sending fails the console shows the reason with a
"Try email again" button, and the server retries failed ones hourly. Use a mailbox on your own domain (for example `website@lusibaneprojects.co.za`).

## Photos and videos (Our Work)
Copy files into the `public/media/` folder (or the folder named by `MEDIA_DIR`). No code change or restart needed.
- Pictures: `.jpg .jpeg .png .webp`. Videos: `.mp4` (H.264, best for phones) or `.webm`. Keep videos short.
- Order and captions come from the file name: `02-fence-before-and-after.jpg` shows as "Fence before and after", sorted by the number.
- Optional video cover: a picture named `02-crew-at-work.poster.jpg` next to `02-crew-at-work.mp4`.
- Visitors tap any item for a full-screen preview (arrow keys or swipe to move on, Esc to close).

## Run it on your computer (to try it)
```
node --version            # must be 22.13 or newer
npm run create-admin -- "Your Name" you@example.com     # asks for a password
npm start                 # open http://127.0.0.1:3000
npm test                  # automated security, joining, email, gallery and business-flow tests
```

## Put it on the internet (about 30 minutes, any small Linux VPS)
1. Get a VPS (Ubuntu 24.04) and point your domain's DNS at it.
2. Install Node 22 and Caddy. Copy this folder to `/opt/lusibane`.
3. Create a user and folders:
   `useradd -r -s /usr/sbin/nologin lusibane; mkdir -p /var/lib/lusibane /opt/lusibane/backups; chown lusibane: /var/lib/lusibane /opt/lusibane/backups`
4. Copy `.env.example` to `/etc/lusibane.env`, set `ALLOWED_ORIGIN` to your https address, `chmod 600` it.
5. Copy `deploy/lusibane.service` to `/etc/systemd/system/`, then `systemctl enable --now lusibane`.
6. Copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile` (edit the domain), `systemctl reload caddy`. HTTPS is automatic.
7. Create your admin: `sudo -u lusibane env $(cat /etc/lusibane.env | xargs) node scripts/create-admin.js "Name" you@example.com`
8. Firewall: allow only ports 22, 80, 443 (`ufw allow OpenSSH; ufw allow 80,443/tcp; ufw enable`). Use SSH keys, not passwords.
9. Backups: add a daily cron `0 2 * * * cd /opt/lusibane && node scripts/backup.js` and **copy the backups folder off the server** (another machine or cloud storage).

Gallery: see "Photos and videos" above. Make sure the media folder is readable by the `lusibane` user.

## Security: what is in place
- Passwords hashed with scrypt (memory-hard) with a unique salt; never stored or logged in plain text.
- Login: generic errors, per-IP and per-email rate limits, account lock after 5 wrong passwords, forced password change for temporary passwords.
- Sessions: random 256-bit tokens stored only as hashes, HttpOnly + SameSite=Strict + Secure cookies, new session each login, idle and absolute expiry,
  all sessions revoked on password reset, disable or password change.
- CSRF: Origin check plus a per-session token on every state-changing request.
- Every database query is parameterised (no SQL injection). Every input is validated for type, length and format.
- Customers have no logins, so no customer data sits behind a login. The joining form is rate limited, has a hidden bot trap, and only counts valid forms. Roles are enforced on the server, never trusted from the browser.
- Strict Content-Security-Policy (no inline scripts), clickjacking protection, HSTS, nosniff, strict referrer policy.
  The portal builds its screens without ever inserting server text as HTML, so stored XSS has no way in.
- Request size limits, timeouts, no directory listing or traversal, password hashes never leave the server, audit log of every important action.
- Service runs as an unprivileged user inside a systemd sandbox; database file permissions are 600.

## Honest limits (please read)
No system is "unhackable". Security is a habit, not a feature. Things this project does **not** do for you:
- **Email is outgoing only** (joining forms to info@). Crew password resets are one-time codes that an admin sends over WhatsApp. No two-factor login yet: use a long unique password for admin accounts.
- **No online card payments.** Payments are recorded by hand (EFT/cash). If you add a payment provider later, let them handle card details, never store them.
- **One server.** Rate limits live in memory and reset on restart; that is fine for one business, not for a large platform.
- **Keep the server patched** (`unattended-upgrades`), keep Node updated, and copy backups off the server.
- `node:sqlite` is marked "experimental" by Node (it works well, and the tests exercise it), so pin your Node version and re-run `npm test` after upgrades.
- Have a developer do an independent security review before you handle large volumes of customer data.
- **POPIA:** you are collecting personal information. Add a privacy notice, appoint an information officer, and register with the Information Regulator as required.
