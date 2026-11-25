// Stateless signed tokens (HMAC-SHA256, Web Crypto) + constant-time compare + tiny rate limiter.
// Runs unchanged on Node >= 20 and Cloudflare Workers. Scopes let the same mechanism later issue
// narrower tokens to the Android companion ('android') and the browser runner ('browser').
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const hmacKey = (secret, usages) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);

export async function signToken(claims, secret, { ttlSeconds = 12 * 3600, now = Date.now() } = {}) {
  if (!secret || secret.length < 32) throw new Error('Signing secret must be at least 32 characters.');
  const iat = Math.floor(now / 1000);
  const payload = { ...claims, iat, exp: iat + ttlSeconds, jti: crypto.randomUUID() };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(`v1.${body}`));
  return { token: `v1.${body}.${b64url(sig)}`, expiresAt: payload.exp * 1000, claims: payload };
}

export async function verifyToken(token, secret, { scope, now = Date.now() } = {}) {
  try {
    if (!secret || secret.length < 32 || typeof token !== 'string' || token.length > 2048) return null;
    const [v, body, sig] = token.split('.');
    if (v !== 'v1' || !body || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), unb64url(sig), enc.encode(`v1.${body}`));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64url(body)));
    if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    if (scope && payload.scope !== scope) return null;
    return payload;
  } catch { return null; }
}

export function bearerFrom(headers = {}) {
  const raw = headers.authorization ?? headers.Authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw));
  return m ? m[1].trim() : '';
}

export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s ?? ''))))));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

export class RateLimiter {
  #hits = new Map();
  constructor({ limit, windowMs, now = () => Date.now() }) { this.limit = limit; this.windowMs = windowMs; this.now = now; }
  // Returns true if the call is allowed (and records it).
  take(key) {
    const t = this.now();
    const recent = (this.#hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) { this.#hits.set(key, recent); return false; }
    recent.push(t);
    this.#hits.set(key, recent);
    if (this.#hits.size > 5000) for (const [k, v] of this.#hits) if (!v.some((x) => t - x < this.windowMs)) this.#hits.delete(k);
    return true;
  }
}
