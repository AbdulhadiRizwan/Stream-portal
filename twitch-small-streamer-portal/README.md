# StreamScout — Twitch Small-Streamer Discovery Portal

A minimal-dark web app with secure login, admin-managed accounts, an admin dashboard, audit events, session visibility, and a Twitch live-stream feed.

## Important Twitch API limitation

Twitch's general live-stream directory does **not** return each channel's follower count or a dependable city/country field. This app never pretends an unverified channel has fewer than 50 followers. The "Under 50 (verified only)" filter includes only channels whose follower count has been verified. A complete global directory of every live channel with fewer than 50 followers cannot be guaranteed through the public API alone.

The included follower-lookup endpoint attempts Twitch's channel-follower endpoint for a specific broadcaster ID, but availability depends on Twitch's current API permissions and authorization rules. Review Twitch's current API documentation and terms before launch.

## Requirements

- Node.js 20 or newer
- A Twitch developer application (Client ID and Client Secret)
- A host that supports a persistent disk for SQLite files, or replace SQLite with a managed database for ephemeral/serverless hosting

## Run locally on Windows 11

1. Install Node.js 20+ from the official Node.js website.
2. Extract this project to a folder.
3. Open PowerShell in that folder.
4. Run:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

5. Set `SESSION_SECRET` to a long random secret. For example, generate one in PowerShell:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Copy the output into `.env`. Keep `.env` private and never commit it.

6. In the Twitch Developer Console, create an application. Add this OAuth Redirect URL for local development:

   `http://localhost:3000/auth/twitch/callback`

   This app uses Twitch app access tokens (client credentials) for public Helix endpoints, so the callback is not used by the current implementation; it is harmless and can be omitted if Twitch's current console allows an app without it. Put the Client ID and Client Secret in `.env`.

7. Install dependencies and start the server:

   ```powershell
   npm install
   npm start
   ```

8. Open `http://localhost:3000`.

The first run creates the admin from `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Defaults are `admin` / `102030`. Change this password immediately from **Administrator tools → Change password**. For a real online launch, override both seed variables with a unique initial password before first deployment. Changing `ADMIN_PASSWORD` after the admin row already exists does not reset the stored password.

## Deploy online

This app uses SQLite, so deploy it to a Node.js host that supports a persistent disk/volume. If the host uses an ephemeral filesystem, accounts and sessions may be lost during redeploys/restarts; use a managed SQL database and a compatible session store for production.

General deployment checklist:

1. Create a new web service from this project repository.
2. Build/install command: `npm install`
3. Start command: `npm start`
4. Add a persistent disk mounted at the project's `data/` directory.
5. Add environment variables:
   - `NODE_ENV=production`
   - `SESSION_SECRET` — long random secret
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `TWITCH_REDIRECT_URI` — not used by current app-access-token flow
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD` — choose a unique, strong initial password; do not use `102030` on a public website
6. Deploy and open the host-provided HTTPS URL.
7. Sign in with the seeded admin account and immediately set a strong password.
8. Create regular users through the admin panel.

Do not publish `.env`, secrets, database files, or session data. Keep dependencies updated. Before public production use, consider moving to PostgreSQL, configuring backups, adding email-based password recovery, and reviewing Twitch Developer Agreement/API rules.

## Features

- Login and logout; bcrypt password hashing
- HttpOnly, SameSite session cookie; HTTPS-only secure cookie in production
- CSRF token on API mutations, Helmet security headers, login rate limiting
- Admin can add accounts, promote/demote roles, disable/enable, and delete other accounts
- Admin can inspect active server-side sessions and recent audit events
- Users can change their own password
- Twitch live streams, search, language filter, viewer count, category, thumbnail and direct Twitch link
- Explicit disclosure when follower counts cannot be verified

## Known limitations / next steps

- City/country filtering is not implemented with fabricated values. Twitch does not expose a universal city field for all streamers. A region filter should only be added if a trusted, permitted location source is available.
- The current endpoint loads the first 100 live streams returned by Twitch. It does not crawl all Twitch live channels; pagination and game/category discovery can broaden coverage within API limits.
- The "Under 50" filter is intentionally strict, but the current feed does not automatically verify each card's follower count. Integrate a permitted, authorized follower-count source before treating that filter as a complete directory.
- For production, use a managed database, persistent session store, backups, monitoring, and a documented admin recovery process.
