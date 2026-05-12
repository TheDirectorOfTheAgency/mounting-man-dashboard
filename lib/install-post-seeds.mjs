const DEFAULT_TEAM_MEMBER_MAP = {
  TMSiHOOr7RGdl2Ki: 'Michael',
  TMT84KWHegsrcWFB: 'Garrison',
  'TMY7unjtR-2XvVpg': 'Marshall',
  TMmOwb6WS9cTplXu: 'Crashon',
};

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

export function normalizeCity(value) {
  const city = String(value || '').trim();
  if (!city) return '';
  const lower = city.toLowerCase();
  if (lower === 'saint paul' || lower === 'st paul' || lower === 'st. paul') {
    return 'St. Paul';
  }
  return city;
}

export function sanitizeStreetName(line1) {
  const raw = String(line1 || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^\d+[A-Za-z\-\/]*\s+/, '')
    .replace(/\b(?:apt|apartment|unit|suite|ste)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '');
}

export function parseTvSize(text) {
  const value = String(text || '');
  const match = value.match(/\b(43|50|55|60|65|70|75|80|85|86|98|100)\b/);
  return match ? `${match[1]}"` : '';
}

export function detectTvBrand(text) {
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

export function detectGalleryStyle(text) {
  const value = String(text || '').toLowerCase();
  return (
    value.includes('frame') ||
    value.includes('canvas') ||
    value.includes('nxtframe') ||
    value.includes('g series')
  );
}

export function detectWallSurface(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return '';
  if (value.includes('wood slat')) return 'Wood Slats';
  if (value.includes('drywall')) return 'Drywall';
  if (value.includes('plaster') || value.includes('stucco')) return 'Plaster';
  if (value.includes('faux brick')) return 'Stone';
  if (value.includes('brick')) return 'Brick';
  if (value.includes('stone')) return 'Stone';
  if (value.includes('tile') || value.includes('porcelain') || value.includes('ceramic')) return 'Tile';
  if (value.includes('concrete') || value.includes('block')) return 'Concrete';
  return '';
}

export function detectBracket(text, { soldByUs = false } = {}) {
  const value = String(text || '').toLowerCase();
  if (!value || (!value.includes('bracket') && !value.includes('mount'))) return '';
  if (value.includes('soundbar')) return '';
  const suffix = soldByUs ? ' (Bought from us)' : '';
  if (value.includes('full motion') || value.includes('full-motion') || value.includes('articulating')) return `Full Motion Bracket${suffix}`;
  if (value.includes('4d tilt')) return `Premium 4D Tilt Bracket${suffix}`;
  if (value.includes('premium tilt')) return `Premium Tilt Bracket${suffix}`;
  if (value.includes('tilt')) return `Tilt Bracket${suffix}`;
  if (value.includes('flush')) return `Flush Bracket${suffix}`;
  if (value.includes('fixed')) return `Fixed Bracket${suffix}`;
  if (value.includes('corner')) return `Corner Bracket${suffix}`;
  return '';
}

export function detectCableManagement(text) {
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
  if (value.includes('cord conceal') || value.includes('cable conceal')) return 'Cord Concealment';
  return '';
}

export function detectFireplace(text) {
  const value = String(text || '').toLowerCase();
  if (!value.includes('fireplace')) return '';
  if (value.includes('brick fireplace')) return 'Brick Fireplace';
  if (value.includes('stone fireplace')) return 'Stone Fireplace';
  if (value.includes('plaster fireplace')) return 'Plaster Fireplace';
  if (value.includes('drywall fireplace')) return 'Drywall Fireplace';
  return 'Fireplace';
}

export function formatMoney(amountCents) {
  const cents = Number(amountCents || 0);
  const amount = cents / 100;
  const fixed = amount.toFixed(2);
  return `$${fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed}`;
}

const STANDARD_TV_INSTALL_PRICE_CENTS = {
  '43"': 15000,
  '50"': 15000,
  '55"': 15000,
  '60"': 15000,
  '65"': 15000,
  '70"': 20000,
  '75"': 22500,
  '80"': 25000,
  '85"': 25000,
  '86"': 25000,
  '98"': 50000,
  '100"': 50000,
};

const GALLERY_TV_INSTALL_PRICE_CENTS = {
  '43"': 25000,
  '50"': 25000,
  '55"': 25000,
  '65"': 25000,
  '75"': 35000,
  '85"': 40000,
  '86"': 40000,
};

const MANTELMOUNT_PRICE_CENTS = {
  '43"': 50000,
  '50"': 50000,
  '55"': 50000,
  '60"': 50000,
  '65"': 50000,
  '70"': 60000,
  '75"': 60000,
  '80"': 75000,
  '85"': 100000,
  '86"': 100000,
};

const WALL_SURFACE_PRICE_CENTS = {
  Drywall: 0,
  Plaster: 5000,
  Brick: 5000,
  'Wood Slats': 5000,
  Concrete: 5000,
  Stone: 10000,
  Tile: 10000,
};

function quantityForItem(item) {
  return Math.max(1, Math.round(Number(item?.quantity || 1)));
}

function rawItemText(item) {
  return [
    item?.variation_name,
    item?.name,
    item?.note,
  ].map(cleanLabelPart).filter(Boolean).join(' ');
}

function grossLineAmountCents(item) {
  const quantity = quantityForItem(item);
  const amount = (money) => Number(money?.amount || 0);
  if (item?.gross_sales_money?.amount !== undefined) {
    return Math.round(amount(item.gross_sales_money));
  }
  if (item?.base_price_money?.amount !== undefined) {
    return Math.round(amount(item.base_price_money) * quantity);
  }
  for (const value of [item?.amount_money?.amount, item?.total_money_amount, item?.total_money?.amount]) {
    const fallback = Number(value);
    if (Number.isFinite(fallback) && fallback > 0) {
      return Math.round(fallback);
    }
  }
  return 0;
}

function tvInstallPriceCents(text) {
  const size = parseTvSize(text);
  if (!size) return null;
  const lower = String(text || '').toLowerCase();
  if (lower.includes('mantelmount') || lower.includes('mantel mount')) {
    return MANTELMOUNT_PRICE_CENTS[size] ?? null;
  }
  if (detectGalleryStyle(text)) {
    return GALLERY_TV_INSTALL_PRICE_CENTS[size] || STANDARD_TV_INSTALL_PRICE_CENTS[size] || null;
  }
  const standardPrice = STANDARD_TV_INSTALL_PRICE_CENTS[size] || 0;
  if (!standardPrice) return null;
  if (detectFireplace(text)) {
    return standardPrice + 5000;
  }
  return standardPrice;
}

function wallSurfacePriceCents(text) {
  const surface = detectWallSurface(text);
  if (!surface) return null;
  return WALL_SURFACE_PRICE_CENTS[surface] ?? null;
}

function bracketPriceCents(text) {
  const lower = String(text || '').toLowerCase();
  if (!detectBracket(text)) return null;
  if (lower.includes('premium full motion')) return 20000;
  if (lower.includes('premium tilt')) return 20000;
  if (lower.includes('4d tilt')) return 10000;
  if (lower.includes('flush')) return 13500;
  if (lower.includes('full motion') || lower.includes('full-motion') || lower.includes('articulating')) return 10000;
  if (lower.includes('corner')) return 10000;
  if (lower.includes('tilt')) return 7500;
  if (lower.includes('fixed')) return 5000;
  return null;
}

function soundbarPriceCents(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.includes('soundbar') && !lower.includes('sound bar')) return null;
  if (lower.includes('premium') && lower.includes('bracket')) return 10000;
  if (lower.includes('bracket')) return 5000;
  if (lower.includes('two') || lower.includes('2 sound')) return 20000;
  return 10000;
}

