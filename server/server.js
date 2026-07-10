/* ============================================================
   Where/Wear Camo — authoritative game server
   Required packages: socket.io@4
   Run with: node server.js
   Serves on port 3000
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// Static client root. Local: ../client. Override with CLIENT_DIR if needed.
const CLIENT_DIR = process.env.CLIENT_DIR
  ? path.resolve(process.env.CLIENT_DIR)
  : path.join(__dirname, '..', 'client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
  });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res) {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const root = path.resolve(CLIENT_DIR);
    const resolved = path.resolve(root, rel);
    // Path traversal guard (Windows-safe)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    fs.stat(resolved, (err, st) => {
      if (!err && st.isFile()) {
        sendFile(res, resolved);
        return;
      }
      // SPA-style fallback only for bare directory hits
      const indexPath = path.join(CLIENT_DIR, 'index.html');
      if (urlPath === '/' || urlPath === '') {
        sendFile(res, indexPath);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
  }
}

// ---------- Shared constants (must match client/index.html) ----------
const MAP_W = 2400, MAP_H = 1800;
const TILE = 64;
const MAP_SEED = 1337;
const PLAYER_SPEED = 160;        // px/s
const PLAYER_RADIUS = 14;
const FIRE_COOLDOWN = 800;       // ms
const HIT_TOLERANCE = 80;        // px, lag allowance for shootHit validation
const TICK_MS = 50;              // 20 ticks/second
const MAX_ROOM_PLAYERS = 16;
const TOTAL_ROUNDS = 5;
const ROUNDEND_MS = 8000;

const CAMO = {
  jungle: { zones: ['A', 'C'] },
  desert: { zones: ['B'] },
  urban:  { zones: [] },        // stub for a future urban map
};
const DEALT_CAMOS = ['jungle', 'desert'];

const ZONES = [
  { id: 'A', x: 200,  y: 200,  w: 600, h: 500 },
  { id: 'B', x: 600,  y: 750,  w: 800, h: 300 },
  { id: 'C', x: 1600, y: 300,  w: 600, h: 600 },
  { id: 'D', x: 1200, y: 1200, w: 700, h: 400 },
];

const HIDER_SPAWNS = [
  {x:300,y:300}, {x:500,y:800}, {x:900,y:400}, {x:1100,y:1300},
  {x:1500,y:500}, {x:1800,y:900}, {x:2100,y:300}, {x:2000,y:1500},
];
const SEEKER_SPAWN_ZONE = { x: 50, y: 50, w: 150, h: 150 };
const SEEKER_SPAWNS = [{x:80,y:80}, {x:120,y:120}];

// ---------- Seeded map generation (verbatim copy of client/index.html) ----------
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateMap(seed) {
  const rng = mulberry32(seed);
  const COLS = Math.ceil(MAP_W / TILE);   // 38
  const ROWS = Math.ceil(MAP_H / TILE);   // 29

  const waterRows = [13, 14];

  const pathCols = [];
  let col = 1;
  for (let r = 0; r < ROWS; r++) {
    pathCols.push(col);
    const drift = rng();
    const target = Math.floor((r / ROWS) * (COLS - 3)) + 1;
    if (col < target || drift < 0.35) col += 1;
    else if (drift > 0.85 && col > 1) col -= 1;
    col = Math.max(1, Math.min(COLS - 2, col));
  }

  const crossings = new Set();
  waterRows.forEach(r => {
    const pc = pathCols[r];
    [pc - 1, pc, pc + 1].forEach(c => crossings.add(c));
  });
  [28, 29, 30].forEach(c => crossings.add(c));

  const groundVariants = [];
  for (let r = 0; r < ROWS; r++) {
    const rowV = [];
    for (let c = 0; c < COLS; c++) rowV.push(rng() < 0.15 ? 1 : 0);
    groundVariants.push(rowV);
  }

  const riverY0 = waterRows[0] * TILE, riverY1 = (waterRows[waterRows.length-1] + 1) * TILE;
  function inRiver(x, y, pad) {
    return y > riverY0 - pad && y < riverY1 + pad;
  }
  function onPath(x, y, pad) {
    const r = Math.floor(y / TILE);
    if (r < 0 || r >= ROWS) return false;
    const pc = pathCols[r];
    return Math.abs(x - (pc * TILE + TILE/2)) < TILE + pad;
  }
  function nearSpawn(x, y) {
    if (x < SEEKER_SPAWN_ZONE.x + SEEKER_SPAWN_ZONE.w + 80 && y < SEEKER_SPAWN_ZONE.y + SEEKER_SPAWN_ZONE.h + 80) return true;
    return HIDER_SPAWNS.some(s => Math.hypot(s.x - x, s.y - y) < 90);
  }
  const placed = [];
  function tooClose(x, y, minDist) {
    return placed.some(p => Math.hypot(p.x - x, p.y - y) < minDist);
  }
  function tryPlace(list, kind, x, y, radius, minDist, avoidRiverPad) {
    if (x < 60 || x > MAP_W - 60 || y < 60 || y > MAP_H - 60) return false;
    if (inRiver(x, y, avoidRiverPad)) return false;
    if (onPath(x, y, 10)) return false;
    if (nearSpawn(x, y)) return false;
    if (tooClose(x, y, minDist)) return false;
    list.push({ kind, x, y, radius });
    placed.push({ x, y });
    return true;
  }

  const trees = [];
  let guard = 0;
  while (trees.length < 48 && guard++ < 4000) {
    let x, y;
    const roll = rng();
    if (roll < 0.3) {
      x = ZONES[0].x + rng() * ZONES[0].w; y = ZONES[0].y + rng() * ZONES[0].h;
    } else if (roll < 0.55) {
      x = ZONES[2].x + rng() * ZONES[2].w; y = ZONES[2].y + rng() * ZONES[2].h;
    } else {
      x = rng() * MAP_W; y = rng() * MAP_H;
    }
    const kind = rng() < 0.4 ? 'treeOak' : (rng() < 0.5 ? 'treePine' : 'treePineLarge');
    tryPlace(trees, kind, x, y, 20, 70, 40);
  }

  const bushes = [];
  guard = 0;
  while (bushes.length < 72 && guard++ < 4000) {
    const cx = 80 + rng() * (MAP_W - 160), cy = 80 + rng() * (MAP_H - 160);
    const clusterSize = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < clusterSize && bushes.length < 72; i++) {
      const x = cx + (rng() - 0.5) * 180, y = cy + (rng() - 0.5) * 180;
      const kind = rng() < 0.5 ? 'bush' : 'bushLarge';
      tryPlace(bushes, kind, x, y, 16, 42, 40);
    }
  }

  const rocks = [];
  guard = 0;
  while (rocks.length < 30 && guard++ < 3000) {
    const x = rng() * MAP_W;
    const y = riverY0 - 40 - rng() * 180;
    const y2 = riverY1 + 40 + rng() * 180;
    const yy = rng() < 0.5 ? y : y2;
    tryPlace(rocks, 'rockLarge', x, yy, 18, 60, 30);
  }

  const flowers = [];
  for (let i = 0; i < 60; i++) {
    const x = 40 + rng() * (MAP_W - 80), y = 40 + rng() * (MAP_H - 80);
    if (inRiver(x, y, 10)) continue;
    flowers.push({ kind: rng() < 0.5 ? 'flowerRed' : 'flowerYellow', x, y });
  }

  return { COLS, ROWS, groundVariants, pathCols, waterRows, crossings, trees, bushes, rocks, flowers };
}

// ---------- Server-side collision geometry ----------
const MAP = generateMap(MAP_SEED);

// Prop collision circles: centered like the client's static rects (y - r*0.4)
const OBSTACLE_CIRCLES = [...MAP.trees, ...MAP.bushes, ...MAP.rocks]
  .map(p => ({ x: p.x, y: p.y - p.radius * 0.4, r: p.radius }));

// Water collision rects (merged runs of non-crossing columns)
const WATER_RECTS = [];
MAP.waterRows.forEach(r => {
  let runStart = null;
  for (let c = 0; c <= MAP.COLS; c++) {
    const isWater = c < MAP.COLS && !MAP.crossings.has(c);
    if (isWater && runStart === null) runStart = c;
    if (!isWater && runStart !== null) {
      WATER_RECTS.push({ x: runStart * TILE, y: r * TILE, w: (c - runStart) * TILE, h: TILE });
      runStart = null;
    }
  }
});

function circleHitsObstacle(x, y) {
  for (const o of OBSTACLE_CIRCLES) {
    const rr = o.r + PLAYER_RADIUS;
    const dx = x - o.x, dy = y - o.y;
    if (dx * dx + dy * dy < rr * rr) return true;
  }
  for (const w of WATER_RECTS) {
    const cx = Math.max(w.x, Math.min(x, w.x + w.w));
    const cy = Math.max(w.y, Math.min(y, w.y + w.h));
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

// Move with axis-separated collision (matches arcade-physics feel)
function moveWithCollision(p, dx, dy, dt) {
  const len = Math.hypot(dx, dy);
  if (len === 0) { p.vx = 0; p.vy = 0; return; }
  const nx = dx / len, ny = dy / len;
  const step = PLAYER_SPEED * dt;
  let newX = p.x + nx * step;
  let newY = p.y + ny * step;
  newX = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, newX));
  newY = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, newY));
  if (!circleHitsObstacle(newX, p.y)) p.x = newX;
  if (!circleHitsObstacle(p.x, newY)) p.y = newY;
  p.vx = nx; p.vy = ny;
}

function zoneAt(x, y) {
  for (const z of ZONES) {
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return z;
  }
  return null;
}

// Shimmer alpha (same formula as the client) — server-computed so seeker
// clients can't peek at "true" hider visibility, and worldUpdate carries it.
function shimmerAlpha(p, nowMs) {
  const time = nowMs / 1000;
  const isMoving = p.vx !== 0 || p.vy !== 0;
  const zone = zoneAt(p.x, p.y);
  const camo = CAMO[p.camo] || CAMO.jungle;
  const inMatchingZone = zone !== null && camo.zones.includes(zone.id);
  const mismatch = zone !== null && !inMatchingZone;

  if (isMoving) {
    return 0.5 + 0.4 * Math.sin(time * Math.PI * 3);
  } else if (p.stillTimer > 2000) {
    let baseAlpha = inMatchingZone ? 0.22 : 0.35;
    if (mismatch) baseAlpha *= 1.2;
    return baseAlpha + 0.15 * Math.sin(time * Math.PI * 0.8);
  }
  return 0.45 + 0.25 * Math.sin(time * Math.PI * 1.5);
}

// ---------- HTTP (static client) + Socket.io ----------
const httpServer = http.createServer((req, res) => {
  // Health check for hosts / uptime probes
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
    return;
  }
  serveStatic(req, res);
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ---------- Rooms ----------
const rooms = new Map();   // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoomState(hostId) {
  return {
    code: makeCode(),
    hostId,
    phase: 'LOBBY',                 // LOBBY | PREP | SEEK | ROUNDEND
    players: new Map(),             // socketId -> player
    round: 0,
    prepTimer: null,
    seekTimer: null,
    roundEndTimer: null,
    tick: null,
    phaseEndsAt: 0,
    settings: { prepTime: 60, seekTime: 180, minPlayers: 2 },
  };
}

function makePlayer(socket) {
  return {
    id: socket.id,
    username: socket.username || ('Player' + socket.id.slice(0, 4)),
    role: 'lobby',
    camo: null,
    score: 0,
    roundScore: 0,
    seekerRounds: 0,        // rounds started as seeker (for fair rotation)
    roundRole: null,        // role at round start
    spawnIndex: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    dx: 0, dy: 0,           // latest input direction
    stillTimer: 0,
    lastFired: 0,
    joinOrder: 0,
  };
}

function publicPlayer(p) {
  return { id: p.id, username: p.username, role: p.role, score: p.score, camo: p.camo };
}

function roomStateFor(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    settings: room.settings,
    players: [...room.players.values()].map(publicPlayer),
  };
}

function getRoom(socket) {
  return rooms.get(socket.roomCode);
}

// ---------- Round / phase machinery ----------
function clearTimers(room) {
  if (room.prepTimer) { clearTimeout(room.prepTimer); room.prepTimer = null; }
  if (room.seekTimer) { clearTimeout(room.seekTimer); room.seekTimer = null; }
  if (room.roundEndTimer) { clearTimeout(room.roundEndTimer); room.roundEndTimer = null; }
}

function assignRoles(room) {
  const players = [...room.players.values()];
  const n = players.length;
  const seekerCount = Math.max(1, Math.floor(n * 0.3));

  // Fair rotation: players who have started as seeker least often go first.
  // (The design doc's literal "swap all roles" degenerates with odd counts —
  // e.g. 5 players would flip 1v4 into 4v1 — so we rotate the seeker slots
  // instead, matching its "rotate the extra player" intent.)
  const sorted = [...players].sort((a, b) =>
    (a.seekerRounds - b.seekerRounds) || (a.joinOrder - b.joinOrder));
  const seekers = new Set(sorted.slice(0, seekerCount).map(p => p.id));

  let hiderIdx = 0, seekerIdx = 0;
  players.forEach(p => {
    p.roundScore = 0;
    p.stillTimer = 0;
    p.dx = 0; p.dy = 0; p.vx = 0; p.vy = 0;
    if (seekers.has(p.id)) {
      p.role = 'seeker';
      p.camo = null;
      p.seekerRounds += 1;
      p.roundRole = 'seeker';
      p.spawnIndex = seekerIdx;
      const s = SEEKER_SPAWNS[seekerIdx % SEEKER_SPAWNS.length];
      // stagger extra seekers inside the spawn zone
      p.x = s.x + Math.floor(seekerIdx / SEEKER_SPAWNS.length) * 30;
      p.y = s.y + Math.floor(seekerIdx / SEEKER_SPAWNS.length) * 20;
      seekerIdx++;
    } else {
      p.role = 'hider';
      p.camo = DEALT_CAMOS[Math.floor(Math.random() * DEALT_CAMOS.length)];
      p.roundRole = 'hider';
      p.spawnIndex = hiderIdx;
      const s = HIDER_SPAWNS[hiderIdx % HIDER_SPAWNS.length];
      p.x = s.x; p.y = s.y;
      hiderIdx++;
    }
  });
}

function startRound(room) {
  room.round += 1;
  assignRoles(room);
  room.phase = 'PREP';
  room.phaseEndsAt = Date.now() + room.settings.prepTime * 1000;

  // Per-player roundStart: seekers must not learn hider spawn positions
  // (same anti-cheat rule as PREP worldUpdate filtering).
  const allRoles = [...room.players.values()].map(p => ({
    id: p.id, role: p.role, camo: p.camo, x: p.x, y: p.y,
  }));
  room.players.forEach(recipient => {
    const roles = allRoles.map(r => {
      if (recipient.role === 'seeker' && r.role === 'hider' && r.id !== recipient.id) {
        return { id: r.id, role: r.role };   // no position, no camo
      }
      return r;
    });
    io.to(recipient.id).emit('roundStart', {
      round: room.round,
      totalRounds: TOTAL_ROUNDS,
      roles,
      prepTime: room.settings.prepTime,
      seekTime: room.settings.seekTime,
    });
  });

  room.prepTimer = setTimeout(() => {
    room.prepTimer = null;
    if (room.phase !== 'PREP') return;
    room.phase = 'SEEK';
    room.phaseEndsAt = Date.now() + room.settings.seekTime * 1000;
    io.to(room.code).emit('phaseChange', { phase: 'SEEK', duration: room.settings.seekTime });
    room.seekTimer = setTimeout(() => {
      room.seekTimer = null;
      endRound(room, 'time');
    }, room.settings.seekTime * 1000);
  }, room.settings.prepTime * 1000);

  if (!room.tick) {
    room.tick = setInterval(() => tickRoom(room), TICK_MS);
  }
}

function endRound(room, reason) {
  if (room.phase !== 'PREP' && room.phase !== 'SEEK') return;
  clearTimers(room);
  room.phase = 'ROUNDEND';

  const players = [...room.players.values()];
  const survivors = players.filter(p => p.role === 'hider');

  // Scoring (authoritative)
  survivors.forEach(p => { p.roundScore += 100; });
  if (reason === 'time' && survivors.length === 1) {
    survivors[0].roundScore += 50;    // last hider standing bonus
  }
  if (survivors.length === 0) {
    players.filter(p => p.role === 'seeker').forEach(p => { p.roundScore += 25; });
  }
  players.forEach(p => { p.score += p.roundScore; });

  const isMatchEnd = room.round >= TOTAL_ROUNDS;
  const scores = players.map(p => ({
    id: p.id, username: p.username,
    roundScore: p.roundScore, total: p.score, role: p.roundRole,
  }));

  io.to(room.code).emit('roundEnd', {
    reason,
    round: room.round,
    scores,
    survivors: survivors.map(p => p.id),
    matchEnd: isMatchEnd,
    nextRoundIn: isMatchEnd ? null : ROUNDEND_MS / 1000,
  });

  if (isMatchEnd) {
    room.roundEndTimer = setTimeout(() => {
      room.roundEndTimer = null;
      finishMatch(room);
    }, ROUNDEND_MS);
  } else {
    room.roundEndTimer = setTimeout(() => {
      room.roundEndTimer = null;
      if (room.players.size >= 2) startRound(room);
      else backToLobby(room);
    }, ROUNDEND_MS);
  }
}

function finishMatch(room) {
  const finalScores = [...room.players.values()]
    .map(p => ({ id: p.id, username: p.username, total: p.score }))
    .sort((a, b) => b.total - a.total);
  io.to(room.code).emit('matchEnd', { finalScores });
  room.phase = 'MATCHEND';
  if (room.tick) { clearInterval(room.tick); room.tick = null; }
}

function backToLobby(room) {
  clearTimers(room);
  if (room.tick) { clearInterval(room.tick); room.tick = null; }
  room.phase = 'LOBBY';
  room.round = 0;
  room.players.forEach(p => {
    p.role = 'lobby'; p.camo = null; p.score = 0; p.roundScore = 0;
    p.seekerRounds = 0; p.roundRole = null;
  });
  io.to(room.code).emit('lobbyState', roomStateFor(room));
}

// ---------- Game tick: movement + world broadcast ----------
function tickRoom(room) {
  if (room.phase !== 'PREP' && room.phase !== 'SEEK') return;
  const dt = TICK_MS / 1000;
  const now = Date.now();

  room.players.forEach(p => {
    if (p.role === 'seeker' && room.phase === 'PREP') {
      // Seekers are locked in their spawn zone during PREP
      const prevX = p.x, prevY = p.y;
      moveWithCollision(p, p.dx, p.dy, dt);
      const z = SEEKER_SPAWN_ZONE;
      p.x = Math.max(z.x + PLAYER_RADIUS, Math.min(z.x + z.w - PLAYER_RADIUS, p.x));
      p.y = Math.max(z.y + PLAYER_RADIUS, Math.min(z.y + z.h - PLAYER_RADIUS, p.y));
      if (p.x === prevX && p.y === prevY) { p.vx = 0; p.vy = 0; }
    } else {
      moveWithCollision(p, p.dx, p.dy, dt);
    }
    const moving = p.dx !== 0 || p.dy !== 0;
    if (moving) p.stillTimer = 0;
    else p.stillTimer += TICK_MS;
  });

  const remaining = Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000));

  const all = [...room.players.values()].map(p => ({
    id: p.id,
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    role: p.role,
    camo: p.camo,
    alpha: p.role === 'hider' ? Math.round(shimmerAlpha(p, now) * 1000) / 1000 : 1,
  }));

  // PREP-phase anti-cheat: seeker clients never receive hider positions,
  // so reading WebSocket traffic can't reveal hiding spots.
  const seekersView = room.phase === 'PREP' ? all.filter(e => e.role !== 'hider') : all;

  room.players.forEach(p => {
    const view = (p.role === 'seeker') ? seekersView : all;
    io.to(p.id).emit('worldUpdate', { players: view, phase: room.phase, remaining });
  });
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  socket.username = null;

  socket.on('setUsername', (name) => {
    if (typeof name !== 'string') return;
    const trimmed = name.trim().slice(0, 16);
    socket.username = trimmed || ('Player' + socket.id.slice(0, 4));
    const room = getRoom(socket);
    if (room && room.players.has(socket.id)) {
      room.players.get(socket.id).username = socket.username;
      io.to(room.code).emit('lobbyState', roomStateFor(room));
    }
  });

  socket.on('createRoom', () => {
    if (getRoom(socket)) return;
    const room = createRoomState(socket.id);
    rooms.set(room.code, room);
    const player = makePlayer(socket);
    player.joinOrder = 0;
    room.players.set(socket.id, player);
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.emit('roomCreated', { code: room.code, roomState: roomStateFor(room) });
  });

  function joinRoomByCode(code) {
    const room = rooms.get(code);
    if (!room) { socket.emit('joinError', { message: 'Room not found.' }); return; }
    if (room.players.size >= MAX_ROOM_PLAYERS) { socket.emit('joinError', { message: 'Room is full.' }); return; }
    if (room.phase === 'SEEK') { socket.emit('joinError', { message: 'Game already in progress.' }); return; }
    if (room.phase !== 'LOBBY') { socket.emit('joinError', { message: 'Round in progress — try again shortly.' }); return; }
    const player = makePlayer(socket);
    player.joinOrder = room.players.size;
    room.players.set(socket.id, player);
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.emit('roomJoined', { roomState: roomStateFor(room) });
    socket.to(room.code).emit('playerJoined', { player: publicPlayer(player) });
    io.to(room.code).emit('lobbyState', roomStateFor(room));
  }

  socket.on('joinRoom', (code) => {
    if (getRoom(socket)) return;
    if (typeof code !== 'string') return;
    joinRoomByCode(code.trim().toUpperCase());
  });

  socket.on('joinRandom', () => {
    if (getRoom(socket)) return;
    let target = null;
    for (const room of rooms.values()) {
      if (room.phase === 'LOBBY' && room.players.size < MAX_ROOM_PLAYERS) { target = room; break; }
    }
    if (target) {
      joinRoomByCode(target.code);
    } else {
      const room = createRoomState(socket.id);
      rooms.set(room.code, room);
      const player = makePlayer(socket);
      room.players.set(socket.id, player);
      socket.join(room.code);
      socket.roomCode = room.code;
      socket.emit('roomCreated', { code: room.code, roomState: roomStateFor(room) });
    }
  });

  socket.on('startGame', (settings) => {
    const room = getRoom(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'LOBBY' && room.phase !== 'MATCHEND') return;
    if (settings && typeof settings === 'object') {
      // WWC_DEBUG=1 relaxes validation so automated tests can run short phases
      const debug = process.env.WWC_DEBUG === '1';
      const okPrep = debug ? Number.isInteger(settings.prepTime) && settings.prepTime >= 1 && settings.prepTime <= 600
                           : [30, 60, 90].includes(settings.prepTime);
      const okSeek = debug ? Number.isInteger(settings.seekTime) && settings.seekTime >= 1 && settings.seekTime <= 600
                           : [120, 180, 300].includes(settings.seekTime);
      const prep = okPrep ? settings.prepTime : room.settings.prepTime;
      const seek = okSeek ? settings.seekTime : room.settings.seekTime;
      const minP = [2, 4, 6].includes(settings.minPlayers) ? settings.minPlayers : room.settings.minPlayers;
      room.settings = { prepTime: prep, seekTime: seek, minPlayers: minP };
    }
    if (room.players.size < Math.max(2, room.settings.minPlayers)) {
      socket.emit('startError', { message: `Need at least ${Math.max(2, room.settings.minPlayers)} players.` });
      return;
    }
    room.round = 0;
    room.players.forEach(p => { p.score = 0; p.seekerRounds = 0; });
    io.to(room.code).emit('gameStart', { settings: room.settings });
    startRound(room);
  });

  socket.on('playAgain', () => {
    const room = getRoom(socket);
    if (!room || room.hostId !== socket.id || room.phase !== 'MATCHEND') return;
    backToLobby(room);
  });

  socket.on('leaveRoom', () => {
    handleLeave(socket);
  });

  socket.on('inputUpdate', (input) => {
    const room = getRoom(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const dx = Number(input && input.dx), dy = Number(input && input.dy);
    p.dx = dx === -1 || dx === 1 ? dx : 0;
    p.dy = dy === -1 || dy === 1 ? dy : 0;
  });

  // Seeker fired — validate, then broadcast so all clients render the paintball
  socket.on('shoot', (data) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'SEEK') return;
    const p = room.players.get(socket.id);
    if (!p || p.role !== 'seeker') return;
    const now = Date.now();
    if (now - p.lastFired < FIRE_COOLDOWN) return;
    p.lastFired = now;
    const angle = Number(data && data.angle) || 0;
    io.to(room.code).emit('playerShot', { id: p.id, x: p.x, y: p.y, angle });
  });

  socket.on('shootHit', (data) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'SEEK') return;
    const shooter = room.players.get(socket.id);
    const target = room.players.get(data && data.targetId);
    const px = Number(data && data.projectileX), py = Number(data && data.projectileY);
    if (!shooter || shooter.role !== 'seeker' || !target || target.role !== 'hider' ||
        !isFinite(px) || !isFinite(py) ||
        Math.hypot(px - target.x, py - target.y) >= HIT_TOLERANCE) {
      socket.emit('hitRejected');
      return;
    }
    // Infection
    target.role = 'seeker';
    target.camo = null;
    shooter.roundScore += 10;
    io.to(room.code).emit('playerInfected', { targetId: target.id, newSeekerId: shooter.id });

    const hidersLeft = [...room.players.values()].filter(pl => pl.role === 'hider').length;
    if (hidersLeft === 0) endRound(room, 'allInfected');
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });

  function handleLeave(sock) {
    const room = getRoom(sock);
    if (!room) return;
    const wasHider = room.players.get(sock.id) && room.players.get(sock.id).role === 'hider';
    room.players.delete(sock.id);
    sock.leave(room.code);
    sock.roomCode = null;

    if (room.players.size === 0) {
      clearTimers(room);
      if (room.tick) { clearInterval(room.tick); room.tick = null; }
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === sock.id) {
      room.hostId = room.players.keys().next().value;
      io.to(room.code).emit('hostChanged', { newHostId: room.hostId });
    }
    io.to(room.code).emit('playerLeft', { id: sock.id });
    io.to(room.code).emit('lobbyState', roomStateFor(room));

    if (room.phase === 'SEEK' || room.phase === 'PREP') {
      const hidersLeft = [...room.players.values()].filter(pl => pl.role === 'hider').length;
      if (wasHider && hidersLeft === 0) endRound(room, 'allInfected');
      else if (room.players.size < 2) endRound(room, 'notEnoughPlayers');
    }
  }
});

const PORT = Number(process.env.PORT) || 3000;
httpServer.listen(PORT, () => {
  console.log('Where/Wear Camo listening on http://localhost:' + PORT);
  console.log('Serving client from ' + CLIENT_DIR);
});
