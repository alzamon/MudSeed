'use strict';

const fs = require('fs');
const path = require('path');

const ROOMS_DIR = path.join(__dirname, '..', 'world', 'rooms');

/** In-memory world state */
const state = {
  rooms: {},       // id -> room object
  items: {},       // id -> item object
  npcs: {},        // id -> npc object
  events: [],      // recent broadcast events (capped at 100)
  godLog: [],      // recent god actions (capped at 100)
};

/** Load all rooms from disk into memory */
function loadRooms() {
  const files = fs.readdirSync(ROOMS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const room = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, file), 'utf8'));
    state.rooms[room.id] = room;
  }
}

/** Persist a single room to disk */
function saveRoom(room) {
  const file = path.join(ROOMS_DIR, `${room.id}.json`);
  fs.writeFileSync(file, JSON.stringify(room, null, 2));
}

/** Get a room by id */
function getRoom(id) {
  return state.rooms[id] || null;
}

/** List all room ids */
function listRooms() {
  return Object.keys(state.rooms);
}

/**
 * Apply a god action to the world.
 * Returns { ok, message, broadcast } where broadcast is an optional string
 * sent to all connected players.
 */
function applyAction(action, godName) {
  switch (action.type) {
    case 'create_room':
      return createRoom(action, godName);
    case 'describe_room':
      return describeRoom(action, godName);
    case 'create_item':
      return createItem(action, godName);
    case 'create_npc':
      return createNpc(action, godName);
    case 'create_event':
      return createEvent(action, godName);
    case 'add_exit':
      return addExit(action, godName);
    case 'speak':
      return godSpeak(action, godName);
    default:
      return { ok: false, message: `Unknown action type: ${action.type}` };
  }
}

function createRoom(action, godName) {
  const { id, name, description, from_room, direction } = action;
  if (!id || !name || !description) {
    return { ok: false, message: 'create_room requires id, name, description' };
  }
  if (state.rooms[id]) {
    return { ok: false, message: `Room '${id}' already exists` };
  }
  const room = {
    id,
    name,
    description,
    exits: {},
    items: [],
    npcs: [],
    created_by: godName,
    created_at: new Date().toISOString(),
  };
  if (from_room && direction) {
    const origin = state.rooms[from_room];
    if (origin) {
      origin.exits[direction] = id;
      const reverse = reverseDir(direction);
      if (reverse) room.exits[reverse] = from_room;
      saveRoom(origin);
    }
  }
  state.rooms[id] = room;
  saveRoom(room);
  logGodAction(godName, `Created room '${name}' (${id})`);
  return {
    ok: true,
    message: `Room '${name}' created`,
    broadcast: `[${godName}] shapes the void — a new place called "${name}" comes into being.`,
  };
}

function describeRoom(action, godName) {
  const { id, description } = action;
  const room = state.rooms[id];
  if (!room) return { ok: false, message: `Room '${id}' not found` };
  room.description = description;
  saveRoom(room);
  logGodAction(godName, `Rewrote description of '${id}'`);
  return {
    ok: true,
    message: `Room '${id}' description updated`,
    broadcast: `[${godName}] touches "${room.name}" — it feels subtly different now.`,
  };
}

function createItem(action, godName) {
  const { id, name, description, room_id } = action;
  if (!id || !name) return { ok: false, message: 'create_item requires id and name' };
  const item = { id, name, description: description || '', created_by: godName };
  state.items[id] = item;
  if (room_id && state.rooms[room_id]) {
    state.rooms[room_id].items.push(id);
    saveRoom(state.rooms[room_id]);
  }
  logGodAction(godName, `Created item '${name}' in room '${room_id}'`);
  return {
    ok: true,
    message: `Item '${name}' created`,
    broadcast: `[${godName}] places "${name}" into the world.`,
  };
}

function createNpc(action, godName) {
  const { id, name, description, room_id } = action;
  if (!id || !name) return { ok: false, message: 'create_npc requires id and name' };
  const npc = { id, name, description: description || '', created_by: godName };
  state.npcs[id] = npc;
  if (room_id && state.rooms[room_id]) {
    state.rooms[room_id].npcs.push(id);
    saveRoom(state.rooms[room_id]);
  }
  logGodAction(godName, `Spawned NPC '${name}' in room '${room_id}'`);
  return {
    ok: true,
    message: `NPC '${name}' spawned`,
    broadcast: `[${godName}] breathes life — "${name}" stirs into existence.`,
  };
}

function createEvent(action, godName) {
  const { text } = action;
  if (!text) return { ok: false, message: 'create_event requires text' };
  const event = { text, by: godName, at: new Date().toISOString() };
  state.events.push(event);
  if (state.events.length > 100) state.events.shift();
  logGodAction(godName, `Event: ${text}`);
  return { ok: true, message: 'Event created', broadcast: text };
}

function addExit(action, godName) {
  const { from_room, direction, to_room } = action;
  const from = state.rooms[from_room];
  const to = state.rooms[to_room];
  if (!from) return { ok: false, message: `Room '${from_room}' not found` };
  if (!to) return { ok: false, message: `Room '${to_room}' not found` };
  from.exits[direction] = to_room;
  saveRoom(from);
  logGodAction(godName, `Added exit ${direction} from '${from_room}' to '${to_room}'`);
  return {
    ok: true,
    message: `Exit added`,
    broadcast: `[${godName}] opens a passage — a new way ${direction} from "${from.name}".`,
  };
}

function godSpeak(action, godName) {
  const { text } = action;
  if (!text) return { ok: false, message: 'speak requires text' };
  logGodAction(godName, `Spoke: ${text}`);
  return {
    ok: true,
    message: 'God spoke',
    broadcast: `[${godName} speaks] "${text}"`,
  };
}

function logGodAction(godName, msg) {
  const entry = { god: godName, msg, at: new Date().toISOString() };
  state.godLog.push(entry);
  if (state.godLog.length > 100) state.godLog.shift();
}

/** Return the opposite cardinal direction */
function reverseDir(dir) {
  const map = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
  return map[dir] || null;
}

/** Serialise the full world state for debugging / god context */
function snapshot() {
  return {
    rooms: state.rooms,
    items: state.items,
    npcs: state.npcs,
    recentEvents: state.events.slice(-20),
    recentGodLog: state.godLog.slice(-20),
  };
}

module.exports = { loadRooms, getRoom, listRooms, applyAction, snapshot, state };
