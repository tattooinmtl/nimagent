// NimAgent extension: web search + page fetch with NO third-party API service.
// Search uses DuckDuckGo directly (no key, no account); web_fetch reads any
// http(s) page as plain text.

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

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// DDG lite wraps result URLs in a redirect: //duckduckgo.com/l/?uddg=<real-url>&rut=…
function realUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

async function ddgLite(query, maxResults = 8) {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return `search failed: HTTP ${res.status}`;
  const html = await res.text();

  // Links: <a rel="nofollow" href="…" class='result-link'>Title</a>
  // Snippets follow in <td class='result-snippet'>…</td>. Quote style varies.
  const linkRe = /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i;

  const results = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    const link = realUrl(decodeEntities(m[1]));
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    // Look for the snippet in the chunk between this link and the next one.
    const tail = html.slice(linkRe.lastIndex, linkRe.lastIndex + 2000);
    const sm = tail.match(snippetRe);
    const snippet = sm
      ? decodeEntities(sm[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
      : "";
    if (title && link) {
      results.push(`- ${title}\n  ${link}${snippet ? `\n  ${snippet}` : ""}`);
    }
  }
  return results.length ? results.join("\n") : "(no results)";
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export default {
  name: "web-search",
  tools: [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web via DuckDuckGo (no API key, no external service account). Returns result titles, URLs, and snippets. Use for current info or docs, then read a result with web_fetch.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            max_results: { type: "integer", description: "Max results, default 8" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description:
          "Fetch an http(s) URL and return its readable text content (HTML stripped). Use after web_search to read documentation or articles.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL to fetch" },
            max_chars: { type: "integer", description: "Max characters to return, default 15000" },
          },
          required: ["url"],
        },
      },
    },
  ],
  impl: {
    async web_search({ query, max_results = 8 }) {
      try {
        const lite = await ddgLite(query, max_results);
        if (lite && lite !== "(no results)" && !lite.startsWith("search failed")) return lite;
        const instant = await ddgInstant(query);
        return instant || lite;
      } catch (e) {
        return "web_search error: " + e.message;
      }
    },

    async web_fetch({ url, max_chars = 15000 }) {
      try {
        if (!/^https?:\/\//i.test(String(url))) {
          return "web_fetch error: only http(s) URLs are supported";
        }
        const res = await fetch(url, {
          headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,*/*" },
          redirect: "follow",
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) return `web_fetch failed: HTTP ${res.status} ${res.statusText}`;
        const type = res.headers.get("content-type") || "";
        const body = await res.text();
        const text = /html/i.test(type) ? htmlToText(body) : body;
        const cap = Math.max(500, Math.min(Number(max_chars) || 15000, 60000));
        return text.length > cap ? text.slice(0, cap) + "\n…[truncated]" : text;
      } catch (e) {
        return "web_fetch error: " + (e.name === "TimeoutError" ? "request timed out (30s)" : e.message);
      }
    },
  },
};
