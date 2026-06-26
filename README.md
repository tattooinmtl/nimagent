# NimAgent

A from-scratch terminal coding agent in the style of `pi` / the Claude CLI.
Talks to **OpenAI-compatible** providers (NVIDIA NIM, local llama.cpp, Ollama,
OpenRouter, …), runs a **tool-calling agent loop**, and logs every session as
JSONL — all with zero npm dependencies (pure Node ≥ 20 + built-in `fetch`).

```
███╗   ██╗██╗███╗   ███╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗
████╗  ██║██║████╗ ████║     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
██╔██╗ ██║██║██╔████╔██║████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██║╚██╗██║██║██║╚██╔╝██║╚═══╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
██║ ╚████║██║██║ ╚═╝ ██║     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
```

## Setup

NimAgent ships **with no API keys** — each user supplies their own. On first run
it writes a clean `settings.json` to its home dir (`<install>/agent/`, or
`%NIMAGENT_HOME%`). That file is git-ignored and holds your keys.

Set a key any of these ways:

```powershell
NimAgent --set-key nvidia nvapi-xxxxxxxx   # persist a key, then exit
$env:NIMAGENT_NVIDIA_KEY = "nvapi-xxxxxxxx" # env var (overrides the file)
# …or inside the REPL:  /apikey nvidia nvapi-xxxxxxxx
```

A free NVIDIA NIM key (the default provider) is available at
<https://build.nvidia.com>. For other providers (OpenAI, OpenRouter, a local
llama.cpp server, …) copy [`settings.example.json`](settings.example.json) into
your home dir and edit it, or add them with `/addprovider` and `/addmodel`.

## Usage

Type `NimAgent` anywhere in PowerShell:

```powershell
NimAgent                          # interactive REPL
NimAgent "fix the bug in app.js"  # one-shot mode
NimAgent --model local/coder      # pick a model
NimAgent --resume                 # resume last session
```

### REPL commands
- `/help` — list commands
- `/model [key]` — show or switch model
- `/models` — list configured models
- `/clear` — reset the conversation
- `/cwd` — show working directory
- `/config` — show config + home paths
- `/cost` — show token usage this session
- `/diff` — toggle diff preview for edits
- `/compact` — summarize conversation to save tokens
- `/resume` — resume last session
- `/exit` `/quit` — leave

### Multi-line input
End a line with `\` to continue on the next line.

## Tools the agent can use
Core: `read_file`, `write_file`, `edit_file`, `list_dir` (with recursive option),
`find_files` (fd), `search` (ripgrep), `jq_query` (jq), `run_shell` (PowerShell),
`run_test`.

Via bundled extensions: `move_file`, `copy_file`, `delete_path`, `make_dir`
(file-tools) and `web_search` (DuckDuckGo).

## Config

Lives in `<install>/agent/` (override with `%NIMAGENT_HOME%`):
- `settings.json` — providers, models, defaults
- `sessions/<cwd-slug>/<timestamp>.jsonl` — full session transcripts

Edit `settings.json` to add providers/models (see
[`settings.example.json`](settings.example.json) for the full shape). Each model
maps to a provider's OpenAI-compatible `/chat/completions` endpoint. `//` line
comments are allowed in `settings.json`.

### Local models (llama.cpp)

The `local` provider talks to a bundled `llama-server.exe`. Point `llama.modelsDir`
in your settings at a folder of `.gguf` files, then from the REPL:

```
/llama list            # numbered list of your .gguf models
/llama start 1         # load model #1
/model local/coder     # switch the agent to the local provider
/llama stop | status
```

`contextSize: 0` (or `"auto"`) reads the model's trained context from the GGUF
header. Set `ngl: 0` for CPU-only.

### Environment variables
- `NIMAGENT_HOME` — override config directory
- `NIMAGENT_<PROVIDER>_KEY` — override any provider's API key
  (e.g. `NIMAGENT_NVIDIA_KEY`, `NIMAGENT_OPENAI_KEY`); always wins over the file
- `NO_COLOR` — disable colored output

These can also live in a **`.env` file** (git-ignored) at the install root or
your config dir. Copy [`.env.example`](.env.example) to `.env` and fill it in —
NimAgent loads it on startup. A real shell variable still overrides the file.

## Binaries

NimAgent uses external binaries that are **not committed** to the repo (they're
large and platform-specific):

- `bin/` — [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`),
  [fd](https://github.com/sharkdp/fd), [jq](https://github.com/jqlang/jq).
  Drop the executables here, or install them on your `PATH` (the tools fall back
  to `PATH` automatically).
- `llama/` — [llama.cpp](https://github.com/ggml-org/llama.cpp) release build
  (`llama-server` + its DLLs), only needed for local models.

All are MIT/Apache/permissively licensed; install the builds for your platform.

## Layout
```
.NimAgent/
  bin/nimagent.mjs     entry / REPL
  src/agent.mjs        tool-calling loop + system prompt
  src/provider.mjs     OpenAI-compatible client
  src/tools.mjs        tool schemas + implementations
  src/config.mjs       settings + session logging + cost tracking
  src/ui.mjs           logo, colors, animated status states, token panel,
                       status bar, input frame, diff preview
  agent/settings.json  (generated on first run)
```



