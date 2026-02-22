/**
 * MudSeed — HTTP + WebSocket game server.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env server.ts [--port 3000]
 *
 * The server serves a browser client at http://localhost:<port>/
 * and accepts WebSocket connections from the terminal client (client.ts)
 * or the browser.
 */

import { extname, join } from "./engine/path.ts";
import * as world from "./engine/world.ts";
import type { WearableItem, WieldableItem } from "./engine/world.ts";
import * as playerManager from "./engine/player.ts";
import type { Player } from "./engine/player.ts";
import * as godEngine from "./engine/gods.ts";

const __dirname = import.meta.dirname!;

// ── Configuration ─────────────────────────────────────────────────────────────

const args = Deno.args;
const portArgIdx = args.indexOf("--port");
const PORT = parseInt(
  Deno.env.get("PORT") ??
    (portArgIdx !== -1 && args[portArgIdx + 1] ? args[portArgIdx + 1] : "3000"),
  10,
);
const PUBLIC_DIR = join(__dirname, "public");

// ── Boot ──────────────────────────────────────────────────────────────────────

world.loadRooms();
world.loadItems();
world.loadNpcs();
godEngine.loadGods();
world.watchDataFiles();
playerManager.watchCharacters();

// ── MIME types ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

// ── HTTP handler ──────────────────────────────────────────────────────────────

function handleHttp(req: Request): Response {
  let filePath = new URL(req.url).pathname;
  if (filePath === "/") filePath = "/index.html";
  const fullPath = join(PUBLIC_DIR, filePath);

  try {
    const data = Deno.readFileSync(fullPath);
    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME[ext] ?? "application/octet-stream";
    return new Response(data, { headers: { "Content-Type": contentType } });
  } catch {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
}

// ── WebSocket helpers ─────────────────────────────────────────────────────────

// Valid character names: 2–20 characters total (first must be a letter, followed by 1-19 letters/digits/_/-)
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,19}$/;

type SessionState =
  | "awaiting_name"
  | "awaiting_new_password"
  | "awaiting_new_password_confirm"
  | "awaiting_login_password"
  | "in_game";

interface Session {
  ws: WebSocket;
  state: SessionState;
  player: Player | null;
  pendingName: string | null;
  pendingPassword: string | null;
  loginAttempts: number;
}

/** Send a raw message to a WebSocket before a player object exists */
function sendRaw(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "message", text }));
  }
}

function broadcast(text: string): void {
  playerManager.broadcast(text);
}

// ── Connection handler ────────────────────────────────────────────────────────

function handleConnection(ws: WebSocket): void {
  const session: Session = {
    ws,
    state: "awaiting_name",
    player: null,
    pendingName: null,
    pendingPassword: null,
    loginAttempts: 0,
  };

  ws.addEventListener("open", () => {
    sendRaw(ws, "\nWelcome to MudSeed!\nEnter your character name (2-20 characters, starting with a letter): ");
  });

  ws.addEventListener("message", (ev) => {
    let input: string;
    try {
      const msg = JSON.parse(ev.data as string) as { text?: string };
      input = (msg.text ?? "").trim();
    } catch {
      input = String(ev.data).trim();
    }
    if (!input) return;

    if (session.state === "awaiting_name") {
      return handleNameInput(session, input);
    }

    if (
      session.state === "awaiting_new_password" ||
      session.state === "awaiting_new_password_confirm" ||
      session.state === "awaiting_login_password"
    ) {
      handlePasswordInput(session, input).catch((err: Error) => {
        console.error("[server] Password handling error:", err.message);
        ws.close();
      });
      return;
    }

    if (session.player) {
      handleCommand(session.player, input);
    }
  });

  ws.addEventListener("close", () => {
    if (session.player) {
      console.log(`[server] Player ${session.player.name} disconnected`);
      world.addPlayerEvent("disconnect", session.player.name, { roomId: session.player.roomId });
      void godEngine.onWorldEvent(world.snapshot());
      playerManager.broadcastToRoom(
        session.player.roomId,
        `${session.player.name} has left the world.`,
        session.player.id,
      );
      playerManager.saveCharacterState(session.player);
      playerManager.removePlayer(session.player.id);
    }
  });

  ws.addEventListener("error", (ev) => {
    const label = session.player ? session.player.name : "(unauthenticated)";
    console.error(`[server] WS error for ${label}:`, ev);
  });
}

