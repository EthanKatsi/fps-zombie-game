# Progress log

The single source of truth for where the project stands. Update it at the end of every milestone.
Original requirements: [SPEC.md](SPEC.md). Design: [ARCHITECTURE.md](ARCHITECTURE.md).

## Status

| # | Milestone | Status | Commit |
|---|---|---|---|
| 1 | Monorepo, physics FPS controller, multiplayer | ✅ Done | `df3293b` (+ mouse fix `63370cd`) |
| 2 | City generation, buildings, doors, stairs, performance | ✅ Done | `5a8abfe` |
| 3 | Inventory, looting containers, item pickup/drop | ✅ Done | `8e67c76` |
| 4 | Survival stats, death, respawn | ✅ Done | `72da7a7` |
| 5 | Weapons & FPS combat with viewmodels | ✅ Done | `de9e212` |
| 6 | Zombies (navmesh AI, noise/vision, combat) | ✅ Done | `24bc1f2` |
| 7 | PvP, lag-compensated hits, death loot bags, kill feed | ✅ Done | `eb1c0b9` |
| 8 | Groups/teams and chat | ✅ Done | see git log "Milestone 8" |
| 9 | Base building, storage, respawn beds | ⏳ Next | |
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
- **Roof access** (added after M4): every multi-floor building has one more flight from the top floor up
  through a railed hatch in the roof. Flights start at `STAIR_Z0 = wall + 1.6 m`, leaving a walkway along the
  front wall. Front doors hinge on the right so an open door never blocks the ground-floor stairs, and
  furniture keeps a 1.4 m landing clear. The test walks from the street to the roof of a house, an apartment and
  the police station.
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

## Milestone 4: survival ✅

- **Config** (`shared/src/config/survival.ts`):
  - Hunger drains 1.25/min and thirst 1.8/min, faster while sprinting.
  - Starvation, dehydration and bleeding each deal damage per second.
  - Health regenerates while food and water are both 70 or above.
  - Fall damage starts at a 13 m/s landing (about a 3.8 m drop), and falls dealing 25 or more start bleeding.
  - Respawn delay is 5 s, and the death bag despawns after 30 min.
- **Server** (`server/src/game/SurvivalSystem.ts`):
  - Ticks the stats and sends `stats` when the rounded values change (checked every 0.5 s).
  - All damage goes through `damage(p, amount, cause, attacker?)`. Zombies (M6) and PvP (M7) must use it.
  - `kill()` moves the whole inventory into a death bag, counts deaths and kills, and sends `died`.
  - Fall damage comes from `ServerPlayer.simulate(dt, onLand)` landing detection. It's server-only and not predicted.
- **Consumables**: the `use` op (left-click with the item in hand, or double-click it in the inventory).
  - Each has a use time (`ItemDef.consume.useTimeMs`) and shows a progress bar.
  - Sprinting, or moving/dropping the item, cancels it.
  - Items that would do nothing are refused ("You don't need that right now").
- **Death**: the player is marked dead and ignores inputs (but still acks their seq numbers).
  - Dead players are left out of other players' snapshots.
  - The client stops predicting and shows the death screen with the cause and a countdown.
  - `respawn` gives a random edge spawn, full health, 80 food and water, and a fresh starting kit.
  - The client calls `LocalPlayer.resetTo(state)`.
- **Death bags**: dynamic containers (`ContainerSystem.addDynamic`, key `b<id>`) shown in the world as ground items with `defId: 'loot_bag'`.
  - "Search X's Bag" opens the container.
  - A bag disappears when emptied or when it despawns (`GroundItems.onRemove` also removes its container).
- If a player disconnects while dead, their next join starts a fresh life (`reviveAt`).
- **Client**: `ui/SurvivalHud.ts` handles the HP, food, water and stamina bars (pulsing when low), the BLEEDING warning, the hit flash and low-health vignette, the use progress bar, and the death screen.

## Milestone 5: combat ✅

- **Config**: `shared/src/config/weapons.ts` defines the 8 weapons plus fists. It covers damage, headshot multiplier,
  fire rate, range, noise radius, bleed chance, stamina cost and windup (melee), and magazine, reload time,
  pellets, spread (hip/ADS/moving), recoil, ADS FOV and projectile speed/gravity (guns). Global rules live in `COMBAT`.
