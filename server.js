'use strict';

/**
 * MudSeed — HTTP + WebSocket game server.
 *
 * Usage:
 *   node server.js [--port 3000] [--lan]
 *
 * The server serves a browser client at http://localhost:<port>/
 * and accepts WebSocket connections from the terminal client (client.js)
 * or the browser.
 *
 * Pass --lan to bind on all interfaces (0.0.0.0) so players on your local
 * network can connect.  Without --lan the server listens on 127.0.0.1 only.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const world = require('./engine/world');
const playerManager = require('./engine/player');
const godEngine = require('./engine/gods');

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || process.argv.find((a, i, arr) => arr[i - 1] === '--port') || '3000', 10);
const LAN = process.argv.includes('--lan');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Return the first non-internal IPv4 address, or undefined. */
function getLanIp() {
  for (const ifaceList of Object.values(os.networkInterfaces())) {
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return undefined;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

world.loadRooms();
godEngine.loadGods();

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Serve index.html for /
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Strip query strings
  filePath = filePath.split('?')[0];
  const fullPath = path.join(PUBLIC_DIR, filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

function broadcast(text) {
  playerManager.broadcast(text);
}

// Valid character names: 2–20 characters total (first must be a letter, followed by 1-19 letters/digits/_/-)
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;

/** Send a raw message to a WebSocket before a player object exists */
function sendRaw(ws, text) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify({ type: 'message', text }));
  }
}

wss.on('connection', ws => {
  // Each connection starts in a pending state until a character is chosen
  const session = { ws, state: 'awaiting_name', player: null, pendingName: null, loginAttempts: 0 };

  sendRaw(ws, '\nWelcome to MudSeed!\nEnter your character name (2-20 characters, starting with a letter): ');

  ws.on('message', raw => {
    let input;
    try {
      const msg = JSON.parse(raw);
      input = (msg.text || '').trim();
    } catch {
      input = raw.toString().trim();
    }
    if (!input) return;

    if (session.state === 'awaiting_name') {
      return handleNameInput(session, input);
    }

    if (session.state === 'awaiting_new_password' || session.state === 'awaiting_new_password_confirm' || session.state === 'awaiting_login_password') {
      handlePasswordInput(session, input).catch(err => {
        console.error('[server] Password handling error:', err.message);
        ws.close();
      });
      return;
    }

    handleCommand(session.player, input);
  });

  ws.on('close', () => {
    if (session.player) {
      console.log(`[server] Player ${session.player.name} disconnected`);
      world.addPlayerEvent('disconnect', session.player.name, { roomId: session.player.roomId });
      godEngine.onWorldEvent(world.snapshot()).catch(err => console.error('[gods] onWorldEvent error:', err.message));
      playerManager.broadcastToRoom(session.player.roomId, `${session.player.name} has left the world.`, session.player.id);
      playerManager.saveCharacterState(session.player);
      playerManager.removePlayer(session.player.id);
    }
  });

  ws.on('error', err => {
    const label = session.player ? session.player.name : '(unauthenticated)';
    console.error(`[server] WS error for ${label}:`, err.message);
  });
});

