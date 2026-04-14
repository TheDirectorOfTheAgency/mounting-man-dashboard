import axios from 'axios';

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VER = '2024-01-18';
const SQUARE_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID || process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;

const DISCORD_BOT_TOKEN =
  process.env.DISCORD_Q_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const DISCORD_INSTALL_THREAD = '1485380804707090643';
const DISCORD_Q_USER_ID = process.env.DISCORD_Q_USER_ID || '';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const Q_QUEUE_KEY = 'agency:context:siri_queue';
const DEDUP_TTL = 86400;

const TEAM_MEMBER_MAP = {
  TMSiHOOr7RGdl2Ki: 'Michael',
  TMT84KWHegsrcWFB: 'Garrison',
  'TMY7unjtR-2XvVpg': 'Marshall',
  TMmOwb6WS9cTplXu: 'Crashon',
};

const squareHeaders = () => ({
  Authorization: `Bearer ${SQUARE_TOKEN}`,
  'Square-Version': SQUARE_VER,
  'Content-Type': 'application/json',
});

async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return false;
  const cmd = ttl
    ? `set/${key}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttl}`
    : `set/${key}/${encodeURIComponent(JSON.stringify(value))}`;
  try {
    await axios.get(`${KV_URL}/${cmd}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return true;
  } catch (err) {
    console.error('[install-seed-kv-error]', err.response?.data || err.message);
    return false;
  }
}

async function kvExists(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await axios.get(`${KV_URL}/exists/${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return res.data?.result === 1;
  } catch {
    return false;
  }
}

async function kvRpush(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await axios.post(
      `${KV_URL}/rpush/${encodeURIComponent(key)}`,
      JSON.stringify(value),
      {
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return Boolean(res.data);
  } catch (err) {
    console.error('[install-seed-rpush-error]', err.response?.data || err.message);
    return false;
  }
}

async function kvSadd(key, member) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await axios.post(
      `${KV_URL}/sadd/${encodeURIComponent(key)}`,
      JSON.stringify([member]),
      {
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return true;
  } catch (err) {
    console.error('[install-seed-sadd-error]', err.response?.data || err.message);
    return false;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function normalizeCity(value) {
  const city = String(value || '').trim();
  if (!city) return '';
  const lower = city.toLowerCase();
  if (lower === 'saint paul' || lower === 'st paul' || lower === 'st. paul') {
    return 'St. Paul';
  }
  return city;
}

function sanitizeStreetName(line1) {
  const raw = String(line1 || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^\d+[A-Za-z\-\/]*\s+/, '')
    .replace(/\b(?:apt|apartment|unit|suite|ste)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '');
}

function parseTvSize(text) {
  const value = String(text || '');
  const match = value.match(/\b(43|50|55|60|65|70|75|80|85|86|98|100)\b/);
  return match ? `${match[1]}"` : '';
}

function detectTvBrand(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return '';
  if (value.includes('onn')) return value.includes('roku') ? 'onn. Roku TV' : 'onn.';
  if (value.includes('samsung')) return 'Samsung';
  if (value.includes('hisense')) return 'Hisense';
  if (value.includes('tcl')) return 'TCL';
  if (value.includes('lg')) return 'LG';
  if (value.includes('sony')) return 'Sony';
  if (value.includes('vizio')) return 'Vizio';
  if (value.includes('roku')) return 'Roku TV';
  return '';
}

function detectGalleryStyle(text) {
  const value = String(text || '').toLowerCase();
  return (
    value.includes('frame') ||
    value.includes('canvas') ||
    value.includes('nxtframe') ||
    value.includes('g series')
  );
}

function detectWallSurface(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return '';
  if (value.includes('drywall')) return 'Drywall';
  if (value.includes('wood slat')) return 'Wood Slats';
  if (value.includes('plaster') || value.includes('stucco')) return 'Plaster';
  if (value.includes('brick')) return 'Brick';
  if (value.includes('stone') || value.includes('faux brick')) return 'Stone';
  if (value.includes('tile') || value.includes('porcelain') || value.includes('ceramic')) return 'Tile';
  if (value.includes('concrete') || value.includes('block')) return 'Concrete';
  return '';
}

function detectBracket(text, { soldByUs = false } = {}) {
  const value = String(text || '').toLowerCase();
  if (!value || (!value.includes('bracket') && !value.includes('mount'))) return '';
  if (value.includes('soundbar')) return '';
  const suffix = soldByUs ? ' (Bought from us)' : '';
  if (value.includes('full motion') || value.includes('articulating')) return `Full Motion Bracket${suffix}`;
  if (value.includes('4d tilt')) return `Premium 4D Tilt Bracket${suffix}`;
  if (value.includes('premium tilt')) return `Premium Tilt Bracket${suffix}`;
  if (value.includes('tilt')) return `Tilt Bracket${suffix}`;
  if (value.includes('flush')) return `Flush Bracket${suffix}`;
  if (value.includes('fixed')) return `Fixed Bracket${suffix}`;
  if (value.includes('corner')) return `Corner Bracket${suffix}`;
  return '';
}

function detectCableManagement(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return '';
  if (value.includes('existing conduit')) return 'Existing Conduit';
  if (value.includes('soundbar cords')) return 'In-Wall Concealment With Soundbar Cords';
  if (value.includes('power bridge')) return 'Recessed Power Bridge';
  if (value.includes('new outlet')) return 'In-Wall Concealment With New Outlet';
  if (value.includes('through fireplace')) return 'In-Wall Concealment Through Fireplace';
  if (value.includes('in-wall') || value.includes('in wall')) return 'In-Wall Concealment';
  if (value.includes('exterior around fireplace')) return 'Exterior Concealment Around Fireplace';
  if (value.includes('exterior')) return 'Exterior Concealment';
  return '';
}

function detectFireplace(text) {
  const value = String(text || '').toLowerCase();
  if (!value.includes('fireplace')) return '';
  if (value.includes('brick fireplace')) return 'Brick Fireplace';
  if (value.includes('stone fireplace')) return 'Stone Fireplace';
  if (value.includes('plaster fireplace')) return 'Plaster Fireplace';
  if (value.includes('drywall fireplace')) return 'Drywall Fireplace';
  return 'Fireplace';
}

function normalizeLineItems(lineItems) {
  return (lineItems || [])
    .filter((item) => item?.name && item.name !== 'Sales Tax' && item.name !== 'CC Processing Fee')
    .map((item) => {
      const label = [item.variation_name, item.name].filter(Boolean).join(' — ');
      return {
        label,
        name: String(item.name || ''),
        variationName: String(item.variation_name || ''),
        quantity: Number(item.quantity || 1),
        note: String(item.note || ''),
      };
    });
}

function buildInstallFacts({ lineItems, payment, order, customer }) {
  const normalized = normalizeLineItems(lineItems);
  const textBlob = normalized.map((item) => `${item.variationName} ${item.name} ${item.note}`.trim()).join(' | ');
  const soldBracketByUs = normalized.some((item) => {
    const haystack = `${item.variationName} ${item.name}`.toLowerCase();
    return haystack.includes('tv mount') || haystack.includes('bracket');
  });
  return {
    performedBy:
      TEAM_MEMBER_MAP[payment?.team_member_id] ||
      TEAM_MEMBER_MAP[order?.created_by_team_member_id] ||
      TEAM_MEMBER_MAP[payment?.created_by_team_member_id] ||
      '',
    tvSize: parseTvSize(textBlob),
    tvBrand: detectTvBrand(textBlob),
    galleryStyle: detectGalleryStyle(textBlob),
    wallSurface: detectWallSurface(textBlob),
    fireplaceType: detectFireplace(textBlob),
    bracketType: detectBracket(textBlob, { soldByUs: soldBracketByUs }),
    cableManagement: detectCableManagement(textBlob),
    streetName: sanitizeStreetName(customer?.address?.address_line_1),
    city: normalizeCity(firstNonEmpty(customer?.address?.locality)),
    state: firstNonEmpty(customer?.address?.administrative_district_level_1),
    postalCode: firstNonEmpty(customer?.address?.postal_code),
    sourceLabels: normalized.map((item) => item.label).filter(Boolean),
  };
}

function compactSeed(seed) {
  return Object.fromEntries(
    Object.entries(seed).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== null && value !== '';
    }),
  );
}

async function fetchRecentCompletedPayments() {
  const begin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    location_id: SQUARE_LOCATION_ID,
    begin_time: begin,
    sort_order: 'DESC',
    limit: '10',
  });
  const response = await axios.get(`${SQUARE_BASE}/payments?${params.toString()}`, {
    headers: squareHeaders(),
  });
  return (response.data?.payments || []).filter((payment) => payment?.status === 'COMPLETED');
}

