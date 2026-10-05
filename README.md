# Grey Season

Browser-based multiplayer open-world zombie survival FPS set in the abandoned city of Calder Point.
TypeScript · Three.js · Rapier · Node · Socket.IO · SQLite.

> Work in progress. Milestone 1 is done (multiplayer first-person movement on a test map). A full README
> lands in milestone 11. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Run (development)

Requires Node 20+ (tested on Node 25).

```bash
npm install
npm run dev        # game server on :2567 + Vite client on :5173
```

Open http://localhost:5173, pick a survivor name, and click into the window.
Open a second browser window with a different name to see multiplayer.

| Control | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Shift | Sprint (uses stamina) |
| C | Crouch |
| Space | Jump |
| Esc | Release mouse / pause |

## Other commands

```bash
npm test           # shared physics tests + server multiplayer tests
npm run typecheck  # all three packages
npm run build      # production client build -> client/dist
npm start          # server only; also serves client/dist at http://localhost:2567
```

## Tweaking balance

Game-balance values live in `shared/src/config/` (restart the server after editing).
Server settings (port, DB path, map seed, offline raid protection) live in `server/src/config.ts` and can be
overridden with environment variables (`PORT`, `DB_PATH`, `MAP_SEED`, `OFFLINE_RAID_PROTECTION`, ...).
The SQLite database is `server/data/game.db`; delete it to wipe all players.
