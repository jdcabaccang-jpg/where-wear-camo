'use strict';
// Where/Wear Camo — authoritative game server (Step 3).
// Owns: rooms, roles, phase timers, movement, NPC brains, hit validation,
// strobe sync, scoring. Clients render and predict; the server decides.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf', '.json': 'application/json', '.ico': 'image/x-icon',
};

// ---- shared game constants (keep in sync with client/index.html)
const WORLD_W = 2400, WORLD_H = 1800;
const PLAYER_SPEED = 160;
const GRACE_LEN = 20000, SEEK_LEN = 100000, ROUNDEND_LEN = 8000;
const ROUNDS_PER_MATCH = 3;
const TICK_MS = 50;                       // 20Hz
const FIRE_COOLDOWN = 800;
const HIT_RADIUS = 80;                    // server-side validation slack (spec)
const NPC_HIT_RADIUS = 28;                // server-simulated npc paintballs
const PAINTBALL_SPEED = 500, PAINTBALL_TTL = 1200;
const NPC_DETECT = 280, NPC_DETECT_ADV = 340;
// hunters fire 15% more often, stalkers 25% more (interval shrink + potshot bump)
const HUNTER_SHOT_MUL = 1 / 1.15, STALKER_SHOT_MUL = 1 / 1.25;
const NPC_ESCAPE = 450, NPC_ESCAPE_ADV = 500;
const CHASE_MAX = 15000, CHASE_SPEED = 152, CHASE_SHOT_EVERY = 900;
const RELOCATE_MIN = 25000, RELOCATE_MAX = 45000;
const STROBE_EVERY = 10000, STROBE_WARN = 1500, STROBE_LEN = 800;
const CHIRP_COOLDOWN = 1000;
const MAX_HUMANS = 9;

const THEMES = ['JUNGLE', 'AUTUMN WOODS', 'BADLANDS'];
const ZONES = [
  { id: 'A', rect: [200, 200, 600, 500] },
  { id: 'B', rect: [600, 750, 800, 300] },
  { id: 'C', rect: [1600, 300, 600, 600] },
  { id: 'D', rect: [1200, 1200, 700, 400] },
];
const HIDER_SPAWNS = [
  { x: 300, y: 300 }, { x: 500, y: 800 }, { x: 900, y: 400 }, { x: 1100, y: 1300 },
  { x: 1500, y: 500 }, { x: 1800, y: 900 }, { x: 2100, y: 300 }, { x: 2000, y: 1500 },
];
const SEEKER_SPAWN = { x: 110, y: 110 };
const ONLINE_NAMES = ['jake02', 'greenbean', 'swampqueen', 'Milo', 'xCamoKing',
  'HideNSneak', 'notabot123', 'TTV_Bushman', 'peekaboo_', 'lil_sprout', 'Dmitri',
  'ferngully', 'SneakyPete', 'mudpie', 'ghostedu', 'Wren'];
const CAMOS = ['jungle', 'desert', 'urban'];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------- rooms
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// host-adjustable, from whitelisted options only
const SETTINGS_OPTIONS = {
  graceMs: [15000, 20000, 30000],
  seekMs: [60000, 100000, 140000],
  rounds: [1, 3, 5],
  minPlayers: [1, 2, 4],
};

function createRoom(hostSocket) {
  const room = {
    code: makeCode(),
    hostId: hostSocket.id,
    phase: 'LOBBY',
    round: 0,
    settings: { graceMs: GRACE_LEN, seekMs: SEEK_LEN, rounds: ROUNDS_PER_MATCH, minPlayers: 1 },
    theme: null,
    seed: 0,
    players: new Map(),      // id -> entity (humans and NPCs share the shape)
    balls: [],               // server-simulated NPC paintballs
    phaseEndsAt: 0,
    nextStrobeAt: 0,
    strobeUntil: 0,
    lastSeekerHumans: new Set(),
    timers: [],
  };
  rooms.set(room.code, room);
  return room;
}

function makeEntity(id, name, human) {
  return {
    id, name, human,
    role: 'hider', camo: pick(CAMOS),
    x: 0, y: 0, rot: 0,
    input: { dx: 0, dy: 0 },
    stillMs: 0, moving: false,
    lastFired: 0, lastChirp: 0,
    chirps: 0, hideMs: 0, found: 0, score: 0,
    startedAsHider: true,
    ai: null,
    connected: true,
  };
}

