// NimAgent extension: extra filesystem tools (move, copy, delete, mkdir).
// Loaded via nimagent.config.json -> extensions. Contract:
//   export default { name, tools: [...], impl: { toolName: fn } }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = path.resolve(__dirname, "..");
const PROJECTS_ROOT = path.join(INSTALL_ROOT, "NimProjects");

function resolve(p) {
  const root = path.resolve(process.cwd());
  const full = path.resolve(root, p);
  const rel = path.relative(root, full);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return full;
  throw new Error(`path escapes workspace: ${rel || full}`);
}

function resolveForProjectCreate(p) {
  if (!p || String(p).trim() === "") throw new Error("path is required");
  const raw = String(p);
  const full = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(PROJECTS_ROOT, raw);
  const projectRel = path.relative(PROJECTS_ROOT, full);
  if (projectRel === "" || (!projectRel.startsWith("..") && !path.isAbsolute(projectRel))) return full;
  const root = path.resolve(process.cwd());
  const rel = path.relative(root, full);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return full;
  throw new Error(`path escapes workspace: ${rel || full}`);
}

export default {
  name: "file-tools",
  tools: [
    {
      type: "function",
      function: {
        name: "move_file",
        description: "Move or rename a file or directory.",
        parameters: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "copy_file",
        description: "Copy a file or directory.",
        parameters: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_path",
        description: "Delete a file or directory (recursive).",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "make_dir",
        description: "Create a directory (and parents).",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
  impl: {
    move_file({ from, to }) {
      const target = resolveForProjectCreate(to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(resolve(from), target);
      return `Moved ${from} -> ${path.relative(process.cwd(), target)}`;
    },
    copy_file({ from, to }) {
      const target = resolveForProjectCreate(to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(resolve(from), target, { recursive: true });
      return `Copied ${from} -> ${path.relative(process.cwd(), target)}`;
    },
    delete_path({ path: p }) {
      fs.rmSync(resolve(p), { recursive: true, force: true });
      return `Deleted ${p}`;
    },
    make_dir({ path: p }) {
      const target = resolveForProjectCreate(p);
      fs.mkdirSync(target, { recursive: true });
      return `Created directory ${path.relative(process.cwd(), target)}`;
    },
  },
};
