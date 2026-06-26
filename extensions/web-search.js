// NimAgent extension: web search via DuckDuckGo (no API key required).
// Uses the Instant Answer API plus a lite HTML fallback for result links.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NimAgent/0.1 (+https://localhost)";

async function ddgInstant(query) {
  const url =
    "https://api.duckduckgo.com/?q=" +
    encodeURIComponent(query) +
    "&format=json&no_html=1&skip_disambig=1";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const data = await res.json();
  const out = [];
  if (data.AbstractText) out.push(`${data.Heading || query}: ${data.AbstractText}`);
  for (const t of data.RelatedTopics || []) {
    if (t.Text && t.FirstURL) out.push(`- ${t.Text} (${t.FirstURL})`);
    if (out.length >= 8) break;
  }
  return out.length ? out.join("\n") : null;
}

async function ddgLite(query) {
  // Fallback: scrape the lite endpoint for result titles + links.
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return `search failed: HTTP ${res.status}`;
  const html = await res.text();
  const links = [...html.matchAll(/<a[^>]+class="result-link"[^>]*>(.*?)<\/a>/gis)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  return links.length ? links.map((l) => `- ${l}`).join("\n") : "(no results)";
}

export default {
  name: "web-search",
  tools: [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web (DuckDuckGo). Returns a short list of result snippets/links. Use for current info or docs.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
    },
  ],
  impl: {
    async web_search({ query }) {
      try {
        const instant = await ddgInstant(query);
        if (instant) return instant;
        return await ddgLite(query);
      } catch (e) {
        return "web_search error: " + e.message;
      }
    },
  },
};
