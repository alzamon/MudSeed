/**
 * MudSeed — World state and action system.
 */

import { join, parseDataFile, toDataFile } from "./path.ts";

const __dirname = import.meta.dirname!;
const ROOMS_DIR = join(__dirname, "..", "world", "rooms");
const ITEMS_DIR = join(__dirname, "..", "world", "items");
const NPCS_DIR = join(__dirname, "..", "world", "npcs");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Room {
  id: string;
  name: string;
  description: string;
  exits: Record<string, string>;
  items: string[];
  npcs: string[];
  created_by?: string;
  created_at?: string;
}

export interface Item {
  id: string;
  name: string;
  description: string;
  properties?: Record<string, unknown>;
  created_by?: string;
}

export interface NPC {
  id: string;
  name: string;
  description: string;
  created_by?: string;
}

export interface WorldEvent {
  type: string;
  player?: string;
  at: string;
  [key: string]: unknown;
}

export interface GodLogEntry {
  god: string;
  msg: string;
  at: string;
}

export interface WorldState {
  rooms: Record<string, Room>;
  items: Record<string, Item>;
  npcs: Record<string, NPC>;
  events: WorldEvent[];
  godLog: GodLogEntry[];
}

export type GodAction =
  | { type: "create_room"; id: string; name: string; description: string; from_room?: string; direction?: string }
  | { type: "describe_room"; id: string; description: string }
  | { type: "create_item"; id: string; name: string; description?: string; room_id?: string; properties?: Record<string, unknown> }
  | { type: "update_item"; id: string; properties: Record<string, unknown> }
  | { type: "create_npc"; id: string; name: string; description?: string; room_id?: string }
  | { type: "create_event"; text: string }
  | { type: "add_exit"; from_room: string; direction: string; to_room: string }
  | { type: "speak"; text: string }
  | { type: "none" };