function cableManagementPriceCents(text) {
  const cable = detectCableManagement(text);
  if (!cable) return null;
  switch (cable) {
    case 'Existing Conduit':
      return 5000;
    case 'Exterior Concealment':
      return 7500;
    case 'Exterior Concealment Around Fireplace':
      return 12500;
    case 'In-Wall Concealment':
    case 'In-Wall Concealment With New Outlet':
    case 'Recessed Power Bridge':
      return 25000;
    case 'In-Wall Concealment With Soundbar Cords':
      return 30000;
    case 'In-Wall Concealment Through Fireplace':
      return 35000;
    default:
      return null;
  }
}

function extractAmountCents(item) {
  const text = rawItemText(item);
  const quantity = quantityForItem(item);
  const servicePrice = [
    tvInstallPriceCents(text) ||
      null,
    wallSurfacePriceCents(text),
    soundbarPriceCents(text),
    cableManagementPriceCents(text),
    bracketPriceCents(text),
  ].find((value) => value !== null && value !== undefined);
  if (servicePrice !== null && servicePrice !== undefined) {
    return servicePrice * quantity;
  }
  return grossLineAmountCents(item);
}

function cleanLabelPart(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeLineItems(lineItems) {
  return (lineItems || [])
    .filter((item) => {
      const name = String(item?.name || '').trim();
      if (!name) return false;
      const lower = name.toLowerCase();
      return !['sales tax', 'cc processing fee', 'credit card processing fee'].includes(lower);
    })
    .map((item, index) => {
      const name = cleanLabelPart(item.name);
      const variationName = cleanLabelPart(item.variation_name);
      const note = cleanLabelPart(item.note);
      const quantity = Math.max(1, Math.round(Number(item.quantity || 1)));
      const label = [variationName, name].filter(Boolean).join(' — ');
      return {
        index,
        label,
        name,
        variationName,
        note,
        quantity,
        amountCents: extractAmountCents(item),
      };
    });
}

function compactSeed(seed) {
  return Object.fromEntries(
    Object.entries(seed).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== null && value !== '';
    }),
  );
}

