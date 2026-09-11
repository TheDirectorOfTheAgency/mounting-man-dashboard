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

export const MINNEAPOLIS_CITY_STAMP = 'TV mounting Minneapolis by The Mounting Man.';

/** GBP Update fence text Mr. Wayne pastes. Book button carries the URL. */
export const GBP_CAPTION_MAX_CHARS = 400;

const HOUSE_NUMBER_RE = /^(?!\d+(?:st|nd|rd|th)\b)\d+[A-Za-z\-/]*\s+/i;
const GBP_HASHTAG_RE = /#\w+/g;
const GBP_URL_RE = /https?:\/\/\S+/gi;
const GBP_REJECT_PHRASE_RE = /\bby The Mounting Man\b|\bbest\b|\btrusted\b|#1|\bcoupon\b|\bsale\b|%\s*off|\bserving the Twin Cities\b|\bcall now\b|\bDM us\b/gi;

function normalizeCity(city) {
  const value = String(city || '').trim();
  const aliases = {
    'st paul': 'St. Paul',
    'saint paul': 'St. Paul',
    'st. paul': 'St. Paul',
  };
  return aliases[value.toLowerCase()] || value;
}

export function isExactMinneapolisCity(city) {
  return normalizeCity(city).toLowerCase() === 'minneapolis';
}

export function cityMountingStamp(city) {
  // Website / famous-mounter CTA only. GBP fence captions must not use this.
  const place = normalizeCity(city);
  if (!place) return 'TV mounting by The Mounting Man.';
  return `TV mounting ${place} by The Mounting Man.`;
}

export function jobUsedFrame(seed = {}) {
  if (seed['gallery-style']) return true;
  const brand = String(seed['tv-brand'] || '').trim().toLowerCase();
  return brand.startsWith('samsung frame') || brand === 'samsung frame pro';
}

export function jobUsedMantel(seed = {}) {
  if (seed.mantelmount) return true;
  const mount = String(seed['mount-type'] || '').trim().toLowerCase();
  return mount.includes('mantelmount') || mount.includes('mantel mount');
}

export function jobUsedFireplace(seed = {}) {
  if (jobUsedMantel(seed)) return true;
  if (String(seed['fireplace-type'] || '').trim()) return true;
  const text = [seed['room-type'], seed['job-notes']].join(' ').toLowerCase();
  if (!text || /\bno fireplace\b|not (?:going )?above a fireplace|not over (?:a )?fireplace/.test(text)) {
    return false;
  }
  return /\bfireplace\b/.test(text);
}

export function ensureCityStamp(text, city, seed = {}) {
  const stamp = cityMountingStamp(city);
  const value = String(text || '').trim();
  if (value.includes(stamp)) return value;
  const extras = [];
  if (jobUsedFrame(seed)) extras.push('Samsung Frame.');
  if (jobUsedMantel(seed)) extras.push('MantelMount.');
  const lead = [stamp, ...extras].join(' ');
  if (value.includes(lead)) return value;
  if (!value) return lead;
  return `${lead} ${value}`;
}

function gbpFactBlob(seed = {}) {
  return [
    seed['cable-management'],
    seed['cord-concealment'],
    seed['cord-concealing'],
    seed['cord-method'],
    seed['job-notes'],
    seed['mount-type'],
    seed['bracket-type'],
    seed['hardware-used'],
    seed['fireplace-type'],
    seed['room-type'],
  ].flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(Boolean)
    .join(' ');
}

function gbpSizeLabel(seed = {}) {
  const match = String(seed['tv-size'] || '').match(/(\d{2,3})/);
  return match ? `${match[1]}"` : '';
}

function fireplaceSurfaceLabel(seed = {}) {
  const text = [
    seed['fireplace-type'],
    seed['wall-surface'],
    seed['job-notes'],
    seed['room-type'],
  ].join(' ').toLowerCase();
  if (/stacked stone/.test(text)) return 'stacked stone';
  if (/\bstone\b/.test(text)) return 'stone';
  if (/\bbrick\b/.test(text)) return 'brick';
  if (/\btile\b/.test(text)) return 'tile';
  if (/\bplaster\b/.test(text)) return 'plaster';
  return '';
}

