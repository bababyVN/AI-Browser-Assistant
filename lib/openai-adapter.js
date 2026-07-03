/**
 * lib/openai-adapter.js — Unified OpenAI-Compatible Adapter
 * 
 * Consolidates ALL OpenAI-format API logic:
 *  - Format conversion (Gemini ⇄ OpenAI)
 *  - callOpenAICompatible (generic caller)
 *  - callOpenAI (OpenAI direct)
 *  - callOpenRouter (OpenRouter)
 *  - Error classes: OpenAIError, OpenRouterError
 */

// ─── Type Map ────────────────────────────────────────────────────────
const TYPE_MAP = {
  'OBJECT': 'object',
  'STRING': 'string',
  'INTEGER': 'integer',
  'BOOLEAN': 'boolean',
  'NUMBER': 'number',
  'ARRAY': 'array'
};

// ─── Tool call ID tracking (Array pool by position index) ────────────
// Stores tool_call IDs by their position in the tool_calls array,
// preventing name-collision bugs when the same function is called twice.
let lastToolCallIdPool = [];

/**
 * Convert Gemini-format messages to OpenAI-format messages.
 * @param {Array} messages - Gemini format conversation history
 * @param {string} [systemPrompt] - Optional system prompt
 * @returns {Array} OpenAI format messages
 */
export function convertMessagesToOpenAI(messages, systemPrompt, options = {}) {
  const { ollamaFormat = false } = options;
  const result = [];

  // Reset pool at the start of each conversion
  lastToolCallIdPool = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const textParts = msg.parts?.filter(p => p.text) || [];
      const funcRespParts = msg.parts?.filter(p => p.functionResponse) || [];

      if (funcRespParts.length > 0) {
        // Turn-2 function result message: match by pool position index
        for (let i = 0; i < funcRespParts.length; i++) {
          const funcResp = funcRespParts[i].functionResponse;
          const toolCallId = lastToolCallIdPool[i] || `call_fallback_${Date.now()}_${i}`;
          result.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(funcResp.response?.content || {})
          });
        }
      } else {
        const text = textParts.map(p => p.text || '').join('') || '';
        result.push({ role: 'user', content: text });
      }

    } else if (msg.role === 'model') {
      const textParts = msg.parts?.filter(p => p.text) || [];
      const toolCallParts = msg.parts?.filter(p => p.functionCall) || [];
      const content = textParts.map(p => p.text).join('') || null;

      const openAIMsg = { role: 'assistant', content };

      if (toolCallParts.length > 0) {
        // Reset pool and populate with new IDs by position
        lastToolCallIdPool = [];
        openAIMsg.tool_calls = toolCallParts.map((p, i) => {
          const id = `call_${Date.now()}_${i}`;
          lastToolCallIdPool.push(id);
          return {
            id,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: ollamaFormat ? (p.functionCall.args || {}) : JSON.stringify(p.functionCall.args || {})
            }
          };
        });
      }

      result.push(openAIMsg);

    } else if (msg.role === 'function') {
      const funcResp = msg.parts?.[0]?.functionResponse;
      if (funcResp) {
        const toolCallId = lastToolCallIdPool[0] || `call_fallback_${Date.now()}`;
        result.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify(funcResp.response?.content || {})
        });
      }
    }
  }

  return result;
}

/**
 * Convert Gemini parameter types to OpenAI/JSON Schema types.
 */
export function convertParametersToOpenAI(params) {
  if (!params) return { type: 'object', properties: {}, required: [] };

  const result = {
    type: TYPE_MAP[params.type] || (params.type || 'object').toLowerCase(),
    properties: {},
    required: params.required || []
  };

  if (params.properties) {
    for (const [key, val] of Object.entries(params.properties)) {
      result.properties[key] = {
        type: TYPE_MAP[val.type] || (val.type || 'string').toLowerCase(),
        description: val.description || ''
      };
    }
  }

  return result;
}

/**
 * Convert Gemini-format tool declarations to OpenAI-format.
 */