function itemText(item) {
  return `${item.variationName} ${item.name} ${item.note}`.trim();
}

function itemTextLower(item) {
  return itemText(item).toLowerCase();
}

function isWallSurfaceItem(item) {
  const text = itemTextLower(item);
  return text.includes('wall type') || text.includes('wall surface');
}

function isSoundbarItem(item) {
  const text = itemTextLower(item);
  return text.includes('soundbar');
}

function isCableItem(item) {
  const text = itemTextLower(item);
  if (isSoundbarItem(item)) return false;
  return Boolean(
    detectCableManagement(text) ||
    text.includes('cord') ||
    text.includes('conduit') ||
    text.includes('raceway') ||
    text.includes('wiremold') ||
    text.includes('cable management') ||
    text.includes('conceal'),
  );
}

function isBracketItem(item) {
  const text = itemTextLower(item);
  if (isSoundbarItem(item) || isCableItem(item) || isWallSurfaceItem(item)) return false;
  if (!detectBracket(text)) return false;
  return text.includes('bracket') || text.includes('tv mount') || text.includes('mounting bracket');
}

function isTvInstallItem(item) {
  const text = itemTextLower(item);
  if (isWallSurfaceItem(item) || isSoundbarItem(item) || isCableItem(item) || isBracketItem(item)) return false;
  if (text.includes('tv installation') || text.includes('tv mounting')) return true;
  if (text.includes('mantelmount installation')) return true;
  return Boolean(parseTvSize(text) && (text.includes('installation') || text.includes('mounting') || text.includes('fireplace')));
}

function expandItem(item) {
  const count = Math.max(1, item.quantity || 1);
  if (count === 1) return [{ ...item, quantity: 1 }];
  const base = Math.floor(item.amountCents / count);
  let remaining = item.amountCents;
  return Array.from({ length: count }, (_, index) => {
    const amountCents = index === count - 1 ? remaining : base;
    remaining -= amountCents;
    return {
      ...item,
      quantity: 1,
      label: `${item.label} #${index + 1}`,
      amountCents,
    };
  });
}