function roomOf(socket) {
  return socket.data.roomCode ? rooms.get(socket.data.roomCode) : null;
}

// NPC hider count shrinks as real players fill the room
function npcHiderCount(humans) {
  if (humans <= 4) return clamp(8 - humans, 4, 6);   // 2->6, 3->5, 4->4
  return clamp(9 - humans, 2, 4);                    // 5->4, 6->3, 7..9->2
}

function lobbyState(room) {
  const humans = [...room.players.values()].filter(p => p.human).length;
  // stalker always + a hunter slot in small rooms + the hider NPCs
  const npcCount = npcHiderCount(Math.max(humans, 1)) + (humans <= 4 ? 2 : 1);
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: [...room.players.values()].filter(p => p.human)
      .map(p => ({ id: p.id, name: p.name })),
    npcCount,
    maxHumans: MAX_HUMANS,
    settings: room.settings,
  };
}

// ---------------------------------------------------------------- round flow
function startMatch(room, io) {
  room.round = 0;
  for (const p of room.players.values()) p.score = 0;
  startRound(room, io);
}

function startRound(room, io) {
  clearTimers(room);
  room.round++;
  room.theme = pick(THEMES);
  room.seed = (Math.random() * 0xffffffff) | 0;
  room.balls = [];

  // drop NPCs from the previous round
  for (const [id, p] of [...room.players]) if (!p.human) room.players.delete(id);

  const humans = [...room.players.values()].filter(p => p.human);

  // ---- role distribution (user-specified brackets)
  // 2-4 humans: 2 seekers = stalker + (one human on a 50% roll, else a hunter)
  // 5-9 humans: stalker + 1-2 human seekers (two candidates roll 50%, min 1)
  // Candidates rotate: humans who have NOT sought yet go first.
  const fresh = humans.filter(h => !room.lastSeekerHumans.has(h.id));
  const ordered = [...fresh, ...humans.filter(h => room.lastSeekerHumans.has(h.id))];
  let humanSeekers = [];
  if (humans.length >= 5) {
    const candidates = ordered.slice(0, 2);
    humanSeekers = candidates.filter(() => Math.random() < 0.5);
    if (humanSeekers.length === 0) humanSeekers = [candidates[0]];
  } else if (humans.length >= 2) {
    if (Math.random() < 0.5) humanSeekers = [ordered[0]];
  }
  // solo online player always hides (matches offline)
  room.lastSeekerHumans = new Set(humanSeekers.map(h => h.id));

  // ---- NPC roster (found NPC hiders convert to hunters mid-round)
  const namePool = [...ONLINE_NAMES].sort(() => Math.random() - 0.5)
    .filter(n => !humans.some(h => h.name === n));
  const addNpc = (role, advanced) => {
    const id = 'npc_' + Math.random().toString(36).slice(2, 8);
    const e = makeEntity(id, namePool.pop() || 'guest' + Math.floor(Math.random() * 99), false);
    e.role = role;
    e.ai = role === 'seeker'
      ? { advanced: !!advanced, target: null, targetUntil: 0, nextShot: 0,
          chirpLead: null, chase: null, searchAt: null, searchUntil: 0 }
      : { state: 'moving', target: null, relocateAt: 0, nextChirp: 0,
          stuck: { x: 0, y: 0, at: 0 } };
    room.players.set(id, e);
    return e;
  };
  for (let i = 0; i < npcHiderCount(humans.length); i++) addNpc('hider', false);
  addNpc('seeker', true);                                   // stalker, always
  if (humanSeekers.length === 0) addNpc('seeker', false);   // hunter fills the slot

  // ---- roles + spawns
  let spawnIdx = 0;
  for (const p of room.players.values()) {
    if (p.human) p.role = humanSeekers.includes(p) ? 'seeker' : 'hider';
    p.startedAsHider = p.role === 'hider';
    p.chirps = 0; p.hideMs = 0; p.found = 0;
    p.stillMs = 0; p.lastFired = 0; p.lastChirp = 0;
    if (p.role === 'hider') {
      const sp = HIDER_SPAWNS[spawnIdx++ % HIDER_SPAWNS.length];
      p.x = sp.x; p.y = sp.y;
    } else {
      p.x = SEEKER_SPAWN.x + Math.random() * 80;
      p.y = SEEKER_SPAWN.y + Math.random() * 80;
    }
    if (!p.human && p.role === 'hider') p.ai.target = pickHidingSpot(room, { initial: true });
  }

  room.phase = 'GRACE';
  const { graceMs, seekMs, rounds } = room.settings;
  room.phaseEndsAt = Date.now() + graceMs;
  room.nextStrobeAt = 0;

  const roster = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, role: p.role, camo: p.camo, x: p.x, y: p.y,
  }));
  for (const p of room.players.values()) {
    if (!p.human) continue;
    io.to(p.id).emit('roundStart', {
      round: room.round, rounds,
      theme: room.theme, seed: room.seed,
      roster, yourId: p.id, yourRole: p.role, hostId: room.hostId,
      phase: 'GRACE', phaseMs: graceMs,
    });
  }

  addTimer(room, graceMs, () => {
    room.phase = 'SEEK';
    room.phaseEndsAt = Date.now() + seekMs;
    room.nextStrobeAt = Date.now() + STROBE_EVERY;
    io.to(room.code).emit('phaseChange', { phase: 'SEEK', phaseMs: seekMs });
    addTimer(room, seekMs, () => endRound(room, io, 'hiders'));
  });
}

