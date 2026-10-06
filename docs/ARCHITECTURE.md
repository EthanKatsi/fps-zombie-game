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

## World generation (milestone 2)

`shared/src/world/city/generateCity.ts` builds **Calder Point** from a seed: a square grid of blocks inside a
quarantine wall with a ring road. Blocks are residential (houses with fenced yards), commercial (grocery,
pharmacy, hardware, gun shop, apartments), parks, parking lots, plus one police station block. Required shops
are always placed (`CITY.requiredBuildings`).

`buildings.ts` assembles each building in a local frame (front wall at z=0) and rotates it in quarter turns,
so every piece stays an axis-aligned box. Buildings are made of modular parts: wall segments around
door/window openings, floor slabs with stairwell holes, switchback stairs (visual steps plus one invisible
ramp collider), interior cross walls with doors, and furniture chosen per room purpose. Lootable furniture
is recorded as `ContainerSpawn`s with a `<buildingType>_<kind>` loot table id, used in milestone 3.

**The full world** (`shared/src/world/generateWorld.ts`, map id `world`, the server default) is a
1.28 km square, laid out in `WORLD` (`config/world.ts`):

- The walled downtown is a city grid in the north-east, with gates on its west and south sides and army
  checkpoints outside them. Burnt and overturned wrecks and trash piles give it the abandoned feel.
- The suburbs are a residential grid in the south-east.
- A big forest covers the west: pines, broadleaf trees, rocks, logs and undergrowth on a jittered grid. It has
  cabins in clearings and a campground.
- A gas station sits on the east-west highway. Asphalt highways and dirt roads connect everything.
- A fence runs round the edge.

Both grids come from `generateGrid` (the old city generator, parameterised) and are merged in with their ids
renumbered. The standalone `city` and `testmap` maps still exist; the tests use them because they are small.

Surfaces all collide: the meadow at -0.06, the forest floor at -0.03, and roads, lots and grid slabs at 0. The
steps are tiny. `MapData.vehicleSpawns` lists where drivable vehicles start.

Only `{mapId, seed}` goes over the wire. Client and server regenerate the same `MapData`, and the server also
sends `hashMap()` so a diverging client is detected right away.

**Vehicles** (`shared/src/sim/vehicle.ts`, `config/vehicles.ts`, `server/src/game/VehicleSystem.ts`,
`client/src/game/VehiclesView.ts`) are server-authoritative and predicted like players:

- **Physics.** `VehicleMotor` is an arcade model (throttle, brake and reverse, coasting drag, speed-dependent
  steering, handbrake). It runs on Rapier's kinematic character controller with a box collider that reaches
  down to the ground (autostep handles curbs).
- **Seating.** A seated player's inputs are routed by `ServerPlayer.seatInput`. The driver's inputs step the
  vehicle; passengers only look around.
- **The occupant's own state** is their seat's feet position, with crouch hitboxes and `PlayerFlags.seated`.
  `NetPlayer.v` = vehicleId * 8 + seat.
- **Prediction.** The driver's client predicts the vehicle with the same motor and reconciles against
  `Snapshot.drive`. Other clients interpolate `Snapshot.vehicles`.
- **Collision.** Every vehicle has a collider (`VEHICLE_GROUPS`) in both worlds, so players bump into parked
  cars. Vehicles collide with the world and with each other, not with players or zombies: hitting those is
  "running over" (`VEHICLE_RULES`). Bullets ignore vehicles (`SHOT_GROUPS`).
- **Server rules:**
  - The server steps the world each tick that a vehicle moved, so queries see the new positions.
  - Crashes damage the vehicle and its occupants.
  - Wrecks eject everyone and respawn at their spawn spot after `respawnAfterSec`.
  - Engines make noise that zombies hear.

**Doors** (`world/doors.ts`) are server-authoritative. A client sends `interact {kind:'door', id}`. The server
checks range, cooldown, and that the swing isn't blocked by a player, then broadcasts `doorChanged`. Both
sides move the door collider in their physics world, so prediction stays in sync.

**Rendering performance** (`client/src/game/MapRenderer.ts`):
- Boxes are bucketed into 64 m chunks. Each chunk becomes ~3 `InstancedMesh`es (main, detail, glass) that
  share one material and use per-instance colors. That gives chunk-level frustum culling and very few draw calls.
- Detail LOD: interiors, furniture and small props are hidden beyond `RENDER.detailDistance`.
- Fog and the camera far plane limit draw distance. The shadow frustum follows the player and snaps to
  texels to avoid shimmer.
- All doors share one instanced mesh, and swings are animated by rewriting instance matrices.

## Items & looting (milestone 3)

- Static item data: `shared/src/config/items.ts`. Loot: `config/loot.ts`. Recipes: `config/crafting.ts`.
  Limits: `config/inventory.ts`.
- `shared/src/inventory/inventory.ts` holds the pure slot rules, shared by server and tests.
  The client never mutates items; it renders the server's `inventory` / `containerUpdate` messages.
- Server: `ContainerSystem` (lazy fill, timed re-roll, viewers), `GroundItems` (interest-managed drops),
  `InventorySystem` (validates every `invOp`: ownership, range, line of sight, weight).
- Looking at a container: the client raycasts its physics world, and `ContainerIndex.atPoint(hit)` maps the
  hit point to a container box. The server repeats the ray from the player's eye and requires the first hit to
  be inside that container, which prevents looting through walls.

## Survival & death (milestone 4)

- `SurvivalSystem` (server) owns health, hunger, thirst and bleeding (`PlayerRecord.stats`, persisted).
  Stamina stays inside the predicted movement state.
- There is one damage entry point, `SurvivalSystem.damage()`. Death drops the inventory into a dynamic `loot_bag`
  container that appears in the world as a ground entity, and the player respawns at an edge spawn after a delay.

## Combat (milestone 5)

- The client sends `attack {seq, dir, aim}`. The server re-derives the origin (its own eye position), the spread
  (from its own movement state) and the pellets (from the shared seed), then resolves hits against the world and the
  hitboxes of players and dummies. It applies damage via the survival system and confirms hits to the shooter.
- The client predicts only the presentation: tracers, recoil, the ammo count, and the swing and reload animations.
- Viewmodels live in a separate Three.js scene rendered after the world with the depth buffer cleared.

## Zombies (milestone 6)

- **Server-only simulation.** A tiled Recast navmesh is built from the map boxes (with stair off-mesh links),
  and a Detour crowd steers the agents.
- `ZombieSystem` runs the senses and state machine, applies closed-door blocking after each crowd step, and
  handles attacks.
- `WeaponSystem` treats zombies as hit targets. Clients receive interest-managed `NetZombie`s in each snapshot and
  animate them procedurally.

## PvP & lag compensation (milestone 7)

- Attacks carry `afterSeq` (the input they follow) and `viewTime` (what the shooter saw).
- The server runs each attack right after that input is simulated, so the shooter's origin is exact. It then
  rewinds players and zombies through their position histories to `viewTime` (capped at 350 ms) before the hit test.
- Deaths are broadcast to everyone as kill feed entries.

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
