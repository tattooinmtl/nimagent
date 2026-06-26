// OpenAI-compatible streaming chat client (uses Node's global fetch / undici).
// Works with NVIDIA NIM, local llama.cpp, Ollama, OpenRouter, etc.
//
// Sends stream:true, parses the SSE response, calls onToken for each text delta,
// and returns { message, finishReason, usage } once the stream ends.
export async function chatStream({ model, messages, tools, signal, onToken }) {
  const url = model.provider.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const body = {
    model: model.id,
    messages,
    max_tokens: model.maxTokens,
    temperature: 0.2,
    stream: true,
    // Ask the provider to emit a final usage chunk (OpenAI spec). Without this,
    // streaming responses report no token usage, so /cost and the status bar
    // would always show 0. Providers that don't support it simply ignore it.
    stream_options: { include_usage: true },
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${model.provider.apiKey}`,
  };

  if (model.provider.extraHeaders) {
    Object.assign(headers, model.provider.extraHeaders);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Provider ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  return await consumeStream(res, onToken);
}

// Parse an OpenAI SSE stream into a single message + usage object.
// Calls onToken(textDelta) for each content chunk as it arrives.
async function consumeStream(res, onToken) {
  // Accumulators for the final message
  let content = "";
  const toolCallsMap = new Map(); // index -> { id, name, arguments }
  let finishReason = null;
  let usage = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() || "";

    let chunk;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === ":") continue;
      if (trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;

      try {
        chunk = JSON.parse(trimmed.slice(6));
      } catch {
        continue; // skip malformed chunks
      }

      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Content delta — stream to terminal immediately
      if (delta && delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
      }

      // Tool call deltas — accumulate by index
      if (delta && delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, {
              id: tc.id || "",
              type: "function",
              function: { name: "", arguments: "" },
            });
          }
          const entry = toolCallsMap.get(idx);
          if (tc.id) entry.id = tc.id;
          if (tc.function) {
            if (tc.function.name) entry.function.name += tc.function.name;
            if (tc.function.arguments) entry.function.arguments += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // Capture usage from the final chunk (some providers send it at the end)
    if (chunk && chunk.usage) {
      usage = chunk.usage;
    }
  }

  // Assemble the final message (same shape a non-streaming completion returns).
  const message = { role: "assistant", content };
  if (toolCallsMap.size > 0) {
    message.tool_calls = [...toolCallsMap.values()];
  }

  return {
    message,
    finishReason,
    usage,
  };
}