async function fetchCustomer(customerId) {
  const response = await axios.get(`${SQUARE_BASE}/customers/${customerId}`, {
    headers: squareHeaders(),
  });
  return response.data?.customer || {};
}

async function fetchOrder(orderId) {
  if (!orderId) return {};
  const response = await axios.get(`${SQUARE_BASE}/orders/${orderId}`, {
    headers: squareHeaders(),
  });
  return response.data?.order || {};
}

async function notifyInstallThread({ payment, customer, order, lineItems, eventType }) {
  if (!DISCORD_BOT_TOKEN) {
    console.warn('[install-seed] No DISCORD_BOT_TOKEN configured');
    return { skipped: 'missing_discord_token' };
  }

  const amountCents = payment.amount_money?.amount || payment.total_money?.amount || 0;
  const amount = (amountCents / 100).toFixed(2);
  const installDedupKey = `square:install-post:${payment.order_id || payment.id || 'unknown'}`;
  if (await kvExists(installDedupKey)) {
    return { skipped: 'duplicate', key: installDedupKey };
  }
  await kvSet(installDedupKey, { processed: new Date().toISOString() }, DEDUP_TTL);

  const facts = buildInstallFacts({ lineItems, payment, order, customer });
  const fullName = [customer?.given_name, customer?.family_name].filter(Boolean).join(' ') || customer?.given_name || 'Customer';
  const addr = customer?.address || {};
  const addressParts = [
    addr.address_line_1,
    addr.address_line_2,
    facts.city && addr.administrative_district_level_1
      ? `${facts.city}, ${addr.administrative_district_level_1}`
      : facts.city || addr.administrative_district_level_1,
    addr.postal_code,
  ].filter(Boolean);
  const addressLine = addressParts.length > 0 ? addressParts.join(', ') : '(address not on file)';
  const streetOnly = facts.streetName ? `${facts.streetName}${facts.city ? `, ${facts.city}` : ''}` : '';
  const triggerStatus = 'Square webhook failed; Vercel fallback succeeded';
  const triggerSourceCode = 'vercel-cron-fallback';
  const triggerEvent = eventType;
  const jobParts = facts.sourceLabels;
  const jobSummary = jobParts.length > 0 ? jobParts.join('\n') : '(job details unavailable)';

  const draftSeed = compactSeed({
    city: facts.city,
    state: facts.state,
    title: '',
    slug: '',
    'post-body': '',
    'post-summary': '',
    'tv-size': facts.tvSize,
    'tv-brand': facts.tvBrand,
    'wall-surface': facts.wallSurface,
    'metro-area': '',
    'location-id': '',
    'gallery-style': facts.galleryStyle,
    'fireplace-type': facts.fireplaceType,
    price: `$${amount}`,
    'performed-by': facts.performedBy,
    'street-name': facts.streetName,
    'mount-type': '',
    'room-type': '',
    'bracket-type': facts.bracketType,
    'hardware-used': '',
    'cable-management': facts.cableManagement,
    'job-notes': jobParts.join(' | '),
    'local-reference': facts.streetName || '',
    'nearby-cities': [],
    'image-path': '',
    'source-order-id': payment.order_id || '',
    'source-payment-id': payment.id || '',
    'trigger-status': triggerStatus,
    'trigger-source-code': triggerSourceCode,
    'trigger-event': triggerEvent,
  });

  const factLines = [
    facts.performedBy ? `Technician: ${facts.performedBy}` : '',
    facts.tvSize ? `TV size: ${facts.tvSize}` : '',
    facts.tvBrand ? `TV brand: ${facts.tvBrand}` : '',
    facts.galleryStyle ? 'Gallery style: true' : '',
    facts.wallSurface ? `Wall surface: ${facts.wallSurface}` : '',
    facts.fireplaceType ? `Fireplace: ${facts.fireplaceType}` : '',
    facts.bracketType ? `Bracket: ${facts.bracketType}` : '',
    facts.cableManagement ? `Cable management: ${facts.cableManagement}` : '',
    streetOnly ? `Street seed: near ${streetOnly}` : '',
  ].filter(Boolean);

  const qMention = DISCORD_Q_USER_ID ? `<@${DISCORD_Q_USER_ID}> ` : '';
  const qTask = [
    'Installation post seed ready.',
    `Client: ${fullName}.`,
    facts.performedBy ? `Technician: ${facts.performedBy}.` : '',
    facts.city ? `City: ${facts.city}.` : '',
    facts.streetName ? `Street seed: ${facts.streetName}.` : '',
    `Amount: $${amount}.`,
    `Square webhook: failed.`,
    `Fallback trigger: Vercel cron succeeded.`,
    `Trigger event: ${triggerEvent}.`,
    payment.order_id ? `Order ID: ${payment.order_id}.` : '',
    `Wait for the photo in Discord thread ${DISCORD_INSTALL_THREAD}, then prepare the installation post from the queued seed JSON.`,
    `Seed JSON: ${JSON.stringify(draftSeed)}`,
  ].filter(Boolean).join(' ');

  const message = [
    `${qMention}📸 **New job paid — ready for installation post**`,
    `**Client**: ${fullName}`,
    `**Address**: ${addressLine}`,
    `**Job**:\n${jobParts.length > 0 ? jobParts.map((p) => `  • ${p}`).join('\n') : `  • ${jobSummary}`}`,
    `**Amount**: $${amount}`,
    `**Square webhook**: failed`,
    `**Fallback trigger**: Vercel cron succeeded`,
    `**Trigger event**: ${triggerEvent}`,
    factLines.length > 0 ? `**Draft facts**:\n${factLines.map((line) => `  • ${line}`).join('\n')}` : '',
    '',
    '**Suggested seed JSON**:',
    '```json',
    JSON.stringify(draftSeed, null, 2),
    '```',
    "Drop the job photo and I'll have the post ready to publish.",
  ].join('\n');

  await kvRpush(Q_QUEUE_KEY, JSON.stringify({
    task: qTask,
    from: 'square-payment-cron',
    timestamp: new Date().toISOString(),
    orderId: payment.order_id || '',
    paymentId: payment.id || '',
    threadId: DISCORD_INSTALL_THREAD,
    seed: draftSeed,
  }));

  // ---- Stage seed in dedicated Redis key for Q's photo handler ----
  const pendingId = payment.order_id || payment.id || `unknown-${Date.now()}`;
  const pendingKey = `install-post:pending:${pendingId}`;
  await kvSet(pendingKey, JSON.stringify({
    seed: draftSeed,
    orderId: payment.order_id || '',
    paymentId: payment.id || '',
    invoiceId: '',
    customerName: fullName,
    threadId: DISCORD_INSTALL_THREAD,
    stagedAt: new Date().toISOString(),
    source: triggerSourceCode,
  }), 172800); // 48h TTL
  await kvSadd('install-post:pending-index', pendingKey);
  console.log(`[install-seed-cron] Staged seed in Redis: ${pendingKey}`);

  await axios.post(
    `https://discord.com/api/v10/channels/${DISCORD_INSTALL_THREAD}/messages`,
    {
      content: message,
      allowed_mentions: DISCORD_Q_USER_ID ? { users: [DISCORD_Q_USER_ID] } : undefined,
    },
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } },
  );

  return {
    posted: true,
    paymentId: payment.id,
    orderId: payment.order_id || '',
    customer: fullName,
  };
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  const vercelCronHeader = req.headers['x-vercel-cron'];
  const cronSecret = process.env.CRON_SECRET || '';
  const authorizedByBearer = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const authorizedByVercelCron = Boolean(vercelCronHeader);

  if (!authorizedByBearer && !authorizedByVercelCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SQUARE_TOKEN || !SQUARE_LOCATION_ID) {
    return res.status(400).json({ error: 'Missing Square credentials' });
  }

  try {
    const payments = await fetchRecentCompletedPayments();
    const results = [];

    for (const payment of payments) {
      if (!payment?.id || !payment?.customer_id) continue;
      try {
        const customer = await fetchCustomer(payment.customer_id);
        const order = await fetchOrder(payment.order_id);
        const lineItems = order?.line_items || [];
        const result = await notifyInstallThread({
          payment,
          customer,
          order,
          lineItems,
          eventType: 'cron.square.completed',
        });
        results.push(result);
      } catch (err) {
        results.push({
          posted: false,
          paymentId: payment.id,
          error: err.response?.data || err.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      scanned: payments.length,
      results,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[square-install-post-seed] Unhandled error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
