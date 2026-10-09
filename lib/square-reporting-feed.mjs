// Read-only Square payment feed for Grok / MoneyPenny.
// Allowlisted fields only: attribution, tips, line items, fees.
// No buyer PII. No payroll math.

export const SQUARE_LOCATION_ID = 'LVNM3Z4RVRWDK';
export const REPORTING_TIMEZONE = 'America/Chicago';
export const SQUARE_VERSION = '2024-01-18';
export const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

export const GET_MOUNTING_MAN_SQUARE_DETAIL = 'get_mounting_man_square_detail';

/** Known staff ids → cashier_name. Mike must be the full legal name. */
export const KNOWN_CASHIERS = {
  TMSiHOOr7RGdl2Ki: 'Michael Wenzel',
  TMT84KWHegsrcWFB: 'Garrison Gillard',
  'TMY7unjtR-2XvVpg': 'Marshall Donnerbauer',
  TMmOwb6WS9cTplXu: 'Crashon Traylor',
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'address',
  'address_line_1',
  'address_line_2',
  'bank_account_details',
  'billing_address',
  'buyer_email_address',
  'buyer_phone',
  'card_details',
  'cardholder_name',
  'cash_details',
  'customer',
  'customer_id',
  'email',
  'email_address',
  'family_name',
  'fingerprint',
  'given_name',
  'last_4',
  'phone_number',
  'postal_code',
  'receipt_number',
  'receipt_url',
  'recipient',
  'shipping_address',
]);

export function chicagoDateString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-CA', { timeZone: REPORTING_TIMEZONE });
}

function timezoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

