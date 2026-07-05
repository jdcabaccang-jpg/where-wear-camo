'use strict';
// Unit tests for the anti-shutout stalker-buff predicate. No server needed.
const { evaluateStalkerBuff } = require('./server.js');

const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const NOW = 1_000_000;

// Build a room whose SEEK elapsed time is exactly `elapsed` ms.
function mkRoom(o) {
  const seekMs = 100000;
  const players = new Map();
  for (let i = 0; i < o.aliveHumanHiders; i++) {
    players.set('h' + i, { human: true, role: 'hider', connected: true });
  }
  return {
    code: 'TEST', phase: o.phase || 'SEEK',
    humanHidersAtStart: o.humanHidersAtStart,
    humansFound: o.humansFound || 0,
    foundCount: o.foundCount || 0,
    stalkerBuff: o.stalkerBuff || false,
    settings: { seekMs },
    phaseEndsAt: NOW + (seekMs - o.elapsed),
    players,
  };
}

// >50% human hiders alive at 45s -> ON
check('45s, 2/2 human hiders alive -> buff ON',
  evaluateStalkerBuff(mkRoom({ elapsed: 46000, humanHidersAtStart: 2, aliveHumanHiders: 2, foundCount: 3 }), NOW) === true);

// 0 finds by 30s -> ON
check('30s, zero finds -> buff ON',
  evaluateStalkerBuff(mkRoom({ elapsed: 31000, humanHidersAtStart: 2, aliveHumanHiders: 2, foundCount: 0 }), NOW) === true);

// too early -> OFF
check('20s, zero finds -> buff OFF (too early)',
  evaluateStalkerBuff(mkRoom({ elapsed: 20000, humanHidersAtStart: 2, aliveHumanHiders: 2, foundCount: 0 }), NOW) === false);

// 45s but only 50% alive (not OVER half) -> OFF
check('45s, 1/2 alive (not >50%) -> buff OFF',
  evaluateStalkerBuff(mkRoom({ elapsed: 46000, humanHidersAtStart: 2, aliveHumanHiders: 1, foundCount: 3 }), NOW) === false);

// 30s with finds already, before 45s -> OFF
check('30s, some finds, pre-45s -> buff OFF',
  evaluateStalkerBuff(mkRoom({ elapsed: 31000, humanHidersAtStart: 2, aliveHumanHiders: 2, foundCount: 2 }), NOW) === false);

// a human has been converted -> forced OFF even if it was ON
check('human converted -> buff stands down',
  evaluateStalkerBuff(mkRoom({ elapsed: 60000, humanHidersAtStart: 2, aliveHumanHiders: 1, humansFound: 1, stalkerBuff: true }), NOW) === false);

// not SEEK -> never buffs
check('GRACE phase -> no buff',
  evaluateStalkerBuff(mkRoom({ phase: 'GRACE', elapsed: 46000, humanHidersAtStart: 2, aliveHumanHiders: 2 }), NOW) === false);

// all humans are seekers (no human hiders) -> never buffs
check('no human hiders -> no buff',
  evaluateStalkerBuff(mkRoom({ elapsed: 60000, humanHidersAtStart: 0, aliveHumanHiders: 0, foundCount: 0 }), NOW) === false);

// stays ON once triggered (until a human is found)
const sticky = mkRoom({ elapsed: 46000, humanHidersAtStart: 2, aliveHumanHiders: 2, foundCount: 3 });
evaluateStalkerBuff(sticky, NOW);
check('buff stays ON on subsequent ticks', evaluateStalkerBuff(sticky, NOW) === true);

const fails = results.filter(r => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