/** Handle the character name input during the login/create flow */
function handleNameInput(session, name) {
  if (!NAME_PATTERN.test(name)) {
    sendRaw(session.ws, 'Invalid name. Names must be 2-20 characters total, starting with a letter, followed by letters, digits, _ or -. Try again: ');
    return;
  }

  const existing = playerManager.findCharacter(name);
  if (existing || playerManager.hasPassword(name)) {
    session.pendingName = existing ? existing.name : name;
    session.state = 'awaiting_login_password';
    sendRaw(session.ws, 'Password: ');
  } else {
    session.pendingName = name;
    session.state = 'awaiting_new_password';
    sendRaw(session.ws, 'Choose a password (min 8 characters): ');
  }
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_LOGIN_ATTEMPTS = 3;

/** Handle the password input for both new-character creation and login. */
async function handlePasswordInput(session, password) {
  if (session.state === 'awaiting_new_password') {
    if (password.length < MIN_PASSWORD_LENGTH) {
      sendRaw(session.ws, `Password too short (min ${MIN_PASSWORD_LENGTH} characters). Try again: `);
      return;
    }
    session.pendingPassword = password;
    session.state = 'awaiting_new_password_confirm';
    sendRaw(session.ws, 'Confirm password: ');
    return;
  }

  if (session.state === 'awaiting_new_password_confirm') {
    if (password !== session.pendingPassword) {
      session.pendingPassword = null;
      session.state = 'awaiting_new_password';
      sendRaw(session.ws, `Passwords do not match. Choose a password (min ${MIN_PASSWORD_LENGTH} characters): `);
      return;
    }
    const char = playerManager.createCharacter(session.pendingName);
    await playerManager.setPassword(session.pendingName, session.pendingPassword);
    session.pendingPassword = null;
    const player = playerManager.createPlayer(session.ws, char.name, char.roomId);
    session.player = player;
    session.state = 'in_game';
    console.log(`[server] Player ${player.name} created`);
    world.addPlayerEvent('connect', player.name, { roomId: player.roomId });
    godEngine.onWorldEvent(world.snapshot()).catch(err => console.error('[gods] onWorldEvent error:', err.message));
    playerManager.broadcastToRoom(player.roomId, `${player.name} has entered the world.`, player.id);
    playerManager.send(player, `\nWelcome, ${player.name}! Your character has been created.`);
  } else {
    // awaiting_login_password
    const ok = await playerManager.verifyPassword(session.pendingName, password);
    if (!ok) {
      session.loginAttempts++;
      if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        sendRaw(session.ws, 'Too many failed attempts. Disconnecting.');
        session.ws.close();
        return;
      }
      sendRaw(session.ws, 'Incorrect password. Try again: ');
      return;
    }
    const character = playerManager.findCharacter(session.pendingName) || playerManager.createCharacter(session.pendingName);
    const player = playerManager.createPlayer(session.ws, character.name, character.roomId);
    session.player = player;
    session.state = 'in_game';
    console.log(`[server] Player ${player.name} logged in`);
    world.addPlayerEvent('connect', player.name, { roomId: player.roomId });
    godEngine.onWorldEvent(world.snapshot()).catch(err => console.error('[gods] onWorldEvent error:', err.message));
    playerManager.broadcastToRoom(player.roomId, `${player.name} has entered the world.`, player.id);
    playerManager.send(player, `\nWelcome back, ${player.name}!`);
  }

  sendRoom(session.player);
  playerManager.send(session.player, 'Type "help" for a list of commands.\n');
}

// ── Command handler ───────────────────────────────────────────────────────────

const DIRECTIONS = ['north', 'south', 'east', 'west', 'up', 'down', 'n', 's', 'e', 'w', 'u', 'd'];
const DIR_ALIAS = { n: 'north', s: 'south', e: 'east', w: 'west', u: 'up', d: 'down' };

function handleCommand(player, raw) {
  const parts = raw.toLowerCase().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (DIRECTIONS.includes(cmd)) {
    return cmdMove(player, DIR_ALIAS[cmd] || cmd);
  }

  switch (cmd) {
    case 'look':
    case 'l':
      return sendRoom(player);

    case 'go':
      return cmdMove(player, args[0]);

    case 'examine':
    case 'x':
    case 'ex': {
      const target = args.join(' ');
      return cmdExamine(player, target);
    }

    case 'inventory':
    case 'inv':
    case 'i':
      return playerManager.send(player, 'You carry nothing. The gods have not yet blessed you with possessions.');

    case 'who':
      return cmdWho(player);

    case 'say': {
      const msg = raw.slice(4).trim();
      return cmdSay(player, msg);
    }

    case 'shout': {
      const msg = raw.slice(6).trim();
      return cmdShout(player, msg);
    }

    case 'gods':
      return cmdGods(player);

    case 'world':
      return cmdWorld(player);

    case 'ledger':
      return cmdLedger(player);

    case 'help':
    case '?':
      return cmdHelp(player);

    default:
      playerManager.send(player, `Unknown command: "${cmd}". Type "help" for a list of commands.`);
  }
}

