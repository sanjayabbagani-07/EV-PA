// Gemini generateContent client with function calling. The API key is sent only in a request header
// (never in the URL or body) and never appears in thrown errors.
import { AgentError } from './errors.mjs';
import { redact } from './redact.mjs';

const BASE = 'https://generativelanguage.googleapis.com';
// Same default as backend/server.js so one GEMINI_MODEL value drives chat and agent. Use a model that supports function calling.
export const DEFAULT_MODEL = 'gemini-3.8-flash';
const BLOCKING_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

function mapHttpError(status, data) {
  const upstream = redact(String(data?.error?.message || '')).slice(0, 300);
  const details = { upstreamStatus: status, upstream };
  if (status === 429) return new AgentError('RATE_LIMITED', 'The AI service is busy. Try again in a moment.', { retryable: true, status: 429, details });
  if (status >= 500) return new AgentError('MODEL_UNAVAILABLE', 'The AI service is temporarily unavailable.', { retryable: true, status: 502, details });
  if (status === 401 || status === 403) return new AgentError('MODEL_KEY_REJECTED', 'The backend Gemini key was rejected. Check GEMINI_API_KEY on the server.', { status: 503, details });
  if (status === 404) return new AgentError('MODEL_NOT_FOUND', 'The configured Gemini model was not found. Check GEMINI_MODEL on the server.', { status: 503, details });
  if (status === 400 && /api key/i.test(upstream)) return new AgentError('MODEL_KEY_REJECTED', 'The backend Gemini key is invalid. Check GEMINI_API_KEY on the server.', { status: 503, details });
  return new AgentError('MODEL_BAD_REQUEST', 'The AI service rejected the request.', { status: 502, details });
}

export async function generate({
  apiKey, model = DEFAULT_MODEL, systemInstruction, contents, tools = [], fetchImpl = globalThis.fetch,
  timeoutMs = 25_000, signal, temperature = 0.4, maxOutputTokens = 1500, baseUrl = BASE,
}) {
  const key = String(apiKey || '').trim().replace(/^["']|["']$/g, '');
  if (!key) throw new AgentError('MODEL_NOT_CONFIGURED', 'Gemini is not configured on the backend (GEMINI_API_KEY).', { status: 503 });
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new AgentError('MODEL_NOT_CONFIGURED', 'GEMINI_MODEL has an invalid value.', { status: 503 });

  const body = {
    systemInstruction: { parts: [{ text: String(systemInstruction || '') }] },
    contents,
    generationConfig: { temperature, maxOutputTokens },
  };
  if (tools.length) {
    body.tools = [{ functionDeclarations: tools }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (e) {
    if (signal?.aborted) throw new AgentError('CANCELLED', 'The task was cancelled.');
    if (timeoutSignal.aborted) throw new AgentError('MODEL_TIMEOUT', 'The AI service took too long to answer.', { retryable: true, status: 504 });
    throw new AgentError('MODEL_NETWORK', 'Could not reach the AI service.', { retryable: true, status: 502 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw mapHttpError(res.status, data);

  if (data?.promptFeedback?.blockReason) throw new AgentError('MODEL_BLOCKED', 'The AI service declined this request.', { status: 422 });
  const cand = data?.candidates?.[0];
  if (!cand) throw new AgentError('MODEL_EMPTY', 'The AI service returned no answer.', { retryable: true, status: 502 });
  const finishReason = cand.finishReason || null;
  if (BLOCKING_FINISH.has(finishReason)) throw new AgentError('MODEL_BLOCKED', 'The AI service declined this request.', { status: 422 });

  const parts = cand.content?.parts ?? [];
  const functionCalls = parts.filter((p) => p.functionCall).map((p) => ({ name: String(p.functionCall.name || ''), args: p.functionCall.args ?? {}, id: p.functionCall.id }));
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  return {
    // Keep the model turn verbatim (including any thought signatures) for the next request.
    content: cand.content ? { role: 'model', parts } : null,
    text, functionCalls, finishReason,
    malformed: finishReason === 'MALFORMED_FUNCTION_CALL',
    usage: data.usageMetadata ?? null,
  };
}