- **Shared math** (`shared/src/combat/combat.ts`):
  - `spreadDegrees` grows with movement and being airborne, and shrinks when aiming or crouching.
  - `pelletDirections` is deterministic, seeded by `shotSeed(salt, seq)`. The server sends the salt at join, and the
    client numbers its attacks strictly +1, so client tracers match the server's pellets and the client can't shop
    for lucky seeds.
  - Humanoid hitboxes: a head sphere plus a body capsule, with ray tests.
- **ADS** is `Buttons.aim` in the movement input. Aiming walks at 60% speed with no sprint, and it's predicted.
- **Server** (`server/src/game/WeaponSystem.ts`):
  - Validates every attack: seq, fire rate (accepting up to 20% early for jitter), ammo, durability, stamina, and no
    attacking mid-reload or mid-swing.
  - Hitscan sums per-target damage across pellets.
  - Melee lands after its windup, using a 5-ray sweep from the latest view direction.
  - Crossbow bolts are server projectiles with gravity. A bolt that hits a wall can drop back as a pickup (70%).
  - Reload moves ammo from the inventory into `ItemStack.loadedAmmo`. Switching weapons cancels it.
  - All player damage goes through `SurvivalSystem.damage(..., 'player', attacker, false, from)`, which sends the
    victim `damaged` with a direction and the shooter `hitConfirm`.
  - Shots are broadcast within 250 m (`shotFired`) for effects, and recorded in `NoiseSystem` for M6 zombies.
- **Dummies**: 5 on a shooting range in the police block (`generateCity` `shootingRange`), plus 5 on the test map.
  150 HP each; they tip over and get back up after 8 s (`DummySystem`).
- **Client**:
  - `weapons/Viewmodel.ts`: procedural low-poly models with equip, swing, kick, reload, use, ADS and bob. Drawn in a
    second render pass so they never clip into walls.
  - `weapons/WeaponController.ts`: input, local prediction (ammo, stamina, tracers, recoil with partial recovery),
    reload and ADS.
  - `Effects.ts`: tracers, a pooled muzzle-flash light, impact bursts and bolts.
  - `ui/CombatHud.ts`: a crosshair that widens with spread, an ammo counter, hit markers (red for head/kill), the
    rifle scope overlay and a damage direction arc.
  - Remote players show their held item and a muzzle flash.
- **Wayfinding** (added after M5): the police station has a blue/white stripe band and a roof light bar, and the
  debug overlay shows which building and floor you're in ("in Police station (floor 2)"). In seed 1337 the
  police station is around x=-187, z=163.
- **Not yet**: lag compensation (M7). The server currently tests against present positions, so fast-moving targets
  are a little harder to hit at high ping. Structure damage from melee comes in M10.

## Milestone 6: zombies ✅

- **Config** (`shared/src/config/zombies.ts`):
  - **Walker:** slow; 80 HP.
  - **Runner:** chases at 5.6 m/s, faster than you walk but slower than you sprint.
  - **Bloater:** 260 HP, hits hard, slow.
  - Each type has its own attack windup, vision range and FOV, hearing and headshot multiplier.
  - `ZOMBIES` holds population, spawning, despawning, density, night multiplier, AI timing, bleed and drop chance.
- **Navigation** (`server/src/game/Navigation.ts`):
  - `recast-navigation` builds a **tiled navmesh** from every collidable map box, in about 4.7 s for the city.
  - It's cached to `server/data/navmesh-<map>-<seed>-<hash>-v<N>.bin` (gitignored), so restarts are instant.
  - **Stairs**: the 45° ramp colliders don't rasterize into connected navmesh reliably, so the city generator records
    every flight as a `NavLink` (foot → landing), which becomes a Detour off-mesh connection. Tests prove zombies
    climb to roofs.
  - Lessons learned (see git history):
    - Triangle winding must be CCW from outside, or box tops count as unwalkable.
    - The tile cache's layers don't connect overlapping ramps/floors within a tile, so we use the plain tiled navmesh.
  - **Doors** aren't in the navmesh (paths go through doorways). Instead, after each crowd step, a zombie whose move
    would cross a closed door panel is put back, so zombies pile up at closed doors. Bashing them comes in M10.
