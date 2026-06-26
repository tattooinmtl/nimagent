// Config + session persistence.
//
// Layout (mirrors pi's ~/.pi/agent):
//   <home>/settings.json          provider + model config
//   <home>/sessions/<cwd-slug>/<ts>.jsonl    one line per message/event
//
// <home> resolves to %NIMAGENT_HOME% if set, otherwise <install-dir>/agent,
// where install-dir is the NimAgent project root (parent of this file's dir).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..");

export const HOME =
  process.env.NIMAGENT_HOME || path.join(INSTALL_ROOT, "agent");

export const SETTINGS_PATH = path.join(HOME, "settings.json");
export const SESSIONS_DIR = path.join(HOME, "sessions");

// Default config — the shape NimAgent writes to settings.json on first run.
// IMPORTANT: never hardcode secrets here. API keys start empty and are supplied
// by each user via the REPL (`/apikey <provider> <key>`), by editing their own
// settings.json, or via environment variables:
//   NIMAGENT_NVIDIA_KEY, NIMAGENT_OPENAI_KEY, NIMAGENT_<PROVIDER>_KEY, …
// See settings.example.json for a fully-commented template.
const DEFAULT_SETTINGS = {
  defaultProvider: "nvidia",
  defaultModel: "nvidia/glm-5.1",
  maxToolIterations: 30,
  diffPreview: true,
  providers: {
    nvidia: {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "", // get a free key at https://build.nvidia.com
    },
    local: {
      baseUrl: "http://localhost:8080/v1",
      apiKey: "not-needed", // local llama.cpp server needs no key
    },
  },
  // Local llama.cpp server (bundled llama-server.exe). Drives the "local"
  // provider above. Manage it from the REPL with /llama list|start|stop|status.
  // Point modelsDir at your own .gguf folder; defaultModel is the file loaded by
  // a bare `/llama start`. binDir defaults to <install-root>/llama when omitted.
  llama: {
    binDir: "",
    modelsDir: "C:\\models",
    host: "127.0.0.1",
    port: 8080,
    contextSize: 8192,
    ngl: 99,
    defaultModel: "",
    extraArgs: [],
  },
  models: {
    "nvidia/glm-5.1": { provider: "nvidia", id: "z-ai/glm-5.1", maxTokens: 16384 },
    "nvidia/llama-3.3-70b": { provider: "nvidia", id: "meta/llama-3.3-70b-instruct", maxTokens: 4096 },
    "nvidia/qwen3.5-397b": { provider: "nvidia", id: "qwen/qwen3.5-397b-a17b", maxTokens: 16384 },
    "nvidia/deepseek-v4-pro": { provider: "nvidia", id: "deepseek-ai/deepseek-v4-pro", maxTokens: 16384 },
    "local/coder": { provider: "local", id: "Qwopus3.5-9B-Coder.i1-Q6_K", maxTokens: 8192 },
  },
};

// Load KEY=VALUE pairs from a .env file into process.env (no dependencies).
// Looked for at <install>/.env and <home>/.env. A real shell environment
// variable always wins over the file. This is the gitignored "env" home for
// secrets; the committed .env.example shows the shape.
function loadDotEnv() {
  for (const file of [path.join(INSTALL_ROOT, ".env"), path.join(HOME, ".env")]) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // no .env here — fine
    }
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

// Allow env var overrides for API keys: NIMAGENT_<PROVIDER>_KEY
function applyEnvKeyOverrides(settings) {
  for (const [name, prov] of Object.entries(settings.providers)) {
    const envKey = `NIMAGENT_${name.toUpperCase()}_KEY`;
    if (process.env[envKey]) {
      prov.apiKey = process.env[envKey];
    }
  }
}

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
}

export async function loadSettings() {
  ensureHome();
  loadDotEnv(); // populate process.env from .env before applying key overrides
  try {
    const raw = await fs.promises.readFile(SETTINGS_PATH, "utf8");
    // tolerate // comments like pi's settings
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(stripped) };
    applyEnvKeyOverrides(settings);
    return settings;
  } catch {
    const settings = { ...DEFAULT_SETTINGS };
    applyEnvKeyOverrides(settings);
    return settings;
  }
}

// Persist settings back to settings.json (pretty-printed, UTF-8 no BOM).
// Note: env-var key overrides always win on next load (see applyEnvKeyOverrides).
export async function saveSettings(settings) {
  ensureHome();
  const { _env, ...clean } = settings; // drop any runtime-only fields
  await fs.promises.writeFile(SETTINGS_PATH, JSON.stringify(clean, null, 2), { encoding: "utf8" });
}

export function resolveModel(settings, modelKey) {
  const key = modelKey || settings.defaultModel;
  const m = settings.models[key];
  if (!m) throw new Error(`Unknown model "${key}". Known: ${Object.keys(settings.models).join(", ")}`);
  const provider = settings.providers[m.provider];
  if (!provider) throw new Error(`Provider "${m.provider}" not configured.`);
  return { key, id: m.id, maxTokens: m.maxTokens || 8192, provider, providerName: m.provider };
}

// Whether the active model's provider still needs an API key. The "not-needed"
// sentinel (used by the local llama provider) counts as configured.
export function providerKeyMissing(model) {
  const key = ((model && model.provider && model.provider.apiKey) || "").trim();
  return key === "";
}

// The environment variable that overrides a provider's key (see loadSettings).
export function providerKeyEnvVar(providerName) {
  return `NIMAGENT_${String(providerName).toUpperCase()}_KEY`;
}

function cwdSlug() {
  return (
    "--" +
    process.cwd().replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "") +
    "--"
  );
}

export class Session {
  constructor() {
    ensureHome();
    const dir = path.join(SESSIONS_DIR, cwdSlug());
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(dir, `${ts}.jsonl`);
    this._cost = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.append({ type: "session_start", cwd: process.cwd(), time: new Date().toISOString() });
  }

  get totalTokens() {
    return this._cost.totalTokens;
  }

  async append(record) {
    try {
      await fs.promises.appendFile(this.file, JSON.stringify(record) + "\n");
    } catch {
      /* non-fatal */
    }
  }

  addCost(usage) {
    if (!usage) return;
    this._cost.promptTokens += usage.prompt_tokens || 0;
    this._cost.completionTokens += usage.completion_tokens || 0;
    this._cost.totalTokens += usage.total_tokens || 0;
  }

  get cost() {
    return { ...this._cost };
  }

  resetCost() {
    this._cost = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  // Find the most recent session file for the current cwd
  static async findLast() {
    const dir = path.join(SESSIONS_DIR, cwdSlug());
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort();
    if (files.length === 0) return null;
    const lastFile = path.join(dir, files[files.length - 1]);
    try {
      const lines = await fs.promises.readFile(lastFile, "utf8");
      const records = lines.trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return { file: lastFile, records };
    } catch {
      return null;
    }
  }
}
