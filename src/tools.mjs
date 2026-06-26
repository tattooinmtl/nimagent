// Tool definitions (OpenAI function-calling schema) + implementations.
// File ops, shell, and code search — the core of a coding agent.

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { rgPath, fdPath, jqPath, INSTALL_ROOT } from "./paths.mjs";

const MAX_OUTPUT = 30000;

function clip(s) {
  s = String(s);
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[truncated]" : s;
}

function resolve(p) {
  return path.resolve(process.cwd(), p);
}

// Helper to run a shell command (used by run_shell and run_test)
function runShellCommand({ command, timeout_ms = 120000 }) {
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const args = isWin ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  const r = spawnSync(shell, args, {
    encoding: "utf8",
    timeout: timeout_ms,
    maxBuffer: 1024 * 1024 * 16,
    cwd: process.cwd(),
  });
  let out = "";
  if (r.stdout) out += r.stdout;
  if (r.stderr) out += (out ? "\n" : "") + r.stderr;
  if (r.error) out += `\n[spawn error: ${r.error.message}]`;
  if (r.status === null && r.error?.killed) out += "\n[timeout: command exceeded time limit]";
  out += `\n[exit code: ${r.status ?? "null"}]`;
  return clip(out.trim());
}

export const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file. Returns up to ~2000 lines with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to cwd or absolute)" },
          offset: { type: "integer", description: "1-based start line (optional)" },
          limit: { type: "integer", description: "Max lines to read (optional, default 2000)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact substring in a file. old_string must appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory (default cwd)" },
          recursive: { type: "boolean", description: "List recursively (optional, default false)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search file contents with a regex (ripgrep). Returns matching lines with paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "Directory or file to search (default cwd)" },
          glob: { type: "string", description: "Optional glob filter, e.g. *.ts" },
          case_insensitive: { type: "boolean", description: "Case-insensitive search (default false)" },
          context: { type: "integer", description: "Number of context lines before/after each match (default 0)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files/directories quickly using fd. Pattern supports regex (default) or glob-like wildcards.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern, or glob-style pattern with * ? []" },
          path: { type: "string", description: "Directory to search (default cwd)" },
          type: { type: "string", description: "Optional entry type: f|d|symlink" },
          max_depth: { type: "integer", description: "Optional max depth" },
          extension: { type: "string", description: "Filter by file extension (without dot), e.g. 'ts' or 'js'" },
          respect_gitignore: { type: "boolean", description: "Honor .gitignore rules (default false)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "jq_query",
      description: "Query or transform JSON data using jq. Runs a jq filter on a JSON file and returns the result.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "jq filter expression, e.g. '.dependencies', '.[] | select(.name == \"foo\")'" },
          path: { type: "string", description: "Path to JSON file (relative to cwd or absolute)" },
          raw: { type: "boolean", description: "Output raw strings (no quotes) for scalar results (default false)" },
        },
        required: ["filter", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command (PowerShell on Windows) in the cwd and return stdout/stderr. Use for build, test, git, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", description: "Optional timeout, default 120000" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_test",
      description: "Run a test command (e.g., npm test, vitest, jest) in the cwd and return output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Test command to run (default: npm test)" },
          timeout_ms: { type: "integer", description: "Optional timeout, default 120000" },
        },
        required: ["command"],
      },
    },
  },
];

