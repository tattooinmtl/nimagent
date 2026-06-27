// The agent loop: send conversation to the model, execute any tool calls,
// feed results back, repeat until the model answers with plain text.

import { chatStream } from "./provider.mjs";
import { tools, runTool } from "./tools.mjs";
import {
  c, assistantPrefix, toolLine, toolResultLine, errorLine,
  startStatus, stopStatus, startGenerationStatus, diffPreviewLine,
  streamWrite, streamNewline
} from "./ui.mjs";

// Map a batch of tool calls to the animated status shown while they run.
// Priority: writing > searching > reading > generic running.
function statusForTools(calls) {
  const names = calls.map((c) => c.function?.name);
  if (names.some((n) => n === "edit_file" || n === "write_file")) return "coding";
  if (names.some((n) => n === "search" || n === "find_files")) return "searching";
  if (names.some((n) => n === "read_file" || n === "list_dir")) return "reading";
  return "running";
}

export function systemPrompt() {
  return [
    "You are NimAgent, a terminal-based coding agent.",
    "You help with software engineering tasks in the user's current working directory.",
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    "",
    "Use the provided tools to read, write, edit, search files, run shell commands, and run tests.",
    "Prefer making concrete changes with tools over describing them.",
    "When you run shell commands, the shell is PowerShell on Windows.",
    "",
    "Guidelines:",
    "- Always read a file before editing it so you know the exact content.",
    "- Use edit_file for small changes; use write_file only for new files or full rewrites.",
    "- When searching, prefer specific patterns over broad ones to reduce noise.",
    "- After making changes, run relevant tests or linters to verify correctness.",
    "- Keep prose concise. After finishing, briefly summarize what you did.",
    "- If a tool call fails, read the error carefully and retry with corrected parameters.",
    "- For multi-file changes, make them one at a time and verify each step.",
  ].join("\n");
}

export async function runTurn({ model, messages, session, maxIterations = 30, diffPreview = true, persona = null }) {
  // If a persona is active, swap the system message and iteration budget.
  // Falls back to the defaults above when persona is null (existing behaviour).
  if (persona) {
    maxIterations = persona.maxIterations ?? maxIterations;
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0] = { role: "system", content: persona.systemPrompt() };
    }
  }
  for (let i = 0; i < maxIterations; i++) {
    let resp;
    let streamedContent = false;
    let tokenCount = 0;
    try {
      // While the model is producing its first token, show the framed token
      // meter (the yellow-bounded bottom panel). As soon as text arrives we
      // tear the panel down and stream the answer inline, token by token.
      startGenerationStatus(() => tokenCount);
      resp = await chatStream({
        model,
        messages,
        tools,
        onToken(token) {
          tokenCount++;
          if (!streamedContent) {
            stopStatus();
            assistantPrefix();
            streamedContent = true;
          }
          streamWrite(token);
        },
      });
      if (!streamedContent) stopStatus();
      else streamNewline();
    } catch (e) {
      if (!streamedContent) stopStatus();
      const msg = e.message || String(e);
      // Retry once on transient errors (429, 502, 503, 504)
      if (/429|50[234]/.test(msg) && i === 0) {
        errorLine("transient error, retrying in 2s…");
        await new Promise((r) => setTimeout(r, 2000));
        try {
          tokenCount = 0;
          startGenerationStatus(() => tokenCount);
          resp = await chatStream({
            model,
            messages,
            tools,
            onToken(token) {
              tokenCount++;
              if (!streamedContent) {
                stopStatus();
                assistantPrefix();
                streamedContent = true;
              }
              streamWrite(token);
            },
          });
          if (!streamedContent) stopStatus();
          else streamNewline();
        } catch (e2) {
          if (!streamedContent) stopStatus();
          errorLine(e2.message);
          session.append({ type: "error", message: e2.message });
          return;
        }
      } else {
        errorLine(msg);
        session.append({ type: "error", message: msg });
        return;
      }
    }

    const msg = resp.message;
    messages.push(msg);
    session.append({ type: "assistant", message: msg, usage: resp.usage });
    if (resp.usage) session.addCost(resp.usage);

    const calls = msg.tool_calls || [];

    // Content already streamed above; only print here if nothing was streamed
    // (e.g. a tool-only response that carried no content tokens).
    if (msg.content && msg.content.trim() && !streamedContent) {
      assistantPrefix();
      console.log(msg.content.trim());
    }

    if (calls.length === 0) return; // model is done

    // Print each tool call (and any edit diff) up front, then animate a single
    // action status (reading / searching / coding / running) while the whole
    // batch executes in parallel, then print the results in call order.
    const parsed = calls.map((call) => {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        /* leave empty */
      }
      const name = call.function?.name;
      toolLine(name, argSummary(name, args));
      if (name === "edit_file" && diffPreview) {
        diffPreviewLine(args.path, args.old_string, args.new_string);
      }
      return { call, name, args };
    });

    startStatus(statusForTools(calls));
    const toolResults = await Promise.all(
      parsed.map(async ({ call, name, args }) => {
        let result;
        try {
          result = await runTool(name, args);
        } catch (e) {
          result = "ERROR: " + e.message;
        }
        return { call, name, args, result };
      })
    );
    stopStatus();

    // Print results and push tool messages in original call order
    // (API requires matching tool_call_id order).
    for (const { call, name, args, result } of toolResults) {
      toolResultLine(result);
      session.append({ type: "tool", name, args, result, tool_call_id: call.id });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  errorLine(`Stopped after ${maxIterations} tool iterations.`);
}

function argSummary(name, args) {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_dir":
      return args.path || "";
    case "find_files":
      return (args.pattern || ".") + (args.path ? ` in ${args.path}` : "");
    case "search":
      return c.dim(`/${args.pattern}/`) + (args.path ? ` in ${args.path}` : "") + (args.glob ? ` ${args.glob}` : "");
    case "run_shell":
      return args.command || "";
    case "run_test":
      return args.command || "npm test";
    case "jq_query":
      return c.dim(args.filter || "") + (args.path ? ` ${args.path}` : "");
    case "web_search":
      return args.query || "";
    case "move_file":
    case "copy_file":
      return args.from && args.to ? `${args.from} → ${args.to}` : "";
    case "delete_path":
    case "make_dir":
      return args.path || "";
    default:
      return "";
  }
}
