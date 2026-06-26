// Loads project-level config: nimagent.config.json, the system prompt file,
// and skills (skills/<name>/SKILL.md with frontmatter). Extensions are loaded
// separately by tools.registerExtensions.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fdPath, INSTALL_ROOT } from "./paths.mjs";
import { systemPrompt as fallbackPrompt } from "./agent.mjs";

export { INSTALL_ROOT } from "./paths.mjs";

const CONFIG_PATH = path.join(INSTALL_ROOT, "nimagent.config.json");

export function loadProjectConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function readPromptText(config) {
  if (!config.promptFile) return null;
  try {
    return fs.readFileSync(path.join(INSTALL_ROOT, config.promptFile), "utf8").trim();
  } catch {
    return null;
  }
}

function discoverSkills() {
  const skillsRoot = path.join(INSTALL_ROOT, "skills");
  if (!fs.existsSync(skillsRoot)) return [];

  const r = spawnSync(
    fdPath(),
    ["SKILL.md", "skills", "--type", "f", "--hidden", "--no-ignore", "--color", "never"],
    { cwd: INSTALL_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 }
  );

  if (!r.error && r.status === 0) {
    return (r.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((p) => path.dirname(p.replace(/\\/g, "/")));
  }

  // Fallback for environments where fd is unavailable.
  const out = [];
  const top = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const item of top) {
    if (!item.isDirectory()) continue;
    const rel = path.posix.join("skills", item.name);
    const skillFile = path.join(INSTALL_ROOT, rel, "SKILL.md");
    if (fs.existsSync(skillFile)) out.push(rel);
  }
  return out;
}

// Very small frontmatter parser: leading `---` ... `---` block of key: value.
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

export function loadSkills(config) {
  const configured = Array.isArray(config.skills) ? config.skills : [];
  const discovered = config.autoDiscoverSkills ? discoverSkills() : [];
  const relSkills = [...new Set([...configured, ...discovered])];
  const skills = [];
  for (const rel of relSkills) {
    const file = rel.endsWith("SKILL.md")
      ? path.join(INSTALL_ROOT, rel)
      : path.join(INSTALL_ROOT, rel, "SKILL.md");
    try {
      const raw = fs.readFileSync(file, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const dir = path.dirname(file);
      const name = meta.name || path.basename(dir);
      skills.push({
        name,
        command: meta.command || "/" + name,
        description: meta.description || "",
        body,
        dir,
      });
    } catch {
      /* skip missing skill */
    }
  }
  return skills;
}

// Build the full system prompt: prompt file (or fallback) + runtime context + skills.
export function buildSystemPrompt(config, skills) {
  const base = readPromptText(config) || fallbackPrompt();
  const ctx = [
    "",
    "# Environment",
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
  ].join("\n");
  let sk = "";
  if (skills && skills.length) {
    sk =
      "\n\n# Skills\nThe user can invoke these with slash commands. When invoked, you'll be given the skill's instructions:\n" +
      skills.map((s) => `- ${s.command} — ${s.description}`).join("\n");
  }
  return base + "\n" + ctx + sk;
}
