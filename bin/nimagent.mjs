#!/usr/bin/env node
// NimAgent CLI entry point. Interactive REPL + one-shot mode.

import readline from "node:readline";
import { loadSettings, saveSettings, resolveModel, Session, SETTINGS_PATH, HOME, providerKeyMissing, providerKeyEnvVar } from "../src/config.mjs";
import { listProviderModels, probeModel } from "../src/provider.mjs";
import { systemPrompt, runTurn } from "../src/agent.mjs";
import { registerExtensions } from "../src/tools.mjs";
import { loadProjectConfig, loadSkills, buildSystemPrompt, INSTALL_ROOT, loadMcpConfig } from "../src/extras.mjs";
import { banner, c, errorLine, infoLine, warnLine, costLine, shutdown, promptTop, promptBottom, statusBar, setPersonaIndicator } from "../src/ui.mjs";
import { installPackage, uninstallPackage, listInstalled, searchRegistry, DEFAULT_REGISTRY } from "../src/registry.mjs";
import { registerMcpProxy, disconnectAll, mcpStatus, reconnectServer } from "../src/mcp.mjs";
import * as llama from "../src/llama.mjs";
import { classifyIntent, warmSidecar, killSidecar, PERSONAS } from "../src/router.mjs";
import { registerNimToolsProxy, disconnectBridge, bridgeStatus } from "../src/bridge.mjs";

const settings = await loadSettings();
const args = process.argv.slice(2);

// Project config: extensions + skills + prompt (nimagent.config.json).
const project = loadProjectConfig();
const loadedExtensions = await registerExtensions(INSTALL_ROOT, project.extensions || []);
const skills = loadSkills(project);
const skillByCommand = new Map(skills.map((s) => [s.command, s]));

// MCP: register the single `mcp` proxy tool (+ any cached directTools). No
// servers connect here — connections are lazy, on first call. See src/mcp.mjs.
const mcpInfo = registerMcpProxy(loadMcpConfig(project));

// NimTools bridge: register the single `nimtools` proxy tool (gated on bridge.enabled).
// Warm-starts bridge_server.py so the first real call has no spawn latency.
const bridgeCfg = settings.bridge || project.bridge || {};
if (bridgeCfg.enabled) {
  registerNimToolsProxy(bridgeCfg);
}

// Intent router: warm-start the Python sidecar so first-turn classification
// has no latency. Gated on router.enabled.
const routerCfg = settings.router || project.router || {};
if (routerCfg.enabled) {
  warmSidecar(settings);
}

// Active persona — null means router is off; routing uses PERSONAS directly.
let activePersona = null;
let routeMode = routerCfg.mode || "auto"; // "auto" | "manual"
let routePinned = false; // true when user manually pinned via /route
let lastFetchedModels = [];
let currentAbort = null;

