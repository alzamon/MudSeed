# MudSeed

A framework for evolving a text-based MUD from scratch using LLM god agents.

The world begins with a single room — **The Pantheon** — and is shaped over time
by LLM agents that act as gods, each with their own domain, personality, and agenda.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+

### Install dependencies

```bash
npm install
```

### Start the server

```bash
node server.js
# or: npm start
```

The server runs at **http://localhost:3000** by default.
Open that URL in your browser to play via the web UI.

You can change the port:

```bash
PORT=8080 node server.js
# or
node server.js --port 8080
```

### Play from the terminal

In a second terminal window:

```bash
node client.js
# or: npm run client
```

Options:

```bash
node client.js --host localhost --port 3000
```

---

## Architecture

```
MudSeed/
├── server.js          # HTTP + WebSocket game server
├── client.js          # Terminal client
├── gods/              # God definitions (one Markdown file per god)
│   ├── README.md      # God system documentation
│   ├── aether.md      # God of Creation and Structure
│   ├── terra.md       # Goddess of Nature and Growth
│   └── chaos.md       # God of Change and the Unexpected
├── world/
│   └── rooms/         # Room state (JSON, auto-saved)
│       └── pantheon.json
├── engine/
│   ├── world.js       # World state and action system
│   ├── player.js      # Player session management
│   └── gods.js        # God agent scheduler and LLM integration
└── public/
    └── index.html     # Browser client
```

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

To connect a god to a real LLM, set the relevant environment variable before
starting the server:

```bash
OPENAI_API_KEY=sk-... node server.js
```

The god's `api_key_env` field (in its `.md` frontmatter) names the variable to
use. The framework calls the OpenAI chat completions API by default.

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
| `say <message>` | Speak to everyone online |
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
