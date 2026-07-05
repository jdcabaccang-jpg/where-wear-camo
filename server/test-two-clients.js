'use strict';
// Integration test: two clients against a live server.
// Run: node server.js  (in another terminal)  then: node test-two-clients.js

const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const once = (sock, ev, timeout = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), timeout);
  sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
});

(async () => {
  const a = io(URL), b = io(URL);
  try {
    await Promise.all([once(a, 'connect'), once(b, 'connect')]);
    check('both clients connect', true);

    // ---- lobby
    a.emit('setUsername', 'Alice');
    b.emit('setUsername', 'Bob');
    a.emit('createRoom');
    const roomA = await once(a, 'roomJoined');
    check('createRoom returns 5-char code', /^[A-Z0-9]{5}$/.test(roomA.code), roomA.code);

    b.emit('joinRoom', roomA.code);
    const roomB = await once(b, 'roomJoined');
    check('joinRoom works', roomB.code === roomA.code);
    check('lobby lists both humans', roomB.players.length === 2);
    check('lobby advertises +8 NPCs for 2 humans', roomB.npcCount === 8, '+' + roomB.npcCount);

    b.emit('joinRoom', 'ZZZZZ');
    const err = await once(b, 'errorMsg');
    check('bad code rejected', /not found/i.test(err));

    // ---- start
    a.emit('startGame');
    const [startA, startB] = await Promise.all([once(a, 'roundStart'), once(b, 'roundStart')]);
    check('roundStart broadcast to both', !!startA && !!startB);
    check('same theme+seed for both', startA.theme === startB.theme && startA.seed === startB.seed,
      startA.theme);
    check('phase starts GRACE', startA.phase === 'GRACE');

    // ---- roster math for 2 humans: 6 NPC hiders, exactly 2 seekers,
    //      stalker NPC always, human seeker only via the 50% roll
    const roster = startA.roster;
    const seekers = roster.filter(r => r.role === 'seeker');
    const npcHiders = roster.filter(r => r.id.startsWith('npc_') && r.role === 'hider');
    const npcSeekers = seekers.filter(r => r.id.startsWith('npc_'));
    const humanSeekers = seekers.filter(r => !r.id.startsWith('npc_'));
    check('exactly 2 seekers', seekers.length === 2,
      `human=${humanSeekers.length} npc=${npcSeekers.length}`);
    check('6 NPC hiders for 2 humans', npcHiders.length === 6, String(npcHiders.length));
    check('at least 1 NPC seeker (stalker always)', npcSeekers.length >= 1);
    check('0-1 human seekers (50% roll)', humanSeekers.length <= 1);
    const npcNames = roster.filter(r => r.id.startsWith('npc_')).map(r => r.name);
    check('NPCs use realistic names', npcNames.every(n => !n.startsWith('BOT-')));

    // which human is hiding? (needed for role-aware checks below)
    const roleOf = (start) => start.roster.find(r => r.id === start.yourId).role;
    const hiderSock = roleOf(startA) === 'hider' ? a : b;
    const hiderStart = roleOf(startA) === 'hider' ? startA : startB;
    const otherSock = hiderSock === a ? b : a;
    const otherStart = hiderSock === a ? startB : startA;
    check('at least one human hides', roleOf(hiderStart) === 'hider');

    // ---- movement sync (hider can move during grace)
    const meH = hiderStart.roster.find(r => r.id === hiderStart.yourId);
    hiderSock.emit('inputUpdate', { dx: 1, dy: 0 });
    let sawMove = false;
    const watch = (d) => {
      const row = d.players.find(p => p[0] === hiderStart.yourId);
      if (row && row[1] > meH.x + 30) sawMove = true;
    };
    // if the observer is a blind grace seeker they can't see the hider — that
    // IS the anti-cheat; observe from the hider's own echo instead
    const observer = roleOf(otherStart) === 'hider' ? otherSock : hiderSock;
    observer.on('worldUpdate', watch);
    await wait(900);
    observer.off('worldUpdate', watch);
    hiderSock.emit('inputUpdate', { dx: 0, dy: 0 });
    check('movement syncs via worldUpdate', sawMove);

    // ---- grace anti-cheat, from whichever side applies
    const wuH = await once(hiderSock, 'worldUpdate');
    const idsH = new Set(wuH.players.map(p => p[0]));
    const npcHiderIds = npcHiders.map(r => r.id);
    check('hider client sees NPC hiders during grace', npcHiderIds.every(id => idsH.has(id)));
    if (roleOf(otherStart) === 'seeker') {
      const wuS = await once(otherSock, 'worldUpdate');
      const idsS = new Set(wuS.players.map(p => p[0]));
      check('seeker client sees NO hiders during grace', npcHiderIds.every(id => !idsS.has(id)));
    } else {
      check('seeker client sees NO hiders during grace', true, 'skipped - no human seeker this roll');
    }

    // ---- SEEK
    const pc = await once(a, 'phaseChange', 25000);
    check('phase changes to SEEK after grace', pc.phase === 'SEEK');

    // ---- chirp relay from the hider
    hiderSock.emit('chirp');
    const chirped = await once(otherSock, 'chirped');
    check('chirp broadcast with position', chirped.id === hiderStart.yourId &&
      typeof chirped.x === 'number');

    // ---- bogus shootHit (hider shooter + wrong position) rejected
    hiderSock.emit('shootHit', { targetId: otherStart.yourId, x: 0, y: 0 });
    let bogusLanded = false;
    const earlyInf = (d) => { if (d.id === otherStart.yourId) bogusLanded = true; };
    otherSock.on('playerInfected', earlyInf);
    await wait(500);
    otherSock.off('playerInfected', earlyInf);
    check('bogus shootHit does nothing', !bogusLanded);

    // ---- NPC seekers eventually infect the moving human hider
    hiderSock.emit('inputUpdate', { dx: 0.5, dy: 0.2 });
    const inf = await once(hiderSock, 'playerInfected', 60000).catch(() => null);
    check('NPC seekers infect a moving hider within 60s', !!inf,
      inf ? 'target=' + inf.id : '');

    // ---- disconnect resilience
    a.disconnect();
    await wait(300);
    let stillAlive = false;
    const alive = () => { stillAlive = true; };
    b.on('worldUpdate', alive);
    await wait(600);
    b.off('worldUpdate', alive);
    check('room survives a mid-round disconnect', stillAlive);

    b.disconnect();
  } catch (e) {
    check('unexpected error: ' + e.message, false);
    a.disconnect(); b.disconnect();
  }
  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