const PROVIDER_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", label: "OpenAI", reasoningParam: "reasoning_effort" },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    label: "NVIDIA NIM",
    api: "openai-completions",
    nativeTools: false,
  },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter", reasoningParam: "none" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", label: "Groq", reasoningParam: "none" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", label: "DeepSeek" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", label: "Google Gemini" },
  xai: { baseUrl: "https://api.x.ai/v1", label: "xAI" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", label: "Mistral", reasoningParam: "none" },
  together: { baseUrl: "https://api.together.xyz/v1", label: "Together AI", reasoningParam: "none" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", label: "Fireworks", reasoningParam: "none" },
  ollama: { baseUrl: "http://localhost:11434/v1", label: "Ollama", apiKey: "not-needed", reasoningParam: "none" },
  local: { baseUrl: "http://localhost:8080/v1", label: "Local llama.cpp", apiKey: "not-needed", reasoningParam: "none" },
};

// Package-management subcommands run once and exit (no model/API key needed):
//   nimagent install <name> | uninstall <name> | list | search <query>
const PKG_CMDS = new Set(["install", "uninstall", "remove", "list", "search"]);
if (PKG_CMDS.has(args[0])) {
  const [sub, ...rest] = args;
  const baseUrl = process.env.NIMAGENT_REGISTRY || project.registry || DEFAULT_REGISTRY;
  try {
    if (sub === "install") {
      const name = rest[0];
      if (!name) throw new Error("usage: nimagent install <package-name>");
      infoLine(`installing ${name} from ${baseUrl} …`);
      const { manifest, installedPaths, needsRestart } = await installPackage(name, { baseUrl });
      infoLine(`installed ${manifest.name}@${manifest.version || "?"} (${manifest.type}) → ${installedPaths.join(", ")}`);
      if (needsRestart) infoLine("restart NimAgent to load it.");
      else infoLine(manifest.command ? `use it with ${manifest.command}` : "ready to use.");
    } else if (sub === "uninstall" || sub === "remove") {
      const name = rest[0];
      if (!name) throw new Error("usage: nimagent uninstall <package-name>");
      const rec = uninstallPackage(name);
      infoLine(`uninstalled ${rec.name} (${rec.type}) — removed ${(rec.installedPaths || []).join(", ")}`);
    } else if (sub === "list") {
      const installed = listInstalled();
      if (!installed.length) infoLine("no packages installed. Browse: " + baseUrl);
      else for (const p of installed) console.log(`  ${p.name.padEnd(24)} ${c.dim(`${p.type} ${p.version}`)}  ${p.description || ""}`);
    } else if (sub === "search") {
      const results = await searchRegistry(rest.join(" "), { baseUrl });
      if (!results.length) infoLine("no matching packages.");
      else for (const p of results) console.log(`  ${p.name.padEnd(24)} ${c.dim(`${p.type} ${p.version || ""}`)}  ${p.description || ""}\n    ${c.dim("nimagent install " + p.name)}`);
    }
    process.exit(0);
  } catch (e) {
    errorLine(e.message);
    process.exit(1);
  }
}

// Inject a skill's instructions as a system message, then queue the user's args.
async function applySkill(skill, arg, msgs, sess) {
  msgs.push({
    role: "system",
    content: `# Skill: ${skill.name}\n${skill.body}`,
  });
  const userMsg = arg ? `Run the "${skill.name}" skill. Arguments: ${arg}` : `Run the "${skill.name}" skill.`;
  msgs.push({ role: "user", content: userMsg });
  await sess.append({ type: "skill", skill: skill.name, arg });
}

// Rebuild the in-memory message list from a saved session's records.
// Shared by the /resume command and the --resume CLI flag.
function restoreSessionMessages(records, msgs) {
  for (const rec of records) {
    if (rec.type === "user") {
      msgs.push({ role: "user", content: rec.content });
    } else if (rec.type === "assistant" && rec.message) {
      msgs.push(rec.message);
    } else if (rec.type === "tool" && rec.tool_call_id) {
      msgs.push({
        role: "tool",
        tool_call_id: rec.tool_call_id,
        content: typeof rec.result === "string" ? rec.result : JSON.stringify(rec.result),
      });
    }
  }
}

// Print setup guidance when the active model's provider has no API key.
// Returns true if a key is missing.
function reportMissingKey(model) {
  if (!providerKeyMissing(model)) return false;
  const prov = model.providerName;
  warnLine(`No API key configured for provider "${prov}".`);
  infoLine(`Set one of:`);
  infoLine(`  • in the REPL:   /apikey ${prov} <your-key>`);
  infoLine(`  • env variable:  ${providerKeyEnvVar(prov)}=<your-key>`);
  infoLine(`  • edit:          ${SETTINGS_PATH}`);
  if (prov === "nvidia") infoLine(`Get a free NVIDIA NIM key at https://build.nvidia.com`);
  return true;
}

// Mask a secret for display: nvapi-1…WxYz
function maskKey(k) {
  if (!k) return "(none)";
  if (k.length <= 10) return "****";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

function normalizeProviderKey(name) {
  return String(name || "").trim().toLowerCase();
}

function modelKeyFor(providerName, id) {
  const safe = String(id).replace(/^models\//, "").replace(/[^a-zA-Z0-9._:-]+/g, "-");
  return `${providerName}/${safe}`;
}

function printReasoningChoices() {
  const current = settings.reasoning || "medium";
  infoLine(`reasoning: ${current}`);
  console.log("    off     no reasoning-effort parameter");
  console.log("    low     faster / cheaper");
  console.log("    medium  balanced default");
  console.log("    high    deeper reasoning");
  console.log("    extra   maximum effort where supported (sent as high to OpenAI-compatible APIs)");
  console.log(c.dim("    usage: /reasoning low|medium|high|extra|off"));
}

async function setReasoningTier(tier) {
  const t = String(tier || "").toLowerCase();
  if (!t) return printReasoningChoices();
  if (!["off", "low", "medium", "high", "extra"].includes(t)) {
    errorLine("usage: /reasoning low|medium|high|extra|off");
    return;
  }
  settings.reasoning = t;
  await saveSettings(settings);
  try { model = resolveModel(settings, model.key); } catch { /* keep current */ }
  infoLine(`reasoning set to ${t} (saved)`);
}

function installProviderPreset(name, key = "") {
  const prov = normalizeProviderKey(name);
  const preset = PROVIDER_PRESETS[prov];
  if (!preset) throw new Error(`unknown provider preset "${name}"`);
  settings.providers[prov] = {
    ...(settings.providers[prov] || {}),
    ...preset,
    apiKey: key || settings.providers[prov]?.apiKey || preset.apiKey || "",
  };
  return prov;
}

function printProviderPresets() {
  console.log("  Provider presets:");
  for (const [name, p] of Object.entries(PROVIDER_PRESETS)) {
    console.log(`    ${name.padEnd(12)} ${c.dim(p.baseUrl)}`);
  }
  console.log(c.dim("  usage: /provider setup <name> [apiKey]"));
}

async function fetchModelsForProvider(providerName, { save = true, filter = "" } = {}) {
  const provKey = normalizeProviderKey(providerName || model.providerName);
  const provider = settings.providers[provKey];
  if (!provider) throw new Error(`unknown provider "${provKey}"`);
  if (providerKeyMissing({ provider }) && provider.apiKey !== "not-needed") {
    throw new Error(`provider "${provKey}" needs an API key (/provider login ${provKey} <key>)`);
  }
  let ids = await listProviderModels(provider);
  if (provKey === "nvidia") {
    ids = ids.filter((id) => id !== "z-ai/glm-5.1");
    if (!ids.includes("z-ai/glm-5.2")) ids.push("z-ai/glm-5.2");
    ids.sort((a, b) => a.localeCompare(b));
  }
  const q = String(filter || "").toLowerCase();
  const shown = q ? ids.filter((id) => id.toLowerCase().includes(q)) : ids;
  lastFetchedModels = shown.map((id, i) => ({ index: i + 1, provider: provKey, id, key: modelKeyFor(provKey, id) }));
  if (save) {
    for (const row of lastFetchedModels) {
      const existing = settings.models[row.key] || {};
      settings.models[row.key] = {
        ...existing,
        provider: row.provider,
        id: row.id,
        maxTokens: existing.maxTokens || 8192,
      };
    }
    await saveSettings(settings);
  }
  if (!lastFetchedModels.length) {
    infoLine(`no models returned for ${provKey}${q ? ` matching "${filter}"` : ""}`);
    return;
  }
  infoLine(`${provKey}: ${lastFetchedModels.length} model(s)${save ? " saved" : ""}`);
  for (const row of lastFetchedModels.slice(0, 80)) {
    const active = row.key === model.key ? c.green("● ") : "  ";
    console.log(`    ${active}${String(row.index).padStart(2)}. ${row.key}${modelHealthLabel(row.key)}`);
  }
  if (lastFetchedModels.length > 80) console.log(c.dim(`    ... ${lastFetchedModels.length - 80} more`));
  console.log(c.dim("    choose with /model for arrows, /model <number>, or /model <provider/model>"));
  return lastFetchedModels;
}

function modelHealthLabel(key) {
  const health = settings.models[key]?.health;
  if (!health) return c.dim(" [?]");
  if (health.ok) return c.green(" [ok]");
  if (health.degraded) return c.red(" [degraded]");
  if (health.retired) return c.red(" [retired]");
  if (health.timeout) return c.yellow(" [timeout]");
  return c.yellow(" [unavailable]");
}

function trimHealthMessage(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

async function doctorModel(keyOrProvider = "") {
  const wanted = String(keyOrProvider || "").trim();
  let key = wanted || model.key;
  if (settings.providers[wanted] && !settings.models[wanted]) key = model.key;
  if (!settings.models[key] && wanted.includes("/")) {
    const slash = wanted.indexOf("/");
    const prov = wanted.slice(0, slash);
    const id = wanted.slice(slash + 1);
    if (settings.providers[prov]) {
      key = wanted;
      settings.models[key] = { provider: prov, id, maxTokens: 8192 };
    }
  }
  const resolved = resolveModel(settings, key);
  infoLine(`probing ${resolved.key} (${resolved.id}) ...`);
  const health = await probeModel(resolved);
  settings.models[resolved.key].health = health;
  await saveSettings(settings);
  if (health.ok) {
    infoLine(`${resolved.key}: ok`);
    return health;
  }
  const label = health.degraded ? "degraded" : health.retired ? "retired" : health.timeout ? "timeout" : "unavailable";
  warnLine(`${resolved.key}: ${label} — ${trimHealthMessage(health.message)}`);
  return health;
}

function activeModelBlockedByHealth() {
  const health = settings.models[model.key]?.health;
  if (!health || health.ok) return false;
  const checked = Date.parse(health.checkedAt || "");
  const fresh = Number.isFinite(checked) && (Date.now() - checked) < 10 * 60 * 1000;
  if (!fresh) return false;
  const label = health.degraded ? "degraded" : health.retired ? "retired" : health.timeout ? "timed out" : "unavailable";
  errorLine(`${model.key} is ${label}: ${trimHealthMessage(health.message)}`);
  infoLine("run /doctor to re-check, or choose another model with /model");
  return true;
}

function renderModelPicker(rows, selected, providerName) {
  const max = Math.min(rows.length, 18);
  const half = Math.floor(max / 2);
  let start = Math.max(0, selected - half);
  start = Math.min(start, Math.max(0, rows.length - max));
  const visible = rows.slice(start, start + max);
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(c.bold(`Select model (${providerName})`));
  console.log(c.dim("Use ↑/↓, Enter to select, Esc/q to cancel\n"));
  for (let i = 0; i < visible.length; i++) {
    const rowIndex = start + i;
    const row = visible[i];
    const pointer = rowIndex === selected ? c.cyan("›") : " ";
    const active = row.key === model.key ? c.green("●") : " ";
    const label = `${pointer} ${active} ${String(row.index).padStart(2)}. ${row.key}${modelHealthLabel(row.key)}`;
    console.log(rowIndex === selected ? c.bold(label) : label);
  }
  if (rows.length > max) {
    console.log(c.dim(`\n${selected + 1}/${rows.length}`));
  }
}

async function pickModelWithArrows(providerName = model.providerName, filter = "") {
  const rows = await fetchModelsForProvider(providerName, { save: true, filter });
  if (!rows?.length) return;
  if (!canRaw) {
    warnLine("arrow picker needs an interactive terminal; use /model <number> instead");
    return;
  }

  let selected = Math.max(0, rows.findIndex((row) => row.key === model.key));
  if (selected < 0) selected = 0;

  rl.pause();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");

  try {
    const chosen = await new Promise((resolve) => {
      const onKeypress = (_str, key = {}) => {
        if (key.name === "up") {
          selected = (selected - 1 + rows.length) % rows.length;
          renderModelPicker(rows, selected, providerName);
          return;
        }
        if (key.name === "down") {
          selected = (selected + 1) % rows.length;
          renderModelPicker(rows, selected, providerName);
          return;
        }
        if (key.name === "pageup") {
          selected = Math.max(0, selected - 10);
          renderModelPicker(rows, selected, providerName);
          return;
        }
        if (key.name === "pagedown") {
          selected = Math.min(rows.length - 1, selected + 10);
          renderModelPicker(rows, selected, providerName);
          return;
        }
        if (key.name === "return") {
          cleanup();
          resolve(rows[selected]);
          return;
        }
        if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
          cleanup();
          resolve(null);
        }
      };
      const cleanup = () => {
        process.stdin.off("keypress", onKeypress);
      };
      process.stdin.on("keypress", onKeypress);
      renderModelPicker(rows, selected, providerName);
    });
    process.stdout.write("\x1b[?25h");
    process.stdin.setRawMode(false);
    console.log("");
    if (!chosen) {
      infoLine("model selection canceled");
      return;
    }
    await switchModel(chosen.key);
  } finally {
    process.stdout.write("\x1b[?25h");
    if (canRaw) process.stdin.setRawMode(false);
    rl.resume();
  }
}

async function ensureLocalModelStarted(selectedModel = model) {
  if (selectedModel.providerName !== "local") return;
  const s = llama.status();
  if (s.running) return;
  const cfg = llama.llamaConfig(settings);
  const target = cfg.defaultModel || selectedModel.id;
  if (!target) {
    warnLine("local provider selected, but no local model is configured. Use /llama list then /llama start <number>.");
    return;
  }
  infoLine(`auto-starting local llama server (${target}) ...`);
  const info = await llama.startServer(settings, target, { onLog: (m) => warnLine(m) });
  settings.providers.local.baseUrl = info.url;
  settings.models["local/coder"] = {
    ...(settings.models["local/coder"] || {}),
    provider: "local",
    id: info.model,
    maxTokens: info.contextSize || settings.models["local/coder"]?.maxTokens || 8192,
  };
  settings.llama = { ...(settings.llama || {}), defaultModel: info.model };
  await saveSettings(settings);
  infoLine(`local llama server ready — ${info.model} @ ${info.url}`);
}

async function switchModel(keyOrIndex) {
  const wanted = String(keyOrIndex || "").trim();
  if (!wanted) {
    infoLine("current model: " + model.key);
    try {
      await fetchModelsForProvider(model.providerName, { save: true });
    } catch (e) {
      warnLine(`could not fetch live models for ${model.providerName}: ${e.message}`);
      infoLine("configured models:");
      for (const k of Object.keys(settings.models)) {
        const m = settings.models[k];
        if (m.provider !== model.providerName) continue;
        const marker = k === model.key ? c.green("● ") : "  ";
        console.log("    " + marker + k + modelHealthLabel(k));
      }
    }
    infoLine("use /model <number|provider/model> to switch, /reasoning for Low/Medium/High/Extra");
    return;
  }
  let key = wanted;
  if (/^\d+$/.test(wanted)) {
    if (!lastFetchedModels.length) {
      await fetchModelsForProvider(model.providerName, { save: true });
    }
    const row = lastFetchedModels[parseInt(wanted, 10) - 1];
    if (!row) throw new Error(`no fetched model #${wanted}`);
    key = row.key;
  }
  if (!settings.models[key] && key.includes("/")) {
    const slash = key.indexOf("/");
    const prov = key.slice(0, slash);
    const id = key.slice(slash + 1);
    if (settings.providers[prov]) {
      settings.models[key] = { provider: prov, id, maxTokens: 8192 };
      await saveSettings(settings);
    }
  }
  model = resolveModel(settings, key);
  if (model.providerName !== "local" && model.provider.apiKey !== "not-needed") {
    const health = await doctorModel(model.key);
    if (!health.ok) {
      warnLine(`selected model is ${health.degraded ? "degraded" : health.retired ? "retired" : "unavailable"} at the provider; choose another with /model`);
    }
  }
  await ensureLocalModelStarted(model);
  infoLine(`switched to ${model.key} (${model.providerLabel}, reasoning=${model.reasoning})`);
}

// --set-key <provider> <key>  : set & persist an API key, then exit (non-interactive).
const ski = args.indexOf("--set-key");
if (ski !== -1) {
  const prov = args[ski + 1];
  const key = args[ski + 2];
  if (!prov || !key) {
    errorLine("usage: NimAgent --set-key <provider> <apiKey>");
    process.exit(1);
  }
  if (!settings.providers[prov]) {
    settings.providers[prov] = { baseUrl: "", apiKey: "" };
    warnLine(`provider "${prov}" was not configured; created it (set its baseUrl in settings.json)`);
  }
  settings.providers[prov].apiKey = key;
  await saveSettings(settings);
  infoLine(`saved API key for ${prov}: ${maskKey(key)}`);
  process.exit(0);
}

// --model <key> flag
let modelKey = settings.defaultModel;
const mi = args.indexOf("--model");
if (mi !== -1 && args[mi + 1]) {
  modelKey = args.splice(mi, 2)[1];
}

// --resume flag: continue last session
let resumeMode = false;
const ri = args.indexOf("--resume");
if (ri !== -1) {
  args.splice(ri, 1);
  resumeMode = true;
}

let model;
try {
  model = resolveModel(settings, modelKey);
} catch (e) {
  errorLine(e.message);
  process.exit(1);
}

const session = new Session();
const messages = [{ role: "system", content: buildSystemPrompt(project, skills) }];
const maxIterations = settings.maxToolIterations || 30;

// One-shot mode: `NimAgent "do this"` or `NimAgent /doctor <path>` runs once and exits.
const promptArg = args.filter((a) => !a.startsWith("--")).join(" ").trim();
if (promptArg) {
  // One-shot can't prompt for a key interactively — fail fast with guidance.
  if (reportMissingKey(model)) {
    await shutdown(1);
  } else {
    const firstWord = promptArg.split(/\s+/)[0];
    const skill = skillByCommand.get(firstWord);
    if (skill) {
      await applySkill(skill, promptArg.slice(firstWord.length).trim(), messages, session);
    } else {
      messages.push({ role: "user", content: promptArg });
      await session.append({ type: "user", content: promptArg });
    }
    if (routerCfg.enabled && !routePinned) {
      activePersona = await classifyIntent({ message: promptArg, settings });
    }
    if (activeModelBlockedByHealth()) {
      await shutdown(1);
    }
    currentAbort = new AbortController();
    await runTurn({ model, messages, session, maxIterations, persona: activePersona, signal: currentAbort.signal });
    currentAbort = null;
    costLine(session);
    await shutdown(0);
  }
}

// Interactive mode (only when no one-shot prompt was given).
if (!promptArg) {
banner(model.key);
if (loadedExtensions.length || skills.length || mcpInfo.servers) {
  infoLine(
    `loaded ${loadedExtensions.length} extension(s), ${skills.length} skill(s), ${mcpInfo.servers} MCP server(s)` +
      (skills.length ? " — " + skills.map((s) => s.command).join(" ") : "")
  );
  console.log("");
}

// First-run onboarding: guide the user to configure a key if none is set.
if (reportMissingKey(model)) console.log("");

// --resume: rebuild the conversation from the last session before prompting.
if (resumeMode) {
  const lastSession = await Session.findLast();
  if (!lastSession) {
    warnLine("--resume: no previous session found for this directory");
  } else {
    restoreSessionMessages(lastSession.records, messages);
    infoLine(`resumed ${messages.length} message(s) from ${lastSession.file}`);
    console.log("");
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: c.cyan("› "),
});

// Ctrl-C interrupt: wired to BOTH process and rl.
// process.on fires when readline is paused (rl.pause() mutes rl.on("SIGINT") on Windows).
// rl.on fires when readline is active and reading input.
const handleInterrupt = () => {
  if (currentAbort) {
    currentAbort.abort();
  } else {
    rl.close();
  }
};
process.on("SIGINT", handleInterrupt);
rl.on("SIGINT", handleInterrupt);

// ESC detection via raw mode. Only enabled while readline is paused (during generation)
// so readline echoing is never affected. In raw mode Ctrl-C arrives as 0x03, caught here too.
const canRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
if (canRaw) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("data", (chunk) => {
    if (currentAbort && (chunk[0] === 0x1b || chunk[0] === 0x03)) {
      currentAbort.abort();
    }
  });
}
const startInterruptWatch = () => { if (canRaw) { process.stdin.setRawMode(true); process.stdin.resume(); } };
const stopInterruptWatch  = () => { if (canRaw) { process.stdin.setRawMode(false); } };

// Multi-line support: lines ending with \ continue input
let multiLine = "";

function help() {
  console.log(
    [
      "",
      "  Commands:",
      "    /                             show this command menu",
      "    /help                         show this help",
      "    /model [provider|key|number]  arrow-select model, or switch by key/number",
      "    /models [provider] [filter]   fetch available models from provider and save them",
      "    /reasoning [tier]             show/set reasoning: off, low, medium, high, extra",
      "    /default [key]                set the default model (persisted)",
      "    /doctor [model]               probe active/named model and save health status",
      "    /addmodel <key> <prov> <id> [maxTokens]   add a model (persisted)",
      "    /provider [name|subcmd]        switch/provider setup (list, presets, setup, add, edit, login, logout, apikey)",
      "    /providers                    list providers + masked keys",
      "    /llama list                   list local models numbered",
      "    /llama start <number>         load a model by its list number (or /llama <number>)",
      "    /llama default <number>       set default local GGUF and auto-start it",
      "    /llama stop | status          stop / show the local llama server",
      "    /apikey <provider> [key]      show or set a provider API key (persisted)",
      "    /addprovider <name> <url> [key]           add a provider (persisted)",
      "    /clear                        reset the conversation",
      "    /cwd                          show working directory",
      "    /config                       show config file path",
      "    /cost                         show token usage this session",
      "    /diff                         toggle diff preview for edits",
      "    /compact                      compact conversation when it gets long",
      "    /compact now                  force compact immediately (no minimum length)",
      "    /resume                       resume last session",
      "    /packages                     list installed packages",
      "    /install <name>               install a package from the registry",
      "    /uninstall <name>             remove an installed package",
      "    /mcp [reconnect <server>]     MCP server status / reconnect",
      "    /route [coding|assistant|auto] show or pin the active persona",
      "    /bridge                       NimTools bridge status + tool count",
      "    /exit, /quit                  leave NimAgent",
      "",
      "  Multi-line: end a line with \\ to continue on the next line.",
      "  Anything else is sent to the agent.",
      "",
    ].join("\n")
  );
}

let diffPreview = settings.diffPreview ?? true;

// /llama — manage the bundled local llama.cpp server (see src/llama.mjs).
async function llamaCommand(sub, subArg) {
  const cfg = llama.llamaConfig(settings);

  // Allow "/llama 3" as a shortcut for "/llama start 3".
  if (/^\d+$/.test(sub)) {
    subArg = sub;
    sub = "start";
  }

  // A bare number (or empty) given to start selects from the numbered list.
  function pickModel(arg) {
    const models = llama.listModels(settings);
    if (/^\d+$/.test(arg)) {
      const idx = parseInt(arg, 10) - 1;
      if (idx < 0 || idx >= models.length) {
        throw new Error(`no model #${arg} — run /llama list (1-${models.length})`);
      }
      return models[idx];
    }
    return arg; // fall through to name/substring resolution in startServer
  }

  switch (sub || "status") {
    case "list":
    case "ls":
    case "models": {
      const models = llama.listModels(settings);
      if (!models.length) {
        warnLine(`no .gguf models found in ${cfg.modelsDir}`);
        break;
      }
      infoLine(`models in ${cfg.modelsDir} — load with /llama start <number>:`);
      const running = llama.status();
      const width = String(models.length).length;
      models.forEach((m, i) => {
        const mark = running.running && running.model === m ? c.green("●") : " ";
        const num = c.cyan(String(i + 1).padStart(width));
        const def = m === cfg.defaultModel ? c.dim(" (default)") : "";
        const insp = llama.inspectModel(settings, m);
        const ctx = insp && insp.contextLength ? `${Math.round(insp.contextLength / 1024)}k ctx` : "?ctx";
        const think = insp && insp.thinking ? c.magenta(" 🧠") : "";
        console.log(`    ${mark} ${num}. ${m}${def}  ${c.dim(ctx)}${think}`);
      });
      break;
    }
    case "status": {
      const s = llama.status();
      if (s.running) {
        infoLine(`llama server running — ${s.model} @ ${s.url} (pid ${s.pid})`);
      } else {
        infoLine(`llama server not running. Start with /llama start [model]`);
        infoLine(`bin: ${cfg.exe}`);
      }
      break;
    }
    case "stop": {
      if (llama.stopServer()) infoLine("llama server stopped");
      else warnLine("no llama server running");
      break;
    }
    case "default":
    case "use":
    case "setup": {
      let target;
      try {
        target = pickModel(subArg);
      } catch (e) {
        errorLine(e.message);
        break;
      }
      if (!target) {
        warnLine("which model? run /llama list, then /llama default <number>");
        break;
      }
      settings.llama = { ...(settings.llama || {}), defaultModel: target };
      installProviderPreset("local");
      settings.models["local/coder"] = {
        ...(settings.models["local/coder"] || {}),
        provider: "local",
        id: target,
        maxTokens: settings.models["local/coder"]?.maxTokens || 8192,
      };
      await saveSettings(settings);
      infoLine(`default local model set to ${target}`);
      if (!llama.status().running) {
        infoLine("starting local llama server ...");
        try {
          const info = await llama.startServer(settings, target, { onLog: (m) => warnLine(m) });
          settings.providers.local.baseUrl = info.url;
          settings.models["local/coder"].id = info.model;
          settings.models["local/coder"].maxTokens = info.contextSize || settings.models["local/coder"].maxTokens;
          await saveSettings(settings);
          model = resolveModel(settings, "local/coder");
          infoLine(`local model ready and selected — ${info.model} @ ${info.url}`);
        } catch (e) {
          errorLine(e.message);
        }
      } else {
        model = resolveModel(settings, "local/coder");
        infoLine("local provider selected; existing llama server is running");
      }
      break;
    }
    case "start":
    case "load": {
      let target;
      try {
        target = pickModel(subArg) || cfg.defaultModel;
      } catch (e) {
        errorLine(e.message);
        break;
      }
      if (!target) {
        warnLine("which model? run /llama list, then /llama start <number>");
        break;
      }
      infoLine(`starting llama server (${target}) — loading model, please wait…`);
      try {
        const info = await llama.startServer(settings, target, { onLog: (m) => warnLine(m) });
        const think = info.thinking ? " · thinking 🧠" : "";
        infoLine(`llama server ready — ${info.model} @ ${info.url} (${info.contextSize} ctx${think})`);
        // Point the "local" provider at the live server and offer a quick switch.
        installProviderPreset("local");
        settings.providers.local.baseUrl = info.url;
        settings.llama = { ...(settings.llama || {}), defaultModel: info.model };
        settings.models["local/coder"] = {
          ...(settings.models["local/coder"] || {}),
          provider: "local",
          id: info.model,
          maxTokens: info.contextSize || settings.models["local/coder"]?.maxTokens || 8192,
        };
        await saveSettings(settings);
        model = resolveModel(settings, "local/coder");
        infoLine("local provider selected: /model local/coder");
      } catch (e) {
        errorLine(e.message);
      }
      break;
    }
    default:
      errorLine(`unknown /llama subcommand "${sub}". Usage: /llama [list|default <number>|start [model]|stop|status]`);
  }
}

// Render the input frame: a status bar (context usage + model) and a top
// separator line above the input. The matching bottom line is printed once the
// user submits, sandwiching their input — a bit like a bottom command panel.
function clearPendingInput() {
  if (typeof rl.line === "string") rl.line = "";
  if (typeof rl.cursor === "number") rl.cursor = 0;
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

function showPrompt() {
  clearPendingInput();
  statusBar(model, session);
  promptTop();
  rl.prompt();
}

showPrompt();

rl.on("line", async (input) => {
  const line = input.trim();

  // Multi-line continuation
  if (line.endsWith("\\") && !line.startsWith("/")) {
    multiLine += line.slice(0, -1) + "\n";
    process.stdout.write(c.dim("… "));
    return;
  }

  const fullLine = multiLine + line;
  multiLine = "";

  if (!fullLine) return showPrompt();

  // Close the input frame: bottom yellow separator under what was typed.
  promptBottom();

  if (fullLine.startsWith("/")) {
    const parts = fullLine.split(/\s+/);
    const cmd = parts[0];
    const arg = parts.slice(1).join(" ");

    if (cmd === "/" || cmd === "/---" || cmd === "/-") {
      help();
      if (skills.length) {
        console.log("  Skills:");
        for (const s of skills) console.log(`    ${s.command.padEnd(16)} ${c.dim(s.description)}`);
        console.log("");
      }
      return showPrompt();
    }

    // Skill commands (from skills/*/SKILL.md) run a turn with skill instructions.
    if (skillByCommand.has(cmd)) {
      await applySkill(skillByCommand.get(cmd), arg, messages, session);
      rl.pause();
      startInterruptWatch();
      currentAbort = new AbortController();
      await runTurn({ model, messages, session, maxIterations, diffPreview, persona: activePersona, signal: currentAbort.signal });
      currentAbort = null;
      stopInterruptWatch();
      console.log("");
      clearPendingInput();
      rl.resume();
      return showPrompt();
    }

    switch (cmd) {
      case "/exit":
      case "/quit":
        rl.close();
        return;
      case "/help":
        help();
        if (skills.length) {
          console.log("  Skills:");
          for (const s of skills) console.log(`    ${s.command.padEnd(16)} ${c.dim(s.description)}`);
          console.log("");
        }
        break;
      case "/clear":
        messages.length = 1; // keep system prompt
        session.resetCost();
        infoLine("conversation cleared");
        break;
      case "/cwd":
        infoLine(process.cwd());
        break;
      case "/config":
        infoLine("config: " + SETTINGS_PATH);
        infoLine("home:   " + HOME);
        infoLine("install: " + INSTALL_ROOT);
        break;
      case "/cost":
        costLine(session);
        break;
      case "/diff":
        diffPreview = !diffPreview;
        infoLine("diff preview: " + (diffPreview ? "on" : "off"));
        break;
      case "/compact": {
        const force = arg.trim().toLowerCase() === "now";
        if (!force && messages.length <= 3) {
          infoLine("conversation too short to compact — use /compact now to force");
          break;
        }
        const sys = messages[0];
        const trail = force ? [] : messages.slice(-2);
        messages.length = 0;
        messages.push(sys);
        messages.push({
          role: "system",
          content: "[Earlier conversation was compacted. Continue from here.]",
        });
        messages.push(...trail);
        infoLine(`compacted conversation (${messages.length} message(s) remaining)`);
        break;
      }
      case "/models":
        {
          const [providerArg, ...filterParts] = arg.trim().split(/\s+/).filter(Boolean);
          if (providerArg) {
            try {
              await fetchModelsForProvider(providerArg, { save: true, filter: filterParts.join(" ") });
            } catch (e) {
              errorLine(e.message);
            }
          } else {
            infoLine("configured models:");
            for (const k of Object.keys(settings.models)) {
              const m = settings.models[k];
              const marker = k === model.key ? c.green("● ") : "  ";
              const info = m.provider ? c.dim(` (${m.provider})`) : "";
              console.log("    " + marker + k + info + modelHealthLabel(k));
            }
            infoLine(`fetch live models with /models <provider>; current provider: ${model.providerName}`);
          }
        }
        break;
      case "/model":
        try {
          const wanted = arg.trim();
          if (!wanted) {
            await pickModelWithArrows(model.providerName);
          } else if (settings.providers[normalizeProviderKey(wanted)]) {
            await pickModelWithArrows(normalizeProviderKey(wanted));
          } else {
            await switchModel(wanted);
          }
        } catch (e) {
          errorLine(e.message);
        }
        break;
      case "/reasoning":
        await setReasoningTier(arg.trim());
        break;
      case "/doctor":
        try {
          await doctorModel(arg);
        } catch (e) {
          errorLine(e.message);
        }
        break;
      case "/resume": {
        const lastSession = await Session.findLast();
        if (!lastSession) {
          warnLine("no previous session found");
          break;
        }
        infoLine("resuming from " + lastSession.file);
        restoreSessionMessages(lastSession.records, messages);
        infoLine("restored " + messages.length + " messages");
        break;
      }
      case "/providers": {
        for (const [name, p] of Object.entries(settings.providers)) {
          const mark = name === model.providerName ? c.green("● ") : "  ";
          const display = p.label || p.baseUrl || "(no baseUrl)";
          console.log("    " + mark + name + c.dim(`  ${display}  key=${maskKey(p.apiKey)}`));
        }
        console.log(c.dim("    presets: /provider presets, setup: /provider setup <name> [apiKey]"));
        break;
      }
      case "/llama": {
        const sub = parts[1] || "";
        const subArg = parts.slice(2).join(" ").trim();
        await llamaCommand(sub, subArg);
        break;
      }
      case "/apikey": {
        const [prov, ...rest] = arg.split(/\s+/);
        if (!prov) {
          for (const [name, p] of Object.entries(settings.providers)) {
            infoLine(`${name}: ${maskKey(p.apiKey)}`);
          }
          infoLine("usage: /apikey <provider> <key>");
          break;
        }
        if (!settings.providers[prov]) {
          errorLine(`unknown provider "${prov}" (try /providers, or /addprovider)`);
          break;
        }
        const key = rest.join(" ").trim();
        if (!key) {
          infoLine(`${prov}: ${maskKey(settings.providers[prov].apiKey)}`);
          break;
        }
        settings.providers[prov].apiKey = key;
        await saveSettings(settings);
        // Re-resolve so the active model picks up the new key immediately.
        try { model = resolveModel(settings, model.key); } catch { /* keep current */ }
        infoLine(`updated API key for ${prov}: ${maskKey(key)} (saved)`);
        break;
      }
      case "/addprovider": {
        const [name, baseUrl, ...keyParts] = arg.split(/\s+/);
        if (!name || !baseUrl) {
          errorLine("usage: /addprovider <name> <baseUrl> [apiKey]");
          break;
        }
        settings.providers[name] = { baseUrl, apiKey: keyParts.join(" ").trim() || "not-needed" };
        await saveSettings(settings);
        infoLine(`added provider ${name} -> ${baseUrl} (saved)`);
        break;
      }
      case "/addmodel": {
        const [key, prov, id, maxTok] = arg.split(/\s+/);
        if (!key || !prov || !id) {
          errorLine("usage: /addmodel <key> <provider> <model-id> [maxTokens]");
          break;
        }
        if (!settings.providers[prov]) {
          errorLine(`unknown provider "${prov}" (add it with /addprovider)`);
          break;
        }
        settings.models[key] = { provider: prov, id, maxTokens: maxTok ? parseInt(maxTok, 10) : 8192 };
        await saveSettings(settings);
        infoLine(`added model ${key} (saved). switch with /model ${key}`);
        break;
      }
      case "/provider": {
        const subParts = arg.trim().split(/\s+/);
        const sub = subParts[0] || "";
        const subArg = subParts.slice(1).join(" ").trim();
        // "/provider <name>" — if sub matches a provider key, switch to it directly.
        const knownSubcmds = new Set(["", "list", "presets", "setup", "add", "edit", "login", "logout", "apikey", "llama", "models"]);
        if (sub && !knownSubcmds.has(sub) && settings.providers[sub.toLowerCase()]) {
          const provKey = sub.toLowerCase();
          // Find the first model that belongs to this provider.
          const modelKey = Object.keys(settings.models).find(
            (k) => settings.models[k].provider === provKey
          );
          if (!modelKey) {
            errorLine(`provider "${provKey}" has no models configured — add one with /addmodel`);
            break;
          }
          try {
            model = resolveModel(settings, modelKey);
            const label = settings.providers[provKey].label || provKey;
            infoLine(`switched to ${label} — model: ${modelKey}`);
          } catch (e) {
            errorLine(e.message);
          }
          break;
        }

        switch (sub) {
          case "":
          case "list": {
            for (const [name, p] of Object.entries(settings.providers)) {
              const mark = name === model.providerName ? c.green("● ") : "  ";
              const display = p.label || p.baseUrl || "(no baseUrl)";
              console.log("    " + mark + name + c.dim(`  ${display}  key=${maskKey(p.apiKey)}`));
            }
            break;
          }
          case "presets": {
            printProviderPresets();
            break;
          }
          case "setup": {
            const [name, ...keyParts] = subArg.split(/\s+/).filter(Boolean);
            if (!name) {
              printProviderPresets();
              break;
            }
            try {
              const prov = installProviderPreset(name, keyParts.join(" ").trim());
              await saveSettings(settings);
              infoLine(`provider ${prov} configured (${settings.providers[prov].baseUrl})`);
              if (!settings.providers[prov].apiKey) {
                infoLine(`add key with /provider login ${prov} <apiKey> or env ${providerKeyEnvVar(prov)}`);
              }
            } catch (e) {
              errorLine(e.message);
            }
            break;
          }
          case "models": {
            const [prov, ...filterParts] = subArg.split(/\s+/).filter(Boolean);
            try {
              await fetchModelsForProvider(prov || model.providerName, { save: true, filter: filterParts.join(" ") });
            } catch (e) {
              errorLine(e.message);
            }
            break;
          }
          case "add": {
            const [name, baseUrl, ...keyParts] = subArg.split(/\s+/);
            if (!name || !baseUrl) {
              errorLine("usage: /provider add <name> <baseUrl> [apiKey]");
              break;
            }
            settings.providers[name] = { baseUrl, apiKey: keyParts.join(" ").trim() || "not-needed" };
            await saveSettings(settings);
            infoLine(`added provider ${name} -> ${baseUrl} (saved)`);
            break;
          }
          case "edit": {
            const [name, field, ...valueParts] = subArg.split(/\s+/);
            const value = valueParts.join(" ").trim();
            if (!name || !field || !value) {
              errorLine("usage: /provider edit <name> <field> <value> (field: baseUrl or apiKey)");
              break;
            }
            const prov = settings.providers[name];
            if (!prov) {
              errorLine(`unknown provider "${name}"`);
              break;
            }
            if (field === "baseUrl") {
              prov.baseUrl = value;
            } else if (field === "apiKey") {
              prov.apiKey = value;
            } else {
              errorLine('field must be "baseUrl" or "apiKey"');
              break;
            }
            await saveSettings(settings);
            infoLine(`updated provider ${name}.${field} (saved)`);
            break;
          }
          case "login": {
            const [prov, ...keyParts] = subArg.split(/\s+/);
            const key = keyParts.join(" ").trim();
            if (!prov || !key) {
              errorLine("usage: /provider login <provider> <apiKey>");
              break;
            }
            if (!settings.providers[prov]) {
              errorLine(`unknown provider "${prov}" (add with /provider add)`);
              break;
            }
            settings.providers[prov].apiKey = key;
            await saveSettings(settings);
            // update active model if uses this provider
            try { model = resolveModel(settings, model.key); } catch { /* keep current */ }
            infoLine(`logged into provider ${prov} (saved)`);
            break;
          }
          case "logout": {
            const prov = subArg.trim();
            if (!prov) {
              errorLine("usage: /provider logout <provider>");
              break;
            }
            if (!settings.providers[prov]) {
              errorLine(`unknown provider "${prov}"`);
              break;
            }
            settings.providers[prov].apiKey = "";
            await saveSettings(settings);
            infoLine(`logged out of provider ${prov} (API key cleared)`);
            break;
          }
          case "apikey": {
            const [prov, ...keyParts] = subArg.split(/\s+/);
            const key = keyParts.join(" ").trim();
            if (!prov) {
              for (const [name, p] of Object.entries(settings.providers)) {
                infoLine(`${name}: ${maskKey(p.apiKey)}`);
              }
              infoLine("usage: /provider apikey <provider> [key]");
              break;
            }
            if (!settings.providers[prov]) {
              errorLine(`unknown provider "${prov}"`);
              break;
            }
            if (!key) {
              infoLine(`${prov}: ${maskKey(settings.providers[prov].apiKey)}`);
              break;
            }
            settings.providers[prov].apiKey = key;
            await saveSettings(settings);
            try { model = resolveModel(settings, model.key); } catch { /* keep current */ }
            infoLine(`updated API key for ${prov}: ${maskKey(key)} (saved)`);
            break;
          }
          case "llama": {
            const lParts = subArg.split(/\s+/);
            await llamaCommand(lParts[0] || "", lParts.slice(1).join(" ").trim());
            break;
          }
          default: {
            errorLine(`unknown provider subcommand "${sub}". Usage: /provider [list|presets|setup|models|add|edit|login|logout|apikey|llama]`);
            break;
          }
        }
        break;
      }
      case "/default": {
        const k = arg.trim() || model.key;
        if (!settings.models[k]) {
          errorLine(`unknown model "${k}" (try /models)`);
          break;
        }
        settings.defaultModel = k;
        await saveSettings(settings);
        infoLine(`default model set to ${k} (saved — used on next launch)`);
        break;
      }
      case "/packages": {
        const installed = listInstalled();
        if (!installed.length) infoLine("no packages installed — browse " + (project.registry || DEFAULT_REGISTRY));
        else for (const p of installed) console.log(`    ${p.name.padEnd(24)} ${c.dim(`${p.type} ${p.version}`)}  ${c.dim(p.description || "")}`);
        break;
      }
      case "/install": {
        const name = arg.trim();
        if (!name) { errorLine("usage: /install <package-name>"); break; }
        try {
          const { manifest, installedPaths, needsRestart } = await installPackage(name, { baseUrl: project.registry || DEFAULT_REGISTRY });
          infoLine(`installed ${manifest.name}@${manifest.version || "?"} (${manifest.type}) → ${installedPaths.join(", ")}`);
          infoLine(needsRestart ? "restart NimAgent to load it." : (manifest.command ? `use it with ${manifest.command}` : "ready."));
        } catch (e) { errorLine(e.message); }
        break;
      }
      case "/uninstall": {
        const name = arg.trim();
        if (!name) { errorLine("usage: /uninstall <package-name>"); break; }
        try {
          const rec = uninstallPackage(name);
          infoLine(`uninstalled ${rec.name} — restart to fully unload.`);
        } catch (e) { errorLine(e.message); }
        break;
      }
      case "/route": {
        const target = arg.trim().toLowerCase();
        if (!target) {
          if (!routerCfg.enabled) {
            infoLine("router is disabled (set router.enabled=true in settings or nimagent.config.json)");
          } else {
            const name = activePersona?.id || routerCfg.default || "coding";
            const pinned = routePinned ? c.yellow(" [pinned]") : c.dim(" [auto]");
            infoLine(`active persona: ${name}${pinned} — mode: ${routeMode}`);
          }
        } else if (target === "auto") {
          routePinned = false;
          routeMode = "auto";
          activePersona = null;
          infoLine("router set to auto — persona will be classified each turn");
        } else if (PERSONAS[target]) {
          activePersona = PERSONAS[target];
          routePinned = true;
          infoLine(`persona pinned to "${target}" — use /route auto to unpin`);
        } else {
          errorLine(`unknown persona "${target}" — try: coding, assistant, auto`);
        }
        break;
      }
      case "/bridge": {
        infoLine(bridgeStatus());
        break;
      }
      case "/mcp": {
        const sub = arg.trim();
        if (sub.startsWith("reconnect")) {
          const srv = sub.split(/\s+/)[1];
          if (!srv) { errorLine("usage: /mcp reconnect <server>"); break; }
          try { const conn = await reconnectServer(srv); infoLine(`reconnected ${srv} — ${conn.tools.length} tool(s).`); }
          catch (e) { errorLine(e.message); }
        } else {
          console.log("  " + (await mcpStatus()).replace(/\n/g, "\n  "));
        }
        break;
      }
      default:
        errorLine("unknown command: " + cmd + " (try /help)");
    }
    return showPrompt();
  }

  messages.push({ role: "user", content: fullLine });
  await session.append({ type: "user", content: fullLine });
  rl.pause();
  startInterruptWatch();
  if (routerCfg.enabled && routeMode === "auto" && !routePinned) {
    activePersona = await classifyIntent({ message: fullLine, settings });
    setPersonaIndicator(activePersona);
  }
  if (activeModelBlockedByHealth()) {
    stopInterruptWatch();
    console.log("");
    clearPendingInput();
    rl.resume();
    return showPrompt();
  }
  currentAbort = new AbortController();
  await runTurn({ model, messages, session, maxIterations, diffPreview, persona: activePersona, signal: currentAbort.signal });
  currentAbort = null;
  stopInterruptWatch();
  console.log("");
  clearPendingInput();
  rl.resume();
  showPrompt();
});

rl.on("close", async () => {
  disconnectAll(); // tear down any live MCP servers
  disconnectBridge(); // tear down NimTools bridge process
  killSidecar();     // tear down intent-router sidecar
  if (llama.status().running) {
    llama.stopServer();
    infoLine("stopped local llama server");
  }
  console.log(c.dim("\n  bye 👋"));
  await shutdown(0);
});
} // end interactive mode
