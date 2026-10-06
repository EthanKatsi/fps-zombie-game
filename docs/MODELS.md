# Realistic character models (drop-in)

The game draws zombies and players with a procedural jointed body by default. If you put
rigged, animated models in `client/public/models/` and list them in
`client/public/models/manifest.json`, the game loads them on start and uses them instead.
Nothing else needs to change. If a file is missing or fails to load, that character falls
back to the procedural body, and the browser console prints `[models] ...`.

Model files are **not committed**: `client/public/models/*` is gitignored except the example
manifest. Every machine that runs the client needs its own copy.

## Licences

Realistic zombie models are almost never CC0. The usual licence is **CC-BY**: free to use, but
you must credit the author. Put the credit text in the manifest's `credit` field and it shows
up in **Menu → Credits**. Don't use "editorial", "NoAI" or non-commercial models if the game
might ever be public.

## Option A: Mixamo (best animations, free Adobe account)

1. Go to https://www.mixamo.com and sign in.
2. **Characters** tab: pick a zombie. Good picks are *Zombie Girl*, *Parasite L Starkie*,
   *Mutant*, *Warzombie F Pedroso*, *Ch10 / Ch39 zombies* and *Yaku J Ignite*. Search "zombie".
3. **Animations** tab, with the zombie selected: download each of these as **FBX Binary**,
   **With Skin** for the first one, **Without Skin** for the rest, 30 fps, and tick
   **In Place** where it's offered:

   | Role     | Mixamo search            |
   |----------|--------------------------|
   | idle     | "Zombie Idle"            |
   | walk     | "Zombie Walk"            |
   | run      | "Zombie Running"         |
   | attack   | "Zombie Attack"          |
   | death    | "Zombie Dying"           |
   | hit      | "Zombie Reaction Hit"    |

4. Put them in `client/public/models/zombie1/` as `idle.fbx`, `walk.fbx`, and so on. Repeat
   with a second and third character for variety (`zombie2/`, `zombie3/`).
5. Players: pick a survivor-looking character (for example *Swat*, *Soldier* or *Ely*).
   Download the regular "Idle", "Walking", "Running", "Crouch Idle", "Crouched Walking" and
   "Dying" animations into `client/public/models/player/`.

Mixamo assets are royalty-free for games, and credit is optional. You can still add
`"credit": "Character and animations: Mixamo (Adobe)"`.

## Option B: Sketchfab (glTF, CC-BY)

1. Sign in at https://sketchfab.com. Search "zombie rigged animated" and filter by
   **Downloadable** and **Animated**.
2. Suggested picks:
   - "Zombie (Rigged & Animated)" by Aiden Studios: CC-BY, about 19.5k triangles,
     idle/walk/attack.
   - "Realistic Zombie Hitman": CC-BY, about 93k triangles. It looks great but is heavy, so use
     at most one variant.
3. Download **glTF** (not "original"), unzip into `client/public/models/zombieN/`, and keep
   `scene.gltf` next to its `scene.bin` and `textures/` folder.
4. Copy the licence line Sketchfab shows ("Model by X, licensed under CC-BY-4.0") into
   `credit`.

Keep each model under about 30k triangles. There can be 60+ zombies on screen at once.

## manifest.json

Copy `client/public/models/manifest.example.json` to `manifest.json` and edit it:

```json
{
  "zombies": [
    {
      "model": "models/zombie1/idle.fbx",
      "animations": {
        "walk": "models/zombie1/walk.fbx",
        "run": "models/zombie1/run.fbx",
        "attack": "models/zombie1/attack.fbx",
        "death": "models/zombie1/death.fbx",
        "hit": "models/zombie1/hit.fbx"
      },
      "walkSpeed": 0.9,
      "credit": "Zombie: Mixamo (Adobe)"
    },
    {
      "model": "models/zombie2/scene.gltf",
      "credit": "\"Zombie (Rigged & Animated)\" by Aiden Studios, CC-BY-4.0, via Sketchfab"
    }
  ],
  "player": {
    "model": "models/player/idle.fbx",
    "animations": {
      "walk": "models/player/walk.fbx",
      "run": "models/player/run.fbx",
      "crouch": "models/player/crouch.fbx",
      "crouchWalk": "models/player/crouch_walk.fbx",
      "death": "models/player/death.fbx"
    },
    "credit": "Player: Mixamo (Adobe)"
  }
}
```

Fields (see `client/src/game/models/ModelLibrary.ts`):

| Field | Meaning |
|---|---|
| `model` | The rigged mesh, `.fbx`, `.glb` or `.gltf`. Clips inside it are found by name (idle, walk, run, attack, death, hit, crouch). |
| `animations` | One file per role, used for Mixamo-style separate exports. |
| `clips` | Map a role to an exact clip name inside the model if auto-matching picks wrong. |
| `height` | Target height in metres (default 1.8). The model is scaled to it. |
| `rotationY` | Turn the model if it walks backwards (default `3.14159`; try `0`). |
| `walkSpeed` / `runSpeed` | m/s the clip was authored at. Playback is synced to real speed so feet don't skate. |
| `credit` | Shown in Menu → Credits. Required for CC-BY. |

Zombie variants are assigned by zombie id. Each type keeps its size from
`shared/src/config/zombies.ts`: bloaters are bigger and runners smaller. Root motion is
removed automatically, because the server moves the characters.

## Variants and common problems

- An `animations` role can be a **list** of files, e.g.
  `"attack": ["models/zombie1/zombie attack.fbx", "models/zombie1/zombie biting.fbx"]`. Each zombie picks one,
  so a crowd doesn't attack in sync.
- **"FBX version not supported, FileVersion: 6100"**: the file is an old FBX 2011 export, which three.js can't
  read. In Mixamo, download the character again with Format **FBX Binary (.fbx)** (version 7.x) and
  **Skin: With Skin**.
- **Animation files contain no body.** Mixamo animations downloaded "Without Skin" are bones only. You still need
  one file **With Skin** as `model`. Any Mixamo animation file downloaded with skin works.

## Checking it worked

Hard-refresh the page. The console should print `[models] 2 zombie model(s), player model: yes`.
If a character walks backwards, set `"rotationY": 0`. If it slides or moonwalks, adjust
`walkSpeed`.