- **AI** (`server/src/game/ZombieSystem.ts`): one Detour `Crowd` agent per zombie.
  - **Thinking:** every 250 ms (staggered). Each zombie tracks which noises it has already heard.
  - **Senses:** a vision cone with line of sight (walls and closed doors block it, and crouching shortens vision), a
    3 m proximity sense, and hearing via `NoiseSystem` (gunshots carry 120–220 m, melee barely).
  - **States:** idle/wander → investigate (noise or last-seen spot) → chase → lunge attack, with a windup you can
    dodge and a cooldown.
  - **Damage:** being shot makes a zombie chase the shooter.
  - **Death:** the agent is removed, the corpse stays for 8 s, and there's a 25% chance of a drop from the
    `zombie_drop` loot table.
  - **Spawning:** around each player at 35–85 m, up to `perPlayer` × density (busier blocks hold more) × night
    multiplier.
  - **Despawning:** zombies more than 140 m from every player for 20 s are removed. There's a global cap of 180.
- **Combat**: zombies are `WeaponSystem` targets (`kind: 'zombie'`) with their own headshot multiplier.
  Zombie hits go through `SurvivalSystem.damage(..., 'zombie', null, false, zombiePos)`, so you get the direction
  arc, bleeding chance, and the death screen's "The dead got you."
- **Network**: `Snapshot.zombies` (within 110 m) carries id, type, position, yaw and animation state. The client's
  `ZombiesView.ts` interpolates them like players, with procedural animation (shamble, sprint with arm pumping,
  lunge, fall over). Bloaters are fat, runners lean.
- **Day/night hook**: `server/src/game/WorldClock.ts` (48-minute day) already drives the night spawn multiplier;
  M11 adds the lighting.
- **Admin**: `POST /admin/zombies {"username":"kats","count":5,"type":"runner"}` spawns zombies 8–16 m away.
- **Known limits**:
  - Players walk through zombies (no player–zombie collision, which keeps prediction simple).
  - Zombies don't open doors.
  - No groan audio yet (M11).

## Extra: realistic graphics pass (requested after M7)

Everything is generated in code (no downloaded assets):
- `client/src/render/textures.ts`: **15 procedural surfaces**, rendered on the GPU at startup into two 512×512 array
  textures. The surfaces are brick, concrete, cracked asphalt, wood planks, lap siding with peeling paint, grass,
  tiles, plaster, brushed/rusty metal, fabric, roof gravel, sidewalk slabs, bark, leaves and a plain one.
  - The detail texture holds the colour multiplier plus a grout mask; the second holds the relief normal plus
    roughness.
  - The first version generated them on the CPU and froze the page for ~45 s. Keep generation on the GPU.
- `client/src/render/worldMaterial.ts`: `MeshStandardMaterial` + `onBeforeCompile`. It samples those textures
  **triplanar in world space** (nothing stretches on scaled boxes), with per-instance surface index, roughness and
  metalness (`aTex`/`aSurf` attributes), plus grime near street level and large weathering stains.
  `SURFACE_OF` maps map material keys to surfaces.
- `client/src/render/atmosphere.ts`: an art-directed hazy gradient sky with a sun glow, a warm sun with soft 4K
  shadows, IBL reflections baked from the sky, and exponential haze. `setSun(elev, az)` is the M11 day/night hook.
  - Three.js' physical `Sky` was tried and blew everything out (HDR values). Don't use it without heavy exposure
    tuning.
- `client/src/render/postfx.ts`: GTAO ambient occlusion → subtle bloom → tone mapping → colour grade (desaturation,
  split toning, contrast, vignette, film grain).
- Foliage renders as lumpy blobs and trunks as cylinders (`MapRenderer` shapes). Glass is reflective.
- **Graphics quality** on **F8**: High (AO, 4K shadows), Medium (no AO, 2K shadows), Low (no post-processing,
  1K shadows, pixel ratio 1). Remembered in localStorage (`grey.gfx`).

- **Load time**: generating the textures takes ~0.2 s. The very first load after a code change pays a one-time
  ~5 s Direct3D (ANGLE) shader compile; later loads use Chrome's shader cache.
  - Generator shaders are one small program per surface. A single big program took 6–12 s to compile.
  - `renderer.compileAsync()` runs before the first frame, so joining doesn't freeze the page.

## Extra: realistic animation pass (requested after M7)