// ── Login flow ────────────────────────────────────────────────────────────────

/** Handle the character name input during the login/create flow */
function handleNameInput(session: Session, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    sendRaw(
      session.ws,
      "Invalid name. Names must be 2-20 characters total, starting with a letter, followed by letters, digits, _ or -. Try again: ",
    );
    return;
  }

  const existing = playerManager.findCharacter(name);
  if (existing || playerManager.hasPassword(name)) {
    session.pendingName = existing ? existing.name : name;
    session.state = "awaiting_login_password";
    sendRaw(session.ws, "Password: ");
  } else {
    session.pendingName = name;
    session.state = "awaiting_new_password";
    sendRaw(session.ws, "Choose a password (min 8 characters): ");
  }
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_LOGIN_ATTEMPTS = 3;

/** Handle the password input for both new-character creation and login. */
async function handlePasswordInput(session: Session, password: string): Promise<void> {
  if (session.state === "awaiting_new_password") {
    if (password.length < MIN_PASSWORD_LENGTH) {
      sendRaw(session.ws, `Password too short (min ${MIN_PASSWORD_LENGTH} characters). Try again: `);
      return;
    }
    session.pendingPassword = password;
    session.state = "awaiting_new_password_confirm";
    sendRaw(session.ws, "Confirm password: ");
    return;
  }

  if (session.state === "awaiting_new_password_confirm") {
    if (password !== session.pendingPassword) {
      session.pendingPassword = null;
      session.state = "awaiting_new_password";
      sendRaw(
        session.ws,
        `Passwords do not match. Choose a password (min ${MIN_PASSWORD_LENGTH} characters): `,
      );
      return;
    }
    const char = playerManager.createCharacter(session.pendingName!);
    await playerManager.setPassword(session.pendingName!, session.pendingPassword!);
    session.pendingPassword = null;
    const player = playerManager.createPlayer(session.ws, char.name, char.roomId, char);
    session.player = player;
    session.state = "in_game";
    console.log(`[server] Player ${player.name} created`);
    world.addPlayerEvent("connect", player.name, { roomId: player.roomId });
    void godEngine.onWorldEvent(world.snapshot());
    playerManager.broadcastToRoom(player.roomId, `${player.name} has entered the world.`, player.id);
    playerManager.send(player, `\nWelcome, ${player.name}! Your character has been created.`);
  } else {
    // awaiting_login_password
    const ok = await playerManager.verifyPassword(session.pendingName!, password);
    if (!ok) {
      session.loginAttempts++;
      if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        sendRaw(session.ws, "Too many failed attempts. Disconnecting.");
        session.ws.close();
        return;
      }
      sendRaw(session.ws, "Incorrect password. Try again: ");
      return;
    }
    const character =
      playerManager.findCharacter(session.pendingName!) ??
      playerManager.createCharacter(session.pendingName!);
    const player = playerManager.createPlayer(session.ws, character.name, character.roomId, character);
    session.player = player;
    session.state = "in_game";
    console.log(`[server] Player ${player.name} logged in`);
    world.addPlayerEvent("connect", player.name, { roomId: player.roomId });
    void godEngine.onWorldEvent(world.snapshot());
    playerManager.broadcastToRoom(player.roomId, `${player.name} has entered the world.`, player.id);
    playerManager.send(player, `\nWelcome back, ${player.name}!`);
  }

  sendRoom(session.player!);
  playerManager.send(session.player!, 'Type "help" for a list of commands.\n');
}

// ── Command handler ───────────────────────────────────────────────────────────

const DIRECTIONS = ["north", "south", "east", "west", "up", "down", "n", "s", "e", "w", "u", "d"];
const DIR_ALIAS: Record<string, string> = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };

function handleCommand(player: Player, raw: string): void {
  const parts = raw.toLowerCase().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (DIRECTIONS.includes(cmd)) {
    return cmdMove(player, DIR_ALIAS[cmd] ?? cmd);
  }

  switch (cmd) {
    case "look":
    case "l":
      return sendRoom(player);

    case "go":
      return cmdMove(player, args[0]);

    case "examine":
    case "x":
    case "ex": {
      const target = args.join(" ");
      return cmdExamine(player, target);
    }

    case "inventory":
    case "inv":
    case "i":
      return cmdInventory(player);

    case "get":
    case "take": {
      const target = args.join(" ");
      return cmdGet(player, target);
    }

    case "drop": {
      const target = args.join(" ");
      return cmdDrop(player, target);
    }

    case "wear":
    case "put": {
      const target = args.join(" ");
      return cmdWear(player, target);
    }

    case "wield":
    case "equip": {
      const target = args.join(" ");
      return cmdWield(player, target);
    }

    case "remove":
    case "unwield":
    case "unequip": {
      const target = args.join(" ");
      return cmdRemove(player, target);
    }

    case "who":
      return cmdWho(player);

    case "say": {
      const msg = raw.slice(4).trim();
      return cmdSay(player, msg);
    }

    case "shout": {
      const msg = raw.slice(6).trim();
      return cmdShout(player, msg);
    }

    case "gods":
      return cmdGods(player);

    case "world":
      return cmdWorld(player);

    case "ledger":
      return cmdLedger(player);

    case "help":
    case "?":
      return cmdHelp(player);

    default:
      playerManager.send(player, `Unknown command: "${cmd}". Type "help" for a list of commands.`);
  }
}

function cmdInventory(player: Player): void {
  const lines: string[] = ["", "Inventory"];
  if (player.inventory.length === 0) {
    lines.push("  (nothing)");
  } else {
    for (const id of player.inventory) {
      const item = world.state.items[id];
      lines.push(`  ${item ? item.name : id}`);
    }
  }
  if (player.wielding) {
    const w = world.state.items[player.wielding];
    lines.push(`Wielding: ${w ? w.name : player.wielding}`);
  }
  const wornEntries = Object.entries(player.worn);
  if (wornEntries.length) {
    lines.push("Wearing:");
    for (const [slot, id] of wornEntries) {
      const item = world.state.items[id];
      lines.push(`  ${slot}: ${item ? item.name : id}`);
    }
  }
  lines.push("");
  playerManager.send(player, lines.join("\n"));
}

function cmdGet(player: Player, target: string): void {
  if (!target) {
    playerManager.send(player, "Get what?");
    return;
  }
  const room = world.getRoom(player.roomId);
  if (!room) return;
  const idx = room.items.findIndex((id) => {
    const item = world.state.items[id];
    return item && item.name.toLowerCase().includes(target);
  });
  if (idx === -1) {
    playerManager.send(player, `You see no "${target}" here.`);
    return;
  }
  const [itemId] = room.items.splice(idx, 1);
  player.inventory.push(itemId);
  world.saveRoom(room);
  playerManager.saveCharacterState(player);
  const item = world.state.items[itemId];
  const name = item ? item.name : itemId;
  playerManager.send(player, `You pick up ${name}.`);
  playerManager.broadcastToRoom(player.roomId, `${player.name} picks up ${name}.`, player.id);
}

function cmdDrop(player: Player, target: string): void {
  if (!target) {
    playerManager.send(player, "Drop what?");
    return;
  }
  const idx = player.inventory.findIndex((id) => {
    const item = world.state.items[id];
    return item && item.name.toLowerCase().includes(target);
  });
  if (idx === -1) {
    playerManager.send(player, `You are not carrying "${target}".`);
    return;
  }
  const [itemId] = player.inventory.splice(idx, 1);
  const room = world.getRoom(player.roomId);
  if (room) {
    room.items.push(itemId);
    world.saveRoom(room);
  }
  playerManager.saveCharacterState(player);
  const item = world.state.items[itemId];
  const name = item ? item.name : itemId;
  playerManager.send(player, `You drop ${name}.`);
  playerManager.broadcastToRoom(player.roomId, `${player.name} drops ${name}.`, player.id);
}

