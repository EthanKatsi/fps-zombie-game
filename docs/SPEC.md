# Original specification

This is the original project brief, saved verbatim so it survives outside the chat. Changes the owner asked
for later are listed at the end. **When they conflict, the later changes win.**

---

Build me an online multiplayer open-world zombie survival game as a 3D first-person shooter that runs in the browser. The tone is gritty and post-apocalyptic, like a classic zombie survival drama: the world ended, the city is abandoned, and survivors are as dangerous as the dead. Use an original setting, name, and characters. Don't use any existing franchise's names, characters, or locations.

## Tech stack
- Client: TypeScript + Three.js, with Rapier (@dimforge/rapier3d-compat) for physics and collision
- First-person controls using Pointer Lock: WASD movement, mouse look, sprint, crouch, jump
- Server: Node.js + TypeScript + Colyseus (or Socket.IO if you think it's simpler), server-authoritative. The server decides movement validity, hit detection, damage, loot, and inventory so players can't cheat
- Persistence: SQLite to start (via Prisma or better-sqlite3), structured so it can move to Postgres later
- Use Vite for the client build. Put client, server, and shared types in one monorepo (/client, /server, /shared)
- Use low-poly placeholder art: simple primitives or free CC0 models (e.g. Kenney, Quaternius) loaded as glTF. Gameplay comes first, visuals later

## Core gameplay
1. **Open world city**: A 3D abandoned city with streets, houses, and stores (grocery, pharmacy, hardware store, gun shop, police station), plus parks, abandoned cars, debris, and fences. Build it from modular building pieces, placed procedurally from a seed or from a JSON layout. Buildings have enterable interiors with rooms, doors that open, and stairs. Use instancing, frustum culling, and LOD so it runs smoothly.
2. **Survival stats**: Health, hunger, thirst, and stamina. Food and water drain over time. Bandages, medkits, and food restore them. Death drops your inventory as a lootable bag and respawns you at a random city edge (or your bed, see bases).
3. **Looting**: Interact with containers (cabinets, fridges, shelves, lockers, car trunks) by looking at them and pressing E. Loot tables depend on building type. Loot respawns on a timer. Items include melee weapons (bat, crowbar, machete, axe), ranged weapons (pistol, shotgun, rifle, crossbow), ammo, food, water, medical supplies, building materials (wood, nails, scrap metal), and a flashlight.
4. **Inventory**: Slot-based with weight limits, a hotbar (1-9 keys and scroll wheel), and drag-and-drop. Simple crafting (e.g. planks + nails = barricade, cloth = bandage).
5. **FPS combat**: First-person weapon viewmodels with animations for swing, fire, and reload. Hitscan for guns and projectile physics for the crossbow. Recoil, spread that increases when moving, aim-down-sights with right-click, ammo, and reload. Melee uses stamina and has swing timing. Headshots deal extra damage. Do server-side hit validation with lag compensation (rewind player positions to the shooter's timestamp).
6. **Zombies**: AI zombies with a navmesh for pathfinding (e.g. recast-navigation-js). They wander, hear noise (gunshots attract them from far away, melee is quiet), see players in a vision cone, chase, and attack. More spawn at night and in dense areas. Types: slow walkers, fast runners, and tanky bloated ones. Simple animations (walk, run, attack, die). Simulate zombies on the server and only sync the ones near each player.
7. **PvP**: Players can damage and kill each other. Add a kill feed and show the killer's name on your death screen.
8. **Bases**: Players can claim an empty building or build on open ground using a ghost-preview placement system with snapping (walls, floors, doors with locks, barricades, storage chests, campfire, bed as a respawn point). Structures have health.
9. **Teams/groups**: Create or join a group, with group chat, teammate name tags visible through walls, teammates shown on the minimap and compass, shared base access (doors and chests), and friendly fire off within groups.
10. **Raiding**: Enemy players can damage walls and doors with tools, weapons, or craftable explosives. Base storage can be looted once breached. Add an optional offline-raid protection setting in the server config.
11. **Day/night cycle**: Dynamic lighting with a moving sun and dark nights where the flashlight matters. Add fog for atmosphere and to limit draw distance.

## Audio
3D positional audio (Three.js PositionalAudio) for footsteps, gunshots, and zombie groans so players can hear threats nearby. Gunshots should be audible from far away, both to players and to zombies.

## UI (HTML/CSS overlay on top of the canvas)
Crosshair, health/hunger/thirst/stamina bars, ammo counter, hotbar, inventory screen (Tab), compass and minimap, group panel, global and group chat (Enter), kill feed, interaction prompts ("Press E to search"), death screen, pause/settings menu (mouse sensitivity, FOV, volume, graphics quality), and a main menu with username login (no real auth yet, but structure it so it can be added).

## Networking
- Client-side prediction with server reconciliation for the local player
- Entity interpolation for other players and zombies
- Interest management: only send entities near each player
- Fixed server tick rate (20–30 ticks/sec)
- Persist players, inventories, groups, and bases in the database so they survive server restarts

## How to work
Build this in milestones. After each one, make sure it runs, commit it, and tell me how to test it before moving on:
1. Project setup, first-person controller with physics walking around a simple 3D test map, and multiple players seeing each other online
2. City generation with enterable buildings, doors, and stairs, plus performance optimizations
3. Inventory, looting containers, and item pickup/drop
4. Survival stats, death, and respawn
5. Weapons and FPS combat (melee and guns) with viewmodels
6. Zombies with navmesh AI, noise/vision detection, and combat
7. PvP with lag-compensated hit detection, death loot bags, and kill feed
8. Groups/teams and chat
9. Base building, storage, and respawn beds
10. Raiding and structure damage
11. Day/night cycle, 3D audio, settings menu, polish, balancing, and a README with run instructions

Start by proposing the folder structure and data models (Player, Item, Inventory, Weapon, Zombie, Structure, Group), then begin milestone 1. Keep game-balance values (damage, fire rate, recoil, spawn rates, loot tables, hunger/thirst drain) in config files so I can tweak them easily.

---

## Later changes requested by the owner

| Date | Change |
|---|---|
| 2026-10-05 | Main menu title changed to **"The Walking Dead"** and the tagline to **"Fight the dead. Fear the living."** The owner chose this, which overrides the "no existing franchise names" rule *for the menu text only*. Internal code names stay "Grey Season" / Calder Point. Note: these are AMC trademarks, so keep the project private. Don't publish or distribute it under that branding. |
| 2026-10-05 | Owner asked that everything be documented inside the project folder so work can resume from a fresh chat. See `CLAUDE.md` and `docs/PROGRESS.md`. |