export const impl = {
  async read_file({ path: p, offset = 1, limit = 2000 }) {
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
    const stat = fs.statSync(full);
    if (stat.size > 5 * 1024 * 1024) throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${p}`);
    const start = Math.max(1, offset);
    const end = start + limit;
    const lines = [];
    let lineNum = 0;

    const stream = createReadStream(full, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      lineNum++;
      if (lineNum >= end) break; // got all we need — stop reading
      if (lineNum >= start) {
        lines.push(`${String(lineNum).padStart(5)}\t${line}`);
      }
    }

    stream.destroy(); // ensure file handle is released
    return clip(lines.join("\n") || "(empty file)");
  },

  write_file({ path: p, content }) {
    const full = resolve(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    const lines = content.split("\n").length;
    return `Wrote ${content.length} bytes (${lines} lines) to ${p}`;
  },

  edit_file({ path: p, old_string, new_string }) {
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
    const text = fs.readFileSync(full, "utf8");
    const count = text.split(old_string).length - 1;
    if (count === 0) throw new Error("old_string not found in file");
    if (count > 1) throw new Error(`old_string matched ${count} times; make it unique`);
    // Use a function replacer so `$&`, `$\``, `$'`, `$1`, `$$` in new_string are
    // inserted literally instead of being interpreted as replacement patterns.
    const newText = text.replace(old_string, () => new_string);
    fs.writeFileSync(full, newText);
    const diff = new_string.length - old_string.length;
    const sign = diff >= 0 ? "+" : "";
    return `Edited ${p} (${sign}${diff} chars)`;
  },

  list_dir({ path: p = ".", recursive = false }) {
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`Directory not found: ${p}`);
    if (!fs.statSync(full).isDirectory()) throw new Error(`Not a directory: ${p}`);
    if (recursive) {
      const args = [
        ".",
        ".",
        "--type",
        "f",
        "--type",
        "d",
        "--hidden",
        "--no-ignore",
        "--color",
        "never",
      ];
      const r = spawnSync(fdPath(), args, {
        cwd: full,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
      });
      if (!r.error && r.status === 0) {
        const entries = (r.stdout || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => line.replace(/\\/g, "/").replace(/^\.\//, ""))
          .map((rel) => {
            const clean = rel.replace(/\/+$/, "");
            if (!clean) return clean;
            try {
              return fs.statSync(path.join(full, clean)).isDirectory() ? `${clean}/` : clean;
            } catch {
              return clean;
            }
          })
          .filter(Boolean)
          .sort();
        return clip(entries.join("\n") || "(empty)");
      }

      // Fallback to recursive Node walk if fd is unavailable.
      const fallbackEntries = [];
      function walk(dir, prefix) {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items.sort()) {
          const rel = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.isDirectory()) {
            fallbackEntries.push(rel + "/");
            try { walk(path.join(dir, item.name), rel); } catch { /* skip */ }
          } else {
            fallbackEntries.push(rel);
          }
        }
      }
      walk(full);
      return clip(fallbackEntries.join("\n") || "(empty)");
    }
    const entries = fs.readdirSync(full, { withFileTypes: true });
    return clip(
      entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n") || "(empty)"
    );
  },

  search({ pattern, path: p = ".", glob, case_insensitive = false, context = 0 }) {
    const args = ["--line-number", "--no-heading", "--color", "never", "-e", pattern];
    if (case_insensitive) args.push("-i");
    if (context > 0) args.push("-C", String(context));
    if (glob) args.push("--glob", glob);
    args.push(resolve(p));
    const r = spawnSync(rgPath(), args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
    if (r.error) {
      // Node.js fallback when rg is unavailable.
      try {
        return clip(searchFallback(pattern, resolve(p), glob, case_insensitive));
      } catch (e) {
        return "search unavailable: " + r.error.message;
      }
    }
    if (r.status === 1) return "(no matches)";
    return clip(r.stdout || r.stderr || "(no matches)");
  },

  find_files({ pattern = ".", path: p = ".", type, max_depth, extension, respect_gitignore = false }) {
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`Directory not found: ${p}`);
    if (!fs.statSync(full).isDirectory()) throw new Error(`Not a directory: ${p}`);

    const args = ["--color", "never", "--hidden"];
    if (!respect_gitignore) args.push("--no-ignore");
    if (Number.isInteger(max_depth) && max_depth >= 0) {
      args.push("--max-depth", String(max_depth));
    }

    if (type) {
      const t = String(type).toLowerCase();
      if (t === "f" || t === "file") args.push("--type", "f");
      else if (t === "d" || t === "dir" || t === "directory") args.push("--type", "d");
      else if (t === "symlink" || t === "l") args.push("--type", "l");
      else throw new Error(`Unsupported type: ${type}. Use f, d, or symlink.`);
    }

    if (extension) {
      for (const ext of String(extension).split(",").map(s => s.trim()).filter(Boolean)) {
        args.push("--extension", ext);
      }
    }

    if (/[*?\[\]{}]/.test(pattern)) args.push("--glob");

    args.push(pattern, ".");

    const r = spawnSync(fdPath(), args, {
      cwd: full,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
    });
    if (r.error) return "find_files unavailable: " + r.error.message;
    if (r.status === 1) return "(no matches)";
    if (r.status && r.status !== 0) return clip(r.stderr || `fd exited with code ${r.status}`);

    const out = (r.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.replace(/\\/g, "/").replace(/^\.\//, ""))
      .join("\n");
    return clip(out || "(no matches)");
  },

  run_shell({ command, timeout_ms = 120000 }) {
    return runShellCommand({ command, timeout_ms });
  },

  run_test({ command = "npm test", timeout_ms = 120000 }) {
    return runShellCommand({ command, timeout_ms });
  },

  jq_query({ filter, path: p, raw = false }) {
    const full = resolve(p);
    if (!fs.existsSync(full)) throw new Error(`File not found: ${p}`);
    const args = [filter];
    if (raw) args.push("-r");
    args.push(full);
    const r = spawnSync(jqPath(), args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      cwd: process.cwd(),
    });
    if (r.error) return "jq unavailable: " + r.error.message;
    if (r.status !== 0) return clip(r.stderr || `jq exited with code ${r.status}`);
    const out = (r.stdout || "").trimEnd();
    return clip(out || "(null or empty result)");
  },
};

export async function runTool(name, args) {
  const fn = impl[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return await fn(args || {});
}

function searchFallback(pattern, searchPath, glob, caseInsensitive) {
  const flags = caseInsensitive ? "gi" : "g";
  const re = new RegExp(pattern, flags);
  const results = [];
  const globRe = glob ? globToRegex(glob) : null;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") walk(full);
      } else if (entry.isFile()) {
        if (globRe && !globRe.test(entry.name)) continue;
        try {
          const content = fs.readFileSync(full, "utf8");
          const lines = content.split(/\r?\n/);
          const rel = path.relative(searchPath, full).replace(/\\/g, "/");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push(`${rel}:${i + 1}:${lines[i]}`);
              if (results.length > 500) return;
            }
            re.lastIndex = 0;
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  if (fs.statSync(searchPath).isFile()) {
    const content = fs.readFileSync(searchPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) results.push(`${i + 1}:${lines[i]}`);
      re.lastIndex = 0;
    }
  } else {
    walk(searchPath);
  }
  return results.length ? results.join("\n") : "(no matches)";
}

function globToRegex(g) {
  const s = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${s}$`, "i");
}

// Load extension modules and merge their tools + impls into the registry.
// Each extension default-exports { name, tools: [...], impl: { name: fn } }.
export async function registerExtensions(root, files = []) {
  const loaded = [];
  for (const rel of files) {
    try {
      const url = pathToFileURL(path.join(root, rel)).href;
      const mod = await import(url);
      const ext = mod.default || mod;
      if (Array.isArray(ext.tools)) {
        for (const t of ext.tools) tools.push(t);
      }
      if (ext.impl && typeof ext.impl === "object") {
        Object.assign(impl, ext.impl);
      }
      loaded.push(ext.name || rel);
    } catch (e) {
      loaded.push(`${rel} (failed: ${e.message})`);
    }
  }
  return loaded;
}