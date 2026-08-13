# Habit.log

A fast, private habit journal inspired by the Bullet Journal monthly ledger.
Journal data is stored in IndexedDB first, works offline, and can be synchronized
across devices through Dexie Cloud using email one-time-code authentication.

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Useful commands

- `npm run dev` — start the local app
- `npm run build` — create a production build
- `npm test` — build and check the rendered shell and offline assets
- `npm run lint` — run the code-quality checks

## Data and backups

Entries, memorable moments, and tracker definitions are stored locally in the
browser. Select **Local → Sign in to sync** to connect a device to the private
cloud journal. Use the same email on every device.

Use **Data → Export backup** regularly. Importing a backup replaces the current
local journal only after confirmation. The Dexie Cloud CLI credential files are
intentionally excluded from source control.
