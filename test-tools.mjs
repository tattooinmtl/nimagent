// Test script: exercise the 3 new capabilities (jq, enhanced search, enhanced find_files)
// Run:  node test-tools.mjs

import { runTool } from "./src/tools.mjs";

let pass = 0, fail = 0;

async function assert(label, result, check) {
  try {
    const ok = check(result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(result).slice(0, 120)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

// ── Test 1: jq_query ──────────────────────────────────────────────
console.log("\nTest 1: jq_query");

await assert("reads top-level string field",
  await runTool("jq_query", { filter: ".name", path: "package.json", raw: true }),
  r => r.trim() === "nimagent"
);

await assert("extracts object keys",
  await runTool("jq_query", { filter: 'keys', path: "package.json" }),
  r => r.includes("name") && r.includes("type")
);

await assert("error on bad filter",
  await runTool("jq_query", { filter: "{{{broken", path: "package.json" }),
  r => r.toLowerCase().includes("error") || r.toLowerCase().includes("exit")
);

// ── Test 2: enhanced search (case_insensitive + context) ─────────
console.log("\nTest 2: search — case_insensitive + context");

await assert("case-insensitive finds mixed-case matches",
  await runTool("search", { pattern: "spawnsync", case_insensitive: true, path: "src" }),
  r => r.includes("spawnSync") && !r.includes("(no matches)")
);

await assert("context=1 includes surrounding lines",
  await runTool("search", { pattern: "function clip", context: 1, path: "src/tools.mjs" }),
  r => {
    const lines = r.split("\n");
    return lines.length > 1 && lines.some(l => l.includes("function clip")) && lines.some(l => !l.includes("function clip"));
  }
);

await assert("context=0 shows match line without dash-separated context",
  await runTool("search", { pattern: "function clip", context: 0, path: "src/tools.mjs" }),
  r => !r.split("\n").some(l => l.startsWith("src/tools.mjs-"))
);

// ── Test 3: enhanced find_files (extension + respect_gitignore) ──
console.log("\nTest 3: find_files — extension + respect_gitignore");

await assert("extension filter returns only .mjs files",
  await runTool("find_files", { pattern: ".", path: "src", extension: "mjs", max_depth: 1 }),
  r => r.split("\n").every(f => f.endsWith(".mjs"))
);

await assert("extension filter with comma-separated extensions",
  await runTool("find_files", { pattern: ".", path: ".", extension: "mjs,json", max_depth: 1 }),
  r => r.split("\n").some(f => f.endsWith(".mjs")) && r.split("\n").some(f => f.endsWith(".json"))
);

await assert("type=d finds directories",
  await runTool("find_files", { pattern: ".", path: ".", type: "d", max_depth: 1 }),
  r => r.split("\n").some(f => f === "src" || f === "bin" || f === "bin/")
);

// ── Summary ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