export interface ActionResult {
  ok: boolean;
  message: string;
  broadcast?: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** In-memory world state */
export const state: WorldState = {
  rooms: {},
  items: {},
  npcs: {},
  events: [],
  godLog: [],
};

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Ensure a directory exists, creating it recursively if needed */
function ensureDir(dir: string): void {
  try {
    Deno.statSync(dir);
  } catch {
    Deno.mkdirSync(dir, { recursive: true });
  }
}

// ── Room persistence ──────────────────────────────────────────────────────────

/** Load all rooms from TypeScript data files into memory */
export function loadRooms(): void {
  const files = [...Deno.readDirSync(ROOMS_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".ts"))
    .map((e) => e.name);
  for (const file of files) {
    const room = parseDataFile<Room>(Deno.readTextFileSync(join(ROOMS_DIR, file)));
    state.rooms[room.id] = room;
  }
}

/** Persist a single room as a TypeScript data file */
function saveRoom(room: Room): void {
  const file = join(ROOMS_DIR, `${room.id}.ts`);
  Deno.writeTextFileSync(file, toDataFile(room));
}

// ── Item persistence ──────────────────────────────────────────────────────────

/** Load all items from TypeScript data files into memory */
export function loadItems(): void {
  ensureDir(ITEMS_DIR);
  const files = [...Deno.readDirSync(ITEMS_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".ts"))
    .map((e) => e.name);
  for (const file of files) {
    const item = parseDataFile<Item>(Deno.readTextFileSync(join(ITEMS_DIR, file)));
    state.items[item.id] = item;
  }
}

/** Persist a single item as a TypeScript data file */
function saveItem(item: Item): void {
  ensureDir(ITEMS_DIR);
  const file = join(ITEMS_DIR, `${item.id}.ts`);
  Deno.writeTextFileSync(file, toDataFile(item));
}

// ── NPC persistence ───────────────────────────────────────────────────────────

/** Load all NPCs from TypeScript data files into memory */
export function loadNpcs(): void {
  ensureDir(NPCS_DIR);
  const files = [...Deno.readDirSync(NPCS_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".ts"))
    .map((e) => e.name);
  for (const file of files) {
    const npc = parseDataFile<NPC>(Deno.readTextFileSync(join(NPCS_DIR, file)));
    state.npcs[npc.id] = npc;
  }
}

/** Persist a single NPC as a TypeScript data file */
function saveNpc(npc: NPC): void {
  ensureDir(NPCS_DIR);
  const file = join(NPCS_DIR, `${npc.id}.ts`);
  Deno.writeTextFileSync(file, toDataFile(npc));
}

/** Get a room by id */
export function getRoom(id: string): Room | null {
  return state.rooms[id] ?? null;
}

/** List all room ids */
export function listRooms(): string[] {
  return Object.keys(state.rooms);
}

// ── Hot-reload watcher ────────────────────────────────────────────────────────

const _watchers: Deno.FsWatcher[] = [];

/**
 * Watch world data directories and hot-reload files when they change on disk.
 * This allows hand-editing rooms, items, and NPCs without restarting the server.
 * Changes take effect immediately while connected players continue playing.
 */
export function watchDataFiles(): void {
  async function watchDir(
    dir: string,
    reload: (text: string) => void,
  ): Promise<void> {
    // Debounce per path — editors often emit multiple events per save
    const timers = new Map<string, number>();
    const watcher = Deno.watchFs(dir);
    _watchers.push(watcher);
    for await (const event of watcher) {
      if (event.kind !== "modify" && event.kind !== "create") continue;
      for (const path of event.paths) {
        if (!path.endsWith(".ts")) continue;
        const existing = timers.get(path);
        if (existing) clearTimeout(existing);
        timers.set(path, setTimeout(() => {
          timers.delete(path);
          let text: string;
          try {
            text = Deno.readTextFileSync(path);
          } catch {
            return; // file deleted or temporarily unreadable — leave state as-is
          }
          try {
            reload(text);
          } catch (err) {
            console.error(`[world] Failed to reload ${path}:`, (err as Error).message);
          }
        }, 50));
      }
    }
  }

  watchDir(ROOMS_DIR, (text) => {
    const room = parseDataFile<Room>(text);
    state.rooms[room.id] = room;
    console.log(`[world] Hot-reloaded room: ${room.id}`);
  }).catch((err) => console.error("[world] Room watcher error:", (err as Error).message));

  watchDir(ITEMS_DIR, (text) => {
    const item = parseDataFile<Item>(text);
    state.items[item.id] = item;
    console.log(`[world] Hot-reloaded item: ${item.id}`);
  }).catch((err) => console.error("[world] Item watcher error:", (err as Error).message));

  watchDir(NPCS_DIR, (text) => {
    const npc = parseDataFile<NPC>(text);
    state.npcs[npc.id] = npc;
    console.log(`[world] Hot-reloaded NPC: ${npc.id}`);
  }).catch((err) => console.error("[world] NPC watcher error:", (err as Error).message));
}

/** Stop all active file watchers */
export function stopWatching(): void {
  for (const w of _watchers) w.close();
  _watchers.length = 0;
}

// ── Action dispatch ───────────────────────────────────────────────────────────

/**
 * Apply a god action to the world.
 * Returns { ok, message, broadcast } where broadcast is an optional string
 * sent to all connected players.
 */
export function applyAction(action: GodAction, godName: string): ActionResult {
  switch (action.type) {
    case "create_room":
      return createRoom(action, godName);
    case "describe_room":
      return describeRoom(action, godName);
    case "create_item":
      return createItem(action, godName);
    case "update_item":
      return updateItem(action, godName);
    case "create_npc":
      return createNpc(action, godName);
    case "create_event":
      return createEvent(action, godName);
    case "add_exit":
      return addExit(action, godName);
    case "speak":
      return godSpeak(action, godName);
    default:
      return { ok: false, message: `Unknown action type: ${(action as { type: string }).type}` };
  }
}

function createRoom(
  action: Extract<GodAction, { type: "create_room" }>,
  godName: string,
): ActionResult {
  const { id, name, description, from_room, direction } = action;
  if (!id || !name || !description) {
    return { ok: false, message: "create_room requires id, name, description" };
  }
  if (state.rooms[id]) {
    return { ok: false, message: `Room '${id}' already exists` };
  }
  const room: Room = {
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

function describeRoom(
  action: Extract<GodAction, { type: "describe_room" }>,
  godName: string,
): ActionResult {
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

function createItem(
  action: Extract<GodAction, { type: "create_item" }>,
  godName: string,
): ActionResult {
  const { id, name, description, room_id, properties } = action;
  if (!id || !name) return { ok: false, message: "create_item requires id and name" };
  const item: Item = { id, name, description: description ?? "", created_by: godName };
  if (properties) item.properties = properties;
  state.items[id] = item;
  if (room_id && state.rooms[room_id]) {
    state.rooms[room_id].items.push(id);
    saveRoom(state.rooms[room_id]);
  }
  saveItem(item);
  logGodAction(godName, `Created item '${name}' in room '${room_id}'`);
  return {
    ok: true,
    message: `Item '${name}' created`,
    broadcast: `[${godName}] places "${name}" into the world.`,
  };
}

function updateItem(
  action: Extract<GodAction, { type: "update_item" }>,
  godName: string,
): ActionResult {
  const { id, properties } = action;
  const item = state.items[id];
  if (!item) return { ok: false, message: `Item '${id}' not found` };
  // Shallow merge: each key in `properties` replaces the same key on the item.
  // To clear a property, set its value to null.
  item.properties = { ...(item.properties ?? {}), ...properties };
  saveItem(item);
  logGodAction(godName, `Updated item '${id}' properties: ${JSON.stringify(properties)}`);
  return { ok: true, message: `Item '${id}' updated` };
}

function createNpc(
  action: Extract<GodAction, { type: "create_npc" }>,
  godName: string,
): ActionResult {
  const { id, name, description, room_id } = action;
  if (!id || !name) return { ok: false, message: "create_npc requires id and name" };
  const npc: NPC = { id, name, description: description ?? "", created_by: godName };
  state.npcs[id] = npc;
  if (room_id && state.rooms[room_id]) {
    state.rooms[room_id].npcs.push(id);
    saveRoom(state.rooms[room_id]);
  }
  saveNpc(npc);
  logGodAction(godName, `Spawned NPC '${name}' in room '${room_id}'`);
  return {
    ok: true,
    message: `NPC '${name}' spawned`,
    broadcast: `[${godName}] breathes life — "${name}" stirs into existence.`,
  };
}

function createEvent(
  action: Extract<GodAction, { type: "create_event" }>,
  godName: string,
): ActionResult {
  const { text } = action;
  if (!text) return { ok: false, message: "create_event requires text" };
  const event: WorldEvent = { type: "god_event", text, by: godName, at: new Date().toISOString() };
  state.events.push(event);
  if (state.events.length > 100) state.events.shift();
  logGodAction(godName, `Event: ${text}`);
  return { ok: true, message: "Event created", broadcast: text };
}

function addExit(
  action: Extract<GodAction, { type: "add_exit" }>,
  godName: string,
): ActionResult {
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
    message: "Exit added",
    broadcast: `[${godName}] opens a passage — a new way ${direction} from "${from.name}".`,
  };
}

function godSpeak(
  action: Extract<GodAction, { type: "speak" }>,
  godName: string,
): ActionResult {
  const { text } = action;
  if (!text) return { ok: false, message: "speak requires text" };
  logGodAction(godName, `Spoke: ${text}`);
  return {
    ok: true,
    message: "God spoke",
    broadcast: `[${godName} speaks] "${text}"`,
  };
}

function logGodAction(godName: string, msg: string): void {
  const entry: GodLogEntry = { god: godName, msg, at: new Date().toISOString() };
  state.godLog.push(entry);
  if (state.godLog.length > 100) state.godLog.shift();
}

// ── Ledger ────────────────────────────────────────────────────────────────────

/**
 * Append a player-originated event to the server's event ledger.
 * The ledger is the authoritative sequence of events in the world.
 */
export function addPlayerEvent(
  type: string,
  playerName: string,
  data: Record<string, unknown>,
): void {
  const entry: WorldEvent = { type, player: playerName, at: new Date().toISOString(), ...data };
  state.events.push(entry);
  if (state.events.length > 200) state.events.shift();
}

/** Return the most recent ledger entries (default: last 20) */
export function getLedger(limit?: number): WorldEvent[] {
  const n = limit ?? 20;
  return state.events.slice(-n);
}

// ── World helpers ─────────────────────────────────────────────────────────────

/** Return the opposite cardinal direction */
function reverseDir(dir: string): string | null {
  const map: Record<string, string> = {
    north: "south",
    south: "north",
    east: "west",
    west: "east",
    up: "down",
    down: "up",
  };
  return map[dir] ?? null;
}

/** Serialise the full world state for debugging / god context */
export function snapshot(): {
  rooms: Record<string, Room>;
  items: Record<string, Item>;
  npcs: Record<string, NPC>;
  recentEvents: WorldEvent[];
  recentGodLog: GodLogEntry[];
} {
  return {
    rooms: state.rooms,
    items: state.items,
    npcs: state.npcs,
    recentEvents: state.events.slice(-20),
    recentGodLog: state.godLog.slice(-20),
  };
}