function endRound(room, io, winner) {
  if (room.phase === 'ROUNDEND' || room.phase === 'LOBBY') return;
  clearTimers(room);
  room.phase = 'ROUNDEND';

  // ---- scoring
  const entities = [...room.players.values()];
  const hiders = entities.filter(e => e.role === 'hider');
  for (const h of hiders) h.score += 100;                    // survived
  if (winner === 'hiders' && hiders.length === 1) hiders[0].score += 50;
  if (winner === 'seekers') {
    for (const e of entities) if (e.role === 'seeker') e.score += 25;
  }
  for (const e of entities) e.score += e.found * 10;

  const stats = entities.map(e => ({
    id: e.id, name: e.name, human: e.human, role: e.role,
    startedAsHider: e.startedAsHider, chirps: e.chirps,
    hideMs: Math.round(e.hideMs), found: e.found, score: e.score,
  }));

  const last = room.round >= room.settings.rounds;
  io.to(room.code).emit('roundEnd', { winner, stats, round: room.round,
    rounds: room.settings.rounds, nextInMs: last ? 0 : ROUNDEND_LEN, matchOver: last });

  if (last) {
    room.phase = 'LOBBY';
    room.round = 0;
    io.to(room.code).emit('matchEnd', { stats });
    io.to(room.code).emit('lobbyUpdate', lobbyState(room));
  } else {
    addTimer(room, ROUNDEND_LEN, () => startRound(room, io));
  }
}

function addTimer(room, ms, fn) {
  room.timers.push(setTimeout(fn, ms));
}
function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
}

// ---------------------------------------------------------------- NPC brains
function zoneAt(x, y) {
  for (const z of ZONES) {
    const [zx, zy, zw, zh] = z.rect;
    if (x >= zx && x <= zx + zw && y >= zy && y <= zy + zh) return z.id;
  }
  return null;
}

// Server has no bush map; dense zones ARE the cover by construction.
// opts.initial: round-start spots keep >=1000px from the seeker spawn corner.
// opts.awayFrom: repositioning keeps >=300px from whoever crowded them.
function pickHidingSpot(room, opts) {
  const initial = opts && opts.initial;
  const awayFrom = opts && opts.awayFrom;
  for (let i = 0; i < 30; i++) {
    const z = Math.random() < 0.85 ? pick([ZONES[0], ZONES[2]]) : pick(ZONES);
    const spot = { x: z.rect[0] + Math.random() * z.rect[2],
                   y: z.rect[1] + Math.random() * z.rect[3] };
    if (initial) {
      const minD = i < 20 ? 1000 : 700;
      if (dist(spot, SEEKER_SPAWN) < minD) continue;
    }
    if (awayFrom && dist(spot, awayFrom) < 300) continue;
    let ok = true;
    for (const p of room.players.values()) {
      if (!p.human && p.role === 'hider' && p.ai && p.ai.target &&
          dist(spot, p.ai.target) < 90) ok = false;
      if (p.role === 'seeker' && dist(spot, p) < 260) ok = false;
    }
    if (ok) return spot;
  }
  return { x: rand(WORLD_W / 2, WORLD_W - 150), y: rand(150, WORLD_H - 150) };
}