function cmdWear(player: Player, target: string): void {
  if (!target) {
    playerManager.send(player, "Wear what?");
    return;
  }
  const itemId = player.inventory.find((id) => {
    const item = world.state.items[id];
    return item && item.name.toLowerCase().includes(target);
  });
  if (!itemId) {
    playerManager.send(player, `You are not carrying "${target}".`);
    return;
  }
  const item = world.state.items[itemId] as WearableItem;
  if (!item.wearable) {
    playerManager.send(player, `${item.name} cannot be worn.`);
    return;
  }
  if (player.worn[item.slot]) {
    const current = world.state.items[player.worn[item.slot]];
    playerManager.send(player, `You are already wearing ${current ? current.name : "something"} on your ${item.slot}. Remove it first.`);
    return;
  }
  player.inventory.splice(player.inventory.indexOf(itemId), 1);
  player.worn[item.slot] = itemId;
  playerManager.saveCharacterState(player);
  playerManager.send(player, `You wear ${item.name}.`);
  playerManager.broadcastToRoom(player.roomId, `${player.name} puts on ${item.name}.`, player.id);
}

function cmdWield(player: Player, target: string): void {
  if (!target) {
    playerManager.send(player, "Wield what?");
    return;
  }
  const itemId = player.inventory.find((id) => {
    const item = world.state.items[id];
    return item && item.name.toLowerCase().includes(target);
  });
  if (!itemId) {
    playerManager.send(player, `You are not carrying "${target}".`);
    return;
  }
  const item = world.state.items[itemId] as WieldableItem;
  if (!item.wieldable) {
    playerManager.send(player, `${item.name} cannot be wielded.`);
    return;
  }
  if (player.wielding) {
    const current = world.state.items[player.wielding];
    playerManager.send(player, `You are already wielding ${current ? current.name : "something"}. Remove it first.`);
    return;
  }
  player.inventory.splice(player.inventory.indexOf(itemId), 1);
  player.wielding = itemId;
  playerManager.saveCharacterState(player);
  playerManager.send(player, `You wield ${item.name}.`);
  playerManager.broadcastToRoom(player.roomId, `${player.name} wields ${item.name}.`, player.id);
}

function cmdRemove(player: Player, target: string): void {
  if (!target) {
    playerManager.send(player, "Remove what?");
    return;
  }
  // Check wielded item
  if (player.wielding) {
    const w = world.state.items[player.wielding];
    if (w && w.name.toLowerCase().includes(target)) {
      player.inventory.push(player.wielding);
      player.wielding = null;
      playerManager.saveCharacterState(player);
      playerManager.send(player, `You stop wielding ${w.name}.`);
      playerManager.broadcastToRoom(player.roomId, `${player.name} lowers ${w.name}.`, player.id);
      return;
    }
  }
  // Check worn items
  for (const [slot, id] of Object.entries(player.worn)) {
    const item = world.state.items[id];
    if (item && item.name.toLowerCase().includes(target)) {
      delete player.worn[slot];
      player.inventory.push(id);
      playerManager.saveCharacterState(player);
      playerManager.send(player, `You remove ${item.name}.`);
      playerManager.broadcastToRoom(player.roomId, `${player.name} removes ${item.name}.`, player.id);
      return;
    }
  }
  playerManager.send(player, `You are not wearing or wielding "${target}".`);
}

function sendRoom(player: Player): void {
  const room = world.getRoom(player.roomId);
  if (!room) {
    playerManager.send(player, "[ERROR] You are nowhere. This should not happen.");
    return;
  }
  const lines = [`\n=== ${room.name} ===`, room.description, ""];

  // Exits
  const exits = Object.keys(room.exits);
  lines.push(exits.length ? `Exits: ${exits.join(", ")}` : "Exits: none");

  // Items
  if (room.items && room.items.length) {
    const names = room.items.map((id) => {
      const item = world.state.items[id];
      return item ? item.name : id;
    });
    lines.push(`Items: ${names.join(", ")}`);
  }

  // NPCs
  if (room.npcs && room.npcs.length) {
    const names = room.npcs.map((id) => {
      const npc = world.state.npcs[id];
      return npc ? npc.name : id;
    });
    lines.push(`NPCs: ${names.join(", ")}`);
  }

  // Other players
  const others = playerManager.playersInRoom(player.roomId).filter((p) => p.id !== player.id);
  if (others.length) {
    lines.push(`Players here: ${others.map((p) => p.name).join(", ")}`);
  }

  lines.push("");
  playerManager.send(player, lines.join("\n"));
}

