# מגן שכן — Magen Shachen

## Overview
Shelter-sharing app for emergencies. Like Pango for parking, but for private bomb shelters (ממ"ד).
Hosts register their shelter as available during rocket alerts. Seekers find the nearest open shelter on a map.

## Tech Stack
- **Backend:** Node.js + Fastify 4 (ESM)
- **Database:** SQLite (better-sqlite3)
- **Framework:** shared-dashboard
- **Frontend:** Vanilla JS + Leaflet maps
- **Push:** web-push
- **Port:** 3011

## Project Structure
```
server.js                    — Fastify entry point
core/config.js               — Environment config
core/logger.js               — Pino logger
services/db.js               — SQLite database + schema
services/admin/adminRoutes.js — Dashboard providers
services/auth/authRoutes.js   — OTP login for hosts
services/shelters/            — Shelter CRUD + nearby search
services/alerts/              — Pikud HaOref polling + alert handling
services/push/                — Web Push notifications
public/app.html               — Seeker interface (map)
public/host.html              — Host management panel
public/index.html             — Admin dashboard
```

## Key URLs
- `/app` — Public seeker map (no login required)
- `/host` — Host panel (OTP login)
- `/` — Admin dashboard

## Commands
```bash
npm run dev    # Development with nodemon
npm start      # Production
```

## Pikud HaOref API
Polls `https://www.oref.org.il/WarningMessages/alert/alerts.json` every 3 seconds.
Filters alerts for configured cities (default: תל מונד).