function isGenericWall(surface) {
  return !surface || surface === 'drywall' || surface === 'wall';
}

function isTileFireplaceJob(seed = {}) {
  if (!jobUsedFireplace(seed)) return false;
  const text = [
    seed['fireplace-type'],
    seed['wall-surface'],
    seed['job-notes'],
    seed['room-type'],
  ].join(' ').toLowerCase();
  return /\btile\b/.test(text);
}

function gbpSurfaceLabel(seed = {}) {
  const surface = String(seed['wall-surface'] || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!jobUsedFireplace(seed)) return surface;
  const material = isGenericWall(surface) ? fireplaceSurfaceLabel(seed) : surface;
  if (isTileFireplaceJob(seed) || /\btile\b/.test(material)) return 'tile fireplace';
  if (jobUsedMantel(seed) || gbpGalleryProduct(seed)) return material || surface;
  if (!material) return 'fireplace';
  return /fireplace/.test(material) ? material : `${material} fireplace`;
}

function gbpStreetLabel(seed = {}, city = '') {
  let street = publicStreet(seed, city);
  street = street.replace(HOUSE_NUMBER_RE, '').trim();
  street = street.replace(/[.,]+$/g, '').trim();
  return street;
}

function gbpGalleryProduct(seed = {}) {
  const brand = String(seed['tv-brand'] || '').trim();
  const brandLower = brand.toLowerCase();
  const notes = String(seed['job-notes'] || '').toLowerCase();
  const gallery = Boolean(seed['gallery-style']);
  const blob = `${brandLower} ${notes}`;

  if (brandLower.includes('frame pro')) return 'Samsung Frame Pro';
  if (brandLower.includes('samsung frame') || brandLower.includes('the frame')) return 'Samsung Frame';
  if (brandLower.includes('canvas')) return 'Hisense Canvas';
  if (brandLower.includes('nxtframe') || brandLower.includes('nxt frame')) return 'TCL NXTFRAME';
  if (
    brandLower.includes('g-series')
    || brandLower.includes('g series')
    || (/\blg\b/.test(brandLower) && /\bg[3-5]\b/.test(brandLower))
  ) {
    return 'LG G-Series';
  }

  if (!gallery) return '';
  if (brandLower === 'samsung' || brandLower === 'samsung tv') return 'Samsung Frame';
  if (brandLower.includes('hisense')) return 'Hisense Canvas';
  if (brandLower === 'tcl') return 'TCL NXTFRAME';
  if (brandLower === 'lg' || (/\blg\b/.test(blob) && /oled|g[-\s]?series|g[3-5]/.test(blob))) {
    return 'LG G-Series';
  }
  if (/\bcanvas\b/.test(notes)) return 'Hisense Canvas';
  if (/\bnxtframe\b/.test(notes)) return 'TCL NXTFRAME';
  // Soundbar "Frame / Gallery" brackets are not a Frame TV.
  if (/\bframe\b/.test(notes) && !/soundbar/.test(notes)) return 'Samsung Frame';
  return 'gallery OLED';
}

function isCorporateBoardJob(seed = {}) {
  const text = [seed['job-notes'], seed['room-type']].join(' ').toLowerCase();
  return /\b(corporate|conference|boardroom|board room|worksite)\b/.test(text);
}

function gbpMasonryProduct(surface) {
  if (/tile/.test(surface)) return 'tile mount';
  if (/stone/.test(surface)) return 'stone mount';
  if (/brick/.test(surface)) return 'brick mount';
  if (/concrete/.test(surface)) return 'concrete mount';
  if (/wood slat/.test(surface)) return 'wood slat mount';
  if (/plaster/.test(surface)) return 'plaster mount';
  return '';
}

function gbpProductLabel(seed = {}) {
  if (isUnmountSeed(seed)) return 'TV unmount';
  const gallery = gbpGalleryProduct(seed);
  const mantel = jobUsedMantel(seed);
  const surface = gbpSurfaceLabel(seed);
  if (gallery && mantel) return `${gallery} + MantelMount`;
  if (mantel) return 'MantelMount';
  if (gallery) return gallery;
  if (isCorporateBoardJob(seed)) return 'corporate board';
  if (jobUsedFireplace(seed)) return '';
  return gbpMasonryProduct(surface) || 'TV mount';
}