- `client/src/game/anim/Humanoid.ts`: a jointed procedural humanoid for players and zombies. It has hips, a spine
  (lean, twist, hunch), neck and head with a simple face (and hair for survivors), shoulder/elbow/hand and
  hip/knee/ankle joints, with capsule limbs.
  - **Gait** is driven by distance travelled, so feet don't slide. It includes hip bob, sway and rotation, torso
    counter-twist, arms opposite the legs, knee bend in the swing phase, a run lean, backpedal, strafe and crouch.
  - **Zombie styles** (per zombie): reach, limp, hunch, runner arm-flailing, lunge/swipe attack.
  - **Players** have a two-handed gun hold that follows their aim, a cocked melee arm with swing, and an item held low.
  - **Hit flinch**: the server sends a hit counter `hc` in `NetPlayer`/`NetZombie`, and clients flinch when it changes.
  - **Death**: knees buckle, then the body topples with gravity-like acceleration and goes limp.
- **First person**:
  - head-bob and roll synced to footsteps (`LocalPlayer.stepPhase`, advanced by distance)
  - a landing dip scaled by fall speed
  - spring-damped weapon sway that lags behind mouse look
  - a figure-eight weapon bob
  - a sprint pose (guns canted down and across, melee raised)
  - idle breathing (reduced while aiming)

## Extra: camera views and controls (requested after M7)

- **V** cycles the camera: first person → third person (over the shoulder) → facing view (looking at your face) →
  first person. The user chose V because R stays Reload.
  - `LocalAvatar` (in `RemotePlayers.ts`) is your own humanoid body, shown in the two outside views.
  - `Game.applyCameraMode` moves the camera out from the eye and stops it short of walls.
  - `Game.aimRay` gives shots and E-interactions an origin at the eye, aimed at the point under the crosshair
    (correct over-the-shoulder aiming). In the facing view it uses your facing direction and hides the crosshair.
  - The rifle scope overlay only appears in first person.
- **Crouch is Shift; sprint is double-tap W and hold** (user request, replacing an earlier Ctrl-crouch that needed
  fullscreen + keyboard lock to stop Ctrl+W closing the tab - that workaround was removed). `Input.sprintLatched`
  is set by a second W press within 300 ms and cleared when W is released.

## Extra: settings, photo textures, drop-in character models (requested after M7)

- **Settings** (`client/src/settings.ts`, localStorage `grey.settings`): Menu → Settings and the pause screen (Esc).
  - Graphics quality: High (AO + bloom), Medium, Low (no post-processing), Performance (no shadows, lower resolution).
  - Mouse sensitivity and field of view. F8 still cycles the quality.
- **Photo textures**: 14 CC0 Poly Haven 1K sets live in `client/public/textures/` (diffuse/normal/roughness plus
  `manifest.json`). `render/textures.ts loadPhotoSurfaces` blits them into the existing texture-array layers after
  start-up, so the procedural textures show first and swap out within about 2 s. The albedo is divided by the
  photo's average colour, so map material colours still tint it. `invScale` follows the photo's real size in metres.
- **Character models** (`client/src/game/models/ModelLibrary.ts`, user guide in `docs/MODELS.md`):
  - Realistic zombie and player models are CC-BY or Mixamo, which need an account, so the **user downloads them**
    into `client/public/models/`. That folder is gitignored except `manifest.example.json`.
  - With no `manifest.json` there, everything falls back to the procedural `Humanoid`.
  - `ModelRig` implements the same `CharacterBody` interface as `Humanoid`, using AnimationMixer clips:
    - idle, walk and run, with playback synced to speed;
    - attack, hit and death;
    - crouch, falling back to walk and idle;
    - a topple if there's no death clip.
  - Root motion is stripped. The hand anchor follows the hand bone's position in metre space, so held items keep
    their size.
  - Verified with the three.js example `Soldier.glb` as both zombie and player, then removed.
- **Menu → Credits** lists the model `credit` strings (required for CC-BY) and the Poly Haven texture names.

## Extra: sniper rifle and armour (requested after M7)

- **Sniper rifle** (`sniper_rifle`): bolt-action, `.308 Rounds` (`ammo_308`), 95 damage with a ×2.5 headshot,
  0.55 shots/s, 5-round magazine, 400 m range and an 11° scope.
  - Spread is huge from the hip or on the move.
  - Rare loot from gun shop lockers and police crates; the ammo comes from gun shop cabinets and police crates.
  - `WeaponDef.scope` now marks the weapons that get the full-screen scope (hunting rifle, sniper).
  - Mouse sensitivity scales with zoom: `tan(fov/2)` ratio in `Game.updateAim`.
  - Note: players and zombies are only sent within `NETWORK.interestRadius` (150 m), so that is the effective
    sniping range for now.
