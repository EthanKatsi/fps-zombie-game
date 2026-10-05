# Grey Season

Browser-based multiplayer open-world zombie survival FPS set in the abandoned city of Calder Point.
TypeScript · Three.js · Rapier · Node · Socket.IO · SQLite.

> Work in progress. Milestones 1-7 are done: multiplayer first-person movement in a procedurally generated
> city with enterable buildings, doors and stairs, plus inventory, looting, crafting, item drops, survival stats, death bags, respawning, melee/gun combat, and zombies (walkers, runners, bloaters) that hear gunshots, see you, chase you up stairs and wait outside closed doors, plus lag-compensated PvP with a kill feed and spawn protection.
> A shooting range with training dummies is next to the police station (blue sign).
> Status and next steps: [docs/PROGRESS.md](docs/PROGRESS.md). A full README
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
| E | Use: open/close doors, search containers, pick up items |
| Tab / I | Inventory (drag to move, Ctrl+drag split, right-click quick-move, drag outside to drop) |
| 1-9 / mouse wheel | Select hotbar slot |
| Q | Drop held item |
| Left click | Attack (fists / melee / shoot), or use held food/drink/medicine |
| Right click (hold) | Aim down sights (guns) |
| R | Reload |
| F8 | Cycle graphics quality (High / Medium / Low) |
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
Weapon stats are in `shared/src/config/weapons.ts`. Items, loot tables, recipes and inventory limits are in `shared/src/config/{items,loot,crafting,inventory}.ts`.
City layout values (blocks, street widths, building mix, car density) are in `shared/src/config/world.ts`.
Server settings (port, DB path, map id/seed, offline raid protection) live in `server/src/config.ts` and can be
overridden with environment variables (`PORT`, `DB_PATH`, `MAP_ID`, `MAP_SEED`, `OFFLINE_RAID_PROTECTION`, ...).
Use `MAP_ID=testmap` for the small milestone-1 test lot.
The SQLite database is `server/data/game.db`; delete it to wipe all players.
