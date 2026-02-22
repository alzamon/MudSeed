'use strict';

/**
 * God agent system.
 *
 * Each god is loaded from a Markdown file in the gods/ directory.
 * The frontmatter (YAML between ---) defines configuration.
 * The body is injected into the LLM system prompt as the god's lore/personality.
 *
 * Gods are invoked in response to world events rather than on a fixed timer.
 * Every EVENTS_PER_CHECK world events a scheduler LLM reviews the last N events
 * and returns a probability (0–1) for each god. Each god is then invoked with
 * that probability.
 *
 * LLM integration is opt-in: set the god's api_key_env environment variable.
 * Without a key, gods run in MOCK mode and demonstrate actions automatically.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const world = require('./world');
const playerManager = require('./player');

const GODS_DIR = path.join(__dirname, '..', 'gods');

const gods = new Map(); // name -> god config

/** Number of world events between god-scheduling checks */
const EVENTS_PER_CHECK = 5;
let _broadcastFn = null;
let _eventsSinceCheck = 0;

/**
 * Parse minimal YAML frontmatter.
 * Handles scalar values, quoted strings, and block scalars (| style).
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  const lines = match[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx === -1) { i++; continue; }
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    if (rest === '|') {
      // Block scalar: collect subsequent indented lines
      const blockLines = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        blockLines.push(lines[i].replace(/^  /, ''));
        i++;
      }
      // Trim trailing empty lines
      while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
      meta[key] = blockLines.join('\n');
    } else {
      let val = rest;
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
      i++;
    }
  }
  const body = text.slice(match[0].length).trim();
  return { meta, body };
}

/** Load all god definitions from the gods/ directory */
function loadGods() {
  const files = fs.readdirSync(GODS_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
  for (const file of files) {
    const raw = fs.readFileSync(path.join(GODS_DIR, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.name) continue;
    gods.set(meta.name, { ...meta, lore: body, file });
    console.log(`[gods] Loaded god: ${meta.name} (domain: ${meta.domain})`);
  }
}

/** Start the god system, registering the broadcast function */
function startGods(broadcastFn) {
  _broadcastFn = broadcastFn;
  _eventsSinceCheck = 0;
  for (const [name, god] of gods.entries()) {
    console.log(`[gods] ${name} (domain: ${god.domain}) is watching the world`);
  }
}

/** Stop the god system */
function stopGods() {
  _broadcastFn = null;
}

/**
 * Called whenever a world event occurs.
 * Every EVENTS_PER_CHECK events, a scheduler LLM (or mock) determines the
 * probability of each god acting, then invokes eligible gods.
 */
async function onWorldEvent(snap) {
  if (!_broadcastFn || gods.size === 0) return;
  _eventsSinceCheck++;
  if (_eventsSinceCheck < EVENTS_PER_CHECK) return;
  _eventsSinceCheck = 0;
  await scheduleGods(snap);
}

/** One god tick: build context, call LLM (or mock), apply action */
async function godTick(god, broadcastFn) {
  try {
    const snap = world.snapshot();
    const action = await getGodAction(god, snap);
    if (!action) return;

    const result = world.applyAction(action, god.name);
    console.log(`[${god.name}] ${result.message}`);
    if (result.broadcast && broadcastFn) {
      broadcastFn(result.broadcast);
    }
  } catch (err) {
    console.error(`[${god.name}] tick error:`, err.message);
  }
}

/**
 * Determine which gods should act based on recent events, then invoke them.
 */
async function scheduleGods(snap) {
  const godList = [...gods.values()];
  const probabilities = await getGodProbabilities(godList, snap);
  for (const god of godList) {
    const prob = probabilities[god.name] ?? 0;
    if (Math.random() < prob) {
      await godTick(god, _broadcastFn);
    }
  }
}

/**
 * Return a probability (0–1) for each god to act, based on recent events.
 * Uses the scheduler LLM if an API key is available, otherwise uses mock logic.
 */
async function getGodProbabilities(godList, snap) {
  let apiKey = null;
  for (const god of godList) {
    if (god.api_key_env) {
      const key = process.env[god.api_key_env];
      if (key) { apiKey = key; break; }
    }
  }
  if (!apiKey) {
    return getMockProbabilities(godList, snap);
  }
  try {
    return await callSchedulerLLM(apiKey, godList, snap);
  } catch (err) {
    console.error('[gods] Scheduler LLM error:', err.message);
    return getMockProbabilities(godList, snap);
  }
}

/**
 * Call the LLM to assign an invocation probability (0–1) to each god based
 * on the last N world events.
 */
function callSchedulerLLM(apiKey, godList, snap) {
  return new Promise((resolve, reject) => {
    const model = godList[0]?.llm_model || 'gpt-4o';
    const systemPrompt = [
      'You are the cosmic scheduler of gods.',
      'You observe recent world events and decide how likely each god is to act right now.',
      `Gods available: ${godList.map(g => `${g.name} (domain: ${g.domain})`).join(', ')}`,
      'Respond with a single JSON object mapping each god\'s name to a probability between 0 and 1.',
      'Base probabilities on whether recent events are relevant to each god\'s domain.',
      `Example: {${godList.map(g => `"${g.name}": 0.5`).join(', ')}}`,
      'Respond ONLY with the JSON object, no markdown fences.',
    ].join('\n');
    const userPrompt = [
      `Recent world events (last ${snap.recentEvents.length}):`,
      JSON.stringify(snap.recentEvents, null, 2),
      '',
      `Assign an invocation probability to each god: ${godList.map(g => g.name).join(', ')}`,
    ].join('\n');

    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 100,
    });

    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            const text = parsed.choices[0].message.content.trim();
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Get an action from the god's LLM, or use mock behaviour if no API key is set.
 */
async function getGodAction(god, worldSnapshot) {
  const apiKey = god.api_key_env ? process.env[god.api_key_env] : null;

  if (!apiKey) {
    return getMockAction(god, worldSnapshot);
  }

  const systemPrompt = buildSystemPrompt(god);
  const userPrompt = buildUserPrompt(worldSnapshot);

  try {
    return await callOpenAI(apiKey, god.llm_model || 'gpt-4o', systemPrompt, userPrompt);
  } catch (err) {
    console.error(`[${god.name}] LLM error:`, err.message);
    return null;
  }
}

function buildSystemPrompt(god) {
  return [
    `You are ${god.name}, the god of ${god.domain}.`,
    `Your personality: ${god.personality || ''}`,
    '',
    god.lore,
    '',
    'You observe the current world state and decide on ONE action to perform, or do nothing.',
    'Respond with a single JSON object (no markdown fences) using one of these schemas:',
    '',
    '{"type":"create_room","id":"<id>","name":"<name>","description":"<desc>","from_room":"<id>","direction":"<north|south|east|west|up|down>"}',
    '{"type":"describe_room","id":"<id>","description":"<new desc>"}',
    '{"type":"create_item","id":"<id>","name":"<name>","description":"<desc>","room_id":"<id>"}',
    '{"type":"create_npc","id":"<id>","name":"<name>","description":"<desc>","room_id":"<id>"}',
    '{"type":"create_event","text":"<narrative text broadcast to all players>"}',
    '{"type":"add_exit","from_room":"<id>","direction":"<dir>","to_room":"<id>"}',
    '{"type":"speak","text":"<what the god says>"}',
    '{"type":"none"}',
    '',
    'Room ids must be lowercase, hyphen-separated, unique strings.',
    'Never repeat an action you have already performed.',
  ].join('\n');
}

function buildUserPrompt(snap) {
  return [
    'Current world state:',
    JSON.stringify(
      {
        rooms: Object.values(snap.rooms).map(r => ({
          id: r.id,
          name: r.name,
          exits: r.exits,
          items: r.items,
          npcs: r.npcs,
        })),
        recentEvents: snap.recentEvents,
        recentGodLog: snap.recentGodLog,
      },
      null,
      2,
    ),
    '',
    'What do you do? Respond with a single JSON action object.',
  ].join('\n');
}

/** Call OpenAI chat completions */
function callOpenAI(apiKey, model, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 300,
    });

    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            const text = parsed.choices[0].message.content.trim();
            const action = JSON.parse(text);
            if (action.type === 'none') return resolve(null);
            resolve(action);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Mock behaviour used when no LLM API key is available.
 * Each god has a small scripted sequence of initial actions.
 */
const mockState = {};

/**
 * Return mock probabilities: gods with remaining scripted actions get 1.0,
 * gods that have exhausted their sequence get 0.
 */
function getMockProbabilities(godList, _snap) {
  const result = {};
  for (const god of godList) {
    if (!mockState[god.name]) mockState[god.name] = 0;
    const step = mockState[god.name];
    const actions = getMockSequence(god.name);
    result[god.name] = step < actions.length ? 1.0 : 0;
  }
  return result;
}

function getMockAction(god, snap) {
  const key = god.name;
  if (!mockState[key]) mockState[key] = 0;
  const step = mockState[key];

  const actions = getMockSequence(god.name, snap);
  if (step >= actions.length) return null;

  const action = actions[step];
  // Only advance if the precondition is met (e.g. room doesn't already exist)
  if (action.type === 'create_room' && snap.rooms[action.id]) {
    mockState[key]++;
    return null;
  }
  mockState[key]++;
  return action;
}

function getMockSequence(godName, snap) {
  switch (godName) {
    case 'Aether':
      return [
        {
          type: 'create_room',
          id: 'hall-of-names',
          name: 'The Hall of Names',
          description:
            'A long hall of white marble, its walls covered floor-to-ceiling with names carved in ' +
            'letters of every size. At the far end stands a lectern bearing an enormous open book — ' +
            'the Ledger of Being. Every room that has ever existed is recorded here.',
          from_room: 'pantheon',
          direction: 'north',
        },
        {
          type: 'create_item',
          id: 'ledger-of-being',
          name: 'Ledger of Being',
          description:
            'A vast tome of ivory vellum. Each page lists a place by name, location, and the god ' +
            'who willed it into existence. The latest entry, still drying, reads: "The Hall of Names."',
          room_id: 'hall-of-names',
        },
        {
          type: 'speak',
          text: 'The world is young. Structure precedes meaning. I have begun.',
        },
      ];

    case 'Terra':
      return [
        {
          type: 'create_event',
          text: 'A warm breeze carrying the scent of pine drifts through the Pantheon, though no window is open.',
        },
        {
          type: 'create_npc',
          id: 'stone-sparrow',
          name: 'Stone Sparrow',
          description:
            'A small bird carved entirely from grey granite, yet it hops and tilts its head as though ' +
            'perfectly alive. It watches you with obsidian eyes.',
          room_id: 'pantheon',
        },
        {
          type: 'create_room',
          id: 'moss-garden',
          name: 'The Moss Garden',
          description:
            'The stone arch opens onto a garden that should not exist indoors. Rich green moss carpets ' +
            'every surface. A shallow stream winds between smooth rocks, its source and destination ' +
            'equally mysterious. The air is cool and smells of rain.',
          from_room: 'pantheon',
          direction: 'east',
        },
      ];

    case 'Chaos':
      return [
        {
          type: 'create_event',
          text: 'The floor briefly becomes the ceiling. Then it stops.',
        },
        {
          type: 'create_item',
          id: 'whispering-coin',
          name: 'Whispering Coin',
          description:
            'An old coin of no recognisable currency. One face shows a labyrinth; the other is blank. ' +
            'When you hold it near your ear you hear it whisper a single word in a language you do not ' +
            'know — but somehow, you understand it means "elsewhere".',
          room_id: 'pantheon',
        },
        {
          type: 'create_room',
          id: 'unmade-place',
          name: 'The Unmade Place',
          description:
            '[DESCRIPTION PENDING] [ATMOSPHERE: unsettling] [NOTE TO SELF: finish this later] ' +
            'The room exists. That much is certain. Everything else about it is a work in progress.',
          from_room: 'pantheon',
          direction: 'down',
        },
        {
          type: 'create_npc',
          id: 'cartographer-of-wrong-maps',
          name: 'Cartographer of Wrong Maps',
          description:
            'A figure in a rumpled coat, hunched over a desk that appears to have followed them here ' +
            'from somewhere else. They draw furiously, occasionally muttering "no, no, that river goes ' +
            'the other way." Their maps are beautifully detailed and entirely incorrect.',
          room_id: 'unmade-place',
        },
      ];

    default:
      return [];
  }
}

module.exports = { loadGods, startGods, stopGods, onWorldEvent, gods };