function isStrobing(room, e) {
  return !e.moving && e.stillMs > 900 && Date.now() < room.strobeUntil;
}
function isSpottable(room, e) {
  return e.moving || e.stillMs <= 900 || isStrobing(room, e);
}

function npcHiderTick(room, e, dtMs, now) {
  const ai = e.ai;
  if (ai.state === 'moving' && ai.target) {
    const d = dist(e, ai.target);
    if (d < 10) {
      ai.state = 'settled';
      ai.target = null;
      e.input.dx = 0; e.input.dy = 0;
      e.stillMs = 2000;
      ai.relocateAt = now + rand(RELOCATE_MIN, RELOCATE_MAX);
    } else {
      const a = Math.atan2(ai.target.y - e.y, ai.target.x - e.x);
      const speed = room.phase === 'GRACE' ? 1 : 0.75;
      e.input.dx = Math.cos(a) * speed; e.input.dy = Math.sin(a) * speed;
      e.rot = a;
      if (now - ai.stuck.at > 1200) {
        if (dist(e, ai.stuck) < 20) ai.target = pickHidingSpot(room);
        ai.stuck = { x: e.x, y: e.y, at: now };
      }
    }
  } else {
    e.input.dx = 0; e.input.dy = 0;
    // a human hider camping on top of us? give it 3-5s, then move away
    let crowder = null;
    for (const p of room.players.values()) {
      if (p.human && p.role === 'hider' && p.connected && dist(p, e) < 40) { crowder = p; break; }
    }
    if (crowder) {
      if (!ai.crowdedSince) {
        ai.crowdedSince = now;
        ai.crowdPatience = 3000 + Math.random() * 2000;
      } else if (now - ai.crowdedSince > ai.crowdPatience) {
        ai.crowdedSince = 0;
        ai.state = 'moving';
        ai.target = pickHidingSpot(room, { awayFrom: { x: crowder.x, y: crowder.y } });
        return;
      }
    } else {
      ai.crowdedSince = 0;
    }
    if (room.phase === 'SEEK') {
      if (now >= ai.relocateAt && ai.relocateAt > 0) {
        ai.state = 'moving';
        ai.target = pickHidingSpot(room);
      }
      if (!ai.nextChirp) ai.nextChirp = now + rand(15000, 40000);
      if (now >= ai.nextChirp) {
        doChirp(room, e, now);
        ai.nextChirp = now + rand(15000, 40000);
      }
    }
  }
}