// Maps movement direction to the label used in arrival announcements
const ARRIVAL_FROM: Record<string, string> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  up: "below",
  down: "above",
};

function cmdMove(player: Player, direction: string): void {
  if (!direction) {
    playerManager.send(player, "Go where? Specify a direction.");
    return;
  }
  const room = world.getRoom(player.roomId);
  const targetId = room?.exits[direction];
  if (!targetId) {
    playerManager.send(player, `You cannot go ${direction} from here.`);
    return;
  }
  const target = world.getRoom(targetId);
  if (!target) {
    playerManager.send(player, "That passage leads nowhere. The gods must have forgotten to finish it.");
    return;
  }
  const fromId = player.roomId;
  playerManager.broadcastToRoom(fromId, `${player.name} leaves ${direction}.`, player.id);
  player.roomId = targetId;
  const fromLabel = ARRIVAL_FROM[direction] ?? "somewhere";
  playerManager.broadcastToRoom(targetId, `${player.name} arrives from the ${fromLabel}.`, player.id);
  world.addPlayerEvent("move", player.name, { from: fromId, direction, to: targetId });
  void godEngine.onWorldEvent(world.snapshot());
  sendRoom(player);
}

function cmdExamine(player: Player, target: string): void {
  if (!target) {
    playerManager.send(player, "Examine what?");
    return;
  }
  const room = world.getRoom(player.roomId);
  if (!room) return;

  // Helper to describe an item
  function describeItem(item: world.Item): string {
    let text = `${item.name}: ${item.description}`;
    const wi = item as WieldableItem;
    const wa = item as WearableItem;
    const tags: string[] = [];
    if (wi.wieldable) {
      const parts = ["wieldable"];
      if (wi.damage) parts.push(`damage: ${wi.damage}`);
      if (wi.hands === 2) parts.push("two-handed");
      tags.push(parts.join(", "));
    }
    if (wa.wearable) {
      const parts = [`wearable (${wa.slot})`];
      if (wa.defense) parts.push(`defense: ${wa.defense}`);
      tags.push(parts.join(", "));
    }
    if (item.properties && Object.keys(item.properties).length) {
      const props = Object.entries(item.properties)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      tags.push(props);
    }
    if (tags.length) text += ` [${tags.join("; ")}]`;
    return text;
  }

  // Check items in room
  for (const itemId of (room.items ?? [])) {
    const item = world.state.items[itemId];
    if (item && item.name.toLowerCase().includes(target)) {
      playerManager.send(player, describeItem(item));
      return;
    }
  }

  // Check items in inventory / equipped
  for (const itemId of [...player.inventory, ...(player.wielding ? [player.wielding] : []), ...Object.values(player.worn)]) {
    const item = world.state.items[itemId];
    if (item && item.name.toLowerCase().includes(target)) {
      playerManager.send(player, describeItem(item));
      return;
    }
  }

  // Check NPCs in room
  for (const npcId of (room.npcs ?? [])) {
    const npc = world.state.npcs[npcId];
    if (npc && npc.name.toLowerCase().includes(target)) {
      playerManager.send(player, `${npc.name}: ${npc.description}`);
      return;
    }
  }

  playerManager.send(player, `You see no "${target}" here.`);
}

function cmdWho(player: Player): void {
  const all = playerManager.allPlayers();
  const names = all.map((p) => p.name + (p.id === player.id ? " (you)" : "")).join(", ");
  playerManager.send(player, `Players online: ${names || "none"}`);
}

