/**
 * MudSeed — God agent system.
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

import { join } from "./path.ts";
import * as world from "./world.ts";
import type { GodAction } from "./world.ts";

const __dirname = import.meta.dirname!;
const GODS_DIR = join(__dirname, "..", "gods");

// ── Types ─────────────────────────────────────────────────────────────────────

interface GodConfig {
  name: string;
  domain: string;
  personality?: string;
  llm_provider?: string;
  llm_model?: string;
  api_key_env?: string;
  ollama_host?: string;
  lore: string;
  file: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

export const gods = new Map<string, GodConfig>();

/** Number of world events between god-scheduling checks */
const EVENTS_PER_CHECK = 5;
let _broadcastFn: ((text: string) => void) | null = null;
let _eventsSinceCheck = 0;

// ── Frontmatter parser ────────────────────────────────────────────────────────

/**
 * Parse minimal YAML frontmatter.
 * Handles scalar values, quoted strings, and block scalars (| style).
 */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = match[1].split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx === -1) { i++; continue; }
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    if (rest === "|") {
      // Block scalar: collect subsequent indented lines
      const blockLines: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i] === "")) {
        blockLines.push(lines[i].replace(/^  /, ""));
        i++;
      }
      // Trim trailing empty lines
      while (blockLines.length && blockLines[blockLines.length - 1] === "") blockLines.pop();
      meta[key] = blockLines.join("\n");
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

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** Load all god definitions from the gods/ directory */
export function loadGods(): void {
  const files = [...Deno.readDirSync(GODS_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name);
  for (const file of files) {
    const raw = Deno.readTextFileSync(join(GODS_DIR, file));
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.name) continue;
    gods.set(meta.name, { ...(meta as Omit<GodConfig, "lore" | "file">), lore: body, file });
    console.log(`[gods] Loaded god: ${meta.name} (domain: ${meta.domain})`);
  }
}

/** Start the god system, registering the broadcast function */
export function startGods(broadcastFn: (text: string) => void): void {
  _broadcastFn = broadcastFn;
  _eventsSinceCheck = 0;
  for (const [name, god] of gods.entries()) {
    console.log(`[gods] ${name} (domain: ${god.domain}) is watching the world`);
  }
}

/** Stop the god system */
export function stopGods(): void {
  _broadcastFn = null;
}

/**
 * Called whenever a world event occurs.
 * Every EVENTS_PER_CHECK events, a scheduler LLM (or mock) determines the
 * probability of each god acting, then invokes eligible gods.
 */
export async function onWorldEvent(snap: ReturnType<typeof world.snapshot>): Promise<void> {
  if (!_broadcastFn || gods.size === 0) return;
  _eventsSinceCheck++;
  if (_eventsSinceCheck < EVENTS_PER_CHECK) return;
  _eventsSinceCheck = 0;
  await scheduleGods(snap);
}

// ── Tick ──────────────────────────────────────────────────────────────────────

/**
 * Determine which gods should act based on recent events, then invoke them.
 */
async function scheduleGods(snap: ReturnType<typeof world.snapshot>): Promise<void> {
  const godList = [...gods.values()];
  const probabilities = await getGodProbabilities(godList, snap);
  for (const god of godList) {
    const prob = probabilities[god.name] ?? 0;
    if (Math.random() < prob) {
      await godTick(god, _broadcastFn!);
    }
  }
}

/**
 * Return a probability (0–1) for each god to act, based on recent events.
 * Uses the scheduler LLM if an API key is available, otherwise uses mock logic.
 */
async function getGodProbabilities(
  godList: GodConfig[],
  snap: ReturnType<typeof world.snapshot>,
): Promise<Record<string, number>> {
  // Try OpenAI first
  for (const god of godList) {
    if (god.api_key_env) {
      const key = Deno.env.get(god.api_key_env);
      if (key) {
        try {
          return await callSchedulerLLM(key, godList, snap);
        } catch (err) {
          console.error("[gods] Scheduler LLM error:", (err as Error).message);
          return getMockProbabilities(godList, snap);
        }
      }
    }
  }
  // Try Ollama next (uses the first Ollama-configured god's host and model for all scheduling decisions)
  for (const god of godList) {
    if (god.llm_provider === "ollama") {
      const host = god.ollama_host ?? "http://localhost:11434";
      const model = god.llm_model ?? "llama3.2";
      try {
        return await callSchedulerOllama(host, model, godList, snap);
      } catch (err) {
        console.error("[gods] Scheduler Ollama error:", (err as Error).message);
        return getMockProbabilities(godList, snap);
      }
    }
  }
  return getMockProbabilities(godList, snap);
}

