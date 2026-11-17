<div align="center">

# 🤖 OpenNova
### A Minecraft Companion Bot

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Minecraft](https://img.shields.io/badge/Minecraft-26.1-62B47A?style=for-the-badge&logo=minecraft&logoColor=white)](https://minecraft.net/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

OpenNova is a Minecraft companion bot built with Mineflayer.
It takes `!commands`, and it can also act as an autonomous agent: you talk to it in plain language, it works out the steps, and it does them.

[Features](#-features) • [Installation](#-installation) • [Agent](#-the-agent) • [Commands](COMMANDS.md) • [Configuration](#-configuration)

</div>

---

## ✨ What it does

It helps you by:

| Feature | Description |
|---------|-------------|
| ⛏️ **Mining** | Can mine specific blocks or strip mine and collect drops |
| 🔨 **Crafting** | Handles recipes fairly well (including utilizing crafting tables) |
| 🛒 **Inventory** | Can check inventory, equip and unequip items |
| 📦 **Organizing** | Remembers where your chests are and what's inside them |
| ⚔️ **Guarding** | Can follow you and fight off mobs (basic combat) attack 1 mob at a time |
| 🏠 **Teleporting** | Saves waypoints and home locations for easy travel |
| 🔌 **Eating and Sleep system** | By using command he can eat when hungry and sleep by finding bed itself |

---

## ⚠️ Known Limitations
*   Intended for **single-player** or private servers.
*   Pathfinding can struggle on complex terrain or long distances.
*   It requires you to be within render distance for some interaction commands.
*   It is a work-in-progress project!

---

## 📦 Installation

### Prerequisites
- **Node.js**: v22 or higher
- **Java**: Java 17+ (for the Minecraft server)
- **Minecraft**: Java Edition 26.1 (the newest version Mineflayer supports; set `bot.version` for older worlds)

### Setup
```bash
# Clone the repository
git clone https://github.com/orbix03/opennova.git
cd opennova

# Install dependencies
npm install

# Configure the bot (edit config/default.json)
# Set your server host, port, and bot username

# Start the bot
npm start
```

---

## 🎮 Basic Usage

Once the bot connects, you control it via chat commands:

```
!come              → Bot walks to your location
!follow            → Bot follows you
!mine iron_ore 5   → Mines 5 iron ore
!craft iron_pickaxe → Crafts a tool (auto-places table if needed)
!sleep             → Finds a bed or goes home to sleep
```

### 📖 [See All 70+ Commands →](COMMANDS.md)

---

## 🧠 The agent

The agent sits on top of the command bot. A language model decides *what* to do; code plans *how* and does it, so most orders need a single model call. The full design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> The agent is new and has only been tested with unit tests and a simulated bot, not yet in a real world. Expect rough edges.

### Talk to it

```
bring me 10 oak logs
make an iron pickaxe
follow me            → no model needed
stop                 → always instant
```

On a server with several players, start the line with the bot's name (`nova, come here`) or whisper it.

### Without a model

These work with no API key and no GPU:

```
!obtain iron_pickaxe     → plans and runs the whole chain: wood, tools, mining, smelting, crafting
!plan diamond_sword      → shows the steps without doing them
!do mine_block blocks=coal_ore count=5
!mode auto               → obey | assist | auto (works through a tech tree by itself)
!trust Steve             → let another player give harmless orders
!agent                   → models, mode, current task, usage
```

Survival reflexes (eat, flee, fight back, surface for air) also run without a model.

### Choose a model

Set two roles in `config/default.json`: `fast` handles normal orders, `smart` is used only when the fast one is stuck.

```json
"llm": {
    "fast":  { "provider": "anthropic", "model": "claude-haiku-5-5", "effort": "low" },
    "smart": { "provider": "anthropic", "model": "claude-opus-5-5", "effort": "medium" }
}
```

| Provider | `provider` value | API key environment variable |
|---|---|---|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |
| Together | `together` | `TOGETHER_API_KEY` |
| Ollama (local) | `ollama` | none |
| LM Studio (local) | `lmstudio` | none |
| Anything OpenAI-compatible | `custom` + `baseURL` | name it with `apiKeyEnv` |

API keys are read from the environment only, never from the config file.

A fully local setup:

```bash
NOVA_FAST_PROVIDER=ollama NOVA_FAST_MODEL=qwen3:14b NOVA_SMART_PROVIDER=none npm start
```

The model needs to support tool calling. Set `settings.owner` to your player name; if it is empty, the first player to speak becomes the owner.

### Tests

```bash
npm test
```

---

## ⚙️ Configuration

Edit `config/default.json` to change settings:

```json
{
    "bot": {
        "username": "OpenNova",
        "port": 25565
    }, ...

}
```

---

## 🤝 Contributing

This is an open-source hobby project. If you find bugs (and you probably will), feel free to open an issue or submit a PR!

---

<div align="center">

Made with ❤️ by Orbix
</div>
