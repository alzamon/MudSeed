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
| `llm_model` | LLM model to use (e.g. `gpt-4`, `ollama/llama3`) |
| `llm_endpoint` | Optional custom endpoint (for local models) |
| `api_key_env` | Environment variable holding the API key |
| `tick_interval` | How often (in seconds) the god acts |

## Active Gods

- [Aether](./aether.md) — God of Creation and Structure
- [Terra](./terra.md) — Goddess of Nature and Growth
- [Chaos](./chaos.md) — God of Change and the Unexpected

## Adding a New God

1. Copy the template below into a new `<godname>.md` file.
2. Fill in all fields.
3. Restart the server — the god will be loaded automatically.

```markdown
---
name: MyGod
domain: my domain
personality: |
  Describe how this god thinks and acts.
llm_model: gpt-4o
api_key_env: OPENAI_API_KEY
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