function npcSeekerTick(room, e, dtMs, now, io) {
  const ai = e.ai;
  if (room.phase !== 'SEEK') { e.input.dx = 0; e.input.dy = 0; return; }
  const detect = ai.advanced ? NPC_DETECT_ADV : NPC_DETECT;
  const escape = ai.advanced ? NPC_ESCAPE_ADV : NPC_ESCAPE;
  const shotMul = ai.advanced ? STALKER_SHOT_MUL : HUNTER_SHOT_MUL;

  if (ai.chase) {
    const t = ai.chase.target;
    const d = dist(e, t);
    if (t.role !== 'hider' || !t.connected || d > escape || now - ai.chase.since > CHASE_MAX) {
      if (ai.advanced && t.role === 'hider') {
        ai.searchAt = { x: t.x, y: t.y };
        ai.searchUntil = now + 20000;
      }
      ai.chase = null; ai.target = null;
    } else {
      const a = Math.atan2(t.y - e.y, t.x - e.x);
      e.input.dx = Math.cos(a) * (CHASE_SPEED / PLAYER_SPEED);
      e.input.dy = Math.sin(a) * (CHASE_SPEED / PLAYER_SPEED);
      e.rot = a;
      if (now >= ai.nextShot) {
        ai.nextShot = now + CHASE_SHOT_EVERY * shotMul;
        npcFire(room, e, t.x, t.y, io);
      }
      return;
    }
  }

  for (const h of room.players.values()) {
    if (h.role !== 'hider' || !h.connected) continue;
    const d = dist(e, h);
    if (d <= detect && (h.moving || isStrobing(room, h))) {
      ai.chase = { target: h, since: now };
      ai.nextShot = Math.min(ai.nextShot, now + 150);
      return;
    }
  }

  if (ai.chirpLead) {
    ai.target = ai.chirpLead; ai.targetUntil = now + 9000; ai.chirpLead = null;
  }
  if (!ai.target || now > ai.targetUntil || dist(e, ai.target) < 14) {
    if (ai.advanced && ai.searchAt && now < ai.searchUntil) {
      ai.target = { x: ai.searchAt.x + rand(-130, 130), y: ai.searchAt.y + rand(-130, 130) };
    } else if (ai.advanced && Math.random() < 0.4) {
      let nearest = null, best = 1e9;
      for (const h of room.players.values()) {
        if (h.role !== 'hider') continue;
        const d = dist(e, h);
        if (d < best) { best = d; nearest = h; }
      }
      ai.target = nearest
        ? { x: nearest.x + rand(-250, 250), y: nearest.y + rand(-250, 250) }
        : { x: rand(100, WORLD_W - 100), y: rand(100, WORLD_H - 100) };
    } else {
      const z = pick(ZONES);
      ai.target = Math.random() < 0.65
        ? { x: z.rect[0] + Math.random() * z.rect[2], y: z.rect[1] + Math.random() * z.rect[3] }
        : { x: rand(100, WORLD_W - 100), y: rand(100, WORLD_H - 100) };
      ai.targetUntil = now + 9000;
    }
    ai.target.x = clamp(ai.target.x, 60, WORLD_W - 60);
    ai.target.y = clamp(ai.target.y, 60, WORLD_H - 60);
    ai.targetUntil = now + 9000;
  }
  const a = Math.atan2(ai.target.y - e.y, ai.target.x - e.x);
  e.input.dx = Math.cos(a) * 0.8; e.input.dy = Math.sin(a) * 0.8;
  e.rot = a;

  if (now >= ai.nextShot) {
    ai.nextShot = now + rand(1400, 3600) * shotMul;
    let target = null, bestD = 320;
    for (const h of room.players.values()) {
      if (h.role !== 'hider') continue;
      const d = dist(e, h);
      if (d < bestD && isSpottable(room, h)) { target = h; bestD = d; }
    }
    if (target) {
      npcFire(room, e, target.x, target.y, io);
      e.rot = Math.atan2(target.y - e.y, target.x - e.x);
    } else if (Math.random() < 0.55 * (ai.advanced ? 1.25 : 1.15)) {
      npcFire(room, e, e.x + rand(-250, 250), e.y + rand(-250, 250), io);
    }
  }
}

function npcFire(room, e, tx, ty, io) {
  const a = Math.atan2(ty - e.y, tx - e.x);
  room.balls.push({
    x: e.x + Math.cos(a) * 34, y: e.y + Math.sin(a) * 34,
    vx: Math.cos(a) * PAINTBALL_SPEED, vy: Math.sin(a) * PAINTBALL_SPEED,
    born: Date.now(), shooter: e,
  });
  io.to(room.code).emit('shotFired', { byId: e.id, x: e.x, y: e.y, angle: a });
}

function doChirp(room, e, now) {
  if (e.role !== 'hider' || room.phase !== 'SEEK') return false;
  if (now - e.lastChirp < CHIRP_COOLDOWN) return false;
  e.lastChirp = now;
  e.chirps++;
  for (const k of room.players.values()) {
    if (k.human || k.role !== 'seeker' || !k.ai) continue;
    const detect = k.ai.advanced ? NPC_DETECT_ADV : NPC_DETECT;
    if (dist(k, e) <= detect) k.ai.chase = { target: e, since: now };
    else k.ai.chirpLead = { x: e.x, y: e.y };
  }
  return true;
}

function infect(room, target, shooter, io) {
  if (target.role !== 'hider') return;
  if (room.phase !== 'SEEK') return;   // nothing can be infected outside SEEK
  target.role = 'seeker';
  if (shooter && shooter.role === 'seeker') shooter.found++;
  if (!target.human) {
    target.ai = { advanced: false, target: null, targetUntil: 0,
      nextShot: Date.now() + 2000, chirpLead: null, chase: null,
      searchAt: null, searchUntil: 0 };
  }
  io.to(room.code).emit('playerInfected', { id: target.id, byId: shooter ? shooter.id : null });
  const hidersLeft = [...room.players.values()].filter(p => p.role === 'hider' && p.connected);
  if (hidersLeft.length === 0) endRound(room, io, 'seekers');
}

// ---------------------------------------------------------------- game tick
function tickRoom(room, io, dtMs) {
  if (room.phase !== 'GRACE' && room.phase !== 'SEEK') return;
  const now = Date.now();

  // strobe schedule (SEEK): warn, then reveal — all clients stay in sync
  if (room.phase === 'SEEK' && room.nextStrobeAt && now >= room.nextStrobeAt) {
    room.nextStrobeAt = now + STROBE_EVERY;
    room.strobeUntil = now + STROBE_WARN + STROBE_LEN;   // reveal follows the warn
    io.to(room.code).emit('strobe', { warnMs: STROBE_WARN, lenMs: STROBE_LEN });
  }

  // NPC brains
  for (const p of room.players.values()) {
    if (p.human || !p.connected) continue;
    if (p.role === 'hider') npcHiderTick(room, p, dtMs, now);
    else npcSeekerTick(room, p, dtMs, now, io);
  }

  // movement (humans by input, NPCs by their ai-written input)
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    let { dx, dy } = p.input;
    const frozenSeeker = p.role === 'seeker' && room.phase === 'GRACE';
    if (frozenSeeker) { dx = 0; dy = 0; }
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    p.x = clamp(p.x + dx * PLAYER_SPEED * dtMs / 1000, 20, WORLD_W - 20);
    p.y = clamp(p.y + dy * PLAYER_SPEED * dtMs / 1000, 20, WORLD_H - 20);
    p.moving = Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01;
    p.stillMs = p.moving ? 0 : p.stillMs + dtMs;
    if (room.phase === 'SEEK' && p.role === 'hider') p.hideMs += dtMs;
    if (p.human && p.moving) p.rot = Math.atan2(dy, dx);
  }

  // NPC paintballs
  for (let i = room.balls.length - 1; i >= 0; i--) {
    const b = room.balls[i];
    b.x += b.vx * dtMs / 1000;
    b.y += b.vy * dtMs / 1000;
    let dead = now - b.born > PAINTBALL_TTL;
    if (!dead) {
      for (const p of room.players.values()) {
        if (p.role !== 'hider' || !p.connected) continue;
        if (dist(b, p) < NPC_HIT_RADIUS) {
          infect(room, p, b.shooter, io);
          dead = true;
          break;
        }
      }
    }
    if (dead) room.balls.splice(i, 1);
  }

  // world updates — GRACE anti-cheat: seekers get no hider positions at all
  const all = [...room.players.values()].filter(p => p.connected)
    .map(p => [p.id, Math.round(p.x), Math.round(p.y), +p.rot.toFixed(2), p.role === 'seeker' ? 1 : 0]);
  const seekersOnly = all.filter(row => row[4] === 1);
  for (const p of room.players.values()) {
    if (!p.human || !p.connected) continue;
    const blind = room.phase === 'GRACE' && p.role === 'seeker';
    io.to(p.id).emit('worldUpdate', { players: blind ? seekersOnly : all, t: now });
  }
}

