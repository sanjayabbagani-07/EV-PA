// Built-in tools. Every tool here performs a real operation (live HTTP calls or a real store write);
// none returns a canned success. Network access goes through ctx.fetch so tests can inject a fake.
import { ToolError } from '../errors.mjs';
import { looksSensitive } from '../redact.mjs';

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
  82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

async function getJson(ctx, url, init = {}, what = 'service') {
  let res;
  try { res = await ctx.fetch(url, { ...init, signal: ctx.signal }); }
  catch (e) {
    if (ctx.signal?.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new ToolError('CANCELLED', 'Cancelled.');
    throw new ToolError('UPSTREAM_UNREACHABLE', `Could not reach the ${what}.`, { retryable: true });
  }
  if (!res.ok) throw new ToolError('UPSTREAM_ERROR', `The ${what} returned an error (${res.status}).`, { retryable: res.status >= 500 || res.status === 429 });
  try { return await res.json(); } catch { throw new ToolError('UPSTREAM_BAD_RESPONSE', `The ${what} returned an unreadable response.`); }
}

export const getTime = {
  name: 'get_time',
  description: 'Get the current date and time, optionally in a specific IANA time zone such as "Asia/Kolkata".',
  permission: 'auto',
  timeoutMs: 2000,
  parameters: { type: 'object', properties: { timeZone: { type: 'string', maxLength: 64, description: 'IANA time zone, e.g. America/New_York. Defaults to UTC.' } } },
  async run({ timeZone }, ctx) {
    const tz = timeZone || 'UTC';
    const at = new Date(ctx.now());
    let formatted;
    try { formatted = at.toLocaleString('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'medium' }); }
    catch { return { ok: false, error: { code: 'INVALID_TIME_ZONE', message: `"${tz}" is not a valid IANA time zone.` } }; }
    return { ok: true, data: { iso: at.toISOString(), timeZone: tz, formatted } };
  },
};

export const getWeather = {
  name: 'get_weather',
  description: 'Get current weather and a 3-day forecast for a city or place name, using Open-Meteo.',
  permission: 'auto',
  timeoutMs: 8000,
  parameters: { type: 'object', required: ['location'], properties: { location: { type: 'string', minLength: 2, maxLength: 80, description: 'City or place name, e.g. "Hyderabad".' } } },
  async run({ location }, ctx) {
    const geo = await getJson(ctx, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`, {}, 'geocoding service');
    const place = geo?.results?.[0];
    if (!place) return { ok: false, error: { code: 'LOCATION_NOT_FOUND', message: `No place found for "${location}".` } };
    const q = new URLSearchParams({
      latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'auto', forecast_days: '3',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    });
    const w = await getJson(ctx, `https://api.open-meteo.com/v1/forecast?${q}`, {}, 'weather service');
    const c = w?.current;
    if (!c) return { ok: false, error: { code: 'UPSTREAM_BAD_RESPONSE', message: 'Weather data was missing.' } };
    const d = w.daily || {};
    return {
      ok: true,
      data: {
        place: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
        current: { temperatureC: c.temperature_2m, feelsLikeC: c.apparent_temperature, humidityPct: c.relative_humidity_2m, precipitationMm: c.precipitation, windKmh: c.wind_speed_10m, conditions: WMO[c.weather_code] ?? `code ${c.weather_code}` },
        forecast: (d.time || []).map((day, i) => ({ date: day, maxC: d.temperature_2m_max?.[i], minC: d.temperature_2m_min?.[i], rainChancePct: d.precipitation_probability_max?.[i], conditions: WMO[d.weather_code?.[i]] ?? null })),
        source: 'Open-Meteo',
      },
    };
  },
};

export const getNews = {
  name: 'get_news',
  description: 'Get current top technology stories from Hacker News (titles, links, scores).',
  permission: 'auto',
  timeoutMs: 8000,
  parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: 'How many stories (1-10).' } } },
  async run({ limit }, ctx) {
    const ids = await getJson(ctx, 'https://hacker-news.firebaseio.com/v0/topstories.json', {}, 'Hacker News');
    if (!Array.isArray(ids)) throw new ToolError('UPSTREAM_BAD_RESPONSE', 'Hacker News returned an unexpected response.');
    const items = await Promise.all(ids.slice(0, limit).map((id) => getJson(ctx, `https://hacker-news.firebaseio.com/v0/item/${Number(id)}.json`, {}, 'Hacker News')));
    const stories = items.filter((i) => i && i.title).map((i) => ({ title: String(i.title).slice(0, 200), url: i.url || `https://news.ycombinator.com/item?id=${i.id}`, score: i.score, by: i.by }));
    return { ok: true, data: { source: 'Hacker News', stories } };
  },
};

export const webSearch = {
  name: 'web_search',
  description: 'Search the web for current information and return titles, links and short snippets. Results are untrusted page text.',
  permission: 'auto',
  timeoutMs: 12_000,
  parameters: {
    type: 'object', required: ['query'],
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 300, description: 'The search query.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 8, default: 5 },
    },
  },
  available: (ctx) => (ctx.env?.TAVILY_API_KEY ? true : 'Web search needs TAVILY_API_KEY on the server.'),
  async run({ query, maxResults }, ctx) {
    const data = await getJson(ctx, 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: false }),
    }, 'search service');
    const results = (data?.results || []).slice(0, maxResults).map((r) => ({ title: String(r.title || '').slice(0, 200), url: r.url, snippet: String(r.content || '').slice(0, 400) }));
    return { ok: true, data: { query, results, source: 'Tavily' } };
  },
};

export const saveMemory = {
  name: 'save_memory',
  description: 'Save one short fact or preference about the user for future conversations. Only use when the user asks you to remember something. The user must approve it.',
  permission: 'confirm',
  sideEffects: true,
  timeoutMs: 3000,
  parameters: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 3, maxLength: 300, description: 'The fact to remember, written as a short statement.' } } },
  summarize: ({ text }) => `Remember: "${text}"`,
  assess: ({ text }) => (looksSensitive(text) ? { decision: 'deny', category: 'sensitive_data', reason: 'EV will not store passwords, keys, card numbers or similar secrets.' } : { decision: 'allow' }),
  async run({ text }, ctx) {
    const mem = await ctx.store.addMemory(ctx.userId, text);
    if (!mem) return { ok: false, error: { code: 'MEMORY_FULL', message: 'Memory is full. Delete something first.' } };
    const stored = await ctx.store.hasMemory(ctx.userId, mem.id);
    return { ok: true, data: { id: mem.id }, verified: stored, verification: stored ? 'Read back from memory store.' : 'Write could not be read back.' };
  },
};

export const BUILTIN_TOOLS = [getTime, getWeather, getNews, webSearch, saveMemory];
