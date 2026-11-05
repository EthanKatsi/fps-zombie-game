# Survive The Zombie Apocalypse

Browser-based multiplayer open-world zombie survival FPS set in the abandoned city of Calder Point
(internal code name: Grey Season). TypeScript · Three.js · Rapier · Node · Socket.IO · SQLite.

> Work in progress. Milestones 1-8 are done: multiplayer first-person movement in a procedurally generated
> city with enterable buildings, doors and stairs, plus inventory, looting, crafting, item drops, survival stats,
> death bags, respawning, melee/gun combat, zombies (walkers, runners, bloaters) that hear gunshots, see you, chase
> you up stairs and wait outside closed doors, lag-compensated PvP with a kill feed and spawn protection, drivable
> vehicles, and groups with chat, a compass, a minimap and a full map.
> A shooting range with training dummies is next to the police station (blue sign).
> Status and next steps: [docs/PROGRESS.md](docs/PROGRESS.md). Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How to run the game

### 1. Install the prerequisites

- [Node.js](https://nodejs.org/) **20 or newer** (tested on Node 25). This includes `npm`.
- [Git](https://git-scm.com/).
- A modern desktop browser (Chrome, Edge or Firefox) with WebGL.

### 2. Get the code and install dependencies

```bash
git clone https://github.com/EthanKatsi/fps-zombie-game.git
cd fps-zombie-game
npm install
```

### 3. Start it (development mode)

```bash
npm run dev
```

This starts the game server on port **2567** and the Vite client on port **5173**. The first start takes a few
seconds while the server generates the city and builds its physics colliders.

### 4. Play

1. Open **http://localhost:5173** in your browser.
2. Type a survivor name (3-16 letters, numbers, `_` or `-`) and click **Enter the city**.
3. Click inside the game window to capture the mouse. Press **Esc** to release it.

To try multiplayer on one computer, open a second browser window with a different survivor name. Friends on the
same network can join at `http://<your-computer's-LAN-IP>:5173` (allow Node through your firewall if asked).

### Alternative: production build (single port)

```bash
npm run build      # builds the client into client/dist
npm start          # runs the server, which also serves the built client
```

Then open **http://localhost:2567**.

### Troubleshooting

- **Port already in use**: another copy of the game (or something else) is using port 2567 or 5173. Close it and
  run `npm run dev` again.
- **Wipe all players and loot**: stop the server and delete `server/data/game.db`.

## Controls

| Control | Action |
|---|---|
| WASD | Move |
| Mouse | Look |
| Double-tap W (hold) | Sprint (uses stamina) |
| Shift | Crouch |
| Space | Jump |
| E | Use: open/close doors, search containers, pick up items |
| Tab / I | Inventory (drag to move, Ctrl+drag split, right-click quick-move, drag outside to drop) |
| 1-9 / mouse wheel | Select hotbar slot |
| Q | Drop held item |
| Left click | Attack (fists / melee / shoot), or use held food/drink/medicine |
| Right click (hold) | Aim down sights (guns) |
| R | Reload |
| V | Camera: first person → third person → facing view → first person (in a vehicle: seat view ↔ chase camera) |
| E (at a vehicle) | Get in: drive if the driver's seat is free, otherwise ride as a passenger. E again gets out (when slow) |
| W / S, A / D, Space (driving) | Throttle / brake and reverse, steer, handbrake |
| Enter | Chat (Tab switches All / Group, Enter sends, Esc cancels) |
| G | Group panel: create, invite, accept invites, kick / make leader, leave |
| M | Full map (teammates in green) |
| F3 | Toggle the debug readout (fps, position, ping) |
| F8 | Cycle graphics quality (High / Medium / Low / Performance); also in Menu → Settings and the Esc pause screen |
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

## Realistic character models (optional)

Drop rigged, animated zombie and player models (Mixamo FBX or Sketchfab glTF) into `client/public/models/` and
list them in `manifest.json`. See [docs/MODELS.md](docs/MODELS.md) for step-by-step instructions. Without them the
game uses its built-in procedural characters. Surface textures are CC0 from Poly Haven (see Menu → Credits).