function serviceLabel(item) {
  const tvSize = parseTvSize(itemText(item));
  const text = itemTextLower(item);
  if (isWallSurfaceItem(item)) {
    const surface = detectWallSurface(itemText(item));
    return surface ? `${surface} — Wall Type` : item.label;
  }
  if (isTvInstallItem(item) && tvSize) {
    return text.includes('fireplace')
      ? `${tvSize} — TV Installation Over Fireplace`
      : `${tvSize} — TV Installation`;
  }
  const bracket = detectBracket(itemText(item));
  if (bracket) return bracket;
  if (isSoundbarItem(item)) return 'Soundbar Mounting';
  const cable = detectCableManagement(itemText(item));
  if (cable) return cable;
  return item.label;
}

function addItem(unit, item) {
  unit.items.push(item);
  unit.sourceIndexes.push(item.index);
  const label = serviceLabel(item);
  if (label && !unit.labels.includes(label)) {
    unit.labels.push(label);
  }
}

function assignSequentialAccessories(units, accessories, { allowAfterLast = true } = {}) {
  for (const item of accessories) {
    if (item.assigned) continue;
    const priorUnits = units.filter((unit) => unit.firstIndex < item.index);
    if (!priorUnits.length) continue;
    const latest = priorUnits[priorUnits.length - 1];
    const nextUnit = units.find((unit) => unit.firstIndex > latest.firstIndex);
    if ((nextUnit && item.index < nextUnit.firstIndex) || (!nextUnit && allowAfterLast)) {
      addItem(latest, item);
      item.assigned = true;
    }
  }
}

function assignByIndex(units, accessories) {
  const unassigned = accessories.filter((item) => !item.assigned);
  if (unassigned.length === units.length) {
    unassigned.forEach((item, index) => {
      addItem(units[index], item);
      item.assigned = true;
    });
  }
}

function unitHasWallSurface(unit) {
  return unit.items.some((item) => Boolean(detectWallSurface(itemText(item))));
}

function unitHasWallSurcharge(unit) {
  return unit.items.some(isWallSurfaceItem);
}

function assignWalls(units, wallItems) {
  assignByIndex(units, wallItems);
  assignSequentialAccessories(units, wallItems, { allowAfterLast: units.length === 1 });

  const unassigned = wallItems.filter((item) => !item.assigned);
  if (!unassigned.length) return;

  const surfaces = unassigned
    .map((item) => ({ item, surface: detectWallSurface(itemText(item)) }))
    .filter((entry) => entry.surface);
  if (!surfaces.length) return;

  for (const entry of surfaces) {
    if (entry.item.assigned) continue;
    const exactUnit = units.find((unit) => {
      return unit.wallSurface === entry.surface && !unitHasWallSurcharge(unit);
    });
    if (exactUnit) {
      addItem(exactUnit, entry.item);
      entry.item.assigned = true;
    }
  }

  const remainingEntries = surfaces.filter((entry) => !entry.item.assigned);
  if (!remainingEntries.length) return;

  if (remainingEntries.length === 1) {
    const target = units.find((unit) => !unitHasWallSurcharge(unit) && !unitHasWallSurface(unit) && !unit.fireplaceType)
      || units.find((unit) => !unitHasWallSurcharge(unit) && !unitHasWallSurface(unit))
      || units.find((unit) => !unitHasWallSurcharge(unit) && !unit.fireplaceType)
      || units.find((unit) => !unitHasWallSurcharge(unit));
    if (target) {
      addItem(target, remainingEntries[0].item);
      remainingEntries[0].item.assigned = true;
    }
    return;
  }

  const brick = remainingEntries.find((entry) => entry.surface === 'Brick');
  const fireplaceUnits = units.filter((unit) => unit.fireplaceType);
  if (brick && fireplaceUnits.length === 1 && !unitHasWallSurcharge(fireplaceUnits[0])) {
    addItem(fireplaceUnits[0], brick.item);
    brick.item.assigned = true;
    const remainingSurfaces = remainingEntries.filter((entry) => !entry.item.assigned);
    for (const entry of remainingSurfaces) {
      const target = units.find((unit) => !unitHasWallSurcharge(unit) && !unitHasWallSurface(unit) && !unit.fireplaceType)
        || units.find((unit) => !unitHasWallSurcharge(unit) && !unitHasWallSurface(unit))
        || units.find((unit) => !unitHasWallSurcharge(unit) && !unit.fireplaceType)
        || units.find((unit) => !unitHasWallSurcharge(unit));
      if (target) {
        addItem(target, entry.item);
        entry.item.assigned = true;
      }
    }
  }
}

