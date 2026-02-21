'use strict';

/**
 * Player session management.
 * Each connected WebSocket client gets a Player object.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let nextId = 1;
const players = new Map(); // id -> player

// Persistent character store: lowercase name -> { name, roomId }
const characters = new Map();

// ── Password store ────────────────────────────────────────────────────────────

const PASSWORDS_FILE = path.join(__dirname, '..', 'data', 'passwords.json');

let passwordStore = {};

function loadPasswords() {
  try {
    const data = fs.readFileSync(PASSWORDS_FILE, 'utf8');
    passwordStore = JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[player] Failed to load passwords file:', err.message);
    }
    passwordStore = {};
  }
}

function savePasswords() {
  const dir = path.dirname(PASSWORDS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PASSWORDS_FILE, JSON.stringify(passwordStore, null, 2));
}

/** Set (or update) a character's password — stores a salted scrypt hash. */
function setPassword(name, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      passwordStore[name.toLowerCase()] = { salt, hash: derivedKey.toString('hex') };
      savePasswords();
      resolve();
    });
  });
}

/** Verify a character's password against the stored hash. Returns a Promise<boolean>. */
function verifyPassword(name, password) {
  const entry = passwordStore[name.toLowerCase()];
  if (!entry) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, entry.salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      const storedKey = Buffer.from(entry.hash, 'hex');
      resolve(crypto.timingSafeEqual(derivedKey, storedKey));
    });
  });
}

// Load persisted passwords on startup
loadPasswords();

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

module.exports = { createPlayer, removePlayer, getPlayer, allPlayers, send, broadcast, findCharacter, createCharacter, saveCharacterState, setPassword, verifyPassword };
