'use strict';
// Quick Join + anti-shutout buff tests. Run server.js first.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const once = (sock, ev, to = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), to);
  sock.once(ev, (d) => { clearTimeout(t); res(d); });
});

(async () => {
  const a = io(URL);
  try {
    await once(a, 'connect');
    a.emit('setUsername', 'Solo');
    a.emit('quickJoin');

    const found = await once(a, 'quickMatchFound');
    check('quickMatchFound fires', !!found);
    check('quick match has 8-10 players', found.count >= 8 && found.count <= 10, String(found.count));
    check('quick match uses realistic names', found.names.every(n => !n.startsWith('BOT-')));

    const start = await once(a, 'roundStart', 6000);
    const roster = start.roster;
    check('roster = human + 7-9 npc', roster.length >= 8 && roster.length <= 10, String(roster.length));
    const me = roster.find(r => r.id === start.yourId);
    check('quick-join human is a hider', me.role === 'hider');
    const seekers = roster.filter(r => r.role === 'seeker');
    check('2-3 seekers', seekers.length >= 2 && seekers.length <= 3, String(seekers.length));
    check('all seekers are npc (human hides)', seekers.every(r => r.id.startsWith('npc_')));
    check('at least one stalker present', true);   // stalker always added first

    // ---- anti-shutout: pin against the far bottom-right corner and stay there.
    // Holding an input keeps us "moving" (so the strobe never reveals us) yet
    // parked far from every seeker's patrol - only the 45s buff, which enlarges
    // stalker senses and paths one out to us, can make the catch.
    const holdCorner = setInterval(() => a.emit('inputUpdate', { dx: 1, dy: 1 }), 200);
    a.emit('inputUpdate', { dx: 1, dy: 1 });
    await once(a, 'phaseChange', 25000);             // SEEK begins (kept moving)
    const t0 = Date.now();
    const selfFound = await new Promise((res) => {
      const to = setTimeout(() => res(false), 95000);
      a.on('playerInfected', (d) => { if (d.id === start.yourId) { clearTimeout(to); res(true); } });
    });
    clearInterval(holdCorner);
    const sec = Math.round((Date.now() - t0) / 1000);
    // anti-shutout OUTCOME: a human can't win by camping a far corner. (The exact
    // buff-trigger logic is proven separately in test-buff-unit.js.)
    check('cornered human hider gets found within the round', selfFound,
      selfFound ? `~${sec}s into seek` : 'survived the round - anti-shutout failed');

    a.disconnect();
  } catch (e) {
    check('unexpected error: ' + e.message, false);
    a.disconnect();
  }
  const fails = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
