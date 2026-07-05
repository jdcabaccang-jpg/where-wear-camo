'use strict';
// Verify: with 3+ NPC seekers, one walks the map perimeter (visits corners).
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const WORLD_W = 2400, WORLD_H = 1800, M = 150;
const CORNERS = [{ x: M, y: M }, { x: WORLD_W - M, y: M }, { x: WORLD_W - M, y: WORLD_H - M }, { x: M, y: WORLD_H - M }];
const once = (s, ev, to = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), to);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});

async function getThreeSeekerMatch() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const a = io(URL);
    await once(a, 'connect');
    a.emit('setUsername', 'Watcher');
    a.emit('quickJoin');
    const start = await once(a, 'roundStart', 6000);
    const npcSeekers = start.roster.filter((r) => r.role === 'seeker' && r.id.startsWith('npc_'));
    if (npcSeekers.length >= 3) return { a, start, seekerIds: npcSeekers.map((r) => r.id) };
    a.disconnect();
  }
  return null;
}

(async () => {
  const results = [];
  const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  (' + extra + ')' : ''}`); };
  const ctx = await getThreeSeekerMatch();
  if (!ctx) { console.log('SKIP: could not roll a 3-NPC-seeker quick match'); process.exit(2); }
  const { a, seekerIds } = ctx;
  console.log('got a match with', seekerIds.length, 'NPC seekers');
  const cornersVisited = new Map();   // seekerId -> Set of corner indices
  seekerIds.forEach((id) => cornersVisited.set(id, new Set()));
  a.on('worldUpdate', (d) => {
    for (const row of d.players) {
      if (!cornersVisited.has(row[0])) continue;
      for (let i = 0; i < 4; i++) {
        if (Math.hypot(row[1] - CORNERS[i].x, row[2] - CORNERS[i].y) < 200) cornersVisited.get(row[0]).add(i);
      }
    }
  });
  a.on('playerInfected', (d) => cornersVisited.delete(d.id));  // ignore converted

  await once(a, 'phaseChange', 25000);              // SEEK
  await new Promise((r) => setTimeout(r, 58000));    // watch most of a lap

  const best = Math.max(0, ...[...cornersVisited.values()].map((s) => s.size));
  console.log('corner-visit counts:', [...cornersVisited.entries()].map(([id, s]) => `${id.slice(0, 8)}:${s.size}`).join(' '));
  check('a seeker patrols the perimeter (>=3 corners visited)', best >= 3, `${best} corners`);
  a.disconnect();
  const fails = results.filter((r) => !r).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
