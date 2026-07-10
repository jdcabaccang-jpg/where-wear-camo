# Where/Wear Camo — Master Build Prompt for Claude Code

## Project Overview

Build a browser-based multiplayer hide-and-seek game called **Where/Wear Camo** (the name is a pun — players *wear* camo clothing to hide). It is inspired by Meccha Chameleon on Steam but reimagined as a 2D top-down HTML game with a distinct camo-clothing mechanic instead of a painting mechanic.

The core fantasy: hiders wear pre-made camo-patterned clothing that blends into specific map environments. They are *always* slightly visible via a silhouette shimmer — the skill is choosing the right spot and staying still. Seekers hunt with paintball guns. Hit hiders join the seeker team mid-round (infection mechanic). Roles rotate between rounds so no one is always hiding.

---

## Tech Stack

- **Game engine:** Phaser 3.60 — load from CDN: `https://cdnjs.cloudflare.com/ajax/libs/phaser/3.60.0/phaser.min.js`
- **Physics:** Phaser Arcade Physics only. Do NOT use Matter.js or Impact physics.
- **Multiplayer:** Node.js + Socket.io v4 (`npm install socket.io@4`)
- **Assets:** Kenney Top Down Nature Kit (files listed below). Character sprites: use Kenney's "Toon Characters 1" pack, or if unavailable, draw players as colored circles using Phaser Graphics API — do NOT block on art.
- **Deployment target:** Browser (Chrome/Firefox). Server on Node.js, client is a static HTML file.

**File structure to create:**
```
/server
  server.js          # Node.js + Socket.io game server
  package.json       # { "dependencies": { "socket.io": "^4.0.0" } }
/client
  index.html         # Single-file client: all JS inline, no separate .js files
  assets/
    nature/          # Kenney Top Down Nature Kit files go here
    characters/      # Kenney Toon Characters or placeholder
README.md
```

---

## Kenney Top Down Nature Kit — Asset Reference

The nature pack files are in `client/assets/nature/`. Use these specific filenames throughout. Do not guess alternative names.

**Ground tiles (use as tilemap base layer):**
- `grass.png` — primary ground, used for open areas
- `grassLight.png` — lighter grass variant, path edges
- `dirt.png` — dirt patches and clearings
- `sand.png` — sandy zones (riverbank)
- `water.png` — river/pond tiles (impassable)

**Vegetation props (placed as sprites over ground, not tiles):**
- `treePine.png` — tall pine tree, solid collision
- `treePineLarge.png` — large pine, solid collision
- `treeOak.png` — oak tree, solid collision
- `bush.png` — low bush, solid collision, good hiding cover
- `bushLarge.png` — large bush, solid collision
- `flowerRed.png`, `flowerYellow.png` — decoration only, no collision

**Rock props:**
- `rockLarge.png` — impassable rock
- `rockSmall.png` — decoration only

**Paths:**
- `pathDirt.png` — dirt path tile

If any of these filenames don't match what's in the folder, check the actual filenames in `client/assets/nature/` and use those. Never hardcode a path that hasn't been verified.

**Player sprites:** Use Kenney Toon Characters if available (`character_femaleAdventurer_idle.png` etc.), otherwise draw players as 32×32 circles using `scene.add.graphics()`. Seekers = orange circle. Hiders = green/brown circle with camo tint.

---

## Build Order — Follow This Exactly

Build in this sequence. Each phase must be independently testable before proceeding.

### Phase 1 — Single-player prototype (no networking)
Playable locally. Tests camo shimmer, movement, paintball, and role switching.

### Phase 2 — Multiplayer server
Wire up Socket.io, rooms, game state sync, and role broadcasting.

### Phase 3 — Round loop polish
Full round structure, role rotation between rounds, scoring UI, lobby/end screens, and sound.

---

## Phase 1: Single-Player Prototype

### Canvas & Camera
- **Canvas size:** 1280×720px (set in Phaser game config)
- **Map size:** 2400×1800px (larger than canvas — camera scrolls)
- Camera follows the local player with `camera.startFollow(player, true, 0.1, 0.1)` (lerp 0.1 for smooth follow)
- Set world bounds: `physics.world.setBounds(0, 0, 2400, 1800)`

### Map Construction
Do NOT use the Tiled editor or load a `.tmx`/`.json` tilemap file. **Build the map procedurally in code** using Phaser's StaticGroup and sprite placement.

Construct the jungle map as follows in the `create()` function:

1. **Ground layer:** Tile the entire 2400×1800 area with `grass.png` at 64×64px each. Scatter `grassLight.png` randomly at ~15% of tiles. Place a winding `dirt.png` path from top-left to bottom-right. Place a horizontal `water.png` strip across the middle (y: 820–900) — this is the river.

2. **Vegetation layer (StaticGroup with arcade physics):** Scatter the following across the map procedurally using a seeded random or hardcoded positions:
   - 40–50 `treePine.png` / `treeOak.png` spread across the map, avoiding the river strip and spawn zones
   - 60–80 `bush.png` / `bushLarge.png` clustered in groups of 3–6 (not uniformly random — cluster them so hiders have real cover)
   - 30 `rockLarge.png` scattered near the riverbank
   - Decorative flowers placed randomly (no physics body)

3. **Collision:** All trees, large bushes, rocks, and water tiles must have `physics.add.staticGroup()` bodies. Players cannot pass through them. Use `physics.add.collider(player, obstaclesGroup)`.

4. **Coverage goal:** At least 35–40% of the walkable area should have vegetation cover (trees or bushes within 64px). This is critical — a sparse map makes the shimmer trivially spottable.

### Camo Zones
Define 4 rectangular camo zones as Phaser `Zone` objects (invisible gameplay regions, not rendered):

```
Zone A — "Deep Jungle":   x:200,  y:200,  w:600, h:500   (dense trees, best for jungle camo)
Zone B — "Riverbank":     x:600,  y:750,  w:800, h:300   (sandy/rocky, best for desert camo)
Zone C — "Forest Edge":   x:1600, y:300,  w:600, h:600   (mixed, moderate for jungle camo)
Zone D — "Clearing":      x:1200, y:1200, w:700, h:400   (open grass, worst for all camos)
```

Draw each zone with a Phaser Graphics object at 8% opacity, tinted by their type (Zone A: green, Zone B: tan, Zone C: olive, Zone D: yellow). This helps players learn which zones match which camo — the visual hint is intentional.

Check which zone the player occupies each frame using `Phaser.Geom.Rectangle.Contains(zoneRect, player.x, player.y)`.

### Spawn Points
Define hardcoded spawn points to prevent overlap:

- **Hider spawns** (8 points, spread across map away from seeker zone):
  `[{x:300,y:300}, {x:500,y:800}, {x:900,y:400}, {x:1100,y:1300}, {x:1500,y:500}, {x:1800,y:900}, {x:2100,y:300}, {x:2000,y:1500}]`

- **Seeker spawn zone** (locked area, top-left corner):
  Rectangle `x:50, y:50, w:150, h:150`. Seekers spawn at `{x:80,y:80}` and `{x:120,y:120}`.

Assign spawn points sequentially (first hider gets point 0, second gets point 1, etc.). Never assign two players to the same spawn point.

### Player — Hider
- **Movement:** WASD, 8-directional, speed 160px/s. Use `physics.add.sprite()` with arcade physics body.
- **Body size:** Set physics body to 28×28px (slightly smaller than sprite for forgiving collision).
- **Camo tint:** Apply `.setTint(0x4a7c3f)` for jungle camo (green-brown). Urban camo: `0x8a8a8a`.
- **Shimmer effect — implement exactly as follows:**

```javascript
// In update(), run every frame for each hider:
const time = scene.time.now / 1000; // seconds
const isMoving = (player.body.velocity.x !== 0 || player.body.velocity.y !== 0);

if (isMoving) {
  // Moving: obvious shimmer
  player.alpha = 0.5 + 0.4 * Math.sin(time * Math.PI * 3);
} else if (player.stillTimer > 2000) {
  // Still for 2+ seconds: subtle shimmer
  let baseAlpha = 0.35;
  // Bonus if in matching camo zone: reduce further
  if (playerInMatchingZone) baseAlpha = 0.22;
  player.alpha = baseAlpha + 0.15 * Math.sin(time * Math.PI * 0.8);
} else {
  // Transitioning to still: medium shimmer
  player.alpha = 0.45 + 0.25 * Math.sin(time * Math.PI * 1.5);
}

// Track stillness
if (isMoving) {
  player.stillTimer = 0;
} else {
  player.stillTimer += delta; // delta is ms from Phaser update()
}
```

  `playerInMatchingZone` is true when the player's camo pattern matches the zone they're standing in (jungle camo in Zone A or C = match; desert camo in Zone B = match).

  The shimmer must be a full-sprite alpha pulse — NOT an outline. Do not add any separate outline or glow object.

