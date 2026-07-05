'use strict';
// Verify NPC hiders spread across the map (3x2 grid) instead of clumping.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const WORLD_W = 2400, WORLD_H = 1800;
const once = (s, ev, to = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), to);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});
const cellOf = (x, y) => {
  const cx = Math.min(2, Math.floor(x / (WORLD_W / 3)));
  const cy = Math.min(1, Math.floor(y / (WORLD_H / 2)));
  return cy * 3 + cx;
};

(async () => {
  const a = io(URL);
  const results = [];
  const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  (' + extra + ')' : ''}`); };
  try {
    await once(a, 'connect');
    a.emit('setUsername', 'Watcher');
    a.emit('quickJoin');
    const start = await once(a, 'roundStart', 6000);
    const npcHiders = new Set(start.roster.filter((r) => r.role === 'hider' && r.id.startsWith('npc_')).map((r) => r.id));
    const pos = new Map();
    a.on('worldUpdate', (d) => { for (const row of d.players) if (npcHiders.has(row[0])) pos.set(row[0], { x: row[1], y: row[2] }); });
    a.on('playerInfected', (d) => npcHiders.delete(d.id));   // ignore any found before we sample

    await new Promise((r) => setTimeout(r, 14000));          // let them travel to their spread cells (grace=20s)

    const cells = [...pos.entries()].filter(([id]) => npcHiders.has(id)).map(([, p]) => cellOf(p.x, p.y));
    const counts = {};
    for (const c of cells) counts[c] = (counts[c] || 0) + 1;
    const distinct = Object.keys(counts).length;
    const maxInOne = Math.max(...Object.values(counts));
    console.log('NPC hider count:', cells.length, ' cells occupied:', counts);
    check('hiders span >=4 of 6 grid cells (spread out)', distinct >= 4, `${distinct} cells`);
    check('no single cell holds most hiders (not clumped)', maxInOne <= Math.ceil(cells.length / 2), `max ${maxInOne}/cell`);

    a.disconnect();
  } catch (e) {
    check('unexpected error: ' + e.message, false);
    a.disconnect();
  }
  const fails = results.filter((r) => !r).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