- **Armour** (category `armor`, `ItemDef.armor {slot, reduction, equipTimeMs}`):

  | Item | Zone | Reduction | Durability |
  |---|---|---|---|
  | Riot Helmet | head | 35% | 120 |
  | Combat Helmet | head | 50% | 180 |
  | Police Vest | body | 30% | 160 |
  | Plate Carrier | body | 50% | 240 |

  - To wear a piece, "use" it (click while holding it, or double-click it in the inventory). This goes through
    `SurvivalSystem.startUse` with a progress bar, and swaps with whatever was worn.
  - Worn pieces live in `Inventory.equipment {head, body}` (saved in the inventory JSON, so no migration). They
    show under "Worn armour" in the inventory; double-click or right-click to take one off
    (`InventoryOp unequip`).
  - `SurvivalSystem.damage` routes player and zombie hits through `absorbWithArmor`: the helmet for headshots,
    the vest otherwise. Durability drops by the absorbed amount × `COMBAT.armorWearPerDamage`. A piece breaks at
    0, with a notice.
  - Starvation, thirst, bleeding and falls ignore armour.
  - Worn armour goes into the death bag.
  - Others see it: `PlayerFlags.helmet`/`vest` (protocol v9), drawn by `Humanoid.setArmor`. Loaded models
    ignore it.
  - Loot: police lockers (riot helmet, police vest), police crates (combat helmet, plate carrier), rare zombie
    drops.
  - Test: `server/test/survival.test.ts` "armour: ...".

## Extra: slower zombies, push-away doors, converted zombie model (requested after M7)

- **Zombie speeds lowered** (owner: "don't make the zombies that fast"). Chase speeds are now 1.6 (walker),
  3.4 (runner) and 1.1 (bloater) m/s; walk speeds are 0.6 / 0.9 / 0.45. All are below a walking player (4.2).
- **Doors open away from you** however close you stand (owner request).
  - `DoorColliders.dir` (1 / -1) and `doorPose(def, ±1)` let a door swing either way.
  - The server picks `doorAwayDir` for the user and falls back to the other way only if a player would end up
    inside the panel (`doorPanelHits`).
  - Closing is refused only when someone stands in the doorway.
  - Protocol v10: `doorChanged.dir` and `JoinAccepted.reversedDoors`.
- **Zombie model**: the owner's Mixamo `X Bot.fbx` is FBX 6.1, which three.js can't read. It was converted to
  `client/public/models/zombie1/character.glb` with FBX2glTF (`npx fbx2gltf`, npm package `fbx2gltf@0.9.7`;
  it reads old FBX files).
  - `ModelLibrary` rescales the position tracks of animations loaded from separate files to the model's hips
    rest height, because FBX animations are in cm while the converted glTF is in m.
  - Models are gitignored, so only the loader change is committed.

## Extra: durability only on armour; Yaku zombie model (requested after M7)

- **Durability only on armour** (owner request). Weapons and the flashlight have no `maxDurability`, never
  wear and never break.
  - `normalizeInventory` strips leftover `durability` from saved non-armour items, so previously broken weapons
    work again.
  - Removed `COMBAT.meleeWearPerHit` and `gunWearPerShot`.
- **Zombie model**: the owner downloaded Mixamo **Yaku J Ignite**
  (`client/public/models/zombie1/zombie_model.fbx`, FBX 7.7 with embedded textures).
  - It was converted with FBX2glTF to `zombie1/zombie.glb`, then the glTF JSON was patched:
    - hook up the normal map (the converter dropped it);
    - metallic 0 and roughness 0.85 (the converter made it shiny plastic);
    - the clothing material set to `MASK` with alpha 1 (it came out fully transparent).
  - Your animation FBX files drive it.
  - The X Bot mannequin (`character.glb`) is no longer used.
  - To redo a conversion: run `FBX2glTF.exe --binary --input x.fbx --output x` from the npm package
    `fbx2gltf@0.9.7`, then apply the same material fixes.

## Extra: vehicle fixes, fuel and gas cans (owner feedback after the big world)