### Player — Seeker
- Fully visible: `alpha = 1.0` always.
- Tint: `0xff6600` (orange). Clear visual contrast from hiders.
- **Paintball gun:**
  - Aim direction: calculate angle from player to mouse pointer using `Phaser.Math.Angle.Between(player.x, player.y, pointer.worldX, pointer.worldY)`
  - Fire on left-click (`pointer.isDown`) or Spacebar, with 800ms cooldown between shots
  - Projectile: `scene.add.circle(x, y, 5, 0xffff00)` — small yellow circle, added to a physics group
  - Projectile speed: 500px/s in aim direction: `physics.velocityFromAngle(angleDeg, 500, projectile.body.velocity)`
  - Projectile lifetime: destroy after 1200ms or on collision with obstacle group
  - On hit with a hider: call `infectPlayer(hider)` — see Infection below
  - Draw aim line: `scene.add.graphics()` — thin white line, 40% alpha, from player position toward mouse, max 180px long. Redraw each frame.
  - Fire rate enforced with: `if (scene.time.now - lastFired < 800) return;`

### Infection (Role Change)
When a hider is hit by a paintball:
1. Flash the hider sprite white 3 times over 0.6s: `scene.tweens.add({ targets: hider, alpha: 1, duration: 100, yoyo: true, repeat: 5 })`
2. After the flash, change their tint to orange (`0xff6600`), set alpha to 1.0, disable shimmer
3. Give them a gun (enable firing controls)
4. Remove them from the hider group, add to seeker group
5. Display floating text "+1 SEEKER" at their position for 1.5s

### Role Switching for Solo Testing
Press `Tab` to toggle between hider and seeker role on the local player. This is for solo testing only and must be removed in Phase 2. On toggle: swap tint, toggle shimmer on/off, toggle gun controls.

### HUD (Phase 1)
Render using Phaser's `scene.add.text()` fixed to camera (`setScrollFactor(0)`):
- Top-center: Phase label — "HIDING PHASE" or "SEEK PHASE" in large bold text
- Below phase label: Timer countdown in `MM:SS` format
- Top-left: "ROLE: HIDER" or "ROLE: SEEKER"
- NOTE: Do NOT add a mini-map in Phase 1 — there are no other players to display. Add it in Phase 2.

---

## Phase 2: Multiplayer Server

### Server (`server/server.js`)

```javascript
// Required packages: socket.io@4
// Run with: node server.js
// Serves on port 3000
```

**CORS:** Configure Socket.io to allow the client origin explicitly:
```javascript
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
```
Also add `res.setHeader('Access-Control-Allow-Origin', '*')` to the HTTP server if serving any routes.

**Room system:**
- `createRoom` event: generate a random 5-char uppercase alphanumeric code. Store room in a `rooms` Map keyed by code. Auto-join the host. Emit `roomCreated { code }` back to host.
- `joinRoom(code)` event: validate code exists, room not full (<16), game not already in SEEK phase. Add player to room. Emit `roomJoined { roomState }` to joiner, `playerJoined { player }` to all others.
- `joinRandom` event: find any room in LOBBY state with <16 players, or create a new one. Join it. Emit same events as `joinRoom`.
- `startGame` event: host-only. Validates min 2 players. Transitions room to PREP phase, assigns roles, broadcasts `gameStart { roles, spawnPoints }`.

**Player identity:** On first connection, the client sends a `setUsername(name)` event with a player-chosen name (max 16 chars, trimmed). The server stores this on the socket object. All subsequent events reference `socket.id` for uniqueness and `socket.username` for display. If no username is set, default to `"Player" + socket.id.slice(0,4)`.

**Room state object:**
```javascript
{
  code: "AB3X9",
  hostId: socket.id,
  phase: "LOBBY" | "PREP" | "SEEK" | "ROUNDEND",
  players: Map<socketId, { id, username, role, score, spawnIndex, x, y }>,
  round: 1,
  prepTimer: null,
  seekTimer: null,
}
```

**Game state:** Server is authoritative. Clients send `inputUpdate { dx, dy }` (normalized direction vector, not raw key state) every 50ms. Server moves the player at 160px/s in that direction, then broadcasts `worldUpdate { players: [{id, x, y, role, alpha}] }` to the whole room at 20 ticks/second.

**Input schema (client → server):**
```javascript
// Client emits every 50ms:
socket.emit('inputUpdate', { dx: -1|0|1, dy: -1|0|1 });
// dx/dy are normalized direction. Server handles speed.
```

**Visibility rule — prep phase anti-cheat:** During PREP phase, the server must NOT include hider positions in `worldUpdate` messages sent to seeker clients. Filter the players array before broadcasting: seekers receive only other seekers' positions. Hiders receive all positions. This prevents client-side cheating where a seeker reads WebSocket messages to find hiders.

