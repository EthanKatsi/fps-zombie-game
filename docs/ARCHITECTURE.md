# Grey Season — Architecture

*Setting: Calder Point, a mid-sized coastal city that fell in eleven days. Original setting and characters.*

## Folder structure

```
/shared            Code used by BOTH client and server (TypeScript source, no build step)
  src/types/       Data models: Player, Item, Inventory, Weapon, Zombie, Structure, Group
  src/config/      Game balance (movement, survival, network; later weapons, zombies, loot, structures)
  src/sim/         Deterministic simulation (character motor, collision layers)
  src/world/       Map data format, builders (stairs, ...), generators (test map → city in M2)
  src/net/         Wire protocol: message types, Socket.IO event maps
  src/math/        Small math helpers + seeded PRNG
  test/            Headless physics tests (node:test + tsx)
/server            Authoritative game server (Node + Socket.IO + Rapier + SQLite)
  src/config.ts    Operational config (port, DB path, map seed, offline-raid protection) via env vars
  src/auth/        AuthProvider interface + GuestAuthProvider (swap for real auth later)
  src/db/          SQLite connection, ordered migrations, repositories (async interfaces → Postgres-ready)
  src/game/        GameServer (tick loop, interest management, snapshots), ServerPlayer
  test/            End-to-end tests with real socket clients
/client            Browser client (Vite + Three.js + Rapier)
  src/net/         Connection + clock sync
  src/game/        Game loop, Input (pointer lock), LocalPlayer (prediction), RemotePlayers (interpolation), MapRenderer
  src/ui/          HTML/CSS overlay
/docs              This file
```

Planned additions per milestone: `server/src/game/{loot,inventory,combat,zombies,structures,groups}`,
`server/src/db/{Inventory,Group,Structure}Repository.ts`, `client/src/{viewmodel,audio,ui/*}`,
`shared/src/config/{items,weapons,zombies,loot,structures,crafting}.ts`.

## Data models (`shared/src/types`)

| Model | Key fields | Persisted |
|---|---|---|
| **PlayerRecord** | id, username, position, yaw, stats (health/hunger/thirst/stamina/bleeding), inventory, groupId, spawnBedId, kills, deaths | `players` table (stats & inventory as JSON) |
| **ItemDef** | id, name, category, weight, maxStack, consume effects, weaponId, structureKind, maxDurability | config file (`items.ts`) |
| **ItemStack** | uid, defId, qty, durability?, loadedAmmo? | inside inventories/containers |
| **Inventory** | slots[] (first 9 = hotbar), activeHotbar | with player |
| **Container** | id, kind (cabinet/fridge/locker/trunk/chest/loot_bag), lootTable, slots, respawnAt | world loot: memory; chests & bags: DB |
| **WeaponDef** | kind (melee/hitscan/projectile), damage, headshot mult, fire rate, range, noise radius, stamina cost, magazine, reload, spread (hip/ADS/moving), recoil, projectile speed/gravity | config file (`weapons.ts`) |
| **Zombie** | id, type (walker/runner/bloater), position, yaw, health, AI state, target, interest point, path | server memory only |
| **ZombieTypeDef** | health, speeds, attack dmg/range/cooldown, vision range/FOV, hearing | config file (`zombies.ts`) |
| **Structure** | id, kind (wall/floor/door/barricade/chest/campfire/bed), position, rotY, health/maxHealth, owner, group, locked/open, containerId | `structures` table |
| **BuildingClaim** | buildingId, owner, group | `building_claims` table |
| **Group** | id, name, leaderId, memberIds, invites | `groups` + `group_members` tables |

Static definitions (`*Def`) live in config files so balance can be tweaked without touching logic;
only instances are stored in the database.

## Networking model

- **Transport**: Socket.IO over WebSocket only. JSON for now; a binary codec can replace it behind `protocol.ts`.
- **Fixed tick**: server and client prediction both run at `NETWORK.tickRate` (30 Hz). One input = one tick.
- **Authority**: clients send *inputs* (axes, buttons, view angles), never positions. The server runs the same
  `CharacterMotor` (Rapier kinematic character controller) on those inputs.
- **Anti-speedhack**: each player gets +1 input credit per tick (capped at `maxInputsPerTick`); extra inputs wait
  or are dropped (`maxInputQueue`). Inputs are sanitized (NaN, ranges).
- **Prediction + reconciliation**: the client simulates locally, keeps unacknowledged inputs, and on each snapshot
  resets to the server state for the last acked input and replays the rest. Small errors are blended visually.
- **Interpolation**: remote players are rendered `interpolationDelayMs` in the past on the estimated server clock.
- **Interest management**: snapshots only include entities within `interestRadius` (spatial hash in M6).
- **Determinism**: players don't collide with each other (collision layers), so the client's map-only physics
  world produces the same results as the server's.

## Persistence

`openDatabase()` applies ordered migrations from `server/src/db/migrations.ts` using portable SQL (TEXT/INTEGER/REAL,
JSON as TEXT). Repositories expose async interfaces (`PlayerRepository`), so moving to Postgres means adding a
`PgPlayerRepository` and choosing it in `server/src/index.ts`. Players are saved on disconnect, every
`autosaveIntervalSec`, and on shutdown.