- **Lag fixed.**
  - The server no longer "coasts" a driven vehicle on ticks where the driver's input hasn't arrived yet.
    Doing that double-stepped it versus the client's prediction and caused constant rubber-banding.
    Prediction corrections are now 0.
  - `world.step()` costs about 7.5 ms on the big map, so it is throttled: at most every 0.5 s on the server and
    every 0.3 s on the client, only when vehicles moved or appeared.
  - Vehicle corrections blend smoothly.
- **New vehicle physics.** The character-controller box sank into flat ground and snagged on lips. Now:
  - the collision box floats 0.38 m above the ground, so curbs and road edges pass under it, and only slides
    along walls;
  - ground height comes from 5 downward rays, so the vehicle rides the highest one and climbs curbs;
  - gravity applies when airborne.
- **Damage only from real crashes.** The body actually has to hit something.
  - Above 6 m/s of speed lost: 25 + 6 per m/s. A sedan survives about five hard crashes.
  - Occupants are hurt only above about 50 km/h of speed lost.
  - Running over zombies no longer damages the vehicle.
  - Zombies can't bite people inside sedans or pickups (motorcycles can be).
- **Fuel** (`VehicleState.fuel`, predicted like everything else) uses real figures:
  - sedan 50 L at 7.5 L/100 km (about 650 km);
  - pickup 80 L at 12 L/100 km;
  - motorcycle 16 L at 4.5 L/100 km;
  - plus idling.
  - Vehicles spawn with 15-60% of a tank. Empty: the engine stops, but you can still roll and steer.
  - The HUD shows fuel in litres.
- **Gas cans** (`gas_can`, `ItemStack.fuel`, 10 L).
  - Found in car trunks, hardware shelves and grocery stock rooms; often empty.
  - Hold one and press E on a vehicle to pour it in.
  - Press E at a gas station pump (`MapData.fuelPumps`) to fill the can.
- Protocol v12. Test: vehicles.test.ts "no fuel, no driving...".

## Extra: big world and drivable vehicles (requested after M7)

- **New default map `world`** (`generateWorld.ts`, `WORLD` config), 1.28 km across:
  - the walled downtown (north-east) with west and south gates and army checkpoints outside them;
  - the suburbs (south-east);
  - a big forest in the west with 10 cabins and a campground;
  - a gas station, highways and dirt roads, and a perimeter fence.
- **Size.** About 60k pieces (33k colliders). It generates in about 90 ms. The navmesh takes about 33 s to build
  once, then loads from `server/data/navmesh-world-*.bin`.
- **Old maps.** The city generator became `generateGrid`, used for both downtown and the suburbs. The old `city`
  map and `testmap` remain for tests.
- **Client rendering.** New pine (cone) and rock (blob) shapes. New materials: forest floor, dirt, burnt car,
  tent and army green. Whole chunks beyond the far plane are hidden.
- **Vehicles:** sedan (4 seats), pickup (2) and motorcycle (2). 39 of them are parked around the world; every
  type is guaranteed to appear in the suburbs. See ARCHITECTURE.md "Vehicles".
  - E gets in; the driver's seat is taken first. W/S drive, A/D steer, Space handbrake, E gets out (below
    4 m/s, beside your door).
  - The chase camera drifts back behind the car when you leave the mouse alone; V switches to the seat view.
  - The speed / health HUD sits bottom right.
  - Drivers can't shoot; passengers can.
  - Running over zombies or players at speed hurts them. Crashes damage the vehicle and occupants. Wrecks
    burn out, eject everyone and respawn after 5 minutes. Engine noise draws zombies.
  - Vehicles are not saved. They reset to their spawns when the server restarts.
