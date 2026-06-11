/**
 * lib/together.js — Together AI API wrapper
 * OpenAI-compatible format, converts to/from Gemini format (same pattern as groq.js)
 */

const TOGETHER_API_URL = 'https://api.together.xyz/v1/chat/completions';
const TOGETHER_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

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
  if (!choice) throw new TogetherError('No response generated.', 'EMPTY_RESPONSE');
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

export async function callTogether(messages, tools, apiKey, systemPrompt) {
  if (!apiKey) throw new TogetherError('Together AI API key not configured.', 'AUTH_ERROR');
  const body = { model: TOGETHER_MODEL, messages: convertMessagesToOpenAI(messages, systemPrompt), temperature: 0.7, max_tokens: 4096 };
  const openAITools = convertToolsToOpenAI(tools);
  if (openAITools?.length > 0) { body.tools = openAITools; body.tool_choice = 'auto'; }
  let response;
  try {
    response = await fetch(TOGETHER_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  } catch (err) { throw new TogetherError('Network error: Unable to reach Together AI API.', 'NETWORK_ERROR'); }
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const status = response.status;
    const message = errorData?.error?.message || response.statusText;
    if (status === 401 || status === 403) throw new TogetherError('Invalid Together AI API key.', 'AUTH_ERROR');
    if (status === 429) throw new TogetherError('Together AI rate limit exceeded.', 'RATE_LIMIT');
    if (status >= 500) throw new TogetherError('Together AI server error.', 'SERVER_ERROR');
    throw new TogetherError(`Together AI error (${status}): ${message}`, 'API_ERROR');
  }
  return convertResponseToGemini(await response.json());
}

export class TogetherError extends Error {
  constructor(message, code) { super(message); this.name = 'TogetherError'; this.code = code; }
}
