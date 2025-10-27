// utils/ai.js
const DEFAULT_URL = process.env.LLM_API_URL || "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const API_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;

async function chatComplete(
  messages,
  { model = DEFAULT_MODEL, temperature = 0.4, max_tokens = 500 } = {}
) {
  if (!API_KEY) {
    const userMsg = messages?.find(m => m.role === "user")?.content || "";
    return { provider: "mock", content: `🤖 (mock) You said: "${userMsg}"` };
  }

  const res = await fetch(DEFAULT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status} ${res.statusText} ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "(no reply)";
  return { provider: "openai", model, content };
}

module.exports = { chatComplete };
