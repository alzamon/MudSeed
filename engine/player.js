'use strict';

/**
 * Player session management.
 * Each connected WebSocket client gets a Player object.
 */

let nextId = 1;
const players = new Map(); // id -> player

function createPlayer(ws) {
  const id = nextId++;
  const player = {
    id,
    name: `Wanderer${id}`,
    roomId: 'pantheon',
    ws,
  };
  players.set(id, player);
  return player;
}

function removePlayer(id) {
  players.delete(id);
}

function getPlayer(id) {
  return players.get(id) || null;
}

function allPlayers() {
  return [...players.values()];
}

/** Send a text message to a specific player */
function send(player, text) {
  if (player.ws && player.ws.readyState === 1 /* OPEN */) {
    player.ws.send(JSON.stringify({ type: 'message', text }));
  }
}

/** Broadcast a message to all connected players */
function broadcast(text) {
  for (const p of players.values()) {
    send(p, text);
  }
}

module.exports = { createPlayer, removePlayer, getPlayer, allPlayers, send, broadcast };