export function chicagoLocalToUtc(dateStr, hour = 0, minute = 0, second = 0) {
  const match = DATE_RE.exec(String(dateStr || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = localAsUtc;
  for (let i = 0; i < 2; i += 1) {
    utc = localAsUtc - timezoneOffsetMs(new Date(utc), REPORTING_TIMEZONE);
  }
  return new Date(utc);
}

export function addCalendarDay(dateStr) {
  const match = DATE_RE.exec(String(dateStr || '').trim());
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  const next = new Date(utc);
  const yyyy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function chicagoDayBounds(dateStr) {
  const start = chicagoLocalToUtc(dateStr, 0, 0, 0);
  const nextDay = addCalendarDay(dateStr);
  const end = nextDay ? chicagoLocalToUtc(nextDay, 0, 0, 0) : null;
  if (!start || !end) return null;
  return {
    date: dateStr,
    timezone: REPORTING_TIMEZONE,
    beginTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

export function sanitizeMoney(money) {
  if (!money || typeof money !== 'object') return null;
  const amount = Number(money.amount);
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    currency: money.currency || 'USD',
  };
}

export function sanitizeLineItem(item) {
  if (!item || typeof item !== 'object') return null;
  const name = item.name == null ? '' : String(item.name);
  const line = {
    name,
    quantity: item.quantity == null ? '1' : String(item.quantity),
    base_price_money: sanitizeMoney(item.base_price_money) || { amount: 0, currency: 'USD' },
  };
  if (item.variation_name) line.variation_name = String(item.variation_name);
  if (item.total_money) line.total_money = sanitizeMoney(item.total_money);
  if (Array.isArray(item.modifiers) && item.modifiers.length > 0) {
    line.modifiers = item.modifiers
      .map((modifier) => {
        if (!modifier || typeof modifier !== 'object') return null;
        return {
          name: modifier.name == null ? '' : String(modifier.name),
          base_price_money: sanitizeMoney(modifier.base_price_money) || { amount: 0, currency: 'USD' },
        };
      })
      .filter(Boolean);
  }
  return line;
}

export function sanitizeProcessingFee(fees) {
  if (!Array.isArray(fees) || fees.length === 0) return undefined;
  return fees.map((fee) => {
    const sanitized = {
      amount_money: sanitizeMoney(fee?.amount_money) || { amount: 0, currency: 'USD' },
    };
    if (fee?.type) sanitized.type = String(fee.type);
    if (fee?.effective_at) sanitized.effective_at = String(fee.effective_at);
    return sanitized;
  });
}

export function cashierNameFromTeamMember(member) {
  if (!member || typeof member !== 'object') return null;
  const display = typeof member.display_name === 'string' ? member.display_name.trim() : '';
  if (display) return display;
  const given = typeof member.given_name === 'string' ? member.given_name.trim() : '';
  const family = typeof member.family_name === 'string' ? member.family_name.trim() : '';
  const combined = [given, family].filter(Boolean).join(' ');
  return combined || null;
}

export function resolveCashierName(teamMemberId, teamMember) {
  if (teamMemberId && KNOWN_CASHIERS[teamMemberId]) return KNOWN_CASHIERS[teamMemberId];
  return cashierNameFromTeamMember(teamMember);
}

export function paymentTeamMemberId(payment, order) {
  return payment?.team_member_id
    || payment?.employee_id
    || order?.created_by_team_member_id
    || payment?.created_by_team_member_id
    || null;
}

function collectForbiddenKeys(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) found.push(key);
    collectForbiddenKeys(child, found);
  }
  return found;
}

export function assertNoBuyerPii(value) {
  const leaked = collectForbiddenKeys(value);
  if (leaked.length > 0) {
    throw new Error(`square reporting feed leaked PII keys: ${leaked.join(', ')}`);
  }
  return value;
}

export function sanitizePaymentDetail({ payment, order, teamMember } = {}) {
  const source = payment && typeof payment === 'object' ? payment : {};
  const teamMemberId = paymentTeamMemberId(source, order);
  const tip = sanitizeMoney(source.tip_money) || {
    amount: 0,
    currency: source.amount_money?.currency || 'USD',
  };
  const lineItems = Array.isArray(order?.line_items)
    ? order.line_items.map(sanitizeLineItem).filter(Boolean)
    : [];

  const detail = {
    payment_id: source.id || null,
    order_id: source.order_id || order?.id || null,
    created_at: source.created_at || null,
    status: source.status || null,
    team_member_id: teamMemberId,
    cashier_name: resolveCashierName(teamMemberId, teamMember),
    amount_money: sanitizeMoney(source.amount_money) || { amount: 0, currency: 'USD' },
    tip_money: tip,
    line_items: lineItems,
  };

  const processingFee = sanitizeProcessingFee(source.processing_fee);
  if (processingFee) detail.processing_fee = processingFee;

  return assertNoBuyerPii(detail);
}

export function parseSquareDetailArgs(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const paymentId = String(input.payment_id || input.paymentId || '').trim();
  const date = String(input.date || '').trim();
  if (paymentId) return { paymentId, date: DATE_RE.test(date) ? date : null };
  if (date && !DATE_RE.test(date)) {
    const error = new Error('date must be YYYY-MM-DD in America/Chicago');
    error.code = 'invalid_date';
    throw error;
  }
  return {
    paymentId: '',
    date: date || chicagoDateString(new Date()),
  };
}

function squareHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Square-Version': SQUARE_VERSION,
    'Content-Type': 'application/json',
  };
}