function sendRoom(player) {
  const room = world.getRoom(player.roomId);
  if (!room) {
    playerManager.send(player, '[ERROR] You are nowhere. This should not happen.');
    return;
  }
  const lines = [`\n=== ${room.name} ===`, room.description, ''];

  // Exits
  const exits = Object.keys(room.exits);
  lines.push(exits.length ? `Exits: ${exits.join(', ')}` : 'Exits: none');

  // Items
  if (room.items && room.items.length) {
    const names = room.items.map(id => {
      const item = world.state.items[id];
      return item ? item.name : id;
    });
    lines.push(`Items: ${names.join(', ')}`);
  }

  // NPCs
  if (room.npcs && room.npcs.length) {
    const names = room.npcs.map(id => {
      const npc = world.state.npcs[id];
      return npc ? npc.name : id;
    });
    lines.push(`NPCs: ${names.join(', ')}`);
  }

  // Other players
  const others = playerManager.playersInRoom(player.roomId).filter(p => p.id !== player.id);
  if (others.length) {
    lines.push(`Players here: ${others.map(p => p.name).join(', ')}`);
  }

  lines.push('');
  playerManager.send(player, lines.join('\n'));
}

// Maps movement direction to the label used in arrival announcements
const ARRIVAL_FROM = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'below', down: 'above' };

function cmdMove(player, direction) {
  if (!direction) {
    playerManager.send(player, 'Go where? Specify a direction.');
    return;
  }
  const room = world.getRoom(player.roomId);
  const targetId = room && room.exits[direction];
  if (!targetId) {
    playerManager.send(player, `You cannot go ${direction} from here.`);
    return;
  }
  const target = world.getRoom(targetId);
  if (!target) {
    playerManager.send(player, `That passage leads nowhere. The gods must have forgotten to finish it.`);
    return;
  }
  const fromId = player.roomId;
  playerManager.broadcastToRoom(fromId, `${player.name} leaves ${direction}.`, player.id);
  player.roomId = targetId;
  const fromLabel = ARRIVAL_FROM[direction] || 'somewhere';
  playerManager.broadcastToRoom(targetId, `${player.name} arrives from the ${fromLabel}.`, player.id);
  world.addPlayerEvent('move', player.name, { from: fromId, direction, to: targetId });
  godEngine.onWorldEvent(world.snapshot()).catch(err => console.error('[gods] onWorldEvent error:', err.message));
  sendRoom(player);
}

function cmdExamine(player, target) {
  if (!target) {
    playerManager.send(player, 'Examine what?');
    return;
  }
  const room = world.getRoom(player.roomId);

  // Check items in room
  for (const itemId of (room.items || [])) {
    const item = world.state.items[itemId];
    if (item && item.name.toLowerCase().includes(target)) {
      playerManager.send(player, `${item.name}: ${item.description}`);
      return;
    }
  }

  // Check NPCs in room
  for (const npcId of (room.npcs || [])) {
    const npc = world.state.npcs[npcId];
    if (npc && npc.name.toLowerCase().includes(target)) {
      playerManager.send(player, `${npc.name}: ${npc.description}`);
      return;
    }
  }

  playerManager.send(player, `You see no "${target}" here.`);
}

function cmdWho(player) {
  const all = playerManager.allPlayers();
  const names = all.map(p => p.name + (p.id === player.id ? ' (you)' : '')).join(', ');
  playerManager.send(player, `Players online: ${names || 'none'}`);
}