function cmdSay(player: Player, msg: string): void {
  if (!msg) {
    playerManager.send(player, "Say what?");
    return;
  }
  const line = `${player.name} says: "${msg}"`;
  playerManager.broadcastToRoom(player.roomId, line, player.id);
  playerManager.send(player, `You say: "${msg}"`);
  world.addPlayerEvent("say", player.name, { roomId: player.roomId, msg });
  void godEngine.onWorldEvent(world.snapshot());
}

function cmdShout(player: Player, msg: string): void {
  if (!msg) {
    playerManager.send(player, "Shout what?");
    return;
  }
  playerManager.broadcast(`${player.name} shouts: "${msg}"`);
  world.addPlayerEvent("shout", player.name, { msg });
  void godEngine.onWorldEvent(world.snapshot());
}

function cmdGods(player: Player): void {
  const list = [...godEngine.gods.entries()].map(
    ([name, g]) => `  ${name} — god of ${g.domain}`,
  );
  playerManager.send(player, list.length ? `Active gods:\n${list.join("\n")}` : "No gods are active.");
}

function cmdLedger(player: Player): void {
  const entries = world.getLedger(20);
  if (!entries.length) {
    playerManager.send(player, "The ledger is empty.");
    return;
  }
  const lines = ["", "Recent Events (Ledger of Truth)", "────────────────────────────────"];
  for (const e of entries) {
    const time = new Date(e.at).toISOString().slice(0, 19).replace("T", " ");
    const roomName = (id: string) => (world.getRoom(id) ?? { name: id }).name;
    if (e.type === "move") {
      lines.push(
        `[${time}] ${e.player} moved ${e.direction} (${roomName(e.from as string)} → ${roomName(e.to as string)})`,
      );
    } else if (e.type === "say") {
      lines.push(`[${time}] ${e.player} says (in ${roomName(e.roomId as string)}): "${e.msg}"`);
    } else if (e.type === "shout") {
      lines.push(`[${time}] ${e.player} shouts: "${e.msg}"`);
    } else if (e.type === "connect") {
      lines.push(`[${time}] ${e.player} entered the world in ${roomName(e.roomId as string)}`);
    } else if (e.type === "disconnect") {
      lines.push(`[${time}] ${e.player} left the world from ${roomName(e.roomId as string)}`);
    } else {
      lines.push(`[${time}] [${e.type}] ${JSON.stringify(e)}`);
    }
  }
  lines.push("");
  playerManager.send(player, lines.join("\n"));
}

function cmdWorld(player: Player): void {
  const rooms = world.listRooms().map((id) => {
    const r = world.getRoom(id)!;
    return `  ${r.name} (${id}) — exits: ${Object.keys(r.exits).join(", ") || "none"}`;
  });
  playerManager.send(player, `Known rooms:\n${rooms.join("\n")}`);
}

function cmdHelp(player: Player): void {
  playerManager.send(
    player,
    [
      "",
      "MudSeed Commands",
      "────────────────",
      "look / l          — describe your current location",
      "north/south/...   — move in a direction (or n/s/e/w/u/d)",
      "go <direction>    — move in a direction",
      "examine <thing>   — examine an item or NPC",
      "get/take <item>   — pick up an item from the room",
      "drop <item>       — drop an item in the room",
      "wear <item>       — wear a wearable item",
      "wield <item>      — wield a wieldable item",
      "remove <item>     — remove worn or wielded item",
      "inventory / i     — show your carried items and equipment",
      "say <message>     — speak to players in your room",
      "shout <message>   — shout to all players everywhere",
      "who               — list connected players",
      "ledger            — show recent event history",
      "gods              — list active god agents",
      "world             — list all known rooms",
      "help / ?          — show this help",
      "",
    ].join("\n"),
  );
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.log(`[server] MudSeed running at http://localhost:${PORT}`);
console.log(`[server] Terminal client: deno run --allow-net --allow-env client.ts [--host localhost] [--port ${PORT}]`);

Deno.serve({ port: PORT }, (req: Request): Response => {
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleConnection(socket);
    return response;
  }
  return handleHttp(req);
});

godEngine.startGods(broadcast);
