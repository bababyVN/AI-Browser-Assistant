/**
 * lib/cerebras.js — Cerebras API wrapper
 * OpenAI-compatible format, converts to/from Gemini format (same pattern as groq.js)
 */

const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'llama-3.3-70b';

// ─── Format converters (reused from groq.js pattern) ────────────────
let lastToolCallIds = new Map();

function convertMessagesToOpenAI(messages, systemPrompt) {
  const result = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.parts?.map(p => p.text || '').join('') || '' });
    } else if (msg.role === 'model') {
      const textParts = msg.parts?.filter(p => p.text) || [];
      const toolCallParts = msg.parts?.filter(p => p.functionCall) || [];
      const content = textParts.map(p => p.text).join('') || null;
      const openAIMsg = { role: 'assistant', content };
      if (toolCallParts.length > 0) {
        openAIMsg.tool_calls = toolCallParts.map((p, i) => {
          const id = `call_${Date.now()}_${i}`;
          lastToolCallIds.set(p.functionCall.name, id);
          return { id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } };
        });
      }
      result.push(openAIMsg);
    } else if (msg.role === 'function') {
      const funcResp = msg.parts?.[0]?.functionResponse;
      if (funcResp) {
        const toolCallId = lastToolCallIds.get(funcResp.name) || `call_fallback_${Date.now()}`;
        result.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(funcResp.response?.content || {}) });
      }
    }
  }
  return result;
}

function convertToolsToOpenAI(tools) {
  if (!tools || tools.length === 0) return undefined;
  const typeMap = { 'OBJECT':'object','STRING':'string','INTEGER':'integer','BOOLEAN':'boolean','NUMBER':'number','ARRAY':'array' };
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name, description: tool.description,
      parameters: {
        type: typeMap[tool.parameters?.type] || 'object',
        properties: Object.fromEntries(Object.entries(tool.parameters?.properties || {}).map(([k,v]) => [k, { type: typeMap[v.type] || 'string', description: v.description || '' }])),
        required: tool.parameters?.required || []
      }
    }
  }));
}

function convertResponseToGemini(data) {
  const choice = data.choices?.[0];
  if (!choice) throw new CerebrasError('No response generated.', 'EMPTY_RESPONSE');
  const message = choice.message;
  const parts = [];
  if (message.content) parts.push({ text: message.content });
  if (message.tool_calls?.length > 0) {
    for (const tc of message.tool_calls) {
      lastToolCallIds.set(tc.function.name, tc.id);
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
  }
  if (parts.length === 0) parts.push({ text: '' });
  return { candidates: [{ content: { parts, role: 'model' } }] };
}

export async function callCerebras(messages, tools, apiKey, systemPrompt) {
  if (!apiKey) throw new CerebrasError('Cerebras API key not configured.', 'AUTH_ERROR');
  const body = { model: CEREBRAS_MODEL, messages: convertMessagesToOpenAI(messages, systemPrompt), temperature: 0.7, max_tokens: 4096 };
  const openAITools = convertToolsToOpenAI(tools);
  if (openAITools?.length > 0) { body.tools = openAITools; body.tool_choice = 'auto'; }
  let response;
  try {
    response = await fetch(CEREBRAS_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  } catch (err) { throw new CerebrasError('Network error: Unable to reach Cerebras API.', 'NETWORK_ERROR'); }
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const status = response.status;
    const message = errorData?.error?.message || response.statusText;
    if (status === 401 || status === 403) throw new CerebrasError('Invalid Cerebras API key.', 'AUTH_ERROR');
    if (status === 429) throw new CerebrasError('Cerebras rate limit exceeded.', 'RATE_LIMIT');
    if (status >= 500) throw new CerebrasError('Cerebras server error.', 'SERVER_ERROR');
    throw new CerebrasError(`Cerebras API error (${status}): ${message}`, 'API_ERROR');
  }
  return convertResponseToGemini(await response.json());
}

export class CerebrasError extends Error {
  constructor(message, code) { super(message); this.name = 'CerebrasError'; this.code = code; }
}