// ---------------------------------------------------------------- wiring
// Serve the client statically too: one deployed service hosts everything
// (game at /, websockets at /socket.io/) — no CORS, no second host needed.
const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok ' + rooms.size + ' room(s)');
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.normalize(path.join(CLIENT_DIR, rel));
  if (!file.startsWith(CLIENT_DIR)) {           // no path traversal
    res.writeHead(403); return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

io.on('connection', (socket) => {
  socket.data.username = 'Player' + socket.id.slice(0, 4);

  socket.on('setUsername', (name) => {
    if (typeof name === 'string' && name.trim()) {
      socket.data.username = name.trim().slice(0, 16);
    }
  });

  const joinAs = (room) => {
    const ent = makeEntity(socket.id, socket.data.username, true);
    room.players.set(socket.id, ent);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit('roomJoined', { ...lobbyState(room), youId: socket.id });
    io.to(room.code).emit('lobbyUpdate', lobbyState(room));
  };

  socket.on('createRoom', () => {
    if (roomOf(socket)) return socket.emit('errorMsg', 'Already in a room');
    joinAs(createRoom(socket));
  });

  socket.on('joinRoom', (code) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return socket.emit('errorMsg', 'Room not found');
    if (room.phase === 'SEEK') return socket.emit('errorMsg', 'Round in progress');
    const humans = [...room.players.values()].filter(p => p.human).length;
    if (humans >= MAX_HUMANS) return socket.emit('errorMsg', 'Room full');
    joinAs(room);
  });

  socket.on('joinRandom', () => {
    let target = null;
    for (const room of rooms.values()) {
      const humans = [...room.players.values()].filter(p => p.human).length;
      if (room.phase === 'LOBBY' && humans < MAX_HUMANS) { target = room; break; }
    }
    joinAs(target || createRoom(socket));
  });

  socket.on('startGame', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id || room.phase !== 'LOBBY') return;
    const humans = [...room.players.values()].filter(p => p.human).length;
    if (humans < room.settings.minPlayers) {
      return socket.emit('errorMsg', `Need at least ${room.settings.minPlayers} player(s)`);
    }
    startMatch(room, io);
  });

  socket.on('updateSettings', (patch) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id || room.phase !== 'LOBBY' || !patch) return;
    for (const key of Object.keys(SETTINGS_OPTIONS)) {
      if (patch[key] !== undefined && SETTINGS_OPTIONS[key].includes(patch[key])) {
        room.settings[key] = patch[key];
      }
    }
    io.to(room.code).emit('lobbyUpdate', lobbyState(room));
  });

  socket.on('inputUpdate', (input) => {
    const room = roomOf(socket);
    const p = room && room.players.get(socket.id);
    if (!p || !input) return;
    p.input.dx = clamp(Number(input.dx) || 0, -1, 1);
    p.input.dy = clamp(Number(input.dy) || 0, -1, 1);
    if (typeof input.rot === 'number' && p.role === 'seeker') p.rot = input.rot;
  });

  socket.on('shotFired', (data) => {
    // cosmetic relay of a human seeker's shot (validation happens on shootHit)
    const room = roomOf(socket);
    const p = room && room.players.get(socket.id);
    if (!p || p.role !== 'seeker' || room.phase !== 'SEEK') return;
    const now = Date.now();
    if (now - p.lastFired < FIRE_COOLDOWN - 50) return;
    p.lastFired = now;
    socket.to(room.code).emit('shotFired', {
      byId: p.id, x: p.x, y: p.y, angle: Number(data && data.angle) || 0 });
  });

  socket.on('shootHit', (data) => {
    const room = roomOf(socket);
    const p = room && room.players.get(socket.id);
    if (!p || !data || p.role !== 'seeker' || room.phase !== 'SEEK') return;
    const target = room.players.get(String(data.targetId));
    if (!target || target.role !== 'hider' || !target.connected) {
      return socket.emit('hitRejected');
    }
    // validate against SERVER positions, with generous slack for latency
    if (dist({ x: Number(data.x) || 0, y: Number(data.y) || 0 }, target) > HIT_RADIUS) {
      return socket.emit('hitRejected');
    }
    infect(room, target, p, io);
  });

  socket.on('chirp', () => {
    const room = roomOf(socket);
    const p = room && room.players.get(socket.id);
    if (!p) return;
    if (doChirp(room, p, Date.now())) {
      io.to(room.code).emit('chirped', { id: p.id, x: p.x, y: p.y });
    }
  });

  socket.on('blendSnap', () => {
    const room = roomOf(socket);
    const p = room && room.players.get(socket.id);
    if (!p || p.role !== 'hider' || p.moving) return;
    p.stillMs = 2000;
    io.to(room.code).emit('blendSnapped', { id: p.id });
  });

  socket.on('leaveRoom', () => dropFromRoom(socket));
  socket.on('disconnect', () => dropFromRoom(socket));

  function dropFromRoom(socket2) {
    const room = roomOf(socket2);
    if (!room) return;
    const p = room.players.get(socket2.id);
    room.players.delete(socket2.id);
    socket2.leave(room.code);
    socket2.data.roomCode = null;
    io.to(room.code).emit('playerLeft', { id: socket2.id });

    const humans = [...room.players.values()].filter(x => x.human);
    if (humans.length === 0) {
      clearTimers(room);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket2.id) {
      room.hostId = humans[0].id;
      io.to(room.code).emit('hostChanged', { hostId: room.hostId });
    }
    io.to(room.code).emit('lobbyUpdate', lobbyState(room));
    // last hider left mid-round -> round over
    if ((room.phase === 'SEEK' || room.phase === 'GRACE') && p && p.role === 'hider') {
      const hidersLeft = [...room.players.values()].filter(x => x.role === 'hider');
      if (hidersLeft.length === 0) endRound(room, io, 'seekers');
    }
  }
});

// global tick
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - lastTick;
  lastTick = now;
  for (const room of rooms.values()) tickRoom(room, io, dt);
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Where/Wear Camo server listening on :${PORT}`);
});
