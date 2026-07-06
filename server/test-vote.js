'use strict';
// Unit tests for the between-round next-map vote (pure logic, no sockets).
const { THEMES, pickVoteCandidates, voteCounts, tallyVote } = require('./server.js');

const results = [];
const check = (name, ok, extra) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

// ---- candidate selection: 3 maps, never the current or previous ----
for (let i = 0; i < 200; i++) {
  const room = { theme: 'JUNGLE', prevTheme: 'HOUSE' };
  const c = pickVoteCandidates(room);
  if (c.length !== 3) { check('candidates always == 3', false, `got ${c.length}`); break; }
  if (c.includes('JUNGLE') || c.includes('HOUSE')) { check('excludes current+previous', false, c.join(',')); break; }
  if (new Set(c).size !== 3) { check('candidates distinct', false, c.join(',')); break; }
  if (!c.every(t => THEMES.includes(t))) { check('candidates are real maps', false, c.join(',')); break; }
  if (i === 199) {
    check('candidates always == 3', true);
    check('excludes current+previous', true);
    check('candidates distinct', true);
    check('candidates are real maps', true);
  }
}

// ---- round 1 case: only a current theme, no previous ----
{
  const c = pickVoteCandidates({ theme: 'WAREHOUSE', prevTheme: null });
  check('round-1 excludes only current', c.length === 3 && !c.includes('WAREHOUSE'), c.join(','));
}

// ---- coverage: every non-excluded map can appear over many draws ----
{
  const seen = new Set();
  for (let i = 0; i < 400; i++) pickVoteCandidates({ theme: 'JUNGLE', prevTheme: 'HOUSE' }).forEach(t => seen.add(t));
  const expected = THEMES.filter(t => t !== 'JUNGLE' && t !== 'HOUSE');
  check('all eligible maps reachable', expected.every(t => seen.has(t)), `${seen.size}/${expected.length}`);
}

// ---- tally: clear majority wins ----
{
  const room = { voteCandidates: ['A', 'B', 'C'], votes: { p1: 'B', p2: 'B', p3: 'C' } };
  check('majority winner', tallyVote(room) === 'B');
  check('voteCounts correct', JSON.stringify(voteCounts(room)) === JSON.stringify({ A: 0, B: 2, C: 1 }));
}

// ---- tally: invalid/stale votes ignored ----
{
  const room = { voteCandidates: ['A', 'B', 'C'], votes: { p1: 'ZZZ', p2: 'A' } };
  check('invalid votes ignored', tallyVote(room) === 'A', JSON.stringify(voteCounts(room)));
}

// ---- tally: a tie resolves to one of the tied candidates ----
{
  const room = { voteCandidates: ['A', 'B', 'C'], votes: { p1: 'A', p2: 'B' } };
  const winners = new Set();
  for (let i = 0; i < 200; i++) winners.add(tallyVote(room));
  const only = [...winners].every(w => w === 'A' || w === 'B');
  check('tie resolves among tied', only && winners.size >= 1, [...winners].join(','));
}

// ---- tally: no votes -> still returns a valid candidate ----
{
  const room = { voteCandidates: ['A', 'B', 'C'], votes: {} };
  check('no votes -> a candidate', room.voteCandidates.includes(tallyVote(room)));
}

const fails = results.filter(r => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