export function convertToolsToOpenAI(tools) {
  if (!tools || tools.length === 0) return undefined;

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: convertParametersToOpenAI(tool.parameters)
    }
  }));
}

/**
 * Convert OpenAI-format response back to Gemini format.
 */
export function convertResponseToGemini(data, options = {}) {
  const { ollamaFormat = false, provider, model } = options;

  const message = ollamaFormat ? data.message : data.choices?.[0]?.message;

  if (!message) {
    throw new Error('No response generated. Please try again.');
  }

  const parts = [];

  if (message.content && message.content.trim()) {
    parts.push({ text: message.content });
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    // Reset and repopulate pool by position
    lastToolCallIdPool = [];
    for (const tc of message.tool_calls) {
      if (tc.function?.name) {
        const id = tc.id || `call_${Date.now()}`;
        lastToolCallIdPool.push(id);

        let args = {};
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments || '{}')
            : (tc.function.arguments || {});
        } catch { args = {}; }

        parts.push({
          functionCall: {
            name: tc.function.name,
            args
          }
        });
      }
    }
  }

  if (parts.length === 0) {
    parts.push({ text: '...' });
  }

  const response = {
    candidates: [{
      content: { parts, role: 'model' }
    }]
  };

  if (provider) response._provider = provider;
  if (model) response._model = model;

  return response;
}

/**
 * Generic OpenAI-compatible API caller.
 */
export async function callOpenAICompatible(url, model, apiKey, messages, tools, systemPrompt, ErrorClass, extra = {}) {
  if (!apiKey) {
    throw new ErrorClass('API key is not configured. Please add a key in Settings.', 'AUTH_ERROR');
  }

  const openAIMessages = convertMessagesToOpenAI(messages, systemPrompt);
  const openAITools = convertToolsToOpenAI(tools);

  const body = {
    model,
    messages: openAIMessages,
    temperature: 0.7,
    max_tokens: 4096,
    ...extra
  };

  if (openAITools && openAITools.length > 0) {
    body.tools = openAITools;
    body.tool_choice = 'auto';
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new ErrorClass(
      `Network error: Unable to reach the API. Check your internet connection.`,
      'NETWORK_ERROR'
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const status = response.status;
    const msg = errorData?.error?.message || response.statusText;

    if (status === 401 || status === 403) {
      throw new ErrorClass(`Invalid API key. Please check your key in Settings.`, 'AUTH_ERROR');
    } else if (status === 429) {
      throw new ErrorClass(`Rate limit exceeded. Please wait a moment and try again.`, 'RATE_LIMIT');
    } else if (status >= 500) {
      throw new ErrorClass(`API server error. Please try again later.`, 'SERVER_ERROR');
    } else if (status === 400) {
      throw new ErrorClass(`Bad request: ${msg}`, 'BAD_REQUEST');
    } else {
      throw new ErrorClass(`API error (${status}): ${msg}`, 'API_ERROR');
    }
  }

  const data = await response.json();
  return convertResponseToGemini(data);
}


// ═══════════════════════════════════════════════════════════════════════
// ─── OpenAI Direct Provider ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';

export class OpenAIError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OpenAIError';
    this.code = code;
  }
}

export async function callOpenAI(messages, tools, apiKey, systemPrompt) {
  return await callOpenAICompatible(
    OPENAI_API_URL,
    OPENAI_MODEL,
    apiKey,
    messages,
    tools,
    systemPrompt,
    OpenAIError
  );
}


// ═══════════════════════════════════════════════════════════════════════
// ─── OpenRouter Provider ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class OpenRouterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OpenRouterError';
    this.code = code;
  }
}

export async function callOpenRouter(messages, tools, apiKey, systemPrompt) {
  const data = await chrome.storage.local.get(['openrouterModel']);
  const model = data.openrouterModel || 'google/gemini-2.5-flash';

  return await callOpenAICompatible(
    OPENROUTER_API_URL,
    model,
    apiKey,
    messages,
    tools,
    systemPrompt,
    OpenRouterError
  );
}