function decorateUnit(unit) {
  const combined = unit.items.map(itemText).join(' | ');
  const baseText = itemText(unit.baseItem);
  unit.tvSize = parseTvSize(baseText) || parseTvSize(combined);
  unit.tvBrand = detectTvBrand(combined);
  unit.galleryStyle = detectGalleryStyle(combined);
  unit.wallSurface = unit.items.map((item) => detectWallSurface(itemText(item))).find(Boolean) || 'Drywall';
  unit.fireplaceType = detectFireplace(combined);
  unit.bracketType = unit.items.map((item) => detectBracket(itemText(item), { soldByUs: true })).find(Boolean) || '';
  unit.cableManagement = unit.items.map((item) => detectCableManagement(itemText(item))).find(Boolean) || '';
  unit.soundbarMounting = unit.items.some(isSoundbarItem);
}

function buildTvUnits(normalizedLineItems) {
  const expanded = normalizedLineItems.flatMap(expandItem);
  const units = expanded.filter(isTvInstallItem).map((item) => {
    const unit = {
      baseItem: item,
      firstIndex: item.index,
      items: [],
      labels: [],
      sourceIndexes: [],
    };
    addItem(unit, item);
    decorateUnit(unit);
    return unit;
  });

  const accessories = expanded.filter((item) => !isTvInstallItem(item));
  const wallItems = accessories.filter(isWallSurfaceItem);
  const bracketItems = accessories.filter(isBracketItem);
  const soundbarItems = accessories.filter(isSoundbarItem);
  const cableItems = accessories.filter(isCableItem);

  assignByIndex(units, bracketItems);
  assignByIndex(units, soundbarItems);
  assignByIndex(units, cableItems);
  assignSequentialAccessories(units, bracketItems, { allowAfterLast: units.length === 1 });
  assignSequentialAccessories(units, soundbarItems, { allowAfterLast: units.length === 1 });
  assignSequentialAccessories(units, cableItems, { allowAfterLast: units.length === 1 });
  assignWalls(units, wallItems);

  units.forEach(decorateUnit);
  return units;
}