function gbpHeadline(seed = {}, city = '') {
  const place = normalizeCity(city || seed.city || '');
  const product = gbpProductLabel(seed);
  const size = gbpSizeLabel(seed);
  const productSize = product
    ? (size && !product.includes(size) ? `${product} ${size}` : product)
    : size;
  const surface = gbpSurfaceLabel(seed);
  const street = gbpStreetLabel(seed, place);
  const bits = [place, productSize].filter(Boolean);
  let line = bits.join(' ');
  if (surface) line += ` on ${surface}`;
  if (street) line += ` — ${street}`;
  return `${line}.`;
}

function hasCordConcealment(blob) {
  return /cord conceal|cable conceal|in-wall|in wall|concealment/.test(blob);
}

function noCordsOutcome(surface) {
  if (/stone/.test(surface)) return 'No cords on the stone';
  if (/tile/.test(surface)) return 'No cords on the tile';
  if (/brick/.test(surface)) return 'No cords on the brick';
  if (surface && surface !== 'drywall' && surface !== 'wall') return `No cords on the ${surface}`;
  return 'Cord concealment';
}

function gbpOutcomes(seed = {}) {
  const blob = gbpFactBlob(seed).toLowerCase();
  const surface = gbpSurfaceLabel(seed);
  const gallery = Boolean(gbpGalleryProduct(seed));
  const fireplace = jobUsedFireplace(seed);
  const outcomes = [];

  if (fireplace) {
    outcomes.push('Centered on the mantel');
    if (hasCordConcealment(blob)) outcomes.push(noCordsOutcome(surface));
    else if (/recessed|power bridge|new outlet/.test(blob)) outcomes.push('Recessed outlet');
    return outcomes.slice(0, 2);
  }

  if (/recessed|power bridge|new outlet/.test(blob)) {
    outcomes.push('Recessed outlet');
  }

  if (/center(?:ed)? on (?:the )?mantel/.test(blob)) {
    outcomes.push('Centered on the mantel');
  }

  const flushMentioned = /\bflush\b/.test(blob);
  if ((flushMentioned || gallery) && surface && surface !== 'drywall' && surface !== 'wall') {
    outcomes.push(`Flush to ${surface}`);
  } else if (flushMentioned) {
    outcomes.push('Flush mount');
  }

  if (hasCordConcealment(blob) && !outcomes.includes('Recessed outlet')) {
    outcomes.push(noCordsOutcome(surface));
  }

  return outcomes.slice(0, 2);
}

function gbpPriceLine(seed = {}) {
  const raw = String(seed.price || '').replace(/,/g, '').trim();
  if (!raw) return '';
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return '';
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const whole = Number.isInteger(amount) || Math.abs(amount - Math.round(amount)) < 1e-9;
  return `$${whole ? Math.round(amount) : amount}.`;
}

function scrubGbpCaption(text) {
  return String(text || '')
    .replace(GBP_URL_RE, '')
    .replace(GBP_HASHTAG_RE, '')
    .replace(GBP_REJECT_PHRASE_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function renderGbpCaption(headline, outcomes, price) {
  const parts = [headline];
  if (outcomes.length) {
    parts.push(`${outcomes.map((item) => item.replace(/\.$/, '')).join('. ')}.`);
  }
  if (price) parts.push(price);
  return parts.join('\n');
}

export function buildGbpFenceCaption(seed = {}) {
  const city = seed.city || '';
  const headline = gbpHeadline(seed, city);
  const price = gbpPriceLine(seed);
  let outcomes = gbpOutcomes(seed);
  let caption = scrubGbpCaption(renderGbpCaption(headline, outcomes, price));
  while (caption.length > GBP_CAPTION_MAX_CHARS && outcomes.length) {
    outcomes = outcomes.slice(0, -1);
    caption = scrubGbpCaption(renderGbpCaption(headline, outcomes, price));
  }
  if (caption.length > GBP_CAPTION_MAX_CHARS) {
    caption = caption.slice(0, GBP_CAPTION_MAX_CHARS).trimEnd();
  }
  return caption;
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
  return ensureCityStamp(stripPublicUnitNumber(summary), place, seed);
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
  return ensureCityStamp(parts.join(' '), place, seed);
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