- Tests: `server/test/vehicles.test.ts` (enter/drive/exit rules, passengers, running over, world contents).
- **Note.** Players' saved positions from the old city map are kept if they're valid ground in the new world
  (they'll appear somewhere around the map). Invalid ones respawn on a road.

## Extra: assault rifle (requested after M7)

- An `assault_rifle` item plus weapon. It's the first **full-auto** weapon (`WeaponDef.automatic`: hold to fire):
  10 rounds/s, 22 damage, 30-round magazine, 5.56 ammo, 2.6 s reload, low recoil per shot.
- Rare loot: police lockers, police crates and gun shop lockers.
- The server fire-rate check already throttles modified clients (tested).

## Milestone 8: groups and chat ✅

- **Groups** (`server/src/game/GroupSystem.ts`, config `GROUPS`). Up to 6 members, one leader.
  - Create (name 3-20 characters, unique), invite (the target must be online; invites expire after 2 minutes),
    accept / decline, leave, and kick / make leader (leader only).
  - When the leader leaves, an online member takes over. The last member out disbands the group.
  - Persisted: migration 2 adds a `groups` table, and membership is `players.group_id`
    (`SqliteGroupRepository`; `MemoryGroupRepository` is the default when no database is given).
  - Offline members stay members and show as offline.
- **Friendly fire off** (`GROUPS.friendlyFire`): guns, melee and running people over all skip teammates
  (`sameGroup` in `WeaponSystem.hit` and `VehicleSystem.runOver`).
- **Teammate positions** go to every online member twice a second regardless of distance (`teammates` event).
  They drive:
  - the compass (top centre: headings, plus "▼ name 41m" markers for teammates in view);
  - the minimap (top right, north-up, about 110 m radius, teammates pinned to the edge when far);
  - the full map (M, with area labels);
  - green name tags through walls: `RemotePlayer.setTeammate` for nearby teammates, `TeammateMarkers`
    (constant-size, always on top) for far ones.
- **Chat** (`ui/Chat.ts`): Enter opens it; Tab switches All / Group; Enter sends; Esc cancels.
  - The server cleans the text (control characters, 200-character cap) and rate-limits (700 ms).
  - System lines cover joins and leaves, group events and invites. Lines fade after 12 s.
  - While typing, `Input.suspended` stops the game reading keys.
- **Group panel** (G): create, answer invites, invite, member list (online dot, leader star), kick, make leader,
  leave.
- **Map image** (`ui/Navigation.ts renderMapImage`) is drawn once from `MapData`: surfaces, buildings
  (police in blue), the city wall, tree crowns and gas pumps.
- **Also:** the debug readout is hidden by default (F3 toggles it), so it doesn't cover the compass; the kill feed
  moved below the minimap.
- **Shared base access** for groups (doors and chests) arrives with bases in milestone 9: structures will check
  `sameGroup(owner, player)`.
- Tests: `server/test/groups.test.ts` covers forming a group, teammate positions, chat channels and spam,
  friendly fire, leadership handover, disbanding and persistence. The server test runner now uses
  `--test-concurrency=2` (less timing flakiness).

## Milestone 7: PvP ✅

- **Config**: `shared/src/config/pvp.ts`. PvP on/off, spawn protection (10 s, ends when you attack), max rewind
  (350 ms), history length, pending-attack timeout, kill feed duration.
- **Lag compensation** (`WeaponSystem.execute`):
  - Every player and zombie keeps a `PositionHistory` (server clock, 1 s).
  - `AttackRequest.viewTime` is the server time the shooter was rendering other entities at (their clock estimate
    minus the interpolation delay).
  - Hitscan targets are tested at their positions at `clamp(viewTime, now - maxRewindMs, now)`. The world itself
    isn't rewound.
  - `AttackRequest.afterSeq` is the shooter's last input before the shot. If the server hasn't simulated that input
    yet, the attack waits in `ServerPlayer.pendingAttacks` and runs right after that input (`simulate(..., onApplied)`),
    so it fires from exactly where the shooter's screen was.
  - Melee and crossbow bolts are not rewound: melee has a forgiving sweep, and bolts fly in real time.
- **Spawn protection**: set on join and on respawn (`SurvivalSystem.reviveAt`). While it's on, player damage is
  ignored with no hit marker. Attacking clears it.
- **Kill feed**: `SurvivalSystem.kill` broadcasts `killFeed {victim, killer, cause, weapon, headshot}` for every
  death, PvP or not. `ui/KillFeed.ts` shows the last 6 entries in the top right, highlighting the ones involving you.
- **Death screen**: "Killed by kats with a Hunting Rifle (headshot) from 64 m.", using `DeathInfo.weapon/headshot/distance`.
- **Death bags** (from M4): the killer or anyone else can loot the victim's whole inventory.
- **Teleports clear history**, so `PositionHistory` never interpolates across a teleport. Tests use `slide()` to
  move a target without clearing it.

## Admin / testing tools

`server/src/admin.ts` is a local-only HTTP admin API. Requests must come from this machine and carry the token
the server writes to `server/data/admin-token.txt` on every start (the file is gitignored).
- `GET /admin/players`: who's online, with position and health.
- `POST /admin/give` with `{"username":"kats","item":"assault_rifle","qty":1}`: guns arrive fully loaded and in full
  condition, and stacks are split as needed. The player's weight limit is ignored. Offline players get the items in
  their saved inventory.
- `POST /admin/teleport` with `{"username":"kats","to":"police"}` (any building type) or `{"username":..., "x":..,"y":..,"z":..}`.
  Offline players are moved in the DB instead.
- Example (bash, one line): `curl -s -X POST -H "x-admin-token: $(cat server/data/admin-token.txt)" -d '{"username":"kats","to":"police"}' http://localhost:2567/admin/teleport`
- Note: the `!` prefix in Claude Code runs **bash**, not PowerShell.

## Tests (run `npm test`)

- `shared/test/movement.test.ts`: physics, determinism, crouch, stairs.
- `shared/test/city.test.ts`: generation determinism and timing, spawn clearance, doors blocking and opening, stairs to the upper floor, curb stepping.
- `shared/test/inventory.test.ts`: item rules, weight, crafting, loot tables refer to real items, normalization.
- `server/test/multiplayer.test.ts`: join, visibility, duplicate names, input application, speedhack limit, persistence (on the test map).
- `server/test/doors.test.ts`: door range, swing blocking, junk ids.
- `server/test/items.test.ts`: starting kit, looting in range, no looting through walls, weight limit, crafting, drop and pickup across players, auto-close, junk ops ignored.
- `server/test/survival.test.ts`: drain, eating with use time, cancelling, refusing a useless use, starvation death leading to a lootable bag that vanishes when emptied, respawn delay and kit, fall damage and bleeding.
- `shared/test/combat.test.ts`: weapon mapping, deterministic pellets inside the cone, spread rules, head and body hitboxes.
- `server/test/combat.test.ts`:
  - pistol vs dummy, with ammo and wear
  - fire-rate and seq enforcement
  - reload, and cancelling it by switching
  - melee stamina and damage
  - headshot multiplier, and kill confirmation with the killer's name
  - crossbow projectile
  - knocking a dummy down
- `server/test/zombies.test.ts` (test map):
  - spawning and snapshots
  - seeing and chasing a player
  - hearing a gunshot 40 m away
  - a bite after the windup
  - headshot kills with confirmation
  - following a player up the stairs to a roof
- `server/test/zombie-doors.test.ts` (city): a closed door keeps a chasing zombie out; opening it lets the zombie in.
- `server/test/history.test.ts`: interpolation, clamping, the keep window.
- `server/test/pvp.test.ts`:
  - a rewound hit lands where the target was, while the same shot judged at "now" misses
  - the rewind cap
  - deferred attacks waiting for their input
  - spawn protection, and attacking ending it
  - the kill feed reaching others, and death info with weapon/headshot/distance
  - environmental deaths in the feed
- Gotcha: newly joined players have spawn protection; PvP tests set `victim.protectedUntil = 0`.
- Gotcha: players can overlap (no player-player collision). Keep test players apart from spawn points and each other, or a bystander takes the hit.
- Gotcha: a teleported test player counts as airborne (+4° spread) until they send a movement input. Use `settle()`.
- Gotcha: the test map scatters wrecked cars just outside a 6 m radius of the origin. Put test players within ~2 m of the origin, or line-of-sight checks will (correctly) fail.

## Known issues / notes

- The client bundle is about 5 MB because Rapier's WASM is inlined. Code-split in M11.
- Background tabs stop sending input (rAF pauses), so that player freezes for others.
- Lighting is flat grey for now. The day/night cycle comes in M11.
- Browser automation (Claude in Chrome) runs in a hidden window, so `requestAnimationFrame` barely runs there. Don't pump `game.frame()` manually: every call queues another rAF and the tab freezes. The dev-only `window.__game` handle exists for inspection.

## Plan for the next milestones

- **M6 Zombies**: recast-navigation-js navmesh built from the city boxes on the server, AI state machine, a spatial hash for interest management, and type configs.
- **M7 PvP**: lag compensation using a position history ring buffer per player (rewind to the shooter's time minus the interpolation delay), death bags, kill feed, killer name on the death screen.
- **M8–M10**: groups (DB tables), chat, structures with a ghost preview and snapping, beds, storage chests (persisted containers), structure health, raiding, and the offline-raid-protection config flag (already in `server/src/config.ts`).
- **M11**: day/night, flashlight (SpotLight), PositionalAudio, settings menu (sensitivity, FOV, volume, quality), balancing, and the final README.