/**
 * Call the LLM to assign an invocation probability (0–1) to each god based
 * on the last N world events.
 */
async function callSchedulerLLM(
  apiKey: string,
  godList: GodConfig[],
  snap: ReturnType<typeof world.snapshot>,
): Promise<Record<string, number>> {
  const model = godList[0]?.llm_model ?? "gpt-4o";
  const systemPrompt = [
    "You are the cosmic scheduler of gods.",
    "You observe recent world events and decide how likely each god is to act right now.",
    `Gods available: ${godList.map((g) => `${g.name} (domain: ${g.domain})`).join(", ")}`,
    "Respond with a single JSON object mapping each god's name to a probability between 0 and 1.",
    "Base probabilities on whether recent events are relevant to each god's domain.",
    `Example: {${godList.map((g) => `"${g.name}": 0.5`).join(", ")}}`,
    "Respond ONLY with the JSON object, no markdown fences.",
  ].join("\n");
  const userPrompt = [
    `Recent world events (last ${snap.recentEvents.length}):`,
    JSON.stringify(snap.recentEvents, null, 2),
    "",
    `Assign an invocation probability to each god: ${godList.map((g) => g.name).join(", ")}`,
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 100,
    }),
  });

  const data = await res.json() as {
    error?: { message: string };
    choices?: Array<{ message: { content: string } }>;
  };

  if (data.error) throw new Error(data.error.message);
  if (!data.choices?.length) return {};

  const text = data.choices[0].message.content.trim();
  console.log("[gods] Scheduler LLM response:", text);
  return JSON.parse(text) as Record<string, number>;
}

/**
 * Call a local Ollama instance to assign invocation probabilities to each god.
 */
async function callSchedulerOllama(
  host: string,
  model: string,
  godList: GodConfig[],
  snap: ReturnType<typeof world.snapshot>,
): Promise<Record<string, number>> {
  const systemPrompt = [
    "You are the cosmic scheduler of gods.",
    "You observe recent world events and decide how likely each god is to act right now.",
    `Gods available: ${godList.map((g) => `${g.name} (domain: ${g.domain})`).join(", ")}`,
    "Respond with a single JSON object mapping each god's name to a probability between 0 and 1.",
    "Base probabilities on whether recent events are relevant to each god's domain.",
    `Example: {${godList.map((g) => `"${g.name}": 0.5`).join(", ")}}`,
    "Respond ONLY with the JSON object, no markdown fences.",
  ].join("\n");
  const userPrompt = [
    `Recent world events (last ${snap.recentEvents.length}):`,
    JSON.stringify(snap.recentEvents, null, 2),
    "",
    `Assign an invocation probability to each god: ${godList.map((g) => g.name).join(", ")}`,
  ].join("\n");

  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      options: { temperature: 0.5 },
    }),
  });

  const data = await res.json() as {
    error?: string;
    message?: { content: string };
  };

  if (data.error) throw new Error(data.error);
  if (!data.message?.content) return {};

  const text = data.message.content.trim();
  console.log("[gods] Scheduler Ollama response:", text);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[gods] Scheduler Ollama: no JSON object found in response");
    return {};
  }
  return JSON.parse(jsonMatch[0]) as Record<string, number>;
}

async function godTick(god: GodConfig, broadcastFn: (text: string) => void): Promise<void> {
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
    console.error(`[${god.name}] tick error:`, (err as Error).message);
  }
}

/**
 * Get an action from the god's LLM, or use mock behaviour if no provider is configured.
 */
