'use strict';

/**
 * MudSeed — Terminal client.
 *
 * Connects to the MudSeed WebSocket server and provides a readline interface
 * for playing the game directly from your terminal.
 *
 * Usage:
 *   node client.js [--host localhost] [--port 3000]
 */

const { WebSocket } = require('ws');
const readline = require('readline');

// ── Argument parsing ──────────────────────────────────────────────────────────

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const HOST = argValue('--host', 'localhost');
const PORT = argValue('--port', '3000');
const URL = `ws://${HOST}:${PORT}`;

// ── Readline interface ────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
});

// ── WebSocket connection ──────────────────────────────────────────────────────

console.log(`Connecting to MudSeed at ${URL} …\n`);

const ws = new WebSocket(URL);

ws.on('open', () => {
  rl.prompt();
});

ws.on('message', raw => {
  try {
    const msg = JSON.parse(raw);
    if (msg.type === 'message') {
      // Clear current input line, print message, restore prompt
      process.stdout.write('\r\x1b[K'); // move to start, clear line
      console.log(msg.text);
      rl.prompt(true);
    }
  } catch {
    console.log(raw.toString());
    rl.prompt(true);
  }
});

ws.on('close', () => {
  console.log('\nDisconnected from server.');
  rl.close();
  process.exit(0);
});

ws.on('error', err => {
  console.error(`\nConnection error: ${err.message}`);
  console.error(`Make sure the server is running: node server.js`);
  rl.close();
  process.exit(1);
});

// ── Input handling ────────────────────────────────────────────────────────────

rl.on('line', line => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }
  if (text === 'quit' || text === 'exit') {
    ws.close();
    return;
  }
  ws.send(JSON.stringify({ text }));
  rl.prompt();
});

rl.on('close', () => {
  ws.close();
  process.exit(0);
});
