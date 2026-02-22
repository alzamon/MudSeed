/**
 * MudSeed — God agent system.
 *
 * Each god is loaded from a Markdown file in the gods/ directory.
 * The frontmatter (YAML between ---) defines configuration.
 * The body is injected into the LLM system prompt as the god's lore/personality.
 *
 * Gods act on a tick_interval. On each tick they receive a snapshot of the
 * world and return a JSON action (or null to do nothing).
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
  llm_model?: string;
  api_key_env?: string;
  tick_interval?: string;
  lore: string;
  file: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

export const gods = new Map<string, GodConfig>();
const timers = new Map<string, number>();

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

/** Start all god timers */
export function startGods(broadcastFn: (text: string) => void): void {
  for (const [name, god] of gods.entries()) {
    const interval = parseInt(god.tick_interval ?? "60", 10) || 60;
    console.log(`[gods] ${name} will act every ${interval}s`);
    const handle = setInterval(() => godTick(god, broadcastFn), interval * 1000);
    timers.set(name, handle);
  }
}

/** Stop all god timers */
export function stopGods(): void {
  for (const handle of timers.values()) clearInterval(handle);
  timers.clear();
}

// ── Tick ──────────────────────────────────────────────────────────────────────

/** One god tick: build context, call LLM (or mock), apply action */
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
 * Get an action from the god's LLM, or use mock behaviour if no API key is set.
 */
async function getGodAction(
  god: GodConfig,
  worldSnapshot: ReturnType<typeof world.snapshot>,
): Promise<GodAction | null> {
  const apiKey = god.api_key_env ? Deno.env.get(god.api_key_env) : null;

  if (!apiKey) {
    return getMockAction(god, worldSnapshot);
  }

  const systemPrompt = buildSystemPrompt(god);
  const userPrompt = buildUserPrompt(worldSnapshot);

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
    '{"type":"create_item","id":"<id>","name":"<name>","description":"<desc>","room_id":"<id>"}',
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
  const action = JSON.parse(text) as GodAction;
  if (action.type === "none") return null;
  return action;
}

// ── Mock mode ─────────────────────────────────────────────────────────────────

/**
 * Mock behaviour used when no LLM API key is available.
 * Each god has a small scripted sequence of initial actions.
 */
const mockState: Record<string, number> = {};

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
