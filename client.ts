/**
 * MudSeed — Terminal client.
 *
 * Connects to the MudSeed WebSocket server and provides a readline interface
 * for playing the game directly from your terminal.
 *
 * Usage:
 *   deno run --allow-net --allow-env client.ts [--host localhost] [--port 3000]
 */

// ── Argument parsing ──────────────────────────────────────────────────────────

function argValue(flag: string, fallback: string): string {
  const idx = Deno.args.indexOf(flag);
  return idx !== -1 && Deno.args[idx + 1] ? Deno.args[idx + 1] : fallback;
}

const HOST = argValue("--host", "localhost");
const PORT = argValue("--port", "3000");
const URL = `ws://${HOST}:${PORT}`;

// ── Output helpers ────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function prompt(): void {
  Deno.stdout.writeSync(enc.encode("> "));
}

// ── WebSocket connection ──────────────────────────────────────────────────────

console.log(`Connecting to MudSeed at ${URL} …\n`);

const ws = new WebSocket(URL);
let connected = false;

ws.addEventListener("open", () => {
  connected = true;
  prompt();
});

ws.addEventListener("message", (ev) => {
  try {
    const msg = JSON.parse(ev.data as string) as { type?: string; text?: string };
    if (msg.type === "message") {
      // Clear current input line, print message, restore prompt
      Deno.stdout.writeSync(enc.encode("\r\x1b[K"));
      console.log(msg.text);
      prompt();
    }
  } catch {
    console.log(String(ev.data));
    prompt();
  }
});

ws.addEventListener("close", () => {
  console.log("\nDisconnected from server.");
  Deno.exit(0);
});

ws.addEventListener("error", () => {
  console.error(`\nConnection error.`);
  console.error(`Make sure the server is running: deno run --allow-net --allow-read --allow-write --allow-env server.ts`);
  Deno.exit(1);
});

// ── Input handling ────────────────────────────────────────────────────────────

/** Async generator that yields lines from stdin using the ReadableStream API. */
async function* readLines(): AsyncGenerator<string> {
  const reader = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let acc = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += value;
      let nl: number;
      while ((nl = acc.indexOf("\n")) !== -1) {
        yield acc.slice(0, nl).replace(/\r$/, "");
        acc = acc.slice(nl + 1);
      }
    }
    if (acc) yield acc;
  } finally {
    reader.releaseLock();
  }
}

for await (const line of readLines()) {
  const text = line.trim();
  if (!text) {
    prompt();
    continue;
  }
  if (text === "quit" || text === "exit") {
    ws.close();
    break;
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ text }));
  }
  prompt();
}

ws.close();
