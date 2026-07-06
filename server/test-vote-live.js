'use strict';
// End-to-end: two clients play a round, vote on the next map, and the voted
// map becomes round 2's theme. Run against a server on WC_URL (default :3000).
const { io } = require('socket.io-client');
const URL = process.env.WC_URL || 'http://localhost:3000';
const once = (s, ev, to = 120000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), to);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});
const connected = (s) => new Promise((res) => { if (s.connected) res(); else s.once('connect', res); });
const results = [];
const check = (name, ok, extra) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };

(async () => {
  const A = io(URL), B = io(URL);
  try {
    await connected(A); await connected(B);
    A.emit('setUsername', 'Host'); B.emit('setUsername', 'Guest');
    A.emit('createRoom');
    const joined = await once(A, 'roomJoined', 6000);
    const code = joined.code;
    B.emit('joinRoom', code);
    await once(B, 'roomJoined', 6000);
    A.emit('updateSettings', { graceMs: 15000, seekMs: 60000, rounds: 3 });
    await new Promise(r => setTimeout(r, 300));
    A.emit('startGame');

    const r1 = await once(A, 'roundStart', 8000);
    const theme1 = r1.theme;
    console.log('round 1 theme:', theme1);

    // arm the vote listener on both before the round ends
    const voteP = once(B, 'mapVote', 100000);
    await once(A, 'roundEnd', 100000);
    const vote = await voteP;
    check('mapVote offers 3 candidates', vote.candidates.length === 3, vote.candidates.join(','));
    check('candidates exclude current map', !vote.candidates.includes(theme1), vote.candidates.join(','));

    const target = vote.candidates[0];
    const updP = once(A, 'voteUpdate', 6000);
    A.emit('voteMap', { theme: target });
    B.emit('voteMap', { theme: target });
    const upd = await updP;
    // after both, target should reach 2 (a later voteUpdate may show it)
    let counts = upd.counts;
    for (let i = 0; i < 3 && (counts[target] || 0) < 2; i++) counts = (await once(A, 'voteUpdate', 4000)).counts;
    check('votes tallied (target has 2)', (counts[target] || 0) === 2, JSON.stringify(counts));

    const r2 = await once(A, 'roundStart', 20000);
    console.log('round 2 theme:', r2.theme);
    check('round 2 uses the voted map', r2.theme === target, `${r2.theme} vs voted ${target}`);
    check('round 2 differs from round 1', r2.theme !== theme1, `${theme1} -> ${r2.theme}`);
  } catch (e) {
    check('unexpected error: ' + e.message, false);
  }
  A.disconnect(); B.disconnect();
  const fails = results.filter(r => !r).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
