# MudSeed

A framework for evolving a text-based MUD from scratch using LLM god agents.

The world begins with a single room — **The Pantheon** — and is shaped over time
by LLM agents that act as gods, each with their own domain, personality, and agenda.

---

## DISCLAIMER

wibe coded work in progress. 


## Quick Start

### Prerequisites

- [Deno](https://deno.land/) 1.38+ (2.x recommended)

### Start the server

```bash
deno run --allow-net --allow-read --allow-write --allow-env server.ts
# or: deno task start
```

The server runs at **http://localhost:3000** by default.
Open that URL in your browser to play via the web UI.

You can change the port:

```bash
PORT=8080 deno run --allow-net --allow-read --allow-write --allow-env server.ts
# or
deno run --allow-net --allow-read --allow-write --allow-env server.ts --port 8080
```

### Play from the terminal

In a second terminal window:

```bash
deno run --allow-net --allow-env client.ts
# or: deno task client
```

Options:

```bash
deno run --allow-net --allow-env client.ts --host localhost --port 3000
```

---

## Architecture

```
MudSeed/
├── server.ts          # HTTP + WebSocket game server
├── client.ts          # Terminal client
├── deno.json          # Deno configuration and task definitions
├── engine/
│   ├── world.ts       # World state and action system
│   ├── player.ts      # Player session management
│   ├── gods.ts        # God agent scheduler and LLM integration
│   └── path.ts        # Minimal path utilities (no external deps)
├── gods/              # God definitions (one Markdown file per god)
│   ├── README.md      # God system documentation
│   ├── aether.md      # God of Creation and Structure
│   ├── terra.md       # Goddess of Nature and Growth
│   └── chaos.md       # God of Change and the Unexpected
├── world/
│   └── rooms/         # Room state (JSON, auto-saved)
│       └── pantheon.json
└── public/
    └── index.html     # Browser client
```

---

## Password Storage Migration Note

This version uses **PBKDF2-SHA-256** (via the Web Crypto API) for password
hashing, replacing the previous scrypt implementation. Existing `data/passwords.json`
files from the Node.js version are **incompatible** — players will need to
create new characters after the upgrade.

---

## God Agents

Gods are defined as Markdown files in the `gods/` directory. See
[gods/README.md](gods/README.md) for the full specification.

Each god has:
- A **domain** (e.g. creation, nature, chaos)
- A **personality** injected into the LLM system prompt
- Lore text that gives the god context and backstory
- A **tick interval** controlling how often the god acts

### LLM Integration

By default gods run in **mock mode**, executing a scripted sequence of actions
to demonstrate the framework without needing an API key.

#### OpenAI

Set the relevant environment variable before starting the server:

```bash
OPENAI_API_KEY=sk-... deno run --allow-net --allow-read --allow-write --allow-env server.ts
```

The god's `api_key_env` field (in its `.md` frontmatter) names the variable to
use. Set `llm_provider: openai` (or omit it — OpenAI is the default when
`api_key_env` is set).

#### Ollama (local models)

No API key is required. Install [Ollama](https://ollama.com/) and pull a model:

```bash
ollama pull llama3.2
```

Then configure a god with `llm_provider: ollama` in its frontmatter:

```yaml
llm_provider: ollama
llm_model: llama3.2
# ollama_host: http://localhost:11434  # optional, this is the default
```

Start the server normally — the god will call Ollama automatically:

```bash
deno run --allow-net --allow-read --allow-write --allow-env server.ts
```

### God Commands

Gods can perform these actions on the world:

| Action | Description |
|--------|-------------|
| `create_room` | Add a new room connected to an existing one |
| `describe_room` | Rewrite a room's description |
| `create_item` | Place an item in a room |
| `create_npc` | Spawn an NPC in a room |
| `create_event` | Broadcast a narrative event to all players |
| `add_exit` | Connect two existing rooms |
| `speak` | Have the god address all players directly |

---

## Player Commands

| Command | Description |
|---------|-------------|
| `look` / `l` | Describe your current location |
| `north` / `south` / `east` / `west` / `up` / `down` | Move (or `n`/`s`/`e`/`w`/`u`/`d`) |
| `go <direction>` | Move in a direction |
| `examine <thing>` | Examine an item or NPC |
| `say <message>` | Speak to everyone in your room |
| `shout <message>` | Shout to all players everywhere |
| `who` | List connected players |
| `gods` | List active god agents |
| `world` | List all known rooms |
| `help` | Show this list |

---

## Adding a God

1. Create a new file in `gods/`, e.g. `gods/ignis.md`.
2. Add YAML frontmatter and lore body (see [gods/README.md](gods/README.md)).
3. Restart the server — the god is loaded automatically.

---

## World Persistence

Room state is persisted to `world/rooms/*.json` automatically whenever a god
modifies a room. The world grows across server restarts.