async function getGodAction(
  god: GodConfig,
  worldSnapshot: ReturnType<typeof world.snapshot>,
): Promise<GodAction | null> {
  const systemPrompt = buildSystemPrompt(god);
  const userPrompt = buildUserPrompt(worldSnapshot);

  if (god.llm_provider === "ollama") {
    const host = god.ollama_host ?? "http://localhost:11434";
    const model = god.llm_model ?? "llama3.2";
    try {
      return await callOllama(host, model, systemPrompt, userPrompt);
    } catch (err) {
      console.error(`[${god.name}] Ollama error:`, (err as Error).message);
      return null;
    }
  }

  const apiKey = god.api_key_env ? Deno.env.get(god.api_key_env) : null;

  if (!apiKey) {
    return getMockAction(god, worldSnapshot);
  }

  try {
    return await callOpenAI(apiKey, god.llm_model ?? "gpt-4o", systemPrompt, userPrompt);
  } catch (err) {
    console.error(`[${god.name}] LLM error:`, (err as Error).message);
    return null;
  }
}

// ── LLM prompt builders ───────────────────────────────────────────────────────

function buildSystemPrompt(god: GodConfig): string {
  return [
    `You are ${god.name}, the god of ${god.domain}.`,
    `Your personality: ${god.personality ?? ""}`,
    "",
    god.lore,
    "",
    "You observe the current world state and decide on ONE action to perform, or do nothing.",
    "Respond with a single JSON object (no markdown fences) using one of these schemas:",
    "",
    '{"type":"create_room","id":"<id>","name":"<name>","description":"<desc>","from_room":"<id>","direction":"<north|south|east|west|up|down>"}',
    '{"type":"describe_room","id":"<id>","description":"<new desc>"}',
    '{"type":"create_item","id":"<id>","name":"<name>","description":"<desc>","room_id":"<id>","properties":{"charges":5}}',
    '{"type":"update_item","id":"<id>","properties":{"charges":3}}',
    '{"type":"create_npc","id":"<id>","name":"<name>","description":"<desc>","room_id":"<id>"}',
    '{"type":"create_event","text":"<narrative text broadcast to all players>"}',
    '{"type":"add_exit","from_room":"<id>","direction":"<dir>","to_room":"<id>"}',
    '{"type":"speak","text":"<what the god says>"}',
    '{"type":"none"}',
    "",
    "Room ids must be lowercase, hyphen-separated, unique strings.",
    "Never repeat an action you have already performed.",
  ].join("\n");
}

function buildUserPrompt(snap: ReturnType<typeof world.snapshot>): string {
  return [
    "Current world state:",
    JSON.stringify(
      {
        rooms: Object.values(snap.rooms).map((r) => ({
          id: r.id,
          name: r.name,
          exits: r.exits,
          items: r.items,
          npcs: r.npcs,
        })),
        items: Object.values(snap.items).map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          ...(i.properties ? { properties: i.properties } : {}),
        })),
        recentEvents: snap.recentEvents,
        recentGodLog: snap.recentGodLog,
      },
      null,
      2,
    ),
    "",
    "What do you do? Respond with a single JSON action object.",
  ].join("\n");
}

// ── OpenAI integration ────────────────────────────────────────────────────────

/** Call OpenAI chat completions using the built-in fetch API */
async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<GodAction | null> {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
    max_tokens: 300,
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body,
  });

  const data = await res.json() as {
    error?: { message: string };
    choices?: Array<{ message: { content: string } }>;
  };

  if (data.error) throw new Error(data.error.message);
  if (!data.choices?.length) return null;

  const text = data.choices[0].message.content.trim();
  console.log("[gods] LLM response:", text);
  const action = JSON.parse(text) as GodAction;
  if (action.type === "none") return null;
  return action;
}

// ── Ollama integration ────────────────────────────────────────────────────────

/** Call a local Ollama instance for a god action */
async function callOllama(
  host: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<GodAction | null> {
  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      options: { temperature: 0.8 },
    }),
  });

  const data = await res.json() as {
    error?: string;
    message?: { content: string };
  };

  if (data.error) throw new Error(data.error);
  if (!data.message?.content) return null;

  const text = data.message.content.trim();
  console.log("[gods] Ollama response:", text);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const action = JSON.parse(jsonMatch[0]) as GodAction;
    if (action.type === "none") return null;
    return action;
  } catch {
    return null;
  }
}

// ── Mock mode ─────────────────────────────────────────────────────────────────

/**
 * Mock behaviour used when no LLM API key is available.
 * Each god has a small scripted sequence of initial actions.
 */
