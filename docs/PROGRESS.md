# Progress log

The single source of truth for where the project stands. Update it at the end of every milestone.
Original requirements: [SPEC.md](SPEC.md). Design: [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| # | Milestone | Status | Commit |
|---|---|---|---|
| 1 | Monorepo, physics FPS controller, multiplayer | ✅ Done | `df3293b` (+ mouse fix `63370cd`) |
| 2 | City generation, buildings, doors, stairs, performance | ✅ Done | `5a8abfe` |
| 3 | Inventory, looting containers, item pickup/drop | ✅ Done (see notes) | see `git log` |
| 4 | Survival stats, death, respawn | ⏳ Next | |
| 5 | Weapons & FPS combat with viewmodels | | |
| 6 | Zombies (navmesh AI, noise/vision, combat) | | |
| 7 | PvP, lag-compensated hits, death loot bags, kill feed | | |
| 8 | Groups/teams and chat | | |
| 9 | Base building, storage, respawn beds | | |
| 10 | Raiding and structure damage | | |
| 11 | Day/night, 3D audio, settings, polish, balancing, final README | | |

Other commits: menu retitle to "The Walking Dead" (`8937010`).

## How to resume work in a new chat

1. Open the project folder in Claude Code. `CLAUDE.md` loads automatically.
2. Read this file and `docs/ARCHITECTURE.md`.
3. Run `npm install`, then `npm test` (everything should pass), then `npm run dev` (if the owner isn't already running it).
4. Continue with the first milestone not marked done. Follow the milestone workflow in `CLAUDE.md`.

---

## Milestone 1: foundation ✅

- npm workspaces `/shared`, `/server`, `/client`. Shared is consumed as TypeScript source (no build step).
- **Movement**: `shared/src/sim/movement.ts` `CharacterMotor` wraps Rapier's kinematic character controller.
  It's deterministic: the server runs it on client inputs, and the client runs it for prediction.
  - Walk 4.2, sprint 7.0, crouch 2.0 m/s. Jump 7.2 m/s, gravity 22. Stamina drains while sprinting and jumping.
  - Crouch shrinks the capsule. You can't stand up under a low ceiling.
  - Walls cancel the velocity component along their normal. Walkable slopes are ignored, so ramps and stairs don't lose speed.
- **Stairs** are visual-only steps plus one invisible ramp collider (`shared/src/world/builders.ts addStairs`).
  Per-step autostep was jittery and got stuck. The top step is solid.
- **Networking**: Socket.IO over WebSocket only, JSON. 30 Hz fixed tick, 20 Hz snapshots.
  - The client sends inputs (`seq`, axes, buttons, yaw/pitch) and the server acks the last seq it applied.
  - Prediction and reconciliation live in `client/src/game/LocalPlayer.ts`. Remote players are interpolated 110 ms in the past (`RemotePlayers.ts`).
  - Input budget: +1 credit per tick, max 3. Floods are dropped (anti-speedhack).
- **Collision layers** (`sim/collision.ts`): players don't collide with each other. That keeps the client's map-only physics world identical to the server's.
- **Persistence**: better-sqlite3, ordered migrations (`server/src/db/migrations.ts`), and an async `PlayerRepository` interface (Postgres-ready).
  - Saves happen on disconnect, every 30 s, and on SIGINT.
- **Auth**: `AuthProvider` interface with a `GuestAuthProvider` (username only, 3–16 characters `[A-Za-z0-9_-]`). A duplicate online name is rejected.
- **Mouse fix**: pointer lock asks for `unadjustedMovement` (raw input). Single deltas above 350 px are ignored (a Chrome/Windows spike bug), and the first move after locking is skipped.

## Milestone 2: city ✅

- `generateCity(seed)` builds Calder Point:
  - a 6×6 grid of 56 m blocks with 14 m streets, inside a 7 m quarantine wall with a ring road
  - block kinds: residential, commercial, park, parking, and one police block
  - required shops (`CITY.requiredBuildings`) always appear
  - about 16k boxes, 461 doors, 1,814 containers and 127 buildings. Generation takes ~26 ms and the physics world builds in ~250 ms.
- `city/buildings.ts`: buildings are built in a local frame (front wall at z=0) with quarter-turn rotation, so everything stays axis-aligned.
  - Parts: wall segments around openings, window glass (25% broken), slabs with stairwell holes, switchback stairs, railings, interior cross walls with doors, furniture per room purpose, and roof parapets.
  - Shop signs are colour-coded: grocery green, pharmacy white, hardware orange, gun shop red, police blue.
- **Doors** (`world/doors.ts`) are server-authoritative. The server checks range (2.6 m + slack), a 200 ms per-player cooldown and a 450 ms swing lock, and won't swing a door through a player. Both sides keep the door colliders in sync. After a door moves, `world.step()` is called so scene queries see the new position.
- **Map hash**: the server sends `hashMap()`, and the client shows "MAP MISMATCH" if its own generation differs.
- **Rendering** (`client/src/game/MapRenderer.ts`):
  - 64 m chunks, each made of instanced meshes (main / detail / glass) with per-instance colours, about 3 draw calls per chunk
  - detail LOD (interiors and props hidden beyond 95 m)
  - all doors in one instanced mesh
  - the shadow camera follows the player, snapped to texels
- Spawns are 32 points on the ring road, facing the city centre. A saved position that is inside geometry is respawned.

## Milestone 3: items ✅

- **Config**: `shared/src/config/items.ts` (27 items), `loot.ts` (tables plus a fallback chain), `crafting.ts` (bandage, barricade kit) and `inventory.ts` (24 slots of which 9 are hotbar, 30 kg limit, use range, container sizes, starting kit).
- **Rules** (`shared/src/inventory/inventory.ts`) are pure functions: insert/merge, weight caps, move/split/swap, atomic crafting, and `normalizeInventory` for old saves.
- **Loot**: `rollLoot` (shared). Container tables are keyed `<buildingType>_<kind>` and fall back as: exact → alias (apartment→house) → `any_<kind>` → `default`.
- **Server**:
  - `ContainerSystem` fills containers lazily the first time they're opened, and re-rolls them after `LOOT.respawnMinutes` (20) when nobody is viewing. Viewers get live updates.
  - `GroundItems` handles dropped items with interest management (60 m radius, add/remove deltas) and a 15-minute despawn.
  - `InventorySystem` validates every op:
    - slot ownership (you can only touch your own slots or the container you opened)
    - range
    - line of sight (the first ray hit must land inside the container's box, so no looting through walls)
    - the weight limit
  - Containers auto-close when you walk more than 4 m away.
- **Client**:
  - `ui/InventoryUI.ts`: the HUD hotbar plus the Tab screen (drag-drop, Ctrl+drag to split, right-click or Shift+click to quick-move, drag outside to drop, tooltips, weight bar, crafting list).
  - `game/GroundItemsView.ts` renders dropped items and picks them by ray.
  - Look targeting priority: ground item > door > container (the ray hit point is resolved through `ContainerIndex`).
  - Keys: E use, Tab/I inventory, 1–9 and the mouse wheel select the hotbar slot, Q drops the held item.
- **Not persisted (by design for now)**: world container contents and ground items reset on server restart. Player inventories are persisted.
- Existing players created before M3 don't get the starting kit; only new survivors do.
- `use` (eat/drink/heal) is wired as an op but answers "arrives in milestone 4".

## Tests (run `npm test`)

- `shared/test/movement.test.ts`: physics, determinism, crouch, stairs.
- `shared/test/city.test.ts`: generation determinism and timing, spawn clearance, doors blocking and opening, stairs to the upper floor, curb stepping.
- `shared/test/inventory.test.ts`: item rules, weight, crafting, loot tables refer to real items, normalization.
- `server/test/multiplayer.test.ts`: join, visibility, duplicate names, input application, speedhack limit, persistence (on the test map).
- `server/test/doors.test.ts`: door range, swing blocking, junk ids.
- `server/test/items.test.ts`: starting kit, looting in range, no looting through walls, weight limit, crafting, drop and pickup across players, auto-close, junk ops ignored.

## Known issues / notes

- The client bundle is about 5 MB because Rapier's WASM is inlined. Code-split in M11.
- Background tabs stop sending input (rAF pauses), so that player freezes for others.
- Lighting is flat grey for now. The day/night cycle comes in M11.
- Browser automation (Claude in Chrome) runs in a hidden window, so `requestAnimationFrame` barely runs there. Don't pump `game.frame()` manually: every call queues another rAF and the tab freezes. The dev-only `window.__game` handle exists for inspection.

## Plan for the next milestones

- **M4 Survival**:
  - Server-side stats: hunger/thirst drain (`SURVIVAL` config), and starvation/dehydration damage at 0.
  - Bleeding later, from combat.
  - The `use` op with a use-time (cancelled by sprinting), using `ItemDef.consume`.
  - HUD bars for health, hunger and thirst.
  - Death drops the inventory as a `loot_bag` container (dynamic container in `ContainerSystem`, key `b<uuid>`).
  - Death screen, then respawn at a random edge spawn (or a bed in M9).
  - Persist the stats.
- **M5 Combat**:
  - `shared/src/config/weapons.ts` (WeaponDef numbers).
  - Viewmodels (primitive meshes) with swing, fire and reload animations.
  - Client fire events carrying shot time, direction and seq. The server validates fire rate, ammo and line of sight.
  - Hitscan with spread and recoil; crossbow bolts as server projectiles.
  - Headshots via separate head/body hit volumes.
  - Melee costs stamina, with windup timing.
- **M6 Zombies**: recast-navigation-js navmesh built from the city boxes on the server, AI state machine, a spatial hash for interest management, and type configs.
- **M7 PvP**: lag compensation using a position history ring buffer per player (rewind to the shooter's time minus the interpolation delay), death bags, kill feed, killer name on the death screen.
- **M8–M10**: groups (DB tables), chat, structures with a ghost preview and snapping, beds, storage chests (persisted containers), structure health, raiding, and the offline-raid-protection config flag (already in `server/src/config.ts`).
- **M11**: day/night, flashlight (SpotLight), PositionalAudio, settings menu (sensitivity, FOV, volume, quality), balancing, and the final README.
