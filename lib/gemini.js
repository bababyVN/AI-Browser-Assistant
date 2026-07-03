/**
 * Gemini API wrapper module
 * Handles all communication with the Google Gemini API
 */

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/**
 * Call the Gemini API with conversation history and tool declarations
 * @param {Array} messages - Conversation history in Gemini format
 * @param {Array} tools - Tool/function declarations
 * @param {string} apiKey - Gemini API key
 * @param {string} systemPrompt - System instruction text
 * @returns {Object} API response
 */
export async function callGemini(messages, tools, apiKey, systemPrompt) {
  if (!apiKey) {
    throw new GeminiError('API key is not configured. Please set your Gemini API key in settings.', 'AUTH_ERROR');
  }

  const url = `${GEMINI_API_URL}?key=${apiKey}`;

  const body = {
    contents: messages,
    tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 4096
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new GeminiError(
      'Network error: Unable to reach the Gemini API. Check your internet connection.',
      'NETWORK_ERROR'
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const status = response.status;
    const message = errorData?.error?.message || response.statusText;

    if (status === 400) {
      throw new GeminiError(`Bad request: ${message}`, 'BAD_REQUEST');
    } else if (status === 401 || status === 403) {
      throw new GeminiError('Invalid API key. Please check your Gemini API key in settings.', 'AUTH_ERROR');
    } else if (status === 429) {
      throw new GeminiError('Rate limit exceeded. Please wait a moment and try again.', 'RATE_LIMIT');
    } else if (status >= 500) {
      throw new GeminiError('Gemini API server error. Please try again later.', 'SERVER_ERROR');
    } else {
      throw new GeminiError(`API error (${status}): ${message}`, 'API_ERROR');
    }
  }

  const data = await response.json();

  // Validate response structure
  if (!data.candidates || data.candidates.length === 0) {
    // Check for prompt feedback (blocked content)
    if (data.promptFeedback?.blockReason) {
      throw new GeminiError(
        `Request blocked: ${data.promptFeedback.blockReason}. Try rephrasing your message.`,
        'BLOCKED'
      );
    }
    throw new GeminiError('No response generated. Please try again.', 'EMPTY_RESPONSE');
  }

  return data;
}

/**
 * Custom error class for Gemini API errors
 */
export class GeminiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
  }
}
