/* Simple bot player for manual browser testing.
   Usage: node test-bot.js <ROOMCODE> [name] [serverUrl]
   Joins the room and wanders randomly during rounds. */
'use strict';
const { io } = require('socket.io-client');

const code = (process.argv[2] || '').toUpperCase();
const name = process.argv[3] || 'Bot';
const url = process.argv[4] || 'http://localhost:3000';
if (!code) { console.error('Usage: node test-bot.js <ROOMCODE> [name]'); process.exit(1); }

const socket = io(url);
let dir = { dx: 0, dy: 0 };

socket.on('connect', () => {
  console.log('[bot] connected as', socket.id);
  socket.emit('setUsername', name);
  socket.emit('joinRoom', code);
});
socket.on('joinError', d => { console.error('[bot] join error:', d.message); process.exit(1); });
socket.on('roomJoined', () => console.log('[bot] joined room', code));
socket.on('roundStart', d => {
  const me = d.roles.find(r => r.id === socket.id);
  console.log('[bot] round', d.round, 'role:', me && me.role, 'camo:', me && me.camo);
});
socket.on('roundEnd', d => console.log('[bot] round end:', d.reason));
socket.on('matchEnd', d => { console.log('[bot] match end:', JSON.stringify(d.finalScores)); });
socket.on('playerInfected', d => { if (d.targetId === socket.id) console.log('[bot] I got infected!'); });
socket.on('disconnect', () => { console.log('[bot] disconnected'); process.exit(0); });

// Wander: pick a random direction every 1.2s, sometimes stand still
setInterval(() => {
  const roll = Math.random();
  if (roll < 0.4) dir = { dx: 0, dy: 0 };
  else dir = { dx: [-1, 0, 1][Math.floor(Math.random() * 3)], dy: [-1, 0, 1][Math.floor(Math.random() * 3)] };
}, 1200);
setInterval(() => socket.emit('inputUpdate', dir), 50);
