# Grey Season (menu title: "The Walking Dead")

Browser multiplayer open-world zombie survival FPS. TypeScript monorepo: `/shared` (types, configs,
deterministic sim, world gen), `/server` (Node + Socket.IO + Rapier + SQLite, authoritative), `/client`
(Vite + Three.js + Rapier).

**Start here:** `docs/PROGRESS.md` (status, what's done, what's next), `docs/SPEC.md` (the owner's original
requirements plus later changes), `docs/ARCHITECTURE.md` (design), `docs/MODELS.md` (drop-in character models).

## Commands
- `npm install`, then `npm run dev` (server :2567 + Vite :5173, `tsx watch` hot-reloads the server)
- `npm test` runs the shared and server tests. They must all pass before committing.
- `npm run typecheck` checks all 3 packages. `npm run build` builds the client.

## Working rules
- **Milestone workflow** (from the owner): build one milestone at a time. Make sure it runs and the tests pass,
  commit, then tell the owner how to test it before starting the next one. Update `docs/PROGRESS.md` at the end
  of every milestone.
- **Server-authoritative**: clients send inputs and requests only. The server validates range, line of sight,
  ownership, cooldowns and weight. Never trust client positions or item states.
- **Shared determinism**: movement (`shared/src/sim/movement.ts`) and world generation run identically on client
  and server. Don't use `Math.random` in generators; use the seeded `mulberry32`. The map is never sent over
  the wire, only `{mapId, seed}` plus a hash check.
- **Balance values live in config files** (`shared/src/config/*.ts`, server ops in `server/src/config.ts`).
  Don't hard-code tuning numbers in logic.
- Bump `PROTOCOL_VERSION` in `shared/src/net/protocol.ts` whenever the wire format changes.
- DB schema changes: append a new migration in `server/src/db/migrations.ts`. Never edit a released one.
- Keep the original setting (Calder Point, original characters). Only the main-menu text uses "The Walking
  Dead" branding, at the owner's request. It's an AMC trademark, so the project must stay private.

## Environment gotchas (Windows)
- **The owner usually has their own `npm run dev` running in Windows Terminal.** Don't kill it. Its
  `tsx watch` picks up server edits automatically (which disconnects connected players). If you start your own
  dev server, the ports clash: check `netstat -ano | grep 2567` and inspect parent processes first, and only
  stop processes you started. `TaskStop` on a background `npm run dev` leaves child node processes running,
  so clean those up by PID.
- When editing files with Python, always use `io.open(p, encoding='utf-8')`. The default cp1252 breaks on `·` etc.
- Complex multi-line edits are safer as a Python script written to the scratchpad than as bash heredocs.
- Browser automation (Claude in Chrome) runs in a hidden window where requestAnimationFrame is throttled.
  Use the dev-only `window.__game` handle to inspect state. Don't call `__game.frame()` in a loop: it multiplies rAF chains and freezes the tab.

## Physics performance (important)
- **Never call `world.step()` during play.** On the big map it costs ~8 ms on the server and ~22 ms in the browser
  (a visible hitch). Rapier only sees moved, added or enabled colliders after a step, so:
  - doors have one collider per pose and switch with collision groups (`DoorColliders.set`), which queries see
    immediately;
  - vehicles are invisible to queries (`VEHICLE_GROUPS` filter 0). Players and vehicles collide with them via
    `pushOutOfBox` (obstacle providers on `CharacterMotor` / `VehicleMotor`). The "Drive" prompt is a ray-box
    test in `VehiclesView.pick`.
- The only steps are at startup, after building the map colliders.

## Git
- The repo is the project folder (`main` branch). Commit messages end with the Co-Authored-By line the
  harness provides.
