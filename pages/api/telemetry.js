// /pages/api/telemetry.js — Reads live agent status, completions, and priorities from Agency Redis
// Data sources:
//   agency:agents:status     — Q's model hierarchy and agent config
//   agency:context:active    — Recent agent activity log (completions)
//   agency:priorities        — Task priority stack (queued/scheduled/backlog)

const AGENCY_REDIS_URL = process.env.AGENCY_REDIS_URL || 'https://devoted-minnow-39394.upstash.io';
const AGENCY_REDIS_TOKEN = process.env.AGENCY_REDIS_TOKEN;

// In-memory cache (15 second TTL)
let cache = { data: null, ts: 0 };
const CACHE_TTL = 15_000;

async function redisGet(key) {
  if (!AGENCY_REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${AGENCY_REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${AGENCY_REDIS_TOKEN}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    let parsed;
    try { parsed = JSON.parse(json.result); } catch { return json.result; }
    // Handle double-encoded values — Q stores {value: "JSON string"}
    if (parsed && typeof parsed.value === 'string') {
      try { return JSON.parse(parsed.value); } catch {}
    }
    return parsed;
  } catch (err) {
    console.error(`[telemetry] Redis fetch error for ${key}:`, err.message);
    return null;
  }
}

function buildAgentResponse(agentData, contextLog) {
  if (!agentData) {
    return {
      agents: [{
        id: 'main', label: 'Q // Front Door', model: 'unknown',
        status: 'offline', task: 'No telemetry data', fallbacks: [],
      }],
      totalAgents: 1, activeCount: 0,
    };
  }

  const agents = [...(agentData.agents || [])];
  const now = Date.now();
  const SUBAGENT_WINDOW = 10 * 60 * 1000;

  // Detect active sub-agents from context log
  const activeSubagents = [];
  if (contextLog?.length > 0) {
    for (const entry of contextLog) {
      const ts = new Date(entry.timestamp || entry.ts).getTime();
      if (now - ts < SUBAGENT_WINDOW) {
        const action = (entry.action || '').toLowerCase();
        if (action.includes('sub-agent') || action.includes('subagent') || action.includes('worker') || action.includes('spawned')) {
          const modelMatch = action.match(/(?:sonnet|opus|haiku|gpt|minimax|qwen)[\w\-.]*/i);
          activeSubagents.push({
            id: `sub-${activeSubagents.length + 1}`,
            label: `Worker ${String.fromCharCode(945 + activeSubagents.length)}`,
            model: modelMatch?.[0] || agentData.subagentConfig?.model || 'sonnet-4.6',
            status: 'active',
            task: entry.action?.substring(0, 60) || 'Processing',
          });
        }
      }
    }
  }

  agents.push(...activeSubagents);

  // Show idle pool if no sub-agents active
  if (activeSubagents.length === 0 && agentData.subagentConfig) {
    agents.push({
      id: 'subagent-pool', label: 'Sub-Agent Pool',
      model: agentData.subagentConfig.model,
      status: 'standby',
      task: `${agentData.subagentConfig.maxConcurrent} slots available`,
    });
  }

  const activeCount = agents.filter(a => a.status === 'active').length;
  return { agents, totalAgents: agents.length, activeCount, updatedAt: agentData.updatedAt };
}

function buildCompletions(contextLog) {
  if (!contextLog?.length) return { items: [], okCount: 0 };

  // Extract recent completed actions from context log
  // Show last 8 entries, most recent first
  const items = contextLog
    .slice(-20)
    .reverse()
    .filter(entry => entry.action && entry.agent)
    .slice(0, 8)
    .map(entry => {
      // Determine model from agent field
      const agent = entry.agent || 'system';
      let model = 'system';
      if (agent.includes('CC-M4') || agent.includes('claude-code')) model = 'sonnet-4.6';
      else if (agent.includes('Q') || agent.includes('q-branch')) model = 'gpt-5.4';
      else if (agent.includes('worker')) model = 'sonnet-4.6';
      else if (agent === 'system') model = 'system';
      else model = agent;

      // Determine if completed (✓) or in-progress (◦)
      const action = (entry.action || '').toLowerCase();
      const isComplete = action.includes('completed') || action.includes('published') ||
        action.includes('posted') || action.includes('synced') || action.includes('added') ||
        action.includes('created') || action.includes('deployed') || action.includes('fixed') ||
        action.includes('updated') || action.includes('ingested') || action.includes('done');

      // Format timestamp
      const ts = entry.timestamp || entry.ts || '';
      const time = ts ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

      return {
        text: entry.action,
        time,
        model,
        status: isComplete ? 'ok' : 'pending',
      };
    });

  const okCount = items.filter(i => i.status === 'ok').length;
  return { items, okCount };
}

function buildPriorities(priorityData) {
  if (!priorityData?.tasks?.length) {
    return { items: [], queuedCount: 0 };
  }

  const items = priorityData.tasks.slice(0, 6).map((task, i) => ({
    rank: i + 1,
    text: task.text || task.task || 'Untitled task',
    status: task.status || 'backlog', // queued, scheduled, backlog, blocked
    model: task.model || task.lane || 'unassigned',
  }));

  const queuedCount = items.filter(i => i.status === 'queued').length;
  return { items, queuedCount };
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
    const [agentData, contextData, priorityData, consoleLines] = await Promise.all([
      redisGet('agency:agents:status'),
      redisGet('agency:context:active'),
      redisGet('agency:priorities'),
      redisGet('agency:console:lines'),
    ]);

    const contextLog = contextData?.log || [];
    const completions = buildCompletions(contextLog);
    const priorities = buildPriorities(priorityData);

    // Console lines from gateway log
    const consoleParsed = Array.isArray(consoleLines) ? consoleLines.slice(-50) : [];

    // Merge contextLog entries into console stream so ops events appear in the feed
    const contextLines = [];
    if (contextLog?.length > 0) {
      for (const entry of contextLog.slice(-50)) {
        if (!entry.action) continue;
        const agent = entry.agent || 'system';
        let label;
        if (agent.includes('CC-M4') || agent.includes('claude-code')) label = 'cc-m4';
        else if (agent === 'system' || agent === 'sys') label = 'sys';
        else label = 'exec';

        const action = (entry.action || '').toLowerCase();
        let level;
        if (action.includes('error') || action.includes('failed')) level = 'error';
        else if (action.includes('warn')) level = 'warn';
        else if (action.includes('completed') || action.includes('deployed') || action.includes('published') ||
                 action.includes('done') || action.includes('fixed') || action.includes('updated') ||
                 action.includes('created') || action.includes('ingested') || action.includes('added')) level = 'ok';
        else if (action.includes('start') || action.includes('spawn') || action.includes('init') ||
                 action.includes('launch')) level = 'start';
        else level = 'info';

        contextLines.push({
          ts: entry.timestamp || entry.ts || '',
          label,
          level,
          msg: entry.action,
          category: 'context',
        });
      }
    }

    // Merge and sort by timestamp (ISO strings sort lexicographically)
    const allConsoleLines = [...consoleParsed, ...contextLines]
      .filter(l => l.ts)
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .slice(-80);

    const response = {
      agents: buildAgentResponse(agentData, contextLog),
      completions,
      priorities,
      console: { lines: allConsoleLines },
      ts: new Date().toISOString(),
    };

    cache = { data: response, ts: now };
    res.status(200).json(response);
  } catch (err) {
    console.error('[telemetry] Handler error:', err);
    res.status(500).json({ error: 'Telemetry fetch failed', message: err.message });
  }
}
