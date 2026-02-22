# Gods of MudSeed

Each god is an LLM agent that shapes the world of MudSeed. Gods observe the world state and issue commands to evolve it — creating rooms, items, NPCs, events, and lore.

## God File Format

Each god is defined by a Markdown file in this directory. The file sets the god's identity, domain, personality, and LLM configuration.

### Fields

| Field | Description |
|-------|-------------|
| `name` | The god's name |
| `domain` | Area of influence (e.g. fire, creation, chaos) |
| `personality` | How the god behaves and speaks |
| `llm_provider` | LLM provider to use: `openai` (default) or `ollama` |
| `llm_model` | LLM model to use (e.g. `gpt-4o`, `llama3.2`) |
| `api_key_env` | Environment variable holding the API key (OpenAI only) |
| `ollama_host` | Ollama server URL (default: `http://localhost:11434`) |
| `tick_interval` | How often (in seconds) the god acts |

## Active Gods

- [Aether](./aether.md) — God of Creation and Structure
- [Terra](./terra.md) — Goddess of Nature and Growth
- [Chaos](./chaos.md) — God of Change and the Unexpected

## Adding a New God

1. Copy one of the templates below into a new `<godname>.md` file.
2. Fill in all fields.
3. Restart the server — the god will be loaded automatically.

### OpenAI template

```markdown
---
name: MyGod
domain: my domain
personality: |
  Describe how this god thinks and acts.
llm_provider: openai
llm_model: gpt-4o
api_key_env: OPENAI_API_KEY
tick_interval: 60
---

## Lore

Write the god's backstory and mythology here. This text is injected into the LLM system prompt.
```

### Ollama template

```markdown
---
name: MyGod
domain: my domain
personality: |
  Describe how this god thinks and acts.
llm_provider: ollama
llm_model: llama3.2
ollama_host: http://localhost:11434
tick_interval: 60
---

## Lore

Write the god's backstory and mythology here. This text is injected into the LLM system prompt.
```

## God Commands

When a god's LLM responds, it returns a JSON action object. Supported actions:

| Action | Description |
|--------|-------------|
| `create_room` | Add a new room connected to an existing one |
| `describe_room` | Rewrite a room's description |
| `create_item` | Place an item in a room |
| `create_npc` | Spawn an NPC in a room |
| `create_event` | Trigger a one-time narrative event |
| `add_exit` | Connect two existing rooms |
| `speak` | Have the god speak to all players |
