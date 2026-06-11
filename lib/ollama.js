/**
 * lib/ollama.js — Local Ollama Provider
 * Calls Ollama running on localhost:11434.
 * Used for simple chat to avoid burning API quota.
 * Returns Gemini-format responses for compatibility.
 */

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
// Preferred models in order — pick the first one available (smallest first)
const PREFERRED_MODELS = ['gemma2:2b', 'phi3:3.8b', 'llama3.1:8b-instruct-q4_0', 'gemma4:latest'];
let selectedModel = 'llama3.1:8b-instruct-q4_0'; // Fallback default

// ─── Tool call ID tracking ──────────────────────────────────────────
let lastToolCallIds = new Map();

/**
 * Check if Ollama is running and has a model available.
 * @returns {{ available: boolean, models: string[], selectedModel: string }}
 */
export async function checkOllamaStatus() {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return { available: false, models: [] };
    const data = await response.json();
    const models = (data.models || []).map(m => m.name);

    // Auto-select best available model (smallest preferred)
    for (const pref of PREFERRED_MODELS) {
      const prefix = pref.split(':')[0];
      const match = models.find(m => m.startsWith(prefix));
      if (match) {
        selectedModel = match;
        break;
      }
    }
    // If none of preferred found, use whatever's first
    if (models.length > 0) {
      const hasPreferred = PREFERRED_MODELS.some(p => models.some(m => m.startsWith(p.split(':')[0])));
      if (!hasPreferred) selectedModel = models[0];
    }

    return { available: true, models, selectedModel };
  } catch (err) {
    console.error("OLLAMA FETCH ERROR:", err);
    return { available: false, models: [], error: err.message || err.toString() };
  }
}

// ─── Formatting Helpers (OpenAI format) ─────────────────────────────

function convertMessagesToOpenAI(messages, systemPrompt) {
  const result = [];
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.parts?.map(p => p.text || '').join('') || '';
      result.push({ role: 'user', content: text });
    } else if (msg.role === 'model') {
      const textParts = msg.parts?.filter(p => p.text) || [];
      const toolCallParts = msg.parts?.filter(p => p.functionCall) || [];
      const content = textParts.map(p => p.text).join('') || null;

      const openAIMsg = { role: 'assistant', content: content };

      if (toolCallParts.length > 0) {
        openAIMsg.tool_calls = toolCallParts.map((p, i) => {
          const id = `call_${Date.now()}_${i}`;
          lastToolCallIds.set(p.functionCall.name, id);
          return {
            id: id,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args || {})
            }
          };
        });
      }
      result.push(openAIMsg);
    } else if (msg.role === 'function') {
      const funcResp = msg.parts?.[0]?.functionResponse;
      if (funcResp) {
        const toolCallId = lastToolCallIds.get(funcResp.name) || `call_fallback_${Date.now()}`;
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

function convertToolsToOpenAI(tools) {
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

function convertParametersToOpenAI(params) {
  if (!params) return { type: 'object', properties: {}, required: [] };
  const typeMap = {
    'OBJECT': 'object', 'STRING': 'string', 'INTEGER': 'integer',
    'BOOLEAN': 'boolean', 'NUMBER': 'number', 'ARRAY': 'array'
  };
  const result = {
    type: typeMap[params.type] || (params.type || 'object').toLowerCase(),
    properties: {},
    required: params.required || []
  };
  if (params.properties) {
    for (const [key, val] of Object.entries(params.properties)) {
      result.properties[key] = {
        type: typeMap[val.type] || (val.type || 'string').toLowerCase(),
        description: val.description || ''
      };
    }
  }
  return result;
}

function convertResponseToGemini(data, useModel) {
  const message = data.message;
  if (!message) {
    throw new OllamaError('No response generated. Please try again.', 'EMPTY_RESPONSE');
  }

  const parts = [];
  if (message.content) {
    parts.push({ text: message.content });
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      if (tc.function?.name) {
        // Some models just dump JSON into content, but proper models output here
        lastToolCallIds.set(tc.function.name, tc.id || `call_${Date.now()}`);
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: args
          }
        });
      }
    }
  }

  if (parts.length === 0) {
    parts.push({ text: '' });
  }

  return {
    candidates: [{
      content: { parts: parts, role: 'model' }
    }],
    _provider: 'ollama',
    _model: useModel
  };
}

// ─── API Calls ────────────────────────────────────────────────────────

/**
 * Call Ollama's chat API (No Tools).
 */
export async function callOllama(messages, systemPrompt, model) {
  return await callOllamaWithTools(messages, [], systemPrompt, model);
}

/**
 * Call Ollama's chat API with tools.
 */
export async function callOllamaWithTools(messages, tools, systemPrompt, model) {
  const useModel = model || selectedModel;
  
  const openAIMessages = convertMessagesToOpenAI(messages, systemPrompt);
  const openAITools = convertToolsToOpenAI(tools);

  if (openAIMessages.length === 0) {
    throw new OllamaError('No messages to send.', 'EMPTY');
  }

  const body = {
    model: useModel,
    messages: openAIMessages,
    stream: false,
    options: {
      temperature: 0.3, // Lower temperature for better tool calling
      num_predict: 2048
    }
  };

  if (openAITools && openAITools.length > 0) {
    body.tools = openAITools;
  }

  let response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000)  // 90s timeout (model loading + inference)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new OllamaError('Ollama response timed out.', 'TIMEOUT');
    }
    throw new OllamaError('Cannot connect to Ollama. Is it running?', 'CONNECTION');
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new OllamaError(`Model "${useModel}" not found. Run: ollama pull ${useModel}`, 'MODEL_NOT_FOUND');
    }
    if (response.status === 403) {
      throw new OllamaError('CORS blocked (403). Set OLLAMA_ORIGINS=* environment variable and restart Ollama.', 'CORS');
    }
    if (response.status === 400 && errorText.includes('Value looks like object')) {
      throw new OllamaError('The local model got confused while trying to use a tool and produced invalid code. Please try rephrasing your request.', 'MODEL_SYNTAX_ERROR');
    }
    throw new OllamaError(`Ollama error (${response.status}): ${errorText}`, 'API_ERROR');
  }

  const data = await response.json();
  return convertResponseToGemini(data, useModel);
}

// ─── Tier 2 Sub-tools ───────────────────────────────────────────────
export const OLLAMA_TOOL_DECLARATIONS = [
  {
    name: 'ask_website',
    description: 'Extract and analyze the content of the currently active webpage. Always use detail_level "brief" to answer questions.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'The question or query about the webpage content.' },
        detail_level: { type: 'STRING', description: 'Must be "brief".' }
      },
      required: ['query']
    }
  },
  {
    name: 'find_history',
    description: 'Search your browsing history using natural language. Returns pages you visited that match your query.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Natural language search query.' },
        limit: { type: 'INTEGER', description: 'Max number of results to return (default: 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'highlight_element',
    description: 'Highlight a specific section or element on the page using its ID.',
    parameters: {
      type: 'OBJECT',
      properties: {
        elementId: { type: 'STRING', description: 'The ID of the section to highlight (e.g. section-1).' }
      },
      required: ['elementId']
    }
  }
];

export class OllamaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
  }
}
