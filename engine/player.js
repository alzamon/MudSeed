'use strict';

/**
 * Player session management.
 * Each connected WebSocket client gets a Player object.
 */

let nextId = 1;
const players = new Map(); // id -> player

// Persistent character store: lowercase name -> { name, roomId }
const characters = new Map();

/** Find a character by name (case-insensitive). Returns character data or null. */
function findCharacter(name) {
  return characters.get(name.toLowerCase()) || null;
}

/** Create and store a new character with default starting values. */
function createCharacter(name) {
  const char = { name, roomId: 'pantheon' };
  characters.set(name.toLowerCase(), char);
  return char;
}

/** Persist a player's current state back to the character store. */
function saveCharacterState(player) {
  const char = characters.get(player.name.toLowerCase());
  if (char) {
    char.roomId = player.roomId;
  }
}

function createPlayer(ws, name, roomId) {
  const id = nextId++;
  const player = {
    id,
    name: name || `Wanderer${id}`,
    roomId: roomId || 'pantheon',
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

module.exports = { createPlayer, removePlayer, getPlayer, allPlayers, send, broadcast, findCharacter, createCharacter, saveCharacterState };
