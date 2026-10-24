// AI provider integration. Routes call generateReply() and aiCapabilities(); provider details stay here.
// Keys are read from the server environment only and are never sent to the browser.

const SYSTEM_PROMPT = [
  'You are HEALIX AI, a health-education assistant. You are not a clinician and cannot examine, diagnose, or treat anyone.',
  'Style: answer in plain language with short paragraphs. Use "## " headings and "- " bullet lists when they make the answer easier to scan. Keep answers focused.',
  'Symptoms: explain possible general causes without claiming certainty, ask concise follow-up questions when important context is missing (age group, duration, severity, other symptoms, existing conditions, current medicines, pregnancy), and suggest sensible next steps and when to see a professional.',
  'Urgent care: if anything described could be an emergency (for example chest pain, difficulty breathing, stroke signs, severe bleeding, severe allergic reaction, suicidal thoughts, sudden severe headache, high fever in an infant), say clearly and first that the person should contact local emergency services now.',
  'Medicines: do not prescribe or recommend starting, stopping, or changing a medicine based on symptoms. You may explain what a medicine is generally used for, common precautions, and what to ask a pharmacist or doctor. Consider allergies, age, pregnancy or breastfeeding, kidney or liver conditions, and other medicines, and ask about them when relevant. Do not invent doses, interactions, or facts; if you are unsure, say so. Refer dosing questions to the product label, a pharmacist, or a prescriber.',
  'Images: if an image is provided, describe only what is visibly present, note that a photo cannot establish a diagnosis, and recommend in-person assessment where appropriate. Do not interpret X-rays, CT, MRI, ultrasound, or other specialist medical scans; explain that these need review by a qualified clinician.',
  'Documents and lab reports: explain terms and what values are generally used to assess. Only refer to values that actually appear in the document; never fill in missing values or reference ranges that are not shown. Recommend discussing results with the clinician who ordered them.',
  'Never claim to have accessed health records, to be a doctor, or that your answer replaces professional care.'
].join('\n\n');

class AiError extends Error {
  // retryable: another model or a later attempt may succeed (busy, quota, timeout, model unavailable).
  constructor(status, message, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

// Per-provider defaults. Gemini models read images and PDFs natively, so those inputs default to on
// for Gemini and can still be switched off with AI_IMAGE_INPUT=false / AI_PDF_INPUT=false.
const PROVIDER_DEFAULTS = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash',
    // Tried in order when the main model is overloaded, rate-limited, unavailable, or too slow.
    fallbackModels: 'gemini-3.5-flash-lite,gemini-3.6-flash',
    multimodal: true
  },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', fallbackModels: '', multimodal: false }
};

function inputEnabled(value, fallback) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function aiSettings() {
  const provider = process.env.AI_PROVIDER || 'gemini';
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.gemini;
  return {
    provider,
    apiKey: process.env.AI_API_KEY || process.env.GEMINI_API_KEY || '',
    baseUrl: (process.env.AI_BASE_URL || defaults.baseUrl).replace(/\/+$/, ''),
    model: process.env.AI_MODEL || defaults.model,
    fallbackModels: (process.env.AI_FALLBACK_MODELS ?? defaults.fallbackModels).split(',').map((name) => name.trim()).filter(Boolean),
    imageInput: inputEnabled(process.env.AI_IMAGE_INPUT, defaults.multimodal),
    pdfInput: inputEnabled(process.env.AI_PDF_INPUT, defaults.multimodal),
    // Total time a user waits, and the most any single model attempt may use of it.
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 60000,
    attemptTimeoutMs: Number(process.env.AI_ATTEMPT_TIMEOUT_MS) || 25000
  };
}

function dataUrl(attachment) {
  return `data:${attachment.mimeType};base64,${attachment.data.toString('base64')}`;
}

const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

