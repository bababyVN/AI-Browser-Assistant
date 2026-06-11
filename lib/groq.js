/**
 * Groq API wrapper module
 * Handles communication with Groq API (OpenAI-compatible)
 * Converts between internal Gemini format and OpenAI format transparently
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Tool call ID tracking ──────────────────────────────────────────
// Maps tool_call_id → function name for matching tool responses
let lastToolCallIds = new Map();

/**
 * Convert Gemini-format messages to OpenAI-format messages
 */
function convertMessagesToOpenAI(messages, systemPrompt) {
  const result = [];

  // System prompt first
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
          // Store mapping for later tool response matching
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

/**
 * Convert Gemini-format tool declarations to OpenAI-format
 */
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

/**
 * Convert Gemini parameter types to OpenAI/JSON Schema types
 */
function convertParametersToOpenAI(params) {
  if (!params) return { type: 'object', properties: {}, required: [] };

  const typeMap = {
    'OBJECT': 'object',
    'STRING': 'string',
    'INTEGER': 'integer',
    'BOOLEAN': 'boolean',
    'NUMBER': 'number',
    'ARRAY': 'array'
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

/**
 * Convert OpenAI response back to Gemini format
 */
function convertResponseToGemini(data) {
  const choice = data.choices?.[0];
  if (!choice) {
    throw new GroqError('No response generated. Please try again.', 'EMPTY_RESPONSE');
  }

  const message = choice.message;
  const parts = [];

  // Add text part
  if (message.content) {
    parts.push({ text: message.content });
  }

  // Add tool call parts
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      // Store the tool_call_id for future tool responses
      lastToolCallIds.set(tc.function.name, tc.id);

      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch (e) {
        args = {};
      }

      parts.push({
        functionCall: {
          name: tc.function.name,
          args: args
        }
      });
    }
  }

  // If no parts at all, add empty text
  if (parts.length === 0) {
    parts.push({ text: '' });
  }

  // Return in Gemini-compatible structure
  return {
    candidates: [{
      content: {
        parts: parts
      }
    }]
  };
}

/**
 * Call the Groq API with conversation history and tool declarations
 * Accepts Gemini-format inputs, returns Gemini-format output
 * @param {Array} messages - Conversation history in Gemini format
 * @param {Array} tools - Tool/function declarations in Gemini format
 * @param {string} apiKey - Groq API key
 * @param {string} systemPrompt - System instruction text
 * @returns {Object} API response in Gemini format
 */
export async function callGroq(messages, tools, apiKey, systemPrompt) {
  if (!apiKey) {
    throw new GroqError('API key is not configured. Please set your Groq API key in settings.', 'AUTH_ERROR');
  }

  // Reset tool call ID tracking for fresh conversation turns
  // (keep existing IDs for ongoing multi-turn conversations)

  // Convert formats
  const openAIMessages = convertMessagesToOpenAI(messages, systemPrompt);
  const openAITools = convertToolsToOpenAI(tools);

  const body = {
    model: GROQ_MODEL,
    messages: openAIMessages,
    temperature: 0.7,
    max_tokens: 4096
  };

  // Only add tools if we have them
  if (openAITools && openAITools.length > 0) {
    body.tools = openAITools;
    body.tool_choice = 'auto';
  }

  let response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new GroqError(
      'Network error: Unable to reach the Groq API. Check your internet connection.',
      'NETWORK_ERROR'
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const status = response.status;
    const message = errorData?.error?.message || response.statusText;

    if (status === 400) {
      throw new GroqError(`Bad request: ${message}`, 'BAD_REQUEST');
    } else if (status === 401 || status === 403) {
      throw new GroqError('Invalid API key. Please check your Groq API key in settings.', 'AUTH_ERROR');
    } else if (status === 429) {
      throw new GroqError('Rate limit exceeded. Please wait a moment and try again.', 'RATE_LIMIT');
    } else if (status >= 500) {
      throw new GroqError('Groq API server error. Please try again later.', 'SERVER_ERROR');
    } else {
      throw new GroqError(`API error (${status}): ${message}`, 'API_ERROR');
    }
  }

  const data = await response.json();

  // Convert OpenAI response to Gemini format
  return convertResponseToGemini(data);
}

/**
 * Custom error class for Groq API errors
 */
export class GroqError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GroqError';
    this.code = code;
  }
}
