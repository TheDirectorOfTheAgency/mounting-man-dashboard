// /pages/api/thread-feed.js
// Fetches messages from ALL text channels in The Agency Discord server
// Guild: The Agency (1472620166033576169)

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const GUILD_ID = '1472620166033576169';

let cache = { data: null, ts: 0 };
const CACHE_TTL = 30_000; // 30 second cache

async function discordFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  try {
    // Get all channels in the guild + active threads (threads need separate endpoint)
    const [channels, activeThreadsData] = await Promise.all([
      discordFetch(`/guilds/${GUILD_ID}/channels`),
      discordFetch(`/guilds/${GUILD_ID}/threads/active`),
    ]);
    if (!channels) return res.status(200).json({ lines: [] });

    // Text channels (type 0 = GUILD_TEXT) plus any type 11/12 returned by channels endpoint
    const textChannels = channels.filter(c => c.type === 0 || c.type === 11 || c.type === 12);

    // Merge active threads (these are NOT returned by /channels — separate API call required)
    const activeThreads = activeThreadsData?.threads || [];
    for (const t of activeThreads) {
      if (!textChannels.find(c => c.id === t.id)) {
        textChannels.push(t);
      }
    }

    // Fetch last 20 messages from each channel in parallel (limit per channel)
    const fetchResults = await Promise.allSettled(
      textChannels.map(ch =>
        discordFetch(`/channels/${ch.id}/messages?limit=5`)
          .then(msgs => ({ channel: ch.name, msgs: msgs || [] }))
          .catch(() => ({ channel: ch.name, msgs: [] }))
      )
    );

    // Flatten all messages
    const allMessages = [];
    for (const result of fetchResults) {
      if (result.status === 'fulfilled' && result.value.msgs.length > 0) {
        for (const msg of result.value.msgs) {
          if (!msg.content && !msg.embeds?.length) continue; // skip empty
          allMessages.push({ ...msg, channelName: result.value.channel });
        }
      }
    }

    // Sort chronologically (oldest first) — Discord returns newest first per channel
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Keep last 80 messages across all channels
    const recent = allMessages.slice(-80);

    const lines = recent.map((msg) => {
      const username = msg.author?.username || 'unknown';
      const isQ = username.toLowerCase().includes('q') ||
                  username.toLowerCase().includes('openclaw') ||
                  username.toLowerCase().includes('branch') ||
                  username === 'CC-M4';
      const isCCM4 = username === 'CC-M4' || username.toLowerCase().includes('cc-m4');

      let label, level;
      if (isCCM4) {
        label = 'cc-m4';
        level = 'info';
      } else if (isQ) {
        label = 'Q';
        level = 'ok';
      } else {
        label = 'mr';
        level = 'info';
      }

      const content = msg.content || (msg.embeds?.length ? '[embed]' : '[attachment]');

      return {
        ts: msg.timestamp, // full ISO timestamp
        label,
        level,
        msg: `[#${msg.channelName}] ${content}`,
        category: 'thread',
      };
    });

    const result = { lines };
    cache = { data: result, ts: now };
    return res.status(200).json(result);
  } catch (err) {
    console.error('[thread-feed] Error:', err.message);
    return res.status(200).json({ lines: [] });
  }
}
