'use strict';
// Repro: host=seeker converts all NPC hiders while a 2nd human keeps hiding.
// The round must NOT end (seekers win) while a human hider is still alive.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev, to = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), to);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});

async function attempt() {
  const a = io(URL), b = io(URL);
  await Promise.all([once(a, 'connect'), once(b, 'connect')]);
  a.emit('setUsername', 'Host'); b.emit('setUsername', 'Guest');
  a.emit('createRoom');
  const ra = await once(a, 'roomJoined');
  b.emit('joinRoom', ra.code);
  await once(b, 'roomJoined');
  a.emit('startGame');
  const [sa, sb] = await Promise.all([once(a, 'roundStart'), once(b, 'roundStart')]);
  const aSeeker = sa.roster.find((r) => r.id === sa.yourId).role === 'seeker';
  const bHider = sb.roster.find((r) => r.id === sb.yourId).role === 'hider';
  if (aSeeker && bHider) return { a, b, sa, sb };
  a.disconnect(); b.disconnect();
  return null;
}

(async () => {
  let ctx = null;
  for (let i = 0; i < 20 && !ctx; i++) ctx = await attempt();
  if (!ctx) { console.log('SKIP: could not roll host=seeker/guest=hider'); process.exit(2); }
  const { a, b, sa, sb } = ctx;
  console.log('config: host is SEEKER, guest is HIDER');

  const npcHiderIds = new Set(sa.roster.filter((r) => r.role === 'hider' && r.id.startsWith('npc_')).map((r) => r.id));
  const bId = sb.yourId;
  let bFound = false, falseWin = false, legitWin = false;
  b.on('playerInfected', (d) => { if (d.id === bId) bFound = true; });
  a.on('playerInfected', (d) => npcHiderIds.delete(d.id));
  a.on('roundEnd', (d) => {
    if (d.winner === 'seekers') { if (bFound) legitWin = true; else falseWin = true; }
  });

  const hold = setInterval(() => b.emit('inputUpdate', { dx: 1, dy: 1 }), 200);  // guest flees & holds
  await once(a, 'phaseChange', 25000);                                            // SEEK

  const pos = new Map();
  a.on('worldUpdate', (d) => { for (const row of d.players) pos.set(row[0], { x: row[1], y: row[2] }); });

  const deadline = Date.now() + 45000;
  while (npcHiderIds.size > 0 && Date.now() < deadline && !falseWin) {
    for (const id of [...npcHiderIds]) {
      const p = pos.get(id);
      if (p) a.emit('shootHit', { targetId: id, x: p.x, y: p.y });   // convert each NPC hider
    }
    await wait(300);
  }
  await wait(1500);
  clearInterval(hold);

  console.log('NPC hiders left unconverted:', npcHiderIds.size);
  console.log('guest (human hider) was legitimately found:', bFound);
  if (falseWin) console.log('FAIL  round ended (seekers win) while a human hider was STILL HIDING — BUG REPRODUCED');
  else if (legitWin) console.log('PASS  round ended only after the human hider was actually found (correct)');
  else console.log('PASS  no false win — round kept going for the human hider');
  a.disconnect(); b.disconnect();
  process.exit(falseWin ? 1 : 0);
})();
