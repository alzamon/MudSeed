'use strict';

/**
 * MudSeed — HTTP + WebSocket game server.
 *
 * Usage:
 *   node server.js [--port 3000]
 *
 * The server serves a browser client at http://localhost:<port>/
 * and accepts WebSocket connections from the terminal client (client.js)
 * or the browser.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const world = require('./engine/world');
const playerManager = require('./engine/player');
const godEngine = require('./engine/gods');

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || process.argv.find((a, i, arr) => arr[i - 1] === '--port') || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

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

wss.on('connection', ws => {
  const player = playerManager.createPlayer(ws);
  console.log(`[server] Player ${player.name} connected`);

  // Welcome
  sendRoom(player);
  playerManager.send(player, `\nWelcome, ${player.name}. You have arrived in ${world.getRoom(player.roomId).name}.`);
  playerManager.send(player, 'Type "help" for a list of commands.\n');

  ws.on('message', raw => {
    let input;
    try {
      const msg = JSON.parse(raw);
      input = (msg.text || '').trim();
    } catch {
      input = raw.toString().trim();
    }
    if (!input) return;
    handleCommand(player, input);
  });

  ws.on('close', () => {
    console.log(`[server] Player ${player.name} disconnected`);
    playerManager.removePlayer(player.id);
  });

  ws.on('error', err => console.error(`[server] WS error for ${player.name}:`, err.message));
});

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

    case 'gods':
      return cmdGods(player);

    case 'world':
      return cmdWorld(player);

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

  lines.push('');
  playerManager.send(player, lines.join('\n'));
}

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
  player.roomId = targetId;
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
  playerManager.broadcast(`${player.name} says: "${msg}"`);
}

function cmdGods(player) {
  const list = [...godEngine.gods.entries()].map(([name, g]) => `  ${name} — god of ${g.domain} (tick: ${g.tick_interval}s)`);
  playerManager.send(player, list.length ? `Active gods:\n${list.join('\n')}` : 'No gods are active.');
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
    'say <message>     — speak to everyone online',
    'who               — list connected players',
    'gods              — list active god agents',
    'world             — list all known rooms',
    'help / ?          — show this help',
    '',
  ].join('\n'));
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[server] MudSeed running at http://localhost:${PORT}`);
  console.log(`[server] Terminal client: node client.js [--host localhost] [--port ${PORT}]`);
  godEngine.startGods(broadcast);
});

server.on('error', err => {
  console.error('[server] Fatal error:', err.message);
  process.exit(1);
});
