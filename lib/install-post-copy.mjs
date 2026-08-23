// Deterministic install-post copy helpers.
//
// Unmount / dismount jobs get first-class title and body here — not a prompt
// desk rewrite, and not by pretending they are mounts. The closing CTA is the
// existing house "famous-mounter" service-area paragraph. Do not rewrite it.

const CITY_SERVICE_SLUG_OVERRIDES = {
  anoka: 'anoka-0c1a3',
  blaine: 'blaine-d4c08',
  champlin: 'champlin-8521d',
  'circle pines': 'circle-pines-9680f',
  'columbia heights': 'columbia-heights-8f67e',
  'coon rapids': 'coon-rapids-fe70d',
  dayton: 'dayton-3102f',
  'lino lakes': 'lino-lakes-3b47c',
  'maple plain': 'maple-plain-553b2',
  'mounds view': 'mounds-view-de2dd',
  'new brighton': 'new-brighton-7997d',
  osseo: 'osseo-477c8',
  rogers: 'rogers-6d853',
  'spring lake park': 'spring-lake-park-84017',
  'st. anthony': 'st-anthony-c649f',
};

const UNIT_TOKEN_RE = /\b(?:apt|apartment|unit|suite|ste|bldg|building|fl|floor|rm|room)\.?\b/i;
const UNIT_HASH_RE = /#\s*[\w-]+/g;
const UNIT_LABELED_RE = /\b(?:apt|apartment|unit|suite|ste|bldg|building)\.?\s*[\w-]+/gi;
const UNIT_TRAILING_NUMBER_RE = /,\s*(?:no\.?|number|#)?\s*\d+[A-Za-z]?\s*$/i;
const UNIT_SLUG_RE = /(?:^|-)(?:apt|apartment|unit|suite|ste|bldg|building|fl|floor)(?:-|$)/g;

export function isNegatedUnmountText(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return false;
  return (
    value.includes('no unmount') ||
    value.includes('do not unmount') ||
    value.includes('don\'t unmount') ||
    value.includes('no unmounting') ||
    value.includes('unmounting needed') && /\bno\b/.test(value) ||
    value.includes('not needed') && value.includes('unmount')
  );
}

export function isUnmountText(text) {
  const value = String(text || '').toLowerCase();
  if (!value || isNegatedUnmountText(value)) return false;
  return (
    /\bunmount/.test(value) ||
    /\bdismount/.test(value) ||
    /\btake[\s-]?down/.test(value) ||
    /\btaking[\s-]?down/.test(value)
  );
}

export function isUnmountSeed(seed = {}) {
  const jobType = String(seed['job-type'] || seed.jobType || '').trim().toLowerCase();
  return jobType === 'unmount' || jobType === 'dismount' || jobType === 'takedown' || jobType === 'take-down';
}

export function stripPublicUnitNumber(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(UNIT_HASH_RE, ' ');
  text = text.replace(UNIT_LABELED_RE, ' ');
  text = text.replace(UNIT_TRAILING_NUMBER_RE, '');
  text = text.replace(/\s+/g, ' ').replace(/[.,]+$/g, '').trim();
  return text;
}

export function slugifyInstallPost(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const chars = [];
  let lastDash = false;
  for (const ch of normalized) {
    if (/[a-z0-9]/.test(ch)) {
      chars.push(ch);
      lastDash = false;
    } else if (!lastDash) {
      chars.push('-');
      lastDash = true;
    }
  }
  return chars.join('').replace(UNIT_SLUG_RE, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cityKey(city) {
  return String(city || '').trim().toLowerCase();
}

function cityServiceSlug(city) {
  const key = cityKey(city);
  return CITY_SERVICE_SLUG_OVERRIDES[key] || slugifyInstallPost(city);
}

function normalizeCity(city) {
  const value = String(city || '').trim();
  const aliases = {
    'st paul': 'St. Paul',
    'saint paul': 'St. Paul',
    'st. paul': 'St. Paul',
  };
  return aliases[value.toLowerCase()] || value;
}

function publicStreet(seed, city) {
  const raw = String(seed['local-reference'] || seed['street-name'] || '').trim();
  return stripPublicUnitNumber(raw.replace(new RegExp(`,\\s*${city}$`, 'i'), '').trim());
}

function visitSuffix(seed) {
  const count = Number(seed['seed-count'] || 0);
  const index = Number(seed['seed-index'] || 0);
  if (count > 1 && index > 1) return String(index);
  return '';
}

function sizeLabel(seed) {
  return String(seed['tv-size'] || '').trim();
}

function brandLabel(seed) {
  return String(seed['tv-brand'] || '').trim();
}

function wallLabel(seed) {
  return String(seed['wall-surface'] || '').trim();
}

function moneyLabel(seed) {
  return String(seed.price || '').trim();
}

function unitLabel(seed) {
  const size = sizeLabel(seed);
  const brand = brandLabel(seed);
  const parts = [size, brand].filter(Boolean);
  const label = parts.join(' ').trim();
  if (label && !label.toLowerCase().endsWith('tv')) return `${label} TV`;
  return label || 'TV';
}

function assertNoUnitNumber(text, field) {
  const value = String(text || '');
  if (UNIT_TOKEN_RE.test(value) || /#\s*[\w-]/.test(value)) {
    throw new Error(`unmount ${field} leaked a unit number: ${value}`);
  }
}

export function buildUnmountTitle(seed = {}, city = '') {
  const place = normalizeCity(city || seed.city || 'Twin Cities');
  const street = publicStreet(seed, place);
  const bits = [];
  if (sizeLabel(seed)) bits.push(sizeLabel(seed));
  if (brandLabel(seed)) bits.push(brandLabel(seed));
  if (wallLabel(seed)) bits.push(wallLabel(seed));
  if (street) bits.push(`Near ${street}`);
  const suffix = visitSuffix(seed);
  if (suffix) bits.push(suffix);
  const title = bits.length
    ? `TV Unmounting in ${place} | ${bits.join(' ')}`
    : `TV Unmounting in ${place}`;
  const cleaned = stripPublicUnitNumber(title);
  assertNoUnitNumber(cleaned, 'title');
  return cleaned;
}

export function buildUnmountSlug(seed = {}, city = '') {
  const place = normalizeCity(city || seed.city || 'Twin Cities');
  const street = publicStreet(seed, place);
  const size = sizeLabel(seed).replace(/"/g, ' inch');
  const bits = ['tv-unmounting', place, size, brandLabel(seed), wallLabel(seed), street, visitSuffix(seed)];
  const slug = slugifyInstallPost(bits.filter(Boolean).join(' '));
  assertNoUnitNumber(slug, 'slug');
  return slug;
}

export function buildUnmountSummary(seed = {}, city = '') {
  const place = normalizeCity(city || seed.city || 'Twin Cities');
  const street = publicStreet(seed, place);
  const wall = wallLabel(seed);
  let summary = `${unitLabel(seed)} unmounting in ${place}`;
  if (wall) summary += ` on ${wall.toLowerCase()}`;
  if (street) summary += `, completed near ${street}`;
  summary += '. The photo is the before shot, with the TV still on the wall.';
  const price = moneyLabel(seed);
  if (price) summary += ` Completed for ${price}.`;
  return stripPublicUnitNumber(summary);
}

function cityServiceLink(city, label) {
  const place = normalizeCity(city);
  const href = `https://www.themountingman.com/tv-mounting/${cityServiceSlug(place)}`;
  return `<a href="${href}">${escapeHtml(label || `TV mounting in ${place}`)}</a>`;
}

function serviceContextLink(seed) {
  const text = [
    seed.title,
    seed.slug,
    seed['post-summary'],
    seed['job-notes'],
    seed['wall-surface'],
    seed['mount-type'],
    seed['tv-brand'],
  ].join(' ').toLowerCase();
  if (text.includes('frame') || seed['gallery-style']) {
    return '<a href="https://www.themountingman.com/service/samsung-frame-installation">Samsung Frame TV installation</a>';
  }
  if (text.includes('mantelmount')) {
    return '<a href="https://www.themountingman.com/service/mantelmount-installation">MantelMount installation</a>';
  }
  if (text.includes('fireplace')) {
    return '<a href="https://www.themountingman.com/service/mount-tv-above-fireplace">fireplace TV mounting</a>';
  }
  return '<a href="https://www.themountingman.com/service/tv-mounting">professional TV mounting services</a>';
}

// Existing famous-mounter CTA. Keep the same links and order as the mount path.
function famousMounterCta(seed, city) {
  const place = normalizeCity(city);
  const nearby = Array.isArray(seed['nearby-cities']) ? seed['nearby-cities'].filter(Boolean).slice(0, 3) : [];
  const metro = String(seed['metro-area'] || '').trim();
  const state = String(seed.state || '').trim();
  const parts = [`This local install is part of our ${cityServiceLink(place)} work.`];
  if (nearby.length) {
    parts.push(`Nearby service areas include ${nearby.map((name) => cityServiceLink(name, normalizeCity(name))).join(', ')}.`);
  } else if (metro && metro.toLowerCase() !== place.toLowerCase() && metro.toLowerCase() !== 'twin cities') {
    parts.push(`We also handle similar installations throughout the ${escapeHtml(metro)}.`);
  } else if (state) {
    parts.push(`We also handle similar installations around ${escapeHtml(place)}, ${escapeHtml(state)}.`);
  }
  parts.push(`For the broader service, see our ${serviceContextLink(seed)}.`);
  return parts.join(' ');
}

export function buildUnmountBody(seed = {}, city = '') {
  const place = normalizeCity(city || seed.city || 'Twin Cities');
  const street = publicStreet(seed, place);
  const size = sizeLabel(seed);
  const brand = brandLabel(seed);
  const wall = wallLabel(seed);
  const price = moneyLabel(seed);
  const label = escapeHtml(unitLabel(seed));
  const location = street ? `${escapeHtml(street)}, ${escapeHtml(place)}` : escapeHtml(place);
  const heading = street
    ? `TV Unmounting Near ${escapeHtml(street)}`
    : `TV Unmounting in ${escapeHtml(place)}`;
  const where = street
    ? `near ${escapeHtml(street)} in ${escapeHtml(place)}`
    : `in ${escapeHtml(place)}`;

  const details = [
    '<h2>Job Details</h2>',
    '<ul>',
    '<li><strong>Service:</strong> TV Unmounting</li>',
  ];
  if (size) details.push(`<li><strong>TV Size:</strong> ${escapeHtml(size)}</li>`);
  if (brand) details.push(`<li><strong>TV Brand:</strong> ${escapeHtml(brand)}</li>`);
  if (wall) details.push(`<li><strong>Wall Type:</strong> ${escapeHtml(wall)}</li>`);
  if (price) details.push(`<li><strong>Price:</strong> ${escapeHtml(price)}</li>`);
  details.push(`<li><strong>Location:</strong> ${location}</li>`, '</ul>');

  const points = [
    street
      ? `Completed near ${escapeHtml(street)} in ${escapeHtml(place)}. This was a TV unmount, not a new mount.`
      : `This was a TV unmount in ${escapeHtml(place)}, not a new mount.`,
  ];
  if (price) points.push(`Unmount subtotal: ${escapeHtml(price)}.`);
  points.push('The required photo is the before shot, with the TV still on the wall.');

  const body = [
    details.join('\n'),
    `<h2>${heading}</h2>`,
    `<p>We took down this ${label} ${where}. The photo for this job is the before shot, with the TV still on the wall.</p>`,
    '<h2>What Made This Unmount Different</h2>',
    '<ul>',
    ...points.map((point) => `<li>${point}</li>`),
    '</ul>',
    '<h2>Taking a TV Off the Wall</h2>',
    '<p>A clean unmount means supporting the TV, backing out the hardware, and walking the screen off the wall without damaging the set or the surface. This job was a take-down, not a mount.</p>',
    `<h2>TV Mounting in ${escapeHtml(place)}</h2>`,
    `<p>${famousMounterCta(seed, place)}</p>`,
  ].join('\n');

  const cleaned = stripPublicUnitNumber(body);
  assertNoUnitNumber(cleaned, 'body');
  return cleaned;
}

export function applyUnmountCopy(seed = {}) {
  if (!isUnmountSeed(seed)) return seed;
  const city = normalizeCity(seed.city || '');
  const next = {
    ...seed,
    'job-type': 'unmount',
    'street-name': stripPublicUnitNumber(seed['street-name'] || ''),
    'local-reference': stripPublicUnitNumber(seed['local-reference'] || seed['street-name'] || ''),
  };
  if (UNIT_TOKEN_RE.test(String(next['street-name']))) next['street-name'] = stripPublicUnitNumber(next['street-name']);
  next.title = String(seed.title || '').trim() || buildUnmountTitle(next, city);
  next.slug = String(seed.slug || '').trim() || buildUnmountSlug(next, city);
  next['post-summary'] = String(seed['post-summary'] || '').trim() || buildUnmountSummary(next, city);
  next['post-body'] = String(seed['post-body'] || '').trim() || buildUnmountBody(next, city);
  return next;
}
