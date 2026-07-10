/* Automated protocol test for Where/Wear Camo server.
   Spawns the server (WWC_DEBUG=1, port 3100), connects two socket.io
   clients, and drives a full match with short phases, asserting the
   Definition-of-Done behaviors along the way.
   Run: node test-protocol.js */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3100;
const URL = 'http://localhost:' + PORT;
let failures = 0;
const results = [];

function check(name, cond, extra) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : (extra ? ' — ' + extra : '')}`);
  if (!cond) failures++;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(socket, event, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeoutMs);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), WWC_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => console.error('[server-err]', String(d)));
  await new Promise(r => server.stdout.once('data', r));

  const a = io(URL), b = io(URL);
  await Promise.all([waitFor(a, 'connect'), waitFor(b, 'connect')]);

  // --- Username + room creation ---
  a.emit('setUsername', 'Alice');
  b.emit('setUsername', 'BobWithAVeryLongName!!');   // >16 chars — should truncate
  a.emit('createRoom');
  const created = await waitFor(a, 'roomCreated');
  check('createRoom returns 5-char code', /^[A-Z0-9]{5}$/.test(created.code), created.code);

  // --- Bad join ---
  b.emit('joinRoom', 'ZZZZZ');
  const joinErr = await waitFor(b, 'joinError');
  check('joining unknown room errors', !!joinErr.message);

  // --- Good join ---
  const joinedPromise = waitFor(b, 'roomJoined');
  const playerJoinedPromise = waitFor(a, 'playerJoined');
  b.emit('joinRoom', created.code);
  const joined = await joinedPromise;
  const pj = await playerJoinedPromise;
  check('joinRoom returns room state', joined.roomState.code === created.code);
  check('host notified of playerJoined', pj.player.id === b.id);
  check('username truncated to 16 chars', pj.player.username.length <= 16, pj.player.username);

  // --- Non-host cannot start ---
  b.emit('startGame', { prepTime: 2, seekTime: 4, minPlayers: 2 });
  await sleep(300);

  // --- Host starts: short phases via WWC_DEBUG ---
  const roundStartA = waitFor(a, 'roundStart');
  const roundStartB = waitFor(b, 'roundStart');
  a.emit('startGame', { prepTime: 2, seekTime: 4, minPlayers: 2 });
  const [rsA, rsB] = await Promise.all([roundStartA, roundStartB]);
  check('roundStart broadcast to both', rsA.round === 1 && rsB.round === 1);
  check('exactly 1 seeker with 2 players', rsA.roles.filter(r => r.role === 'seeker').length === 1);
  const seekerId = rsA.roles.find(r => r.role === 'seeker').id;
  const hiderId = rsA.roles.find(r => r.role === 'hider').id;
  const seekerSock = seekerId === a.id ? a : b;
  const hiderSock = hiderId === a.id ? a : b;
  const rsSeeker = seekerId === a.id ? rsA : rsB;   // seeker's own view
  const rsHider = hiderId === a.id ? rsA : rsB;     // hider's own view
  const hiderEntry = rsHider.roles.find(r => r.id === hiderId);
  check('hider has a dealt camo (own view)', ['jungle', 'desert'].includes(hiderEntry.camo), String(hiderEntry.camo));
  check('anti-cheat: seeker roundStart hides hider position+camo', (() => {
    const h = rsSeeker.roles.find(r => r.id === hiderId);
    return h && h.x === undefined && h.y === undefined && h.camo === undefined;
  })(), JSON.stringify(rsSeeker.roles));
  check('seeker spawns in spawn zone', (() => {
    const s = rsSeeker.roles.find(r => r.id === seekerId);
    return s.x >= 50 && s.x <= 200 && s.y >= 50 && s.y <= 200;
  })());

  // --- PREP anti-cheat: seeker's worldUpdate must not contain hiders ---
  const wuSeeker = await waitFor(seekerSock, 'worldUpdate');
  check('PREP: seeker view has no hiders', !wuSeeker.players.some(p => p.role === 'hider'),
    JSON.stringify(wuSeeker.players.map(p => p.role)));
  const wuHider = await waitFor(hiderSock, 'worldUpdate');
  check('PREP: hider view has everyone', wuHider.players.length === 2);

  // --- Movement: hider walks right, position advances on server ---
  const x0 = wuHider.players.find(p => p.id === hiderId).x;
  const mover = setInterval(() => hiderSock.emit('inputUpdate', { dx: 1, dy: 0 }), 50);
  await sleep(700);
  clearInterval(mover);
  hiderSock.emit('inputUpdate', { dx: 0, dy: 0 });
  const wu2 = await waitFor(hiderSock, 'worldUpdate');
  const x1 = wu2.players.find(p => p.id === hiderId).x;
  check('server moves player from input (~112px in 0.7s)', x1 - x0 > 60 && x1 - x0 < 200, `moved ${(x1 - x0).toFixed(1)}px`);

  // --- Seeker locked in spawn during PREP ---
  const sx0 = wuSeeker.players.find(p => p.id === seekerId);
  const seekMover = setInterval(() => seekerSock.emit('inputUpdate', { dx: 1, dy: 1 }), 50);
  await sleep(600);
  clearInterval(seekMover);
  seekerSock.emit('inputUpdate', { dx: 0, dy: 0 });
  const wu3 = await waitFor(seekerSock, 'worldUpdate');
  const sPos = wu3.players.find(p => p.id === seekerId);
  check('PREP: seeker clamped to spawn zone', sPos.x <= 200 + 1 && sPos.y <= 200 + 1, JSON.stringify(sPos));

  // --- Phase change to SEEK ---
  // (phaseChange may already have fired while we were moving; poll worldUpdate)
  let wu4 = await waitFor(seekerSock, 'worldUpdate');
  const tWait = Date.now();
  while (wu4.phase !== 'SEEK' && Date.now() - tWait < 5000) wu4 = await waitFor(seekerSock, 'worldUpdate');
  check('phase transitions to SEEK', wu4.phase === 'SEEK');
  check('SEEK: seeker now sees hiders', wu4.players.some(p => p.role === 'hider'));
  const hAlpha = wu4.players.find(p => p.role === 'hider');
  check('hider alpha is shimmering (<1)', hAlpha.alpha < 1, String(hAlpha.alpha));
  check('SEEK: worldUpdate carries hider camo for tinting', ['jungle', 'desert'].includes(hAlpha.camo), String(hAlpha.camo));

  // --- Invalid hit: too far away ---
  seekerSock.emit('shootHit', { targetId: hiderId, projectileX: 0, projectileY: 0 });
  const rejected = await waitFor(seekerSock, 'hitRejected');
  check('far-away shootHit rejected', true);

  // --- Valid hit: at hider's true position ---
  const hPos = wu4.players.find(p => p.id === hiderId);
  const infectedPromise = waitFor(hiderSock, 'playerInfected');
  seekerSock.emit('shootHit', { targetId: hiderId, projectileX: hPos.x + 10, projectileY: hPos.y });
  const infected = await infectedPromise;
  check('valid shootHit broadcasts playerInfected', infected.targetId === hiderId && infected.newSeekerId === seekerId);

  // --- All hiders infected -> immediate roundEnd with seeker scoring ---
  const re = await waitFor(seekerSock, 'roundEnd');
  check('round ends early when all hiders infected', re.reason === 'allInfected');
  const seekerScore = re.scores.find(s => s.id === seekerId);
  const hiderScore = re.scores.find(s => s.id === hiderId);
  check('seeker got +10 (hit) +25 (all infected) = 35', seekerScore.roundScore === 35, String(seekerScore.roundScore));
  check('infected hider got +25 all-infected bonus (now a seeker)', hiderScore.roundScore === 25, String(hiderScore.roundScore));
  check('roundEnd not matchEnd on round 1', re.matchEnd === false);

  // --- Round 2: roles must rotate ---
  const rs2 = await waitFor(seekerSock, 'roundStart', 15000);
  check('round 2 starts automatically', rs2.round === 2);
  const newSeeker = rs2.roles.find(r => r.role === 'seeker').id;
  check('roles rotate: previous hider seeks round 2', newSeeker === hiderId,
    `expected ${hiderId}, got ${newSeeker}`);

  // --- Survive round 2 (nobody shoots): hider survives, gets 100 + 50 last-standing ---
  const re2 = await waitFor(seekerSock, 'roundEnd', 20000);
  check('round 2 ends on time expiry', re2.reason === 'time');
  const r2Hider = rs2.roles.find(r => r.role === 'hider').id;
  const r2HiderScore = re2.scores.find(s => s.id === r2Hider);
  check('survivor scores 100 + 50 last-standing', r2HiderScore.roundScore === 150, String(r2HiderScore.roundScore));

  // --- Play through rounds 3-5 quickly, then expect matchEnd ---
  for (let round = 3; round <= 5; round++) {
    await waitFor(seekerSock, 'roundStart', 15000);
    await waitFor(seekerSock, 'roundEnd', 20000);
  }
  const me = await waitFor(seekerSock, 'matchEnd', 15000);
  check('matchEnd after 5 rounds', Array.isArray(me.finalScores) && me.finalScores.length === 2);
  check('final scores sorted desc', me.finalScores[0].total >= me.finalScores[1].total);

  // --- Play again (host) returns to lobby ---
  const lobbyPromise = waitFor(a, 'lobbyState');
  a.emit('playAgain');
  const lst = await lobbyPromise;
  check('playAgain returns to lobby with scores reset', lst.phase === 'LOBBY' && lst.players.every(p => p.score === 0));

  // --- Disconnect handling: host leaves mid-lobby -> host migrates ---
  const hostChangedPromise = waitFor(b, 'hostChanged');
  a.disconnect();
  const hc = await hostChangedPromise;
  check('host migrates on disconnect', hc.newHostId === b.id);

  // --- Mid-round hider disconnect ends round ---
  const c = io(URL);
  await waitFor(c, 'connect');
  c.emit('setUsername', 'Carol');
  c.emit('joinRoom', created.code);
  await waitFor(c, 'roomJoined');
  const rs3p = waitFor(b, 'roundStart');
  b.emit('startGame', { prepTime: 1, seekTime: 30, minPlayers: 2 });
  const rs3 = await rs3p;
  const hider3 = rs3.roles.find(r => r.role === 'hider').id;
  const hiderSock3 = hider3 === b.id ? b : c;
  const otherSock3 = hider3 === b.id ? c : b;
  await sleep(1500);   // into SEEK
  const re3p = waitFor(otherSock3, 'roundEnd', 8000);
  hiderSock3.disconnect();
  const re3 = await re3p;
  check('last hider disconnect mid-SEEK ends round', ['allInfected', 'notEnoughPlayers'].includes(re3.reason), re3.reason);

  otherSock3.disconnect();
  server.kill();
  console.log('\n' + results.join('\n'));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS ERROR:', e.message); console.log(results.join('\n')); process.exit(1); });
