// Secret / sensitive-data helpers. Used for logs, task records, approval previews and tool output.
const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-key]'],
  [/\bAQ\.[0-9A-Za-z_-]{20,}/g, '[redacted-key]'],
  [/\btvly-[0-9A-Za-z_-]{10,}/g, '[redacted-key]'],
  [/\bgsk_[0-9A-Za-z]{16,}/g, '[redacted-key]'],
  [/\bsk-[0-9A-Za-z_-]{16,}/g, '[redacted-key]'],
  [/\bBearer\s+[0-9A-Za-z._~+\/=-]{12,}/gi, 'Bearer [redacted]'],
  [/\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/g, '[redacted-jwt]'],
  [/\bv1\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}/g, '[redacted-token]'],
];
const NUMBER_PATTERN = [/\b(?:\d[ -]?){13,19}\b/g, '[redacted-number]'];
const SENSITIVE_WORDS = /\b(password|passcode|passwd|otp|one[- ]time (?:code|password)|cvv|cvc|secret|api[_ -]?key|private key|seed phrase|ssn|social security)\b/i;
const SENSITIVE_KEYS = /^(password|passcode|passwd|token|secret|authorization|api[_-]?key|apikey|cookie|otp|cvv|cvc)$/i;

export function redact(text, { numbers = false } = {}) {
  let out = String(text ?? '');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  if (numbers) out = out.replace(NUMBER_PATTERN[0], NUMBER_PATTERN[1]);
  return out;
}

export function redactDeep(value, { numbers = false, depth = 0 } = {}) {
  if (value == null) return value;
  if (typeof value === 'string') return redact(value, { numbers });
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, { numbers, depth: depth + 1 }));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redactDeep(v, { numbers, depth: depth + 1 });
  }
  return out;
}

export function looksSensitive(text) {
  const s = String(text ?? '');
  if (SENSITIVE_WORDS.test(s)) return true;
  if (redact(s, { numbers: true }) !== s) return true;
  return false;
}