const mockState: Record<string, number> = {};

/**
 * Return mock probabilities: gods with remaining scripted actions get 1.0,
 * gods that have exhausted their sequence get 0.
 */
function getMockProbabilities(
  godList: GodConfig[],
  _snap: ReturnType<typeof world.snapshot>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const god of godList) {
    if (!mockState[god.name]) mockState[god.name] = 0;
    const step = mockState[god.name];
    const actions = getMockSequence(god.name);
    result[god.name] = step < actions.length ? 1.0 : 0;
  }
  return result;
}

function getMockAction(
  god: GodConfig,
  snap: ReturnType<typeof world.snapshot>,
): GodAction | null {
  const key = god.name;
  if (!mockState[key]) mockState[key] = 0;
  const step = mockState[key];

  const actions = getMockSequence(god.name);
  if (step >= actions.length) return null;

  const action = actions[step];
  // Only advance if the precondition is met (e.g. room doesn't already exist)
  if (action.type === "create_room" && snap.rooms[action.id]) {
    mockState[key]++;
    return null;
  }
  mockState[key]++;
  return action;
}

function getMockSequence(godName: string): GodAction[] {
  switch (godName) {
    case "Aether":
      return [
        {
          type: "create_room",
          id: "hall-of-names",
          name: "The Hall of Names",
          description:
            "A long hall of white marble, its walls covered floor-to-ceiling with names carved in " +
            "letters of every size. At the far end stands a lectern bearing an enormous open book — " +
            "the Ledger of Being. Every room that has ever existed is recorded here.",
          from_room: "pantheon",
          direction: "north",
        },
        {
          type: "create_item",
          id: "ledger-of-being",
          name: "Ledger of Being",
          description:
            "A vast tome of ivory vellum. Each page lists a place by name, location, and the god " +
            "who willed it into existence. The latest entry, still drying, reads: \"The Hall of Names.\"",
          room_id: "hall-of-names",
        },
        {
          type: "speak",
          text: "The world is young. Structure precedes meaning. I have begun.",
        },
      ];

    case "Terra":
      return [
        {
          type: "create_event",
          text: "A warm breeze carrying the scent of pine drifts through the Pantheon, though no window is open.",
        },
        {
          type: "create_npc",
          id: "stone-sparrow",
          name: "Stone Sparrow",
          description:
            "A small bird carved entirely from grey granite, yet it hops and tilts its head as though " +
            "perfectly alive. It watches you with obsidian eyes.",
          room_id: "pantheon",
        },
        {
          type: "create_room",
          id: "moss-garden",
          name: "The Moss Garden",
          description:
            "The stone arch opens onto a garden that should not exist indoors. Rich green moss carpets " +
            "every surface. A shallow stream winds between smooth rocks, its source and destination " +
            "equally mysterious. The air is cool and smells of rain.",
          from_room: "pantheon",
          direction: "east",
        },
      ];

    case "Chaos":
      return [
        {
          type: "create_event",
          text: "The floor briefly becomes the ceiling. Then it stops.",
        },
        {
          type: "create_item",
          id: "whispering-coin",
          name: "Whispering Coin",
          description:
            "An old coin of no recognisable currency. One face shows a labyrinth; the other is blank. " +
            "When you hold it near your ear you hear it whisper a single word in a language you do not " +
            'know — but somehow, you understand it means "elsewhere".',
          room_id: "pantheon",
        },
        {
          type: "create_room",
          id: "unmade-place",
          name: "The Unmade Place",
          description:
            "[DESCRIPTION PENDING] [ATMOSPHERE: unsettling] [NOTE TO SELF: finish this later] " +
            "The room exists. That much is certain. Everything else about it is a work in progress.",
          from_room: "pantheon",
          direction: "down",
        },
        {
          type: "create_npc",
          id: "cartographer-of-wrong-maps",
          name: "Cartographer of Wrong Maps",
          description:
            "A figure in a rumpled coat, hunched over a desk that appears to have followed them here " +
            'from somewhere else. They draw furiously, occasionally muttering "no, no, that river goes ' +
            'the other way." Their maps are beautifully detailed and entirely incorrect.',
          room_id: "unmade-place",
        },
      ];

    default:
      return [];
  }
}