export function createSquareReportingClient({
  token,
  locationId = SQUARE_LOCATION_ID,
  httpClient,
} = {}) {
  if (!httpClient) {
    throw new Error('httpClient is required');
  }
  if (!token) {
    throw new Error('Square token is not configured');
  }

  const headers = squareHeaders(token);

  return {
    locationId,
    async getPayment(paymentId) {
      const response = await httpClient.get(
        `${SQUARE_API_BASE}/payments/${encodeURIComponent(paymentId)}`,
        { headers },
      );
      return response.data?.payment || null;
    },
    async listPayments({ beginTime, endTime } = {}) {
      const payments = [];
      let cursor;
      do {
        const params = new URLSearchParams({
          location_id: locationId,
          limit: '100',
        });
        if (beginTime) params.set('begin_time', beginTime);
        if (endTime) params.set('end_time', endTime);
        if (cursor) params.set('cursor', cursor);
        const response = await httpClient.get(`${SQUARE_API_BASE}/payments?${params}`, { headers });
        payments.push(...(response.data?.payments || []));
        cursor = response.data?.cursor || null;
      } while (cursor);
      return payments;
    },
    async batchOrders(orderIds) {
      const ids = [...new Set((orderIds || []).filter(Boolean))];
      const orders = {};
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const response = await httpClient.post(
          `${SQUARE_API_BASE}/orders/batch-retrieve`,
          { order_ids: chunk },
          { headers },
        );
        for (const order of response.data?.orders || []) {
          if (order?.id) orders[order.id] = order;
        }
      }
      return orders;
    },
    async getTeamMember(teamMemberId) {
      const response = await httpClient.get(
        `${SQUARE_API_BASE}/team-members/${encodeURIComponent(teamMemberId)}`,
        { headers },
      );
      return response.data?.team_member || null;
    },
  };
}

async function loadTeamMembers(client, teamMemberIds, logger) {
  const members = {};
  await Promise.all((teamMemberIds || []).map(async (id) => {
    if (KNOWN_CASHIERS[id]) {
      members[id] = {
        id,
        given_name: KNOWN_CASHIERS[id].split(' ')[0],
        family_name: KNOWN_CASHIERS[id].split(' ').slice(1).join(' '),
      };
      return;
    }
    try {
      members[id] = await client.getTeamMember(id);
    } catch (error) {
      logger?.warn?.('square_reporting_team_member_lookup_failed', { teamMemberId: id });
      members[id] = null;
    }
  }));
  return members;
}

function isCompletedAtLocation(payment, locationId) {
  if (!payment || payment.status !== 'COMPLETED') return false;
  if (payment.location_id && payment.location_id !== locationId) return false;
  return true;
}

export async function getMountingManSquareDetail(rawArgs, {
  client,
  now = new Date(),
  logger,
} = {}) {
  if (!client) throw new Error('Square reporting client is required');
  const args = parseSquareDetailArgs(rawArgs && Object.keys(rawArgs).length ? rawArgs : {
    date: chicagoDateString(now),
  });

  let payments = [];
  let date = args.date;

  if (args.paymentId) {
    const payment = await client.getPayment(args.paymentId);
    if (isCompletedAtLocation(payment, client.locationId)) {
      payments = [payment];
      date = chicagoDateString(payment.created_at);
    }
  } else {
    const bounds = chicagoDayBounds(args.date);
    if (!bounds) {
      const error = new Error('date must be YYYY-MM-DD in America/Chicago');
      error.code = 'invalid_date';
      throw error;
    }
    const listed = await client.listPayments({
      beginTime: bounds.beginTime,
      endTime: bounds.endTime,
    });
    payments = listed.filter((payment) => (
      isCompletedAtLocation(payment, client.locationId)
      && chicagoDateString(payment.created_at) === args.date
    ));
  }

  const orderIds = payments.map((payment) => payment.order_id).filter(Boolean);
  const orders = orderIds.length > 0 ? await client.batchOrders(orderIds) : {};
  const teamIds = [...new Set(payments
    .map((payment) => paymentTeamMemberId(payment, orders[payment.order_id]))
    .filter(Boolean))];
  const teamMembers = await loadTeamMembers(client, teamIds, logger);

  const feed = {
    timezone: REPORTING_TIMEZONE,
    location_id: client.locationId,
    date: date || null,
    payment_count: payments.length,
    payments: payments.map((payment) => {
      const order = orders[payment.order_id];
      const teamMemberId = paymentTeamMemberId(payment, order);
      return sanitizePaymentDetail({
        payment,
        order,
        teamMember: teamMembers[teamMemberId],
      });
    }),
  };

  return assertNoBuyerPii(feed);
}