const providers = {
  // Google Gemini API (generateContent). Images and PDFs are sent as inline data.
  gemini: async (settings, model, messages, signal) => {
    const contents = [];
    for (const message of messages) {
      const role = message.role === 'assistant' ? 'model' : 'user';
      const parts = [
        { text: message.content },
        ...(message.attachments || []).map((attachment) => ({
          inlineData: { mimeType: attachment.mimeType, data: attachment.data.toString('base64') }
        }))
      ];
      // A failed reply can leave two user turns in a row; Gemini expects alternating turns.
      const previous = contents.at(-1);
      if (previous?.role === role) previous.parts.push(...parts);
      else contents.push({ role, parts });
    }
    const response = await fetch(`${settings.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents }),
      signal
    });
    if (!response.ok) {
      console.error(`AI provider returned HTTP ${response.status} for model ${model}.`);
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new AiError(502, 'The AI service rejected the request. The administrator should check the Gemini API key.');
      }
      if (response.status === 404) throw new AiError(502, 'The configured AI model is not available. The administrator should check AI_MODEL.', true);
      if (response.status === 429) throw new AiError(503, 'The AI service is busy or its quota is used up. Please try again in a minute.', true);
      throw new AiError(503, 'The AI service is very busy right now. Please try again in a minute.', true);
    }
    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || (BLOCKED_FINISH_REASONS.has(candidate?.finishReason) && !candidate?.content?.parts?.length)) {
      throw new AiError(422, 'The AI service declined to answer this message. Try rephrasing it. If this is urgent, contact a healthcare professional or local emergency services.');
    }
    return candidate?.content?.parts?.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('');
  },

  // OpenAI-compatible Chat Completions (OpenAI, compatible gateways, local servers, ...).
  'openai-compatible': async (settings, model, messages, signal) => {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages.map((message) => {
            if (!message.attachments?.length) return { role: message.role, content: message.content };
            return {
              role: message.role,
              content: [
                { type: 'text', text: message.content },
                ...message.attachments.map((attachment) => (attachment.mimeType === 'application/pdf'
                  ? { type: 'file', file: { filename: attachment.name, file_data: dataUrl(attachment) } }
                  : { type: 'image_url', image_url: { url: dataUrl(attachment) } }))
              ]
            };
          })
        ]
      }),
      signal
    });
    if (!response.ok) {
      console.error(`AI provider returned HTTP ${response.status} for model ${model}.`);
      throw new AiError(502, 'The AI service could not complete this response. Please try again.', response.status === 429 || response.status >= 500);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content;
  }
};

function aiCapabilities() {
  const settings = aiSettings();
  const configured = Boolean(settings.apiKey) && Boolean(providers[settings.provider]);
  return {
    configured,
    images: configured && settings.imageInput,
    documents: configured && settings.pdfInput
  };
}

const MAX_REPLY_LENGTH = 12000;

async function attempt(provider, settings, model, messages, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reply = await provider(settings, model, messages, controller.signal);
    if (typeof reply !== 'string' || !reply.trim()) {
      console.error(`AI provider returned an empty response for model ${model}.`);
      throw new AiError(502, 'The AI service returned an empty response. Please try again.', true);
    }
    const text = reply.trim();
    return text.length > MAX_REPLY_LENGTH
      ? `${text.slice(0, MAX_REPLY_LENGTH - 80).trimEnd()}

[Response shortened. Ask a follow-up question for more detail.]`
      : text;
  } catch (error) {
    if (error instanceof AiError) throw error;
    const timedOut = error.name === 'AbortError';
    console.error(timedOut ? `AI provider request timed out for model ${model}.` : `AI provider request failed for model ${model}.`);
    throw new AiError(timedOut ? 504 : 502, timedOut
      ? 'The AI service took too long to respond. Please try again.'
      : 'The AI service is temporarily unavailable. Please try again.', true);
  } finally {
    clearTimeout(timeout);
  }
}

// messages: [{ role: 'user' | 'assistant', content, attachments?: [{ name, mimeType, data: Buffer }] }]
// Tries the main model, then each fallback model, within one overall time budget.
async function generateReply(messages) {
  const settings = aiSettings();
  const provider = providers[settings.provider];
  if (!settings.apiKey || !provider) {
    throw new AiError(503, 'AI chat is not configured yet. Set AI_API_KEY on the server, then restart HEALIX.');
  }
  const models = [...new Set([settings.model, ...settings.fallbackModels])];
  const deadline = Date.now() + settings.timeoutMs;
  let lastError;
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) break;
    try {
      return await attempt(provider, settings, model, messages, Math.min(settings.attemptTimeoutMs, remaining));
    } catch (error) {
      lastError = error;
      if (!error.retryable) throw error;
    }
  }
  throw lastError || new AiError(504, 'The AI service took too long to respond. Please try again.');
}

module.exports = { SYSTEM_PROMPT, AiError, aiCapabilities, generateReply };
