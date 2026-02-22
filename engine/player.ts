/**
 * MudSeed — Player session management.
 * Each connected WebSocket client gets a Player object.
 *
 * Passwords are hashed with PBKDF2-SHA-256 via the Web Crypto API.
 * Note: passwords stored by the previous Node.js/scrypt version are
 * incompatible and will need to be reset.
 */

import { join, parseDataFile, toDataFile } from "./path.ts";

const __dirname = import.meta.dirname!;
const PASSWORDS_FILE = join(__dirname, "..", "data", "passwords.json");
const CHARACTERS_DIR = join(__dirname, "..", "world", "characters");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Player {
  id: number;
  name: string;
  roomId: string;
  ws: WebSocket;
  inventory: string[];
  worn: Record<string, string>;
  wielding: string | null;
}

export interface Character {
  name: string;
  roomId: string;
  inventory: string[];
  worn: Record<string, string>;
  wielding: string | null;
}

interface PasswordEntry {
  salt: string;
  hash: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

let nextId = 1;
const players = new Map<number, Player>();
const characters = new Map<string, Character>();

// ── Password store ────────────────────────────────────────────────────────────

let passwordStore: Record<string, PasswordEntry> = {};

function loadPasswords(): void {
  try {
    const data = Deno.readTextFileSync(PASSWORDS_FILE);
    passwordStore = JSON.parse(data) as Record<string, PasswordEntry>;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.error("[player] Failed to load passwords file:", (err as Error).message);
    }
    passwordStore = {};
  }
}

function savePasswords(): void {
  const dir = PASSWORDS_FILE.slice(0, PASSWORDS_FILE.lastIndexOf("/"));
  try {
    Deno.statSync(dir);
  } catch {
    Deno.mkdirSync(dir, { recursive: true });
  }
  Deno.writeTextFileSync(PASSWORDS_FILE, JSON.stringify(passwordStore, null, 2));
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

function hexEncode(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexDecode(hex: string): Uint8Array {
  const len = hex.length / 2;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

/** Constant-time byte array comparison */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/** Set (or update) a character's password — stores a salted PBKDF2-SHA-256 hash. */
export async function setPassword(name: string, password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt);
  passwordStore[name.toLowerCase()] = {
    salt: hexEncode(salt),
    hash: hexEncode(derived),
  };
  savePasswords();
}

/** Verify a character's password against the stored hash. Returns a Promise<boolean>. */
export async function verifyPassword(name: string, password: string): Promise<boolean> {
  const entry = passwordStore[name.toLowerCase()];
  if (!entry) return false;
  const salt = hexDecode(entry.salt);
  const derived = await pbkdf2(password, salt);
  const stored = hexDecode(entry.hash);
  return timingSafeEqual(derived, stored);
}

/** Return true if a stored password entry exists for this character name. */
export function hasPassword(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(passwordStore, name.toLowerCase());
}

// Load persisted passwords on startup
loadPasswords();

// ── Character persistence ─────────────────────────────────────────────────────

function ensureCharactersDir(): void {
  try {
    Deno.statSync(CHARACTERS_DIR);
  } catch {
    Deno.mkdirSync(CHARACTERS_DIR, { recursive: true });
  }
}

/** Load all persisted characters from TypeScript data files into memory */
function loadCharacters(): void {
  ensureCharactersDir();
  const files = [...Deno.readDirSync(CHARACTERS_DIR)]
    .filter((e) => e.isFile && e.name.endsWith(".ts"))
    .map((e) => e.name);
  for (const file of files) {
    try {
      const char = parseDataFile<Character>(Deno.readTextFileSync(join(CHARACTERS_DIR, file)));
      // Provide defaults for fields added after initial character creation
      char.inventory ??= [];
      char.worn ??= {};
      char.wielding ??= null;
      characters.set(char.name.toLowerCase(), char);
    } catch (err) {
      console.error("[player] Failed to load character file:", file, (err as Error).message);
    }
  }
}

/** Persist a character as a TypeScript data file */
function saveCharacter(char: Character): void {
  ensureCharactersDir();
  const file = join(CHARACTERS_DIR, `${char.name.toLowerCase()}.ts`);
  Deno.writeTextFileSync(file, toDataFile(char));
}

// Load persisted characters on startup
loadCharacters();

/**
 * Watch the characters directory and hot-reload files when they change on disk.
 * If the character is currently online, their in-memory position is left
 * unchanged (the live player.roomId is authoritative); all other fields update.
 */
export function watchCharacters(): void {
  async function watch(): Promise<void> {
    ensureCharactersDir();
    const timers = new Map<string, number>();
    const watcher = Deno.watchFs(CHARACTERS_DIR);
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
            return;
          }
          try {
            const char = parseDataFile<Character>(text);
            const key = char.name.toLowerCase();
            // If the character is currently online, preserve their live roomId
            const onlinePlayer = [...players.values()].find(
              (p) => p.name.toLowerCase() === key,
            );
            if (onlinePlayer) char.roomId = onlinePlayer.roomId;
            characters.set(key, char);
            console.log(`[player] Hot-reloaded character: ${char.name}`);
          } catch (err) {
            console.error(`[player] Failed to reload ${path}:`, (err as Error).message);
          }
        }, 50));
      }
    }
  }

  watch().catch((err) => console.error("[player] Character watcher error:", (err as Error).message));
}

// ── Character management ──────────────────────────────────────────────────────

/** Find a character by name (case-insensitive). Returns character data or null. */
export function findCharacter(name: string): Character | null {
  return characters.get(name.toLowerCase()) ?? null;
}

/** Create and store a new character with default starting values. */
export function createCharacter(name: string): Character {
  const char: Character = { name, roomId: "pantheon", inventory: [], worn: {}, wielding: null };
  characters.set(name.toLowerCase(), char);
  saveCharacter(char);
  return char;
}

/** Persist a player's current state back to the character store. */
export function saveCharacterState(player: Player): void {
  const char = characters.get(player.name.toLowerCase());
  if (char) {
    char.roomId = player.roomId;
    char.inventory = player.inventory;
    char.worn = player.worn;
    char.wielding = player.wielding;
    saveCharacter(char);
  }
}

// ── Player management ─────────────────────────────────────────────────────────

export function createPlayer(ws: WebSocket, name: string, roomId: string, char?: Character): Player {
  const id = nextId++;
  const player: Player = {
    id,
    name: name || `Wanderer${id}`,
    roomId: roomId || "pantheon",
    ws,
    inventory: char?.inventory ?? [],
    worn: char?.worn ?? {},
    wielding: char?.wielding ?? null,
  };
  players.set(id, player);
  return player;
}

export function removePlayer(id: number): void {
  players.delete(id);
}

export function getPlayer(id: number): Player | null {
  return players.get(id) ?? null;
}

export function allPlayers(): Player[] {
  return [...players.values()];
}

/** Send a text message to a specific player */
export function send(player: Player, text: string): void {
  if (player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify({ type: "message", text }));
  }
}

/** Broadcast a message to all connected players */
export function broadcast(text: string): void {
  for (const p of players.values()) {
    send(p, text);
  }
}

/** Return all players currently in a given room */
export function playersInRoom(roomId: string): Player[] {
  return [...players.values()].filter((p) => p.roomId === roomId);
}

/** Send a message to all players in a room, optionally excluding one player by id */
export function broadcastToRoom(roomId: string, text: string, excludeId?: number): void {
  for (const p of playersInRoom(roomId)) {
    if (p.id !== excludeId) send(p, text);
  }
}
