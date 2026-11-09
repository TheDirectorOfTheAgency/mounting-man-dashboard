// Home HUD telemetry.
// The active-agent roster and the completion/console panels do not read
// Agency Redis. Priorities still come from agency:priorities.

import { activeAgentsView, completionsForHud, consoleLinesForHud } from '../../lib/home-hud.js';

const PRIORITIES_KEY = 'agency:priorities';

let cache = { data: null, ts: 0 };
const CACHE_TTL = 15_000;

function agencyRedisConfig() {
  return {
    url: process.env.AGENCY_REDIS_URL || 'https://devoted-minnow-39394.upstash.io',
    token: process.env.AGENCY_REDIS_TOKEN,
  };
}

async function redisGet(key) {
  const { url, token } = agencyRedisConfig();
  if (!token) return null;
  try {
    const res = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    let parsed;
    try { parsed = JSON.parse(json.result); } catch { return json.result; }
    if (parsed && typeof parsed.value === 'string') {
      try { return JSON.parse(parsed.value); } catch { /* keep the outer object */ }
    }
    return parsed;
  } catch (err) {
    console.error(`[telemetry] Redis fetch error for ${key}:`, err.message);
    return null;
  }
}

function buildPriorities(priorityData) {
  if (!priorityData?.tasks?.length) {
    return { items: [], queuedCount: 0 };
  }

  const items = priorityData.tasks.slice(0, 6).map((task, index) => ({
    rank: index + 1,
    text: task.text || task.task || 'Untitled task',
    status: task.status || 'backlog',
  }));

  const queuedCount = items.filter((item) => item.status === 'queued').length;
  return { items, queuedCount };
}

export function resetTelemetryCache() {
  cache = { data: null, ts: 0 };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  try {
    const priorityData = await redisGet(PRIORITIES_KEY);
    const { items, okCount } = completionsForHud();
    const response = {
      agents: activeAgentsView(),
      completions: { items, okCount },
      priorities: buildPriorities(priorityData),
      console: { lines: consoleLinesForHud().lines },
      ts: new Date().toISOString(),
    };

    cache = { data: response, ts: now };
    res.status(200).json(response);
  } catch (err) {
    console.error('[telemetry] Handler error:', err);
    res.status(500).json({ error: 'Telemetry fetch failed', message: err.message });
  }
}