function cmdSay(player, msg) {
  if (!msg) {
    playerManager.send(player, 'Say what?');
    return;
  }
  const line = `${player.name} says: "${msg}"`;
  playerManager.broadcastToRoom(player.roomId, line, player.id);
  playerManager.send(player, `You say: "${msg}"`);
  world.addPlayerEvent('say', player.name, { roomId: player.roomId, msg });
  godEngine.onWorldEvent(world.snapshot()).catch(err => console.error('[gods] onWorldEvent error:', err.message));
}

function cmdShout(player, msg) {
  if (!msg) {
    playerManager.send(player, 'Shout what?');
    return;
  }
  playerManager.broadcast(`${player.name} shouts: "${msg}"`);
  world.addPlayerEvent('shout', player.name, { msg });
  godEngine.onWorldEvent(world.snapshot()).catch(err => console.error('[gods] onWorldEvent error:', err.message));
}

function cmdGods(player) {
  const list = [...godEngine.gods.entries()].map(([name, g]) => `  ${name} — god of ${g.domain}`);
  playerManager.send(player, list.length ? `Active gods:\n${list.join('\n')}` : 'No gods are active.');
}

function cmdLedger(player) {
  const entries = world.getLedger(20);
  if (!entries.length) {
    playerManager.send(player, 'The ledger is empty.');
    return;
  }
  const lines = ['', 'Recent Events (Ledger of Truth)', '────────────────────────────────'];
  for (const e of entries) {
    const time = new Date(e.at).toISOString().slice(0, 19).replace('T', ' ');
    const roomName = id => (world.getRoom(id) || {}).name || id;
    if (e.type === 'move') {
      lines.push(`[${time}] ${e.player} moved ${e.direction} (${roomName(e.from)} → ${roomName(e.to)})`);
    } else if (e.type === 'say') {
      lines.push(`[${time}] ${e.player} says (in ${roomName(e.roomId)}): "${e.msg}"`);
    } else if (e.type === 'shout') {
      lines.push(`[${time}] ${e.player} shouts: "${e.msg}"`);
    } else if (e.type === 'connect') {
      lines.push(`[${time}] ${e.player} entered the world in ${roomName(e.roomId)}`);
    } else if (e.type === 'disconnect') {
      lines.push(`[${time}] ${e.player} left the world from ${roomName(e.roomId)}`);
    } else {
      lines.push(`[${time}] [${e.type}] ${JSON.stringify(e)}`);
    }
  }
  lines.push('');
  playerManager.send(player, lines.join('\n'));
}

function cmdWorld(player) {
  const rooms = world.listRooms().map(id => {
    const r = world.getRoom(id);
    return `  ${r.name} (${id}) — exits: ${Object.keys(r.exits).join(', ') || 'none'}`;
  });
  playerManager.send(player, `Known rooms:\n${rooms.join('\n')}`);
}

function cmdHelp(player) {
  playerManager.send(player, [
    '',
    'MudSeed Commands',
    '────────────────',
    'look / l          — describe your current location',
    'north/south/...   — move in a direction (or n/s/e/w/u/d)',
    'go <direction>    — move in a direction',
    'examine <thing>   — examine an item or NPC',
    'say <message>     — speak to players in your room',
    'shout <message>   — shout to all players everywhere',
    'who               — list connected players',
    'ledger            — show recent event history',
    'gods              — list active god agents',
    'world             — list all known rooms',
    'help / ?          — show this help',
    '',
  ].join('\n'));
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`[server] MudSeed running at http://localhost:${PORT}`);
  if (LAN) {
    const lanIp = getLanIp();
    if (lanIp) console.log(`[server] LAN access:           http://${lanIp}:${PORT}`);
  }
  console.log(`[server] Terminal client: node client.js [--host localhost] [--port ${PORT}]`);
  godEngine.startGods(broadcast);
});

server.on('error', err => {
  console.error('[server] Fatal error:', err.message);
  process.exit(1);
});
