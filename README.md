# NimAgent V2

*Vice Summer Edition 2026*

A from-scratch terminal coding agent in the style of `pi` / the Claude CLI.
Talks to **OpenAI-compatible** providers (NVIDIA NIM, local llama.cpp, Ollama,
OpenRouter, …), runs a **tool-calling agent loop**, and logs every session as
JSONL — all with zero npm dependencies (pure Node ≥ 20 + built-in `fetch`).

```
███╗   ██╗██╗███╗   ███╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗   ██╗   ██╗██████╗
████╗  ██║██║████╗ ████║     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝   ██║   ██║╚════██╗
██╔██╗ ██║██║██╔████╔██║████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║      ██║   ██║ █████╔╝
██║╚██╗██║██║██║╚██╔╝██║╚═══╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║      ╚██╗ ██╔╝██╔═══╝
██║ ╚████║██║██║ ╚═╝ ██║     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║       ╚████╔╝ ███████╗
╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝        ╚═══╝  ╚══════╝
                                                      v i c e   s u m m e r   e d i t i o n   2 0 2 6
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
Files & code: `read_file`, `read_many_files`, `write_file`, `edit_file`,
`apply_patch` (multi-file patches), `list_dir` (with recursive option),
`find_files` (fd), `search` (ripgrep), `jq_query` (jq).

Shell & processes: `run_shell` (PowerShell), `run_test`, `start_process` /
`process_status` / `stop_process` (dev servers & watchers).

Project & git: `project_inspect` (stack detection), `project_todo`,
`git_status`, `git_diff`, `git_commit`, `create_markdown_report`.

System diagnostics: `system_info` (OS build, CPU, RAM, GPU, disks),
`dev_env_report` (probes ~85 toolchains in parallel across 16 categories —
JS/TS, Python, PHP, Ruby, Rust, Go, JVM, .NET/C#, C/C++, Perl, other
languages, shells/WSL, version control, containers, databases, utilities —
reporting version + PATH location, flagging missing tools per category and
broken PATH entries, in a few seconds), and `where_is` (locate any executable
on PATH). Use these to tell a code bug from a dependency/PATH problem.

Via bundled extensions: `move_file`, `copy_file`, `delete_path`, `make_dir`
(file-tools), plus `web_search` (DuckDuckGo — no API key or service account),
`web_fetch` (read any http(s) page as plain text), and `youtube_transcript`
(title, channel, description, and full timestamped transcript from a video's
caption tracks — no API key, no external AI service; the agent "watches" a
video by reading its transcript and summarizing it. YouTube URLs passed to
`web_fetch` route here automatically).

Persistent memory: `memory_save`, `memory_search`, `memory_list`,
`memory_forget` — durable facts stored in `<home>/memory.jsonl` that survive
across sessions and projects; recent memories are injected into the system
prompt at startup.

### Tool permissions

Each tool can be set to one of three states in `settings.json` (`permissions`
block) or from the REPL with `/perm <tool|*> <allow|deny|ask>`:

| State | Behavior |
|-------|----------|
| `allow` | Permits the action silently (default) |
| `deny`  | Blocks the action with an error message the model sees |
| `ask`   | Prompts you for confirmation (`y` / `N` / `a` = always this session) |

`*` sets the default for unlisted tools. In one-shot (non-interactive) mode,
`ask` behaves as `deny`.

### Robust tool calling on any provider

Providers without native OpenAI tool calling (e.g. NVIDIA NIM) use a text
protocol: the model emits `<tool_call>` XML that NimAgent parses. The parser
(`src/toolcalls.mjs`) is deliberately tolerant — it accepts the canonical
format plus the formats models were actually trained on (GLM
`<arg_key>/<arg_value>`, Qwen JSON-in-`<tool_call>`, bare `<function=…>`,
unclosed envelopes, and hybrid mixes), with schema-aware argument coercion.
If a tool call still can't be parsed (or the response is truncated by
`max_tokens`), the agent tells the model what went wrong and lets it re-emit
instead of silently ending the turn — up to 3 corrective retries.

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
  src/toolcalls.mjs    tolerant text-protocol tool-call parser + recovery
  src/provider.mjs     OpenAI-compatible client
  src/tools.mjs        tool schemas + implementations (incl. system diagnostics)
  src/config.mjs       settings + session logging + cost tracking
  src/ui.mjs           logo, colors, animated status states, token panel,
                       status bar, input frame, diff preview
  agent/settings.json  (generated on first run)
```

