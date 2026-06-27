#!/usr/bin/env node
// NimAgent CLI entry point. Interactive REPL + one-shot mode.

import readline from "node:readline";
import { loadSettings, saveSettings, resolveModel, Session, SETTINGS_PATH, HOME, providerKeyMissing, providerKeyEnvVar } from "../src/config.mjs";
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
    await runTurn({ model, messages, session, maxIterations, persona: activePersona });
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

// Multi-line support: lines ending with \ continue input
let multiLine = "";

function help() {
  console.log(
    [
      "",
      "  Commands:",
      "    /help                         show this help",
      "    /model [key]                  show or switch the active model",
      "    /models                       list configured models",
      "    /default [key]                set the default model (persisted)",
      "    /addmodel <key> <prov> <id> [maxTokens]   add a model (persisted)",
      "    /provider [subcmd]            manage providers (list, add, edit, login, logout, apikey, llama)",
      "    /providers                    list providers + masked keys",
      "    /llama list                   list local models numbered",
      "    /llama start <number>         load a model by its list number (or /llama <number>)",
      "    /llama stop | status          stop / show the local llama server",
      "    /apikey <provider> [key]      show or set a provider API key (persisted)",
      "    /addprovider <name> <url> [key]           add a provider (persisted)",
      "    /clear                        reset the conversation",
      "    /cwd                          show working directory",
      "    /config                       show config file path",
      "    /cost                         show token usage this session",
      "    /diff                         toggle diff preview for edits",
      "    /compact                      summarize conversation to save tokens",
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
        if (settings.providers.local) settings.providers.local.baseUrl = info.url;
        const localModel = Object.keys(settings.models).find((k) => settings.models[k].provider === "local");
        if (localModel) infoLine(`switch to it with: /model ${localModel}`);
      } catch (e) {
        errorLine(e.message);
      }
      break;
    }
    default:
      errorLine(`unknown /llama subcommand "${sub}". Usage: /llama [list|start [model]|stop|status]`);
  }
}

// Render the input frame: a status bar (context usage + model) and a top
// separator line above the input. The matching bottom line is printed once the
// user submits, sandwiching their input — a bit like a bottom command panel.
function showPrompt() {
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

    // Skill commands (from skills/*/SKILL.md) run a turn with skill instructions.
    if (skillByCommand.has(cmd)) {
      await applySkill(skillByCommand.get(cmd), arg, messages, session);
      rl.pause();
      await runTurn({ model, messages, session, maxIterations, diffPreview, persona: activePersona });
      console.log("");
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
        break;
      case "/cost":
        costLine(session);
        break;
      case "/diff":
        diffPreview = !diffPreview;
        infoLine("diff preview: " + (diffPreview ? "on" : "off"));
        break;
      case "/compact": {
        // Keep system prompt + last 2 messages, summarize the rest
        if (messages.length <= 3) {
          infoLine("conversation too short to compact");
          break;
        }
        const sys = messages[0];
        const last2 = messages.slice(-2);
        messages.length = 0;
        messages.push(sys);
        messages.push({
          role: "system",
          content: "[Earlier conversation was compacted. Continue from here.]",
        });
        messages.push(...last2);
        infoLine("compacted conversation (" + messages.length + " messages remaining)");
        break;
      }
      case "/models":
        for (const k of Object.keys(settings.models)) {
          const m = settings.models[k];
          const marker = k === model.key ? c.green("● ") : "  ";
          const info = m.provider ? c.dim(` (${m.provider})`) : "";
          console.log("    " + marker + k + info);
        }
        break;
      case "/model":
        if (!arg) {
          infoLine("current model: " + model.key);
        } else {
          try {
            model = resolveModel(settings, arg);
            infoLine("switched to " + model.key);
          } catch (e) {
            errorLine(e.message);
          }
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
          console.log("    " + mark + name + c.dim(`  ${p.baseUrl || "(no baseUrl)"}  key=${maskKey(p.apiKey)}`));
        }
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
        switch (sub) {
          case "":
          case "list": {
            for (const [name, p] of Object.entries(settings.providers)) {
              const mark = name === model.providerName ? c.green("● ") : "  ";
              console.log("    " + mark + name + c.dim(`  ${p.baseUrl || "(no baseUrl)"}  key=${maskKey(p.apiKey)}`));
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
            errorLine(`unknown provider subcommand "${sub}". Usage: /provider [list|add|edit|login|logout|apikey|llama]`);
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
  if (routerCfg.enabled && routeMode === "auto" && !routePinned) {
    activePersona = await classifyIntent({ message: fullLine, settings });
    setPersonaIndicator(activePersona);
  }
  await runTurn({ model, messages, session, maxIterations, diffPreview, persona: activePersona });
  console.log("");
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
