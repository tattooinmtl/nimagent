// NimAgent extension: extra filesystem tools (move, copy, delete, mkdir).
// Loaded via nimagent.config.json -> extensions. Contract:
//   export default { name, tools: [...], impl: { toolName: fn } }

import fs from "node:fs";
import path from "node:path";

const resolve = (p) => path.resolve(process.cwd(), p);

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
      fs.mkdirSync(path.dirname(resolve(to)), { recursive: true });
      fs.renameSync(resolve(from), resolve(to));
      return `Moved ${from} -> ${to}`;
    },
    copy_file({ from, to }) {
      fs.mkdirSync(path.dirname(resolve(to)), { recursive: true });
      fs.cpSync(resolve(from), resolve(to), { recursive: true });
      return `Copied ${from} -> ${to}`;
    },
    delete_path({ path: p }) {
      fs.rmSync(resolve(p), { recursive: true, force: true });
      return `Deleted ${p}`;
    },
    make_dir({ path: p }) {
      fs.mkdirSync(resolve(p), { recursive: true });
      return `Created directory ${p}`;
    },
  },
};
