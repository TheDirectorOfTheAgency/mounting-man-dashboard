// pages/api/webhooks/zenbooker-to-square.js
// Receives ZenBooker booking webhooks → finds or creates Square customer record
//
// Phase 1 (active): Customer record only
//   1. Find or create Square customer by email
//   2. Return customer ID — no orders, no appointments yet
//
// Phase 2 (future): Square Appointments
//   - MAIN_SERVICE_MAP, OPTION_MAP, TECH_MAP, and buildLineItems() are already built
//   - Will use Square Bookings API (/v2/bookings) to create appointments in Square Calendar
//
// Webhook URL configured in ZenBooker:
//   https://mounting-man-dashboard.vercel.app/api/webhooks/zenbooker-to-square?secret=<ZENBOOKER_WEBHOOK_SECRET>

import axios from 'axios';

// ============================================================================
// SQUARE CONFIG
// ============================================================================
const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VER  = '2024-01-18';
const LOCATION_ID = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID || 'LVNM3Z4RVRWDK';

const squareHeaders = () => ({
  Authorization:    `Bearer ${process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN}`,
  'Square-Version': SQUARE_VER,
  'Content-Type':   'application/json',
  'Accept':         'application/json',
});

// ============================================================================
// FIELD MAP — ZenBooker webhook payload paths (dot notation, tried in order)
// Always logs the full raw payload — check Vercel logs after first webhook
// to verify/adjust these paths.
// ============================================================================
const FIELD_MAP = {
  eventType:         ['type', 'event', 'event_type'],
  jobId:             ['data.id', 'data.job.id', 'data.job_id', 'id'],
  customerEmail:     ['data.customer.email', 'customer.email', 'data.job.customer.email', 'data.customer_email'],
  customerPhone:     ['data.customer.phone', 'customer.phone', 'data.job.customer.phone', 'data.customer_phone'],
  customerFirstName: ['data.customer.first_name', 'customer.first_name', 'data.job.customer.first_name'],
  customerLastName:  ['data.customer.last_name',  'customer.last_name',  'data.job.customer.last_name'],
  customerName:      ['data.customer.name', 'customer.name', 'data.job.customer.name', 'data.customer_name'],

  // Top-level service category — ZenBooker sends as "service_name" at job root
  serviceName: [
    'data.service_name',  'service_name',
    'data.job.service_name', 'data.service.name', 'data.job.type',
    'data.services.0.service_name', 'services.0.service_name',
  ],

  // Selected options — ZenBooker can send these either as top-level service_fields
  // or nested under services[0].service_selections, depending on the webhook shape.
  // Extraction handled specially below (selected_options[m].text / display_label).
  lineItems: [
    'data.service_fields', 'service_fields',
    'data.services.0.service_selections', 'services.0.service_selections',
    'data.services.0.service_fields', 'services.0.service_fields',
    'data.job.service_fields', 'data.line_items', 'data.options',
  ],

  // ZenBooker sends start_date (ISO) for job start time
  scheduledAt: ['data.start_date', 'start_date', 'data.job.start_date', 'data.scheduled_at', 'data.job.scheduled_at'],
  totalAmount: ['data.invoice.total', 'invoice.total', 'data.job.invoice.total', 'data.total_amount'],

  // Job service address — ZenBooker sends under service_address (not address)
  jobStreet: ['data.service_address.line1', 'service_address.line1', 'data.job.service_address.line1', 'data.address.line1'],
  jobLine2:  ['data.service_address.line2', 'service_address.line2', 'data.job.service_address.line2', 'data.address.line2'],
  jobCity:   ['data.service_address.city',  'service_address.city',  'data.job.service_address.city',  'data.address.city'],
  jobState:  ['data.service_address.state', 'service_address.state', 'data.job.service_address.state', 'data.address.state'],
  jobZip:    ['data.service_address.postal_code', 'service_address.postal_code', 'data.job.service_address.postal_code', 'data.address.postal_code'],

  // Duration — ZenBooker sends estimated_duration_seconds (convert ÷60 below)
  jobDuration: ['data.estimated_duration_seconds', 'estimated_duration_seconds', 'data.job.estimated_duration_seconds', 'data.duration'],

  notes: ['data.job_notes', 'job_notes', 'data.job.job_notes', 'data.notes', 'data.customer.notes'],

  // Assigned providers — ZenBooker sends assigned_providers[] array, handled below
  providerList:  ['data.assigned_providers', 'assigned_providers', 'data.job.assigned_providers'],
  providerName: [
    'data.assigned_provider.name', 'data.provider.name', 'data.job.provider.name', 'data.provider_name',
  ],
  providerEmail: [
    'data.assigned_provider.email', 'data.provider.email', 'data.job.provider.email',
  ],
};

// ============================================================================
// TECHNICIAN MAP — ZenBooker provider name (lowercase) → Square Team Member ID
// Active team members as of 2026-02-21
// ============================================================================
const TECH_MAP = {
  'michael wenzel':       'TMSiHOOr7RGdl2Ki',
  'garrison gillard':     'TMT84KWHegsrcWFB',
  'marshall donnerbauer': 'TMY7unjtR-2XvVpg',
  'marshall wayne':       'TMY7unjtR-2XvVpg',
  'marshall':             'TMY7unjtR-2XvVpg',
  'crashon traylor':      'TMmOwb6WS9cTplXu',
  'crashon traylor sr.':  'TMmOwb6WS9cTplXu',
  'crashon':              'TMmOwb6WS9cTplXu',
};

const DEFAULT_TECH_NAME = 'Marshall Donnerbauer';
const DEFAULT_TECH_ID = 'TMY7unjtR-2XvVpg';

// ============================================================================
// MAIN SERVICE MAP — Reserved for Phase 2: Square Appointments
// ZenBooker top-level service name → { ZenBooker size option → Square variation ID }
// _default = used when no matching size option is found in the selected options.
// All IDs verified from Square catalog 2026-02-21.
// ============================================================================
const MAIN_SERVICE_MAP = {

  // ── Standard wall mount — TV size selects variation ──────────────────────
  // Square item: "TV Mounting – Standard" (FHZANUTIBZHNTOIJPAEM526L)
  // Category: "TV Mounting – ZenBooker" (LJHIZES47NL7RUT3DLQUYQ4T) — created 2026-02-22
  'Mount 1 Or More TVs (Normal TV Onto Any Surface)': {
    'Under 50 Inches': 'ZRYVFRZ5UAQO75H5G2ZG6DU3', // $150
    '43 Inches':       'ZRYVFRZ5UAQO75H5G2ZG6DU3', // $150 (alias → Under 50")
    '50 Inches':       'HMGSL34BHWHO7PAGLGM7DJJT', // $150
    '55 Inches':       'S4IRWJGHYNKWFQNPIKIWAH5B', // $150
    '60 Inches':       'EVCVX2YUT54OBHUN673C6O3Z', // $150
    '65 Inches':       'OEIUGPSC7KNJZ7J6CC77CR5V', // $150
    '70 Inches':       'DJSMVMFZNNGCSWQOALO3QS5O', // $200
    '75 Inches':       'LJGOOVS5KIIJR7M2I7PDR5RP', // $225
    '80 Inches':       'F7SWKR5TF3ECVVONYVGTFPI5', // $250
    '85 Inches':       '6XN6FG6NZHIGRB37O4536UP7', // $250
    '86 Inches':       '6XN6FG6NZHIGRB37O4536UP7', // $250 (alias → 85")
    '87" to 100"':     'T24XNGFILT5BRHCKKL7D6PAW', // $500
    '98" or 100" TV':  'T24XNGFILT5BRHCKKL7D6PAW', // $500 (alias)
    _default:          'OEIUGPSC7KNJZ7J6CC77CR5V', // 65" — most common
  },

  // Alternate ZenBooker service name spelling for same service
  'Mount 1 Or More TVs (Normal TV(s) Onto Any Surface.)': {
    'Under 50 Inches': 'ZRYVFRZ5UAQO75H5G2ZG6DU3',
    '43 Inches':       'ZRYVFRZ5UAQO75H5G2ZG6DU3',
    '50 Inches':       'HMGSL34BHWHO7PAGLGM7DJJT',
    '55 Inches':       'S4IRWJGHYNKWFQNPIKIWAH5B',
    '60 Inches':       'EVCVX2YUT54OBHUN673C6O3Z',
    '65 Inches':       'OEIUGPSC7KNJZ7J6CC77CR5V',
    '70 Inches':       'DJSMVMFZNNGCSWQOALO3QS5O',
    '75 Inches':       'LJGOOVS5KIIJR7M2I7PDR5RP',
    '80 Inches':       'F7SWKR5TF3ECVVONYVGTFPI5',
    '85 Inches':       '6XN6FG6NZHIGRB37O4536UP7',
    '86 Inches':       '6XN6FG6NZHIGRB37O4536UP7',
    '87" to 100"':     'T24XNGFILT5BRHCKKL7D6PAW',
    '98" or 100" TV':  'T24XNGFILT5BRHCKKL7D6PAW',
    _default:          'OEIUGPSC7KNJZ7J6CC77CR5V',
  },

  // ── Samsung Frame / gallery-style TVs ─────────────────────────────────────
  // Square item: "TV Mounting – Samsung Frame / Gallery Style" (2CDBRPVTCDNZSU3KXYDH7FT6)
  'Picture Frame (Gallery) Style TVs (Samsung Frame, LG G Series, Hisense Canvas, TCL NXTFRAME...)': {
    '43 Inches': 'GMO57YE3IVREFPJYRGTY75KO', // $250
    '50 Inches': 'OMDLPMB7J5TSKHCY73OZZSOL', // $250
    '55 Inches': 'UFUF2QP3D54T7UKTYHZA25GD', // $250
    '65 Inches': 'J34PODCQBCZ6Y32A6OKSSBNO', // $250
    '75 Inches': 'WGBLVCJSMZT4QEPBUAR34Z7W', // $350
    '85 Inches': '5KNEPGCPHTDFG264XLVUY7S4', // $400
    '86 Inches': '5KNEPGCPHTDFG264XLVUY7S4', // $400 (alias → 85")
    _default:    'J34PODCQBCZ6Y32A6OKSSBNO', // 65" — most common
  },

  // ── Mantel Mount ─────────────────────────────────────────────────────────
  // Square item: "TV Mounting – Mantel Mount Installation" (4DYXFZHFPZG3IHABDJMHMRXX)
  'The Mantel Mount Installation': {
    '65 Inches or Under': 'ODMRKTHXC3LGXFBPENJZQPCP', // $500
    '65" or Under':       'ODMRKTHXC3LGXFBPENJZQPCP', // $500
    '65 Inches':          'ODMRKTHXC3LGXFBPENJZQPCP', // $500
    '70 to 75 Inches':    '4CR3YWEXX2RBPSXXAYKURBMB', // $600
    '70 Inches':          '4CR3YWEXX2RBPSXXAYKURBMB', // $600 (approx)
    '75 Inches':          '4CR3YWEXX2RBPSXXAYKURBMB', // $600
    '76 to 80 Inches':    'IT5W4UHB6OLYUEE6XI4346FQ', // $750
    '80 Inches':          'IT5W4UHB6OLYUEE6XI4346FQ', // $750
    '81 to 88 Inches':    'MP6GKOABYJ5NYI66EL7VZBE4', // $1,000
    '85 Inches':          'MP6GKOABYJ5NYI66EL7VZBE4', // $1,000
    '86 Inches':          'MP6GKOABYJ5NYI66EL7VZBE4', // $1,000
    _default:             'ODMRKTHXC3LGXFBPENJZQPCP', // 65" or Under
  },

  // ── Unmount ───────────────────────────────────────────────────────────────
  // Square item: "TV Unmount Service" (5LMQCZPBPRJJX4M52KRE7KWR)
  'Unmount TVs (Minimum Booking $150)': {
    '65" or Under':    'PV7HL4JIHKYF2X4RFF4HXYS6', // $75
    '65 Inches':       'PV7HL4JIHKYF2X4RFF4HXYS6', // $75
    'Up to 65"':       'PV7HL4JIHKYF2X4RFF4HXYS6', // $75
    '66 to 75 Inches': 'OZLOPB5BTXDKJZB7BXDKYCKR', // $100
    '70 Inches':       'OZLOPB5BTXDKJZB7BXDKYCKR', // $100 (approx)
    '75 Inches':       'OZLOPB5BTXDKJZB7BXDKYCKR', // $100
    '76 to 86 Inches': 'PZMQG57A32MY54XF7EHJ3Q7T', // $125
    '80 Inches':       'PZMQG57A32MY54XF7EHJ3Q7T', // $125
    '86 Inches':       'PZMQG57A32MY54XF7EHJ3Q7T', // $125
    _default:          'PV7HL4JIHKYF2X4RFF4HXYS6', // 65" or Under
  },

  // ── Outdoor TV Mounting ───────────────────────────────────────────────────
  // Square item: "TV Mounting – Outdoor" (TFMJ3NPQS5HO7MKRBUL6H576)
  'Outdoor TV Mounting': {
    _default: 'X7IABYNS5VQRKBWTXGWGRPGQ', // Standard $250
  },

  // ── Special TV Mounting Situation ─────────────────────────────────────────
  // Square item: "TV Mounting – Special Situation" (EGAEWO6HZTLTN2O22WMX3K43)
  'Special TV Mounting Situation': {
    'Over Fireplace':          'EE5SK4HAG4XOEEG5PLJJW5NG', // $300
    'Stone':                   'EE5SK4HAG4XOEEG5PLJJW5NG', // $300 (stone over fireplace)
    'Brick':                   'YCSD2PKWUATKUZZIP4GHWGHP', // Brick Wall $250
    'Solid Brick':             'YCSD2PKWUATKUZZIP4GHWGHP', // $250
    'Concrete':                'EQBMVWE6FJFJHO3X5JALGLF7', // Concrete/Block $250
    'Tile':                    'HUHIBLCIRCVL6WCCLMRV5APC', // Hardened Tile $250
    'Glass Tile':              'HUHIBLCIRCVL6WCCLMRV5APC', // $250
    'Sheet Metal':             'AJF75HM2D2VTUIDS3QEJIEL3', // Unique Situation $250
    'Corner':                  '2PIQO6L3DPTUEC4UGLRLOVIW', // Corner Mount $250
    'Ceiling':                 'NAGEB72SQIQ3TFOQQ7JTPD37', // Ceiling Mounted $250
    'Motorized':               'MASBRGJC24DTBMVZX64KWHP5', // Motorized Ceiling $350
    'Extended Mount':          'LELAZHRFRWRH4X45DE6MSHZ4', // 30-45" Extended $200
    _default:                  'AJF75HM2D2VTUIDS3QEJIEL3', // Unique Situation $250
  },

  // ── Handyman Work ─────────────────────────────────────────────────────────
  // Square item: "Handyman Work" (4WOKTWSZMPOKFRKJ3NCTUIII)
  'Handyman Work': {
    _default: 'O7KZ2JJUMZREVQJ6IDNSX66I', // Regular $150/hr
  },

  // ── General Mounting ──────────────────────────────────────────────────────
  // Square item: "General Mounting – Curtains, Blinds, Shelves, Art" (PEKGKWPWHP3SGZFR2RHNUPB6)
  'General Mounting (ANYTHING OTHER THAN TVS) ...Curtains, Blinds, Shelves, Art...)': {
    _default: '52U3P4QKMOZ3DVBR6NIQ6WVM', // Regular $150
  },
};

const FIREPLACE_SERVICE_MAP = {
  'Mount 1 Or More TVs (Normal TV Onto Any Surface)': {
    'Under 50 Inches': 'VL4QAU3GBHLZ4ZGCJUAO53W4', // $200
    '43 Inches':       'VL4QAU3GBHLZ4ZGCJUAO53W4',
    '50 Inches':       '5LVUCPQGN3QZW2AYEYZRVFTS', // $200
    '55 Inches':       'WXFH7HSFOVKECZ2JMJD3GP3W', // $200
    '60 Inches':       'NIXDOUHRKSBOBHTAHLGGGH37', // $200
    '65 Inches':       'FCXBZCUOG2GVP7LYBMNJL7E2', // $200
    '70 Inches':       'OLLMXR2VIRJNNIV7SADD52C7', // $250
    '75 Inches':       'PUK5RW55CEN7UEKR4RGHDKFV', // $275
    '80 Inches':       'S5L3YKMHOMU7RYRHQIB2N2VT', // $300
    '85 Inches':       'ANA56W25SMZYAW6AFYMXK5PK', // $300
    '86 Inches':       'ANA56W25SMZYAW6AFYMXK5PK',
    '87" to 100"':     'C5LRCSQMLKU3TXXXYKVOWBQF', // $550
    '98" or 100" TV':  'C5LRCSQMLKU3TXXXYKVOWBQF',
    _default:          'FCXBZCUOG2GVP7LYBMNJL7E2',
  },
  'Mount 1 Or More TVs (Normal TV(s) Onto Any Surface.)': {
    'Under 50 Inches': 'VL4QAU3GBHLZ4ZGCJUAO53W4',
    '43 Inches':       'VL4QAU3GBHLZ4ZGCJUAO53W4',
    '50 Inches':       '5LVUCPQGN3QZW2AYEYZRVFTS',
    '55 Inches':       'WXFH7HSFOVKECZ2JMJD3GP3W',
    '60 Inches':       'NIXDOUHRKSBOBHTAHLGGGH37',
    '65 Inches':       'FCXBZCUOG2GVP7LYBMNJL7E2',
    '70 Inches':       'OLLMXR2VIRJNNIV7SADD52C7',
    '75 Inches':       'PUK5RW55CEN7UEKR4RGHDKFV',
    '80 Inches':       'S5L3YKMHOMU7RYRHQIB2N2VT',
    '85 Inches':       'ANA56W25SMZYAW6AFYMXK5PK',
    '86 Inches':       'ANA56W25SMZYAW6AFYMXK5PK',
    '87" to 100"':     'C5LRCSQMLKU3TXXXYKVOWBQF',
    '98" or 100" TV':  'C5LRCSQMLKU3TXXXYKVOWBQF',
    _default:          'FCXBZCUOG2GVP7LYBMNJL7E2',
  },
};

// ============================================================================
// OPTION MAP — Reserved for Phase 2: Square Appointments
// ZenBooker selected option name → Square catalog VARIATION ID (direct lookup)
// Options that are just TV size (handled by MAIN_SERVICE_MAP above) are excluded.
// Options with "no/none" meaning are excluded (handled by isNoSelection).
// ============================================================================
const OPTION_MAP = {

  // ── Wall mount / bracket items (REGULAR, taxable in MN) ──────────────────
  // Square category: "TV Mounting – ZenBooker (Items)" (A2OMV7PZ725T6Z44YPOEOUTM)
  'Fixed Bracket':                                       'XXW6UNO5ELUXQ7TVHJJFPGAR', // TV Mount / Bracket → Fixed $50
  'Fixed':                                               'XXW6UNO5ELUXQ7TVHJJFPGAR',
  'Standard Tilt Mount (For Up to 86" TVs)':             'HDME4QNZXQGGKMFKQCG3MP2A', // TV Mount / Bracket → Standard Tilt $75
  'Tilting':                                             'HDME4QNZXQGGKMFKQCG3MP2A',
  'Buy Tilt TV Mounting Bracket':                        'HDME4QNZXQGGKMFKQCG3MP2A',
  '98" -  100" TV Tilt Bracket':                        'HDME4QNZXQGGKMFKQCG3MP2A',
  'Standard Full Motion Mount (For up to 86" TVs)':      'OCWEQ2XTRFFJPC2YEQJULAPW', // TV Mount / Bracket → Standard Full Motion $100
  'Full Motion':                                         'OCWEQ2XTRFFJPC2YEQJULAPW',
  'Buy Full Motion (Articulating) TV Mounting Bracket':  'OCWEQ2XTRFFJPC2YEQJULAPW',
  'Corner Mounting Bracket':                             'OCWEQ2XTRFFJPC2YEQJULAPW',
  'Flush Mounting Bracket':                              '5N5OV2NBZN6TOQEE5PDU6WN2', // TV Mount / Bracket → Flush $135
  'Premium 4D Tilt Mount':                               'YU6RUNKKNK2EI7DTN2IPEWPD', // TV Mount / Bracket → Premium 4D Tilt $100
  'Premium Tilt Mounting Bracket':                       'MDLM3WBWCJV7JZAEGKUXOW4C', // TV Mount / Bracket → Premium Tilt $200
  'Premium Full Motion Mounting Bracket':                'NL6QS6KDHESFCY5PDQNFW2YQ', // TV Mount / Bracket → Premium Full Motion $200
  'Premium Full Motion Mounting Bracket (Special)':      'NL6QS6KDHESFCY5PDQNFW2YQ',

  // ── Soundbar labor (APPOINTMENTS_SERVICE, not taxed) ─────────────────────
  // Square item: "Soundbar Mounting – Labor" (PFVBZCBVBGMAGZDGJLHVQET4)
  'Yes I Need A Sound Bar Mounted':                      'SWNAVW6UAOKR2DV4FBEJRUOT', // Soundbar Mounting → Yes $100
  'I Need One Sound Bar Mounted':                        'SWNAVW6UAOKR2DV4FBEJRUOT',
  'Mount Sound Bar':                                     'SWNAVW6UAOKR2DV4FBEJRUOT',
  'Mount Soundbar':                                      'SWNAVW6UAOKR2DV4FBEJRUOT',
  'Mount Soundbar ':                                     'SWNAVW6UAOKR2DV4FBEJRUOT', // trailing space variant
  'I Need Two Sound Bars Mounted':                       '7HOG7EI2MG6OILS3MAHXX25M', // 2 Soundbars $200

  // ── Soundbar brackets (REGULAR, taxable in MN) ───────────────────────────
  // Square items: "Soundbar Mounting Bracket" / "Premium Soundbar Mounting Bracket"
  'Soundbar Mounting Bracket':                           '3Q23ZPDYQLJYLM6NVGBUVG6K', // Soundbar Bracket → Standard $50
  'Buy Sound Bar Mounting Bracket':                      '3Q23ZPDYQLJYLM6NVGBUVG6K',
  'Yes - Give me a standard sound bar mounting bracket.':'3Q23ZPDYQLJYLM6NVGBUVG6K',
  'Purchase Soundbar Mounting Bracket':                  '3Q23ZPDYQLJYLM6NVGBUVG6K',
  'Yes - Give me a premium sound bar mounting bracket.': 'ARXV4EQUKYK7CYK4ARTHIDHN', // Soundbar Bracket → Premium $100

  // ── Soundbar cord concealing (maps to exterior concealing service) ────────
  'Conceal Sound Bar Cords As Well':                     'HWHVY252QHA5JZJI5NMP5WU2', // Cord Concealing → In-Wall With Soundbar Cords $300

  // ── In-wall cord concealing (APPOINTMENTS_SERVICE) ───────────────────────
  // Square item: "Cord Concealing – In-Wall" (WTOJ5OLNW7MULFPYRNQW56F3)
  'In-Wall Concealing (And Install An Outlet Behind TV)':                              'BBKPIPW7ZL7O2XMO25Q535LV', // Cord Concealing → In-Wall + New Outlet $400
  'Install New Outlet & Hide Cords In Wall':                                           'BBKPIPW7ZL7O2XMO25Q535LV',
  'In-Wall Concealing (Drywall)':                                                      'MRYFWOHANW7NL4XGMV5SMIOG', // Cord Concealing → In-Wall w/ Power Bridge (Drywall) $250
  'In-Wall w/ Power Bridge (Drywall)':                                                 'MRYFWOHANW7NL4XGMV5SMIOG',
  'In Wall Cord Concealing Through Drywall Fireplace Cavity':                          'MYOL5QYOWAVRKNE77FAHN2CG', // Cord Concealing → In-Wall Through Fireplace $350
  'In Wall Cord Concealing Through Drywall Fireplace':                                 'MYOL5QYOWAVRKNE77FAHN2CG',
  'In Wall Cord Concealing Through Plaster Fireplace':                                 'MYOL5QYOWAVRKNE77FAHN2CG',
  'In-Wall Concealing Through A Fireplace (Drywall Exterior) And Install An Outlet Behind TV': 'MYOL5QYOWAVRKNE77FAHN2CG',
  'In-Wall Concealing Through A Fireplace (Drywall) And Install An Outlet Behind TV':  'MYOL5QYOWAVRKNE77FAHN2CG',
  'In-Wall Concealing Through Brick Fireplace':                                        'MYOL5QYOWAVRKNE77FAHN2CG',
  'In Wall Cord Concealing & Installing Outlet Through Stone Fireplace':               'MYOL5QYOWAVRKNE77FAHN2CG',
  'In Wall Cord Concealing & Installing Outlet Through Brick Fireplace':               'MYOL5QYOWAVRKNE77FAHN2CG',
  'In Wall Cord Concealing With Soundbar Cords':                                       'HWHVY252QHA5JZJI5NMP5WU2', // Cord Concealing → In-Wall With Soundbar Cords $300
  'Conceal Cords Through Already Existing Conduit':                                    'UXQ6MF63SGKNPKXJHOH6TVNC', // Cord Concealing → Through Existing Conduit $50
  'Concealing Through Existing Conduit':                                               'UXQ6MF63SGKNPKXJHOH6TVNC',

  // ── Exterior cord concealing (APPOINTMENTS_SERVICE) ──────────────────────
  // Square item: "Cord Concealing – Exterior" (M6VI2UEOR462UOYAR43ZZZCJ)
  'Exterior Concealing (Not above fireplace.)':          'NVQPYMKHEFSM45FIJTXBDP2Q', // Cord Concealing → Exterior $75
  'Exterior Cord Concealing (Not around fireplace.)':    'NVQPYMKHEFSM45FIJTXBDP2Q',
  'Exterior Concealing':                                 'NVQPYMKHEFSM45FIJTXBDP2Q',
  'Exterior Concealing Around A Fireplace':              'VYDX7EYT4TTEKELJVHT65FLW', // Cord Concealing → Exterior Around Fireplace $125
  'Exterior Concealing Around A Brick Fireplace':        'VYDX7EYT4TTEKELJVHT65FLW',
  'Exterior Cord Concealing Around Fireplace':           'VYDX7EYT4TTEKELJVHT65FLW',

  // ── Recessed power bridge / recessed box (APPOINTMENTS_SERVICE) ─────────
  // Square items: generic cord concealing + legacy recessed box sync item
  'Recessed Power Bridge Installation':                                                'MRYFWOHANW7NL4XGMV5SMIOG', // Cord Concealing → Power Bridge $250
  'Recessed Outlet & Cords Concealed Through Wall':                                    'MRYFWOHANW7NL4XGMV5SMIOG', // Cord Concealing → Power Bridge $250
  'Recessed Box and Electrical Outlet Installation Behind TV (Drywall)':               '7DVPGCFPKYANLK7ZHDZLKIEH',
  'Recessed Box and Electrical Outlet Installation Behind TV (Plaster)':               '7DVPGCFPKYANLK7ZHDZLKIEH',
  'Recessed Box Behind TV to Store Components (With Electrical)':                      '7DVPGCFPKYANLK7ZHDZLKIEH',
  'Recessed Box Behind TV (Drywall) to Store Components (With Electrical)':            '7DVPGCFPKYANLK7ZHDZLKIEH',
  'Recessed Box and Electrical Outlet Installation Behind TV':                         '7DVPGCFPKYANLK7ZHDZLKIEH',
  'Recessed Box Installation':                                                         '7DVPGCFPKYANLK7ZHDZLKIEH',
  'Yes - I Need the RB100 Installed':                                                  '7DVPGCFPKYANLK7ZHDZLKIEH',

  // ── Unmount add-ons (when unmounting is part of another service) ──────────
  // Square item: "TV Unmount Service" (5LMQCZPBPRJJX4M52KRE7KWR)
  'Unmount 65" Or Under TV':      'PV7HL4JIHKYF2X4RFF4HXYS6', // $75
  'Unmount TV(s) - 65" Or Under': 'PV7HL4JIHKYF2X4RFF4HXYS6',
  'Unmount TV(s) 70" or Under':   'PV7HL4JIHKYF2X4RFF4HXYS6',
  'Unmount Misc Objects':         'PV7HL4JIHKYF2X4RFF4HXYS6',
  '65" Or Under':                 'PV7HL4JIHKYF2X4RFF4HXYS6',
  'Unmount 65 - 75" TV':          'OZLOPB5BTXDKJZB7BXDKYCKR', // $100
  'Unmount TV(s) - Over 65"':     'OZLOPB5BTXDKJZB7BXDKYCKR',
  'Unmount TV(s) 75" or Over':    'OZLOPB5BTXDKJZB7BXDKYCKR',
  'Over 65"':                     'OZLOPB5BTXDKJZB7BXDKYCKR',
  'Unmount 76" to 86" TV':        'PZMQG57A32MY54XF7EHJ3Q7T', // $125

  // ── Wall surface selections (APPOINTMENTS_SERVICE) ───────────────────────
  // Square item: "What Surface Is The TV Going Onto?" (57XGNN7MD55Y262FR3YS6UQH)
  'Plaster':                                            'UH4KYZ5VHDNPV2V57VE4J2GC', // $50
  'Plaster Walls':                                      'UH4KYZ5VHDNPV2V57VE4J2GC',
  'Plaster Wall':                                       'UH4KYZ5VHDNPV2V57VE4J2GC',
  'Brick':                                              'AKARFSUH7CSBYJLNNZGWCRRR', // $100
  'Brick Walls':                                        'AKARFSUH7CSBYJLNNZGWCRRR',
  'Brick Wall':                                         'AKARFSUH7CSBYJLNNZGWCRRR',
  'Stone':                                              '6X7VHWLJLHGNEJKIYFBQ2M4M', // $150
  'Stone Wall':                                         '6X7VHWLJLHGNEJKIYFBQ2M4M',
  'Stone Walls':                                        '6X7VHWLJLHGNEJKIYFBQ2M4M',
  'Faux Brick':                                         '6X7VHWLJLHGNEJKIYFBQ2M4M',
  'Porcelain Tile':                                     'FIBV6ASXYHJFR7T4PS62QYYQ', // $150
  'Ceramic Tile':                                       'FIBV6ASXYHJFR7T4PS62QYYQ',
  'Tile Wall':                                          'FIBV6ASXYHJFR7T4PS62QYYQ',
  'Wood Slats':                                         '2U5PLCGMIEIMSI3UA5QSCH6E', // $100

  // ── Specialty ─────────────────────────────────────────────────────────────
  'Storm Shell Assembly':                               'HOHISWDYWICVXD2C5LOI7SEW', // existing item $500
  'Storm Shell Assembly and TV Mounting':               'HOHISWDYWICVXD2C5LOI7SEW',

  // ── General mounting add-ons ──────────────────────────────────────────────
  // Square item: "General Mounting – Curtains, Blinds, Shelves, Art" (PEKGKWPWHP3SGZFR2RHNUPB6)
  'Install Curtains (Normal sized window)':             '52U3P4QKMOZ3DVBR6NIQ6WVM', // $150
  'Install Curtains (Picture window sized window)':     '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Blinds (Normal Sized Window)':                       '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Blinds (Picture Window Sized Window)':               '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Small Pictures (20" width or height - whichever is greatest.)':                    '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Medium Pictures (Over 20" width or height to 50" Width or height - whichever is greatest.)': '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Large Pictures (Over 50" width or height - whichever is greatest.)':               '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Shelves (2 feet width or less.)':                    '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Shelves (Over 2 feet width to 4 feet width.)':       '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Small Mirror (24" Width or Height - Whichever is greatest)':                       '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Medium Mirror (25\' to 50" Width or Height - Whichever is greatest)':              '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Large Mirror (51" to 72" Width or Height - Whichever is greatest)':                '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Extra Large Mirror Over 72" Width or Height - Whichever is greatest)':             '52U3P4QKMOZ3DVBR6NIQ6WVM',
  'Bathroom Mirror with Standoffs. ':                   '52U3P4QKMOZ3DVBR6NIQ6WVM',
};

// ============================================================================
// HELPERS
// ============================================================================

function getNestedValue(obj, path) {
  return path.split('.').reduce((cur, key) => cur?.[key], obj);
}

function resolveField(payload, fieldPaths) {
  if (typeof fieldPaths === 'string') return getNestedValue(payload, fieldPaths);
  for (const path of fieldPaths) {
    const val = getNestedValue(payload, path);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return null;
}

function splitName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] || null, lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

/** Extract string name from a ZenBooker line item (may be string, object, or array). */
function extractOptionName(item) {
  if (typeof item === 'string') return item.trim();
  if (item?.name) return String(item.name).trim();
  if (item?.service_name) return String(item.service_name).trim();
  if (item?.description) return String(item.description).trim();
  return null;
}

function stripLineItemPrefix(label) {
  return String(label || '').replace(/^(Service|Option):\s*/, '').trim();
}

function summarizeLabels(labels) {
  const counts = new Map();
  for (const rawLabel of labels || []) {
    const label = stripLineItemPrefix(rawLabel);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => (
    count > 1 ? `${label} x${count}` : label
  ));
}

function expandSelectionLabels(selections) {
  const labels = [];
  for (const selection of selections || []) {
    const quantity = Math.max(1, Number(selection?.quantity) || 1);
    for (let i = 0; i < quantity; i += 1) {
      labels.push(selection?.label);
    }
  }
  return labels.filter(Boolean);
}

function cleanFieldName(fieldName) {
  return String(fieldName || 'Selection')
    .replace(/\s+/g, ' ')
    .replace(/[:?]+$/g, '')
    .trim();
}

function shortFieldName(fieldName) {
  const cleaned = cleanFieldName(fieldName);
  const lower = cleaned.toLowerCase();

  if (lower.includes('size')) return 'Size';
  if (lower.includes('surface') || lower.includes('wall')) return 'Surface';
  if (lower.includes('sound bar') || lower.includes('soundbar')) return 'Soundbar';
  if (lower.includes('conceal') || lower.includes('cord') || lower.includes('outlet') || lower.includes('conduit')) return 'Cord Concealment';
  if (lower.includes('bracket') || lower.includes('mount')) return 'Bracket';
  if (lower.includes('unmount')) return 'Unmount';

  return cleaned;
}

function getFieldCategory(fieldName) {
  const cleaned = cleanFieldName(fieldName);
  const lower = cleaned.toLowerCase();

  if (lower.includes('size')) return 'size';
  if (lower.includes('fireplace')) return 'fireplace';
  if (lower.includes('surface') || lower.includes('wall')) return 'surface';
  if (lower.includes('sound bar') || lower.includes('soundbar')) return 'soundbar';
  if (lower.includes('conceal') || lower.includes('cord') || lower.includes('outlet') || lower.includes('conduit')) return 'concealment';
  if (lower.includes('unmount')) return 'unmount';
  if (lower.includes('bracket') || lower.includes('mount')) return 'bracket';

  return 'other';
}

function normalizeDisplayLabel(label) {
  return String(label || '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/g, '')
    .trim();
}

function normalizeSelectionForSummary(fieldName, label) {
  const category = getFieldCategory(fieldName);
  const normalized = normalizeDisplayLabel(label);
  const lower = normalized.toLowerCase();

  if (!normalized || lower === 'other') return null;

  switch (category) {
    case 'size':
      return normalized;
    case 'fireplace':
      if (lower.includes('not going above a fireplace')) return 'standard wall placement';
      if (lower.includes('above a fireplace')) return 'above fireplace';
      return normalized;
    case 'surface':
      if (lower === 'normal drywall' || lower === 'drywall') return 'drywall';
      if (lower.includes('stone')) return 'stone / faux brick';
      if (lower.includes('tile')) return 'tile';
      if (lower.includes('wood slats')) return 'wood slats';
      if (lower.includes('brick')) return 'brick';
      if (lower.includes('plaster')) return 'plaster';
      return normalized;
    case 'bracket':
      if (
        lower.includes('do not need a mount') ||
        lower.includes('have your own') ||
        lower.includes('have my own') ||
        lower.includes('already have')
      ) return 'customer-supplied mount';
      if (lower.includes('premium full motion')) return 'premium full-motion mount';
      if (lower.includes('full motion')) return 'full-motion mount';
      if (lower.includes('premium 4d tilt')) return 'premium 4D tilt mount';
      if (lower.includes('premium tilt')) return 'premium tilt mount';
      if (lower.includes('flush')) return 'flush mount';
      if (lower.includes('tilt')) return 'tilt mount';
      if (lower.includes('fixed')) return 'fixed mount';
      if (lower.includes('corner')) return 'corner mount';
      return normalized;
    case 'soundbar':
      if (
        lower.includes('no - i have my own sound bar bracket') ||
        lower.includes('none to be mounted') ||
        lower.includes('no sound bar') ||
        lower.includes('no soundbar')
      ) return 'no soundbar bracket';
      if (lower.includes('premium')) return 'premium soundbar bracket';
      if (lower.includes('standard')) return 'standard soundbar bracket';
      if (lower.includes('mount sound bar') || lower.includes('mount soundbar')) return 'soundbar mount';
      return normalized;
    case 'concealment':
      if (lower.includes('no cord concealing')) return 'no cord concealment';
      if (lower.includes('existing conduit')) return 'existing conduit concealment';
      if (lower.includes('recessed box')) return 'recessed box behind TV';
      if (lower.includes('brick fireplace')) return 'in-wall concealment through brick fireplace';
      if (lower.includes('new outlet')) return 'new outlet with in-wall concealment';
      if (lower.includes('in-wall') || lower.includes('in wall')) return 'in-wall concealment';
      if (lower.includes('exterior') && lower.includes('fireplace')) return 'exterior concealment around fireplace';
      if (lower.includes('exterior')) return 'exterior concealment';
      return normalized;
    case 'unmount':
      if (lower.includes('no unmount')) return 'no unmount';
      return normalized;
    default:
      if (isNoSelection(normalized)) return null;
      return normalized;
  }
}

function parseQuantitySelection(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const prefixedMatch = text.match(/^(\d+)\s*x\s+(.+)$/i);
  if (prefixedMatch) {
    return {
      quantity: Math.max(1, Number(prefixedMatch[1]) || 1),
      label: prefixedMatch[2].trim(),
    };
  }

  return { quantity: 1, label: text };
}

function extractServiceFieldSelections(rawOptions) {
  const fieldSelections = [];
  const optionSelections = [];

  if (!Array.isArray(rawOptions)) {
    return { fieldSelections, optionSelections };
  }

  rawOptions.forEach((item, index) => {
    const fieldName = cleanFieldName(
      item?.field_name
      || item?.name
      || item?.label
      || item?.title
      || `Selection ${index + 1}`
    );
    const selections = [];

    if (Array.isArray(item?.selected_options)) {
      item.selected_options.forEach((opt) => {
        const parsed = parseQuantitySelection(opt?.display_label || opt?.text || opt?.name || '');
        if (!parsed?.label) return;

        const selection = {
          fieldName,
          label: parsed.label,
          quantity: parsed.quantity,
          rawLabel: (opt?.display_label || opt?.text || opt?.name || '').trim(),
        };

        selections.push(selection);
        optionSelections.push(selection);
      });
    } else {
      const extracted = extractOptionName(item);
      const parsed = parseQuantitySelection(extracted);
      if (parsed?.label) {
        const selection = {
          fieldName,
          label: parsed.label,
          quantity: parsed.quantity,
          rawLabel: extracted,
        };
        selections.push(selection);
        optionSelections.push(selection);
      }
    }

    if (selections.length > 0) {
      fieldSelections.push({ fieldName, selections });
    }
  });

  return { fieldSelections, optionSelections };
}

function addTvUnitDetail(tvUnit, category, value) {
  if (!value) return;
  if (!tvUnit.byCategory[category]) {
    tvUnit.byCategory[category] = [];
  }
  if (!tvUnit.byCategory[category].includes(value)) {
    tvUnit.byCategory[category].push(value);
  }
}

function expandSelectionsForSummary(field) {
  const expanded = [];
  for (const selection of field?.selections || []) {
    const summaryValue = normalizeSelectionForSummary(field.fieldName, selection.label);
    if (!summaryValue) continue;
    const quantity = Math.max(1, Number(selection.quantity) || 1);
    for (let i = 0; i < quantity; i += 1) {
      expanded.push(summaryValue);
    }
  }
  return expanded;
}

function formatTvSizeLabel(sizeValue) {
  const normalized = normalizeDisplayLabel(sizeValue);
  if (!normalized) return null;

  const lower = normalized.toLowerCase();
  if (lower.includes('under 50')) return 'Under 50-inch TV';

  const rangeMatch = normalized.match(/^(\d+)\s*["']?\s*to\s*(\d+)\s*["']?$/i);
  if (rangeMatch) {
    return `${rangeMatch[1]}-${rangeMatch[2]}-inch TV`;
  }

  const singleMatch = normalized.match(/^(\d+)\s*(inch|inches|["'])/i) || normalized.match(/^(\d+)$/);
  if (singleMatch) {
    return `${singleMatch[1]}-inch TV`;
  }

  return normalized;
}

function formatTvUnitSummary(tvUnit) {
  const orderedCategories = ['size', 'fireplace', 'surface', 'bracket', 'soundbar', 'concealment', 'unmount', 'other'];
  const parts = [];
  const sizeValues = tvUnit.byCategory?.size || [];
  const headline = sizeValues.length > 0
    ? sizeValues.map(formatTvSizeLabel).filter(Boolean).join(' / ')
    : 'TV mount';

  for (const category of orderedCategories) {
    if (category === 'size') continue;
    const values = tvUnit.byCategory?.[category] || [];
    if (values.length === 0) continue;
    parts.push(values.join(' / '));
  }

  return parts.length > 0 ? `${headline}, ${parts.join(', ')}` : headline;
}

function summarizeTvUnitSummaries(tvUnits) {
  const counts = new Map();

  for (const tvUnit of tvUnits || []) {
    const summary = tvUnit?.summary?.trim();
    if (!summary) continue;
    counts.set(summary, (counts.get(summary) || 0) + 1);
  }

  return [...counts.entries()].map(([summary, count]) => (
    count > 1 ? `${count} x ${summary}` : summary
  ));
}

function normalizeZenbookerJob({
  jobId,
  serviceName,
  providerName,
  fieldSelections,
  unknownOptions,
}) {
  const serviceEntry = MAIN_SERVICE_MAP[serviceName];
  const normalizedFields = (fieldSelections || [])
    .map((field) => {
      const expanded = expandSelectionsForSummary(field);
      return expanded.length > 0 ? { ...field, category: getFieldCategory(field.fieldName), expanded } : null;
    })
    .filter(Boolean);

  const sizeSelections = [];
  if (serviceEntry) {
    normalizedFields.forEach((field) => {
      field.selections.forEach((selection) => {
        if (serviceEntry[selection.label]) {
          for (let i = 0; i < selection.quantity; i += 1) {
            sizeSelections.push(selection.label);
          }
        }
      });
    });
  }

  const fieldCounts = normalizedFields.map((field) => field.expanded.length);
  const tvCount = Math.max(1, sizeSelections.length > 0 ? sizeSelections.length : Math.max(...fieldCounts, 0));

  const tvUnits = Array.from({ length: tvCount }, (_, index) => ({
    ordinal: index + 1,
    byCategory: {},
  }));
  const additionalSelections = [];

  normalizedFields.forEach((field) => {
    if (tvCount === 1) {
      field.expanded.forEach((value) => addTvUnitDetail(tvUnits[0], field.category, value));
      return;
    }

    if (field.expanded.length === tvCount) {
      field.expanded.forEach((value, index) => addTvUnitDetail(tvUnits[index], field.category, value));
      return;
    }

    const summary = summarizeLabels(field.expanded);
    if (summary.length > 0) {
      additionalSelections.push({
        category: field.category,
        fieldName: shortFieldName(field.fieldName),
        values: summary,
      });
    }
  });

  return {
    jobId,
    serviceName,
    providerName,
    tvCount,
    tvUnits: tvUnits.map((tvUnit) => ({
      ...tvUnit,
      summary: formatTvUnitSummary(tvUnit),
    })),
    additionalSelections,
    unknownOptions: summarizeLabels(unknownOptions),
  };
}

function buildReadableSellerNote({
  existingSellerNote,
  normalizedJob,
  nonBookableLabels,
}) {
  const lines = [];

  if (existingSellerNote) lines.push(existingSellerNote.trim());
  if (normalizedJob?.serviceName) lines.push(`Service: ${normalizedJob.serviceName}`);
  if (normalizedJob?.providerName) lines.push(`Tech: ${normalizedJob.providerName}`);

  if ((normalizedJob?.tvUnits || []).length > 0) {
    lines.push(`TV count: ${normalizedJob.tvCount}`);
    summarizeTvUnitSummaries(normalizedJob.tvUnits).forEach((summary) => {
      lines.push(summary);
    });
  }

  if ((normalizedJob?.additionalSelections || []).length > 0) {
    const selectionText = normalizedJob.additionalSelections.map((selection) => (
      `${selection.fieldName}: ${selection.values.join('; ')}`
    ));
    lines.push(`Additional selections: ${selectionText.join(' | ')}`);
  }

  const taxableItems = summarizeLabels(nonBookableLabels);
  if (taxableItems.length > 0) {
    lines.push(`Items to add in Square: ${taxableItems.join('; ')}`);
  }

  if ((normalizedJob?.unknownOptions || []).length > 0) {
    lines.push(`Unmapped ZenBooker options: ${normalizedJob.unknownOptions.join('; ')}`);
  }

  return lines.join('\n').trim();
}

/** Check if an option name represents a "none/no" selection — skip these. */
function isNoSelection(name) {
  const lower = name.toLowerCase().trim();
  return (
    lower === 'no' || lower === 'none' || lower === 'other' ||
    lower.startsWith('no ') || lower.startsWith('no -') ||
    lower.startsWith('do not need') ||
    lower.startsWith('i have one') || lower.startsWith('i do not') ||
    lower.startsWith('no thanks') || lower.startsWith('no, ') ||
    lower.includes('i have my own') || lower.includes('already have') ||
    lower.includes('i already have') || lower.includes('no unmount') ||
    lower.includes('not above a fireplace') || lower.includes('no sound bar') ||
    lower.includes('no soundbar') || lower.includes('do not unmount') ||
    lower.includes('only the mantel mount installation') ||
    lower.includes('just the mounting') || lower.includes('not needed')
  );
}

function isInformationalSelection(name) {
  const lower = name.toLowerCase().trim();
  return lower === 'normal drywall' || lower === 'drywall';
}

function isAffirmativeFireplaceSelection(name) {
  const lower = String(name || '').toLowerCase().trim();
  return lower.includes('above a fireplace') && !lower.includes('not going above a fireplace');
}

function shouldUseFireplaceBaseService(serviceName, optionSelections) {
  if (!FIREPLACE_SERVICE_MAP[serviceName]) return false;
  return (optionSelections || []).some((selection) => isAffirmativeFireplaceSelection(selection?.label));
}

/** Look up Square Team Member ID from provider name. */
function lookupTech(providerName) {
  if (!providerName) return null;
  const key = String(providerName).toLowerCase().trim();
  // Exact match first
  if (TECH_MAP[key]) return TECH_MAP[key];
  // Partial match (first name)
  for (const [techName, techId] of Object.entries(TECH_MAP)) {
    if (key.includes(techName) || techName.includes(key)) return techId;
  }
  return null;
}

function isUnassignedProvider(providerName) {
  if (!providerName) return true;
  const key = String(providerName).toLowerCase().trim();
  return key === 'unassigned' || key === 'not assigned' || key === 'none' || key === 'n/a';
}

function resolveTechAssignment(providerName) {
  if (isUnassignedProvider(providerName)) {
    return {
      techSquareId: DEFAULT_TECH_ID,
      resolvedProviderName: DEFAULT_TECH_NAME,
      assignmentMode: 'defaulted_unassigned',
    };
  }

  const mappedTechId = lookupTech(providerName);
  if (mappedTechId) {
    return {
      techSquareId: mappedTechId,
      resolvedProviderName: providerName,
      assignmentMode: 'mapped_assigned',
    };
  }

  return {
    techSquareId: null,
    resolvedProviderName: providerName,
    assignmentMode: 'unmapped_assigned',
  };
}

// ============================================================================
// BUILD LINE ITEMS — fully synchronous, zero catalog API calls
// ============================================================================

function buildLineItems(serviceName, optionSelections) {
  const lineItems = [];
  const addedIds = new Set(); // prevent duplicate variation IDs
  const unknownOptions = [];
  let unknownService = null;

  function addVariation(variationId, label, { allowDuplicate = false } = {}) {
    if (!variationId) return false;
    if (!allowDuplicate && addedIds.has(variationId)) {
      console.log(`  ↩ Skipping duplicate variation ${variationId} (${label})`);
      return false;
    }
    if (!allowDuplicate) addedIds.add(variationId);
    lineItems.push({ catalog_object_id: variationId, quantity: '1', label });
    console.log(`  ✓ ${label} → ${variationId}`);
    return true;
  }

  const usesFireplaceBaseService = shouldUseFireplaceBaseService(serviceName, optionSelections);
  const serviceEntry = usesFireplaceBaseService
    ? FIREPLACE_SERVICE_MAP[serviceName]
    : MAIN_SERVICE_MAP[serviceName];
  const squareServiceLabel = usesFireplaceBaseService ? 'TV Installation Over Fireplace' : serviceName;

  // 1) Map the top-level service → main variation (size option selects which)
  if (serviceEntry) {
    const sizeSelections = (optionSelections || []).filter((selection) => (
      !isNoSelection(selection.label) && serviceEntry[selection.label]
    ));

    if (sizeSelections.length > 0) {
      sizeSelections.forEach((selection) => {
        for (let i = 0; i < selection.quantity; i += 1) {
          console.log(`  📐 Size match: "${selection.label}"`);
          addVariation(serviceEntry[selection.label], `Service: ${squareServiceLabel} (${selection.label})`, { allowDuplicate: true });
        }
      });
    } else {
      addVariation(serviceEntry._default, `Service: ${squareServiceLabel}`);
    }
  } else if (serviceName) {
    console.warn(`  ✗ Unknown service: "${serviceName}" — keeping in seller note`);
    unknownService = serviceName;
  }

  // 2) Map each selected option → add-on variation (skip sizes already handled)
  for (const selection of optionSelections || []) {
    const optName = selection.label;
    if (isNoSelection(optName)) continue;
    if (isInformationalSelection(optName)) continue;
    if (usesFireplaceBaseService && isAffirmativeFireplaceSelection(optName)) continue;
    // Skip if this option was a service-level size selector
    if (serviceEntry?.[optName]) continue;

    const variationId = OPTION_MAP[optName];
    if (variationId) {
      for (let i = 0; i < selection.quantity; i += 1) {
        addVariation(variationId, `Option: ${optName}`, { allowDuplicate: true });
      }
    } else {
      // Unknown options stay in the seller note so the Square UI avoids $0 placeholders.
      console.warn(`  ? Unknown option: "${optName}" — keeping in seller note`);
      for (let i = 0; i < selection.quantity; i += 1) {
        unknownOptions.push(optName);
      }
    }
  }

  return {
    lineItems,
    unknownOptions,
    unknownService,
    effectiveServiceName: squareServiceLabel || serviceName || null,
  };
}

// ============================================================================
// SQUARE API CALLS
// ============================================================================

/** Batch-fetch catalog info for variation IDs. Returns { id → { version, bookable, durationMs } }. */
async function fetchCatalogInfo(variationIds) {
  const ids = [...new Set(variationIds.filter(Boolean))];
  if (ids.length === 0) return {};
  try {
    const resp = await axios.post(
      `${SQUARE_BASE}/catalog/batch-retrieve`,
      { object_ids: ids },
      { headers: squareHeaders() }
    );
    const map = {};
    for (const obj of resp.data?.objects || []) {
      const vd = obj.item_variation_data || {};
      map[obj.id] = {
        version:    obj.version,
        bookable:   vd.available_for_booking === true,
        durationMs: vd.service_duration || null,
      };
    }
    return map;
  } catch (err) {
    console.error('Catalog batch-retrieve failed:', err.response?.data || err.message);
    return {};
  }
}

async function findSquareCustomer(email) {
  try {
    const resp = await axios.post(
      `${SQUARE_BASE}/customers/search`,
      { query: { filter: { email_address: { exact: email } } } },
      { headers: squareHeaders() }
    );
    return resp.data?.customers?.[0] || null;
  } catch (err) {
    console.error('Square customer search failed:', err.response?.data || err.message);
    return null;
  }
}

/** Convert ZenBooker datetime (any parseable format) to RFC 3339. Returns null if unparseable. */
function parseScheduledAt(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString(); // always valid RFC 3339
  } catch { return null; }
}

/** Normalize phone to E.164 (+1XXXXXXXXXX). Returns null if unrecognizable — Square rejects non-E.164. */
function sanitizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;                         // US 10-digit
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;    // US with country code
  return null; // unrecognizable — omit rather than fail customer creation
}

async function createSquareCustomer({ firstName, lastName, email, phone, note, address }) {
  try {
    const body = {};
    if (firstName) body.given_name    = firstName;
    if (lastName)  body.family_name   = lastName;
    if (email)     body.email_address = email;
    const cleanPhone = sanitizePhone(phone);
    if (cleanPhone) body.phone_number = cleanPhone;
    if (note)      body.note          = note;
    if (address?.street) {
      body.address = {
        address_line_1: address.street,
        address_line_2: address.line2 || undefined,
        locality:       address.city,
        administrative_district_level_1: address.state || undefined,
        postal_code:    address.zip   || undefined,
        country:        'US',
      };
    }
    const resp = await axios.post(`${SQUARE_BASE}/customers`, body, { headers: squareHeaders() });
    return resp.data?.customer || null;
  } catch (err) {
    console.error('Square customer create failed:', err.response?.data || err.message);
    return null;
  }
}

async function createSquareBooking({
  locationId,
  startAt,
  customerId,
  teamMemberId,
  lineItems,
  catalogInfo,
  address,
  durationMinutes,
  customerNote,
  idempotencyKey,
}) {
  try {
    // Build an appointment segment for every bookable service variation.
    const segments = [];

    for (const item of lineItems || []) {
      const info = catalogInfo?.[item.catalog_object_id];
      if (!item.catalog_object_id) {
        continue;
      }
      if (info?.bookable) {
        const seg = {
          team_member_id: teamMemberId,
          service_variation_id: item.catalog_object_id,
          service_variation_version: info.version,
        };
        // Use catalog service_duration (ms → minutes) if available
        if (info.durationMs) {
          seg.duration_minutes = Math.round(info.durationMs / 60000);
        }
        segments.push(seg);
        console.log(`  📅 Segment: ${item.label || item.catalog_object_id} (${seg.duration_minutes || '?'}min)`);
      } else {
        console.log(`  ↩ Ignoring non-bookable item: ${item.label || item.catalog_object_id}`);
      }
    }

    // Fallback: if no bookable segments found, create a bare segment
    if (segments.length === 0) {
      segments.push({
        team_member_id: teamMemberId,
        duration_minutes: durationMinutes ? Math.round(Number(durationMinutes)) : 120,
      });
      console.log('  ⚠ No bookable items — using bare segment');
    }

    const booking = {
      location_id:          locationId,
      start_at:             startAt,
      customer_id:          customerId,
      location_type:        'CUSTOMER_LOCATION',
      appointment_segments: segments,
    };
    if (address?.street) {
      booking.address = {
        address_line_1: address.street,
        address_line_2: address.line2 || undefined,
        locality:       address.city,
        administrative_district_level_1: address.state || undefined,
        postal_code:    address.zip   || undefined,
      };
    }
    if (customerNote) booking.customer_note = customerNote;

    console.log(`Square booking: ${segments.length} segment(s)`);
    console.log('Square booking request:', JSON.stringify({ idempotency_key: idempotencyKey, booking }, null, 2));

    const resp = await axios.post(
      `${SQUARE_BASE}/bookings`,
      { idempotency_key: idempotencyKey, booking },
      { headers: squareHeaders() }
    );
    return { booking: resp.data?.booking || null, error: null };
  } catch (err) {
    const errors = err.response?.data?.errors || [];
    const errSummary = errors.map(e => `${e.code}: ${e.detail} (field: ${e.field || 'n/a'})`).join('; ')
      || err.response?.data
      || err.message;
    console.error('Square booking create failed:', JSON.stringify(err.response?.data || err.message));
    return { booking: null, error: typeof errSummary === 'string' ? errSummary : JSON.stringify(errSummary) };
  }
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.query.secret || req.headers['x-webhook-secret'];
  if (!process.env.ZENBOOKER_WEBHOOK_SECRET) {
    console.error('ZENBOOKER_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  if (secret !== process.env.ZENBOOKER_WEBHOOK_SECRET) {
    console.warn('Webhook auth failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;

  // Log top-level keys + condensed payload (avoid Vercel log truncation)
  console.log('=== ZENBOOKER → SQUARE WEBHOOK ===');
  console.log('Top-level keys:', Object.keys(payload || {}));
  const dataKeys = payload?.data ? Object.keys(payload.data) : [];
  console.log('data keys:', dataKeys);
  console.log('Payload (condensed):', JSON.stringify({
    type: payload?.type,
    id: payload?.id || payload?.data?.id,
    customer_email: payload?.data?.customer?.email || payload?.customer?.email,
    service_name: payload?.data?.service_name || payload?.service_name,
    service_address: payload?.data?.service_address || payload?.service_address,
    assigned_providers: (payload?.data?.assigned_providers || payload?.assigned_providers || []).map(p => p.name),
    estimated_duration_seconds: payload?.data?.estimated_duration_seconds || payload?.estimated_duration_seconds,
    start_date: payload?.data?.start_date || payload?.start_date,
    service_fields_count: (
      payload?.data?.service_fields
      || payload?.service_fields
      || payload?.data?.services?.[0]?.service_selections
      || payload?.services?.[0]?.service_selections
      || []
    ).length,
  }));

  try {
    const jobId        = resolveField(payload, FIELD_MAP.jobId);
    const eventType    = resolveField(payload, FIELD_MAP.eventType);
    const email        = resolveField(payload, FIELD_MAP.customerEmail);
    const phone        = resolveField(payload, FIELD_MAP.customerPhone);
    const totalAmount  = resolveField(payload, FIELD_MAP.totalAmount);
    const scheduledAt  = resolveField(payload, FIELD_MAP.scheduledAt);
    const rawNotes     = resolveField(payload, FIELD_MAP.notes);
    // job_notes may be array of strings or a plain string
    const notes = Array.isArray(rawNotes) ? rawNotes.join(' | ') : (rawNotes || null);
    const serviceName  = resolveField(payload, FIELD_MAP.serviceName) || '';
    const rawOptions   = resolveField(payload, FIELD_MAP.lineItems);
    const jobStreet    = resolveField(payload, FIELD_MAP.jobStreet);
    const jobLine2     = resolveField(payload, FIELD_MAP.jobLine2);
    const jobCity      = resolveField(payload, FIELD_MAP.jobCity);
    const jobState     = resolveField(payload, FIELD_MAP.jobState);
    const jobZip       = resolveField(payload, FIELD_MAP.jobZip);

    // Duration: ZenBooker sends estimated_duration_seconds — convert to minutes
    const rawDuration  = resolveField(payload, FIELD_MAP.jobDuration);
    const jobDuration  = rawDuration
      ? (rawDuration > 300 ? Math.round(rawDuration / 60) : Math.round(rawDuration))
      : null;

    let firstName = resolveField(payload, FIELD_MAP.customerFirstName);
    let lastName  = resolveField(payload, FIELD_MAP.customerLastName);
    if (!firstName && !lastName) {
      const s = splitName(resolveField(payload, FIELD_MAP.customerName));
      firstName = s.firstName; lastName = s.lastName;
    }

    // Provider: ZenBooker sends assigned_providers[] array — take first entry
    const rawProviders = resolveField(payload, FIELD_MAP.providerList);
    const providerName = (Array.isArray(rawProviders) && rawProviders[0]?.name)
      || resolveField(payload, FIELD_MAP.providerName)
      || null;
    const providerEmail = (Array.isArray(rawProviders) && rawProviders[0]?.email)
      || resolveField(payload, FIELD_MAP.providerEmail)
      || null;

    const { fieldSelections, optionSelections } = extractServiceFieldSelections(rawOptions);

    // Technician lookup / fallback
    const {
      techSquareId,
      resolvedProviderName,
      assignmentMode,
    } = resolveTechAssignment(providerName);

    console.log('Extracted:', {
      jobId, eventType, serviceName,
      email:        email     ? `${email.slice(0,3)}***`   : null,
      phone:        phone     ? `***${phone.slice(-4)}`    : null,
      firstName:    firstName ? `${firstName[0]}***`       : null,
      scheduledAt, totalAmount,
      providerName, resolvedProviderName, techSquareId, assignmentMode,
      jobStreet, jobCity, jobState, jobZip, jobDuration,
      fieldCount: fieldSelections.length,
      optionCount: optionSelections.length,
      options: optionSelections.map((selection) => (
        selection.quantity > 1 ? `${selection.label} x${selection.quantity}` : selection.label
      )),
    });

    if (!email && !phone) {
      return res.status(200).json({ skipped: true, reason: 'No customer email or phone' });
    }

    // ── STEP 1: Find or create Square customer ────────────────────────────────
    let existingCustomer = email ? await findSquareCustomer(email) : null;
    let customer = existingCustomer;
    if (customer) {
      console.log(`Square customer found: ${customer.id}`);
    } else {
      const note = [
        'Booked via ZenBooker',
        scheduledAt  ? `Appt: ${scheduledAt}`     : null,
        jobId        ? `Job: ${jobId}`             : null,
        resolvedProviderName ? `Tech: ${resolvedProviderName}` : null,
      ].filter(Boolean).join(' | ');
      customer = await createSquareCustomer({ firstName, lastName, email, phone, note, address: { street: jobStreet, line2: jobLine2, city: jobCity, state: jobState, zip: jobZip } });
      console.log(customer ? `Square customer created: ${customer.id}` : 'Customer creation FAILED');
    }

    // Build line items once — used by both booking and order
    const {
      lineItems,
      unknownOptions,
      unknownService,
      effectiveServiceName,
    } = buildLineItems(serviceName, optionSelections);
    const normalizedJob = normalizeZenbookerJob({
      jobId,
      serviceName: effectiveServiceName || serviceName,
      providerName: resolvedProviderName,
      fieldSelections,
      unknownOptions,
    });
    const primaryVariationId = lineItems[0]?.catalog_object_id || null;

    console.log('Normalized job:', JSON.stringify({
      jobId: normalizedJob.jobId,
      serviceName: normalizedJob.serviceName,
      providerName: normalizedJob.providerName,
      tvCount: normalizedJob.tvCount,
      tvUnits: normalizedJob.tvUnits.map((tvUnit) => ({
        ordinal: tvUnit.ordinal,
        summary: tvUnit.summary,
      })),
      additionalSelections: normalizedJob.additionalSelections,
      unknownOptions: normalizedJob.unknownOptions,
    }, null, 2));

    // ── STEP 2: Create Square appointment (calendar / tech scheduling) ────────
    let booking = null;
    let bookingSkipReason = null;
    let bookingError = null;
    const startAt = parseScheduledAt(scheduledAt);

    if (!customer?.id) {
      bookingSkipReason = 'No Square customer ID';
    } else if (!techSquareId) {
      bookingSkipReason = `Tech not mapped: "${providerName}"`;
    } else if (!startAt) {
      bookingSkipReason = `Invalid scheduledAt: "${scheduledAt}"`;
    } else if (!jobStreet || !jobCity) {
      bookingSkipReason = `No service address (street: ${jobStreet || 'null'}, city: ${jobCity || 'null'})`;
    } else if (!primaryVariationId) {
      bookingSkipReason = `No variation ID for service: "${serviceName}"`;
    } else {
      // Fetch catalog info for all variation IDs (version, bookable status, duration)
      const variationIds = lineItems.map(li => li.catalog_object_id).filter(Boolean);
      const catalogInfo = await fetchCatalogInfo(variationIds);
      console.log('Catalog info:', JSON.stringify(catalogInfo));

      const result = await createSquareBooking({
        locationId:      LOCATION_ID,
        startAt,
        customerId:      customer.id,
        teamMemberId:    techSquareId,
        lineItems,
        catalogInfo,
        address:         { street: jobStreet, line2: jobLine2, city: jobCity, state: jobState, zip: jobZip },
        durationMinutes: jobDuration || null,
        customerNote:    notes   || undefined,
        idempotencyKey:  `zb-${jobId}`,
      });
      booking = result?.booking || result;
      bookingError = result?.error || null;
      console.log(booking?.id ? `Square booking created: ${booking.id}` : `Booking creation FAILED: ${bookingError || 'unknown'}`);
    }
    if (bookingSkipReason) console.warn(`Skipping booking — ${bookingSkipReason}`);

    // Always 200 to prevent ZenBooker retries
    return res.status(200).json({
      processed:        true,
      jobId,
      squareCustomerId: customer?.id   || null,
      customerCreated:  !existingCustomer,
      squareBookingId:  booking?.id    || null,
      bookingCreated:   !!booking?.id,
      bookingSkipReason,
      bookingError,
      techMatched:      !!techSquareId,
      techName:         resolvedProviderName || null,
      techAssignmentMode: assignmentMode,
      normalizedTvCount: normalizedJob.tvCount,
    });

  } catch (err) {
    console.error('ZenBooker→Square error:', err.message, err.stack);
    return res.status(200).json({ processed: false, error: err.message });
  }
}