**Hit validation:**
- Client emits `shootHit { targetId, projectileX, projectileY }` when a paintball collides with another player sprite.
- Server validates: shooter is a seeker, target is a hider, distance between `projectileX/Y` and target's server-side position is < 80px (tolerance for network lag). If valid, emit `playerInfected { targetId, newSeekerId }` to all clients in the room.
- If invalid (cheating or lag), emit `hitRejected` to the shooter only.

**Disconnection handling:**
- On `disconnect`: remove player from their room's player Map. If room is now empty, delete the room. If the host disconnected and others remain, promote the next player (first in Map) to host — emit `hostChanged { newHostId }` to the room. If a disconnect happens mid-SEEK phase and the disconnecting player was the last hider, trigger round end immediately.

### Role Assignment Logic
- **Round 1:** Randomly assign roles. 70% hiders, 30% seekers, minimum 1 seeker always. Use `Math.floor(playerCount * 0.3)` seekers, minimum 1.
- **Round 2+:** Swap roles. Previous seekers become hiders, previous hiders become seekers. If count is uneven, rotate the "extra" player: whoever was extra last round swaps, a new player becomes extra.
- **Infection mid-round:** On valid `shootHit`, server immediately updates the target's role to `'seeker'` in room state and broadcasts `playerInfected`. All clients apply the visual infection transformation on receipt.

### Phase Timing (server-controlled)
- **PREP phase:** 60 seconds. Server sets a `setTimeout` for 60s, then emits `phaseChange { phase: 'SEEK' }`. During this phase, seeker clients receive world updates filtered to seeker positions only (see above).
- **SEEK phase:** 180 seconds (3 minutes). Server checks after every `playerInfected` event whether all hiders are now seekers — if so, end the round immediately: `clearTimeout(seekTimer)`, emit `roundEnd`.
- **Round end:** Emit `roundEnd { scores, survivors }`. Wait 8 seconds (server `setTimeout`), then emit `roundStart` with new roles. After 5 rounds, emit `matchEnd { finalScores }` instead.

### Scoring (server-side, authoritative)
- Hider survives seek phase: +100 points
- Hider gets infected: 0 points for hider, +10 for the seeker who shot them
- Last hider standing when time expires: +50 bonus
- All hiders infected before time: +25 bonus to every seeker
- Store cumulative scores in room state across rounds.

### Client-Side Interpolation
For smooth rendering of other players (not the local player), interpolate their displayed position toward the server-reported position each frame:
```javascript
otherPlayer.displayX += (otherPlayer.serverX - otherPlayer.displayX) * 0.2;
otherPlayer.displayY += (otherPlayer.serverY - otherPlayer.displayY) * 0.2;
```
Apply this in the Phaser `update()` loop for all remote players.

### Mini-Map (add in Phase 2)
Bottom-right corner, 160×120px. Draw using Phaser Graphics, fixed to camera (`setScrollFactor(0)`):
- Dark rectangle background (80% opacity)
- Scale factor: `miniX = player.x / 2400 * 160`, `miniY = player.y / 1800 * 120`
- Local player: white dot, 4px radius
- Other hiders (visible to hiders only): green dot, 3px radius
- Seekers: orange dot, 3px radius
- Update every frame

---

## Phase 3: Round Loop Polish

### Lobby Screen (Phaser scene or HTML overlay)
- Display room code in large font, centered: "ROOM CODE: AB3X9"
- Below: scrolling list of connected player usernames with their role badge (assigned after start)
- "START GAME" button — visible only to host, disabled if < 2 players connected
- "COPY CODE" button — copies room code to clipboard
- Random matchmaking button: "JOIN RANDOM GAME"
- Username input field: shown before joining, max 16 characters

### Between-Round Screen (8 seconds)
- Round scoreboard: player name, this-round points, total points, role played
- Large announcement: "NEXT ROUND — YOU ARE: HIDING / SEEKING" in player's role color
- Countdown bar depleting over 8 seconds

### End Screen
- Final leaderboard: rank, name, total score
- "PLAY AGAIN" button (host only — starts a new match in same room, same players)
- "LEAVE ROOM" button

### Sound (Web Audio API — no external files required)
Use the Web Audio API `AudioContext` to synthesize sounds — do not require audio file assets:

```javascript
function playSound(type) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  if (type === 'shoot') { osc.frequency.value = 800; gain.gain.setValueAtTime(0.3, 0); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15); }
  if (type === 'hit')   { osc.frequency.value = 200; gain.gain.setValueAtTime(0.5, 0); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3); }
  if (type === 'start') { osc.frequency.value = 440; gain.gain.setValueAtTime(0.4, 0); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5); }
  osc.start(); osc.stop(ctx.currentTime + 0.5);
}
```

### Host Settings Panel
Small gear icon (top-right of lobby screen). Opens a settings panel with:
- Prep time: radio buttons — 30s / 60s / 90s (default: 60s)
- Seek time: radio buttons — 2min / 3min / 5min (default: 3min)
- Min players to start: 2 / 4 / 6 (default: 2 for testing)
- These values are sent to the server on `startGame` and stored in room state.

---

## Camo Pattern System

For the prototype implement **Jungle** and **Urban** patterns only.

| Pattern | Tint color | Best zones | Notes |
|---|---|---|---|
| Jungle | `0x4a7c3f` (dark green) | Zone A, Zone C | Matches dense tree/bush tiles |
| Urban | `0x7a7a7a` (mid grey) | None in jungle map (add in future urban map) | Visible in jungle — wrong map |
| Desert | `0xc8a45a` (tan) | Zone B (riverbank) | Partial match |

Camo is randomly assigned to hiders at round start. Display the assigned camo in the lobby ("Your camo: 🟢 Jungle") so players know which zones to target.

Shimmer amplitude modifier by zone match:
- Matching zone: multiply shimmer `baseAlpha` by 0.65 (harder to see)
- Neutral zone: multiply by 1.0
- Mismatched camo in wrong zone: multiply by 1.2 (slightly more visible — wrong background)

---

## Implementation Notes — Read Before Writing Any Code

1. **Shimmer is the #1 mechanic.** Get it feeling right before anything else. A still hider in Zone A with jungle camo should be genuinely difficult to spot for 3–5 seconds. If you can find them instantly, reduce the base alpha. If they're invisible, increase it. Tune until it feels like "I know something's there but I have to stare."

2. **Physics: Arcade only.** Do not use Matter.js. All physics bodies: `scene.physics.add.sprite()` or `scene.physics.add.staticGroup()`. Set `immovable: true` on all obstacle sprites.

3. **Tilemap: procedural only.** Do not reference any `.json` or `.tmx` tilemap file. Build the map by placing individual sprites in `create()`.

4. **Verify asset filenames.** Before writing any `scene.load.image()` call, list the actual files in `client/assets/nature/`. If a filename in this prompt doesn't match, use the real filename. Add a comment noting the discrepancy.

5. **CORS.** The client at `localhost:8080` talks to the server at `localhost:3000`. Configure Socket.io with `cors: { origin: "*" }` and add the header to HTTP responses. Without this, the connection silently fails in Firefox.

6. **No localStorage.** All state lives in Phaser scene data (client) and the `rooms` Map (server). Nothing persists between page loads by design.

7. **Single HTML file.** All client JavaScript is inline in `index.html`. No separate `.js` files. This keeps it paste-and-run simple and avoids module/import complexity.

8. **Test at every phase boundary.** Phase 1 must be fully playable before writing a single line of Socket.io code. Phase 2 must successfully sync two browser tabs before adding any Phase 3 UI.

---

## How to Run

```bash
# Terminal 1 — start server
cd server && npm install && node server.js
# Server listens on port 3000

# Terminal 2 — serve client
npx serve client -p 8080
# Open http://localhost:8080 in browser

# To test multiplayer: open two browser windows to localhost:8080
# Window 1: enter username, click "Create Room" — note the code
# Window 2: enter username, enter the code, click "Join Room"
# Window 1: click "Start Game"
```

---

## Definition of Done for Prototype

- [ ] Phase 1: Solo play works — shimmer visible, movement amplifies it, Tab switches roles, paintball fires and infects
- [ ] Phase 1: Jungle map is visually dense — standing still in Zone A with jungle camo takes genuine effort to spot
- [ ] Phase 2: Two browser tabs connect via room code
- [ ] Phase 2: Player movement syncs in real time between clients with smooth interpolation
- [ ] Phase 2: Hiders are hidden from seeker clients during PREP phase
- [ ] Phase 2: A paintball hit is validated server-side and role change broadcasts to all clients
- [ ] Phase 2: Disconnecting a tab mid-round doesn't crash the remaining client
- [ ] Phase 3: Full round loop — lobby → prep → seek → round end → next round, 5 rounds total
- [ ] Phase 3: Scores accumulate correctly and final leaderboard is accurate
- [ ] Phase 3: Roles rotate between rounds — no one is always hiding