export function buildInstallFacts({ lineItems, payment, order, customer, teamMemberMap = DEFAULT_TEAM_MEMBER_MAP }) {
  const normalized = normalizeLineItems(lineItems);
  const textBlob = normalized.map(itemText).join(' | ');
  const soldBracketByUs = normalized.some((item) => {
    const haystack = `${item.variationName} ${item.name}`.toLowerCase();
    return haystack.includes('tv mount') || haystack.includes('bracket');
  });
  return {
    performedBy:
      teamMemberMap[payment?.team_member_id] ||
      teamMemberMap[order?.created_by_team_member_id] ||
      teamMemberMap[payment?.created_by_team_member_id] ||
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

function seedFromUnit({ unit, facts, orderId, paymentId, invoiceId, triggerStatus, triggerSourceCode, triggerEvent, seedIndex, seedCount }) {
  const subtotalCents = unit.items.reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
  const hasLinePricing = unit.items.some((item) => Number(item.amountCents || 0) > 0);
  const wallSurface = unit.wallSurface || 'Drywall';
  const labels = [...unit.labels];
  if (wallSurface && !labels.some((label) => /wall type/i.test(label))) {
    labels.push(`${wallSurface} — Wall Type`);
  }
  return compactSeed({
    city: facts.city,
    state: facts.state,
    title: '',
    slug: '',
    'post-body': '',
    'post-summary': '',
    'tv-size': unit.tvSize || facts.tvSize,
    'tv-brand': unit.tvBrand || facts.tvBrand,
    'wall-surface': wallSurface,
    'metro-area': '',
    'location-id': '',
    'gallery-style': Boolean(unit.galleryStyle || facts.galleryStyle),
    'fireplace-type': unit.fireplaceType || '',
    price: hasLinePricing ? formatMoney(subtotalCents) : '',
    'performed-by': facts.performedBy,
    'street-name': facts.streetName,
    'mount-type': '',
    'room-type': '',
    'bracket-type': unit.bracketType || '',
    'hardware-used': '',
    'cable-management': unit.cableManagement || '',
    'soundbar-mounting': unit.soundbarMounting || '',
    'job-notes': labels.join(' | '),
    'local-reference': facts.streetName || '',
    'nearby-cities': [],
    'image-path': '',
    'seed-index': seedIndex,
    'seed-count': seedCount,
    'source-order-id': orderId,
    'source-payment-id': paymentId,
    'source-invoice-id': invoiceId,
    'trigger-status': triggerStatus,
    'trigger-source-code': triggerSourceCode,
    'trigger-event': triggerEvent,
  });
}

function fallbackSeed({ facts, amountCents, orderId, paymentId, invoiceId, triggerStatus, triggerSourceCode, triggerEvent }) {
  return compactSeed({
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
    price: amountCents ? formatMoney(amountCents) : '',
    'performed-by': facts.performedBy,
    'street-name': facts.streetName,
    'mount-type': '',
    'room-type': '',
    'bracket-type': facts.bracketType,
    'hardware-used': '',
    'cable-management': facts.cableManagement,
    'job-notes': facts.sourceLabels.join(' | '),
    'local-reference': facts.streetName || '',
    'nearby-cities': [],
    'image-path': '',
    'source-order-id': orderId,
    'source-payment-id': paymentId,
    'source-invoice-id': invoiceId,
    'trigger-status': triggerStatus,
    'trigger-source-code': triggerSourceCode,
    'trigger-event': triggerEvent,
  });
}

export function buildInstallPostSeeds({
  lineItems,
  payment,
  order,
  customer,
  amountCents = 0,
  orderId = '',
  paymentId = '',
  invoiceId = '',
  triggerStatus = '',
  triggerSourceCode = '',
  triggerEvent = '',
  teamMemberMap = DEFAULT_TEAM_MEMBER_MAP,
}) {
  const normalized = normalizeLineItems(lineItems);
  const facts = buildInstallFacts({ lineItems, payment, order, customer, teamMemberMap });
  const tvUnits = buildTvUnits(normalized);

  if (!tvUnits.length) {
    return [fallbackSeed({ facts, amountCents, orderId, paymentId, invoiceId, triggerStatus, triggerSourceCode, triggerEvent })];
  }

  return tvUnits.map((unit, index) => seedFromUnit({
    unit,
    facts,
    orderId,
    paymentId,
    invoiceId,
    triggerStatus,
    triggerSourceCode,
    triggerEvent,
    seedIndex: index + 1,
    seedCount: tvUnits.length,
  }));
}

function seedBlockLabel(seed, index, count) {
  if (count === 1) return '**Suggested seed JSON**:';
  const bits = [
    seed['tv-size'] || 'TV',
    seed['wall-surface'] || '',
    seed['fireplace-type'] ? 'fireplace' : '',
    seed.price || '',
  ].filter(Boolean);
  return `**Suggested seed JSON ${index + 1} of ${count} — ${bits.join(' / ')}**:`;
}

export function formatInstallSeedBlocks(seeds) {
  const list = Array.isArray(seeds) && seeds.length ? seeds : [];
  return list.map((seed, index) => [
    seedBlockLabel(seed, index, list.length),
    '```json',
    JSON.stringify(seed, null, 2),
    '```',
  ].join('\n')).join('\n\n');
}
