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
  ],

  // Selected options — ZenBooker sends as service_fields array with selected_options
  // Extraction handled specially below (service_fields[n].selected_options[m].text)
  lineItems: [
    'data.service_fields', 'service_fields',
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

// ============================================================================
// OPTION MAP — Reserved for Phase 2: Square Appointments
// ZenBooker selected option name → Square catalog VARIATION ID (direct lookup)
// Options that are just TV size (handled by MAIN_SERVICE_MAP above) are excluded.
// Options with "no/none" meaning are excluded (handled by isNoSelection).
// ============================================================================
const OPTION_MAP = {

  // ── Wall mount / bracket items (REGULAR, taxable in MN) ──────────────────
  // Square category: "TV Mounting – ZenBooker (Items)" (A2OMV7PZ725T6Z44YPOEOUTM)
  'Fixed Bracket':                                       '55AH2PEGDHUA4QSUCP5FEEPS', // Fixed Mounting Bracket $50
  'Fixed':                                               '55AH2PEGDHUA4QSUCP5FEEPS',
  'Standard Tilt Mount (For Up to 86" TVs)':             'L2A7RYGRBNHFHXGBU6PACVWA', // Standard Tilt Bracket $75
  'Tilting':                                             'L2A7RYGRBNHFHXGBU6PACVWA',
  'Buy Tilt TV Mounting Bracket':                        'L2A7RYGRBNHFHXGBU6PACVWA',
  '98" -  100" TV Tilt Bracket':                        'L2A7RYGRBNHFHXGBU6PACVWA',
  'Standard Full Motion Mount (For up to 86" TVs)':      'D247N27TKKKR76EQBMZQZK3M', // Standard Full Motion Bracket $100
  'Full Motion':                                         'D247N27TKKKR76EQBMZQZK3M',
  'Buy Full Motion (Articulating) TV Mounting Bracket':  'D247N27TKKKR76EQBMZQZK3M',
  'Corner Mounting Bracket':                             'D247N27TKKKR76EQBMZQZK3M', // closest match
  'Flush Mounting Bracket':                              'DBOM6BP4K3P5TLOAJ3NNM3RM', // Flush Mounting Bracket $135
  'Premium 4D Tilt Mount':                               'HFVX6IJLPWDRRTN2JKOY4SZZ', // Premium 4D Tilt Bracket $100
  'Premium Tilt Mounting Bracket':                       'DND3X262IGHVDL6LX3RCMTMF', // Premium Tilt Bracket $200
  'Premium Full Motion Mounting Bracket':                '57WCFYOYU6BFIZLZ2DWUF2HY', // Premium Full Motion Bracket $200
  'Premium Full Motion Mounting Bracket (Special)':      '57WCFYOYU6BFIZLZ2DWUF2HY',

  // ── Soundbar labor (APPOINTMENTS_SERVICE, not taxed) ─────────────────────
  // Square item: "Soundbar Mounting – Labor" (PFVBZCBVBGMAGZDGJLHVQET4)
  'Yes I Need A Sound Bar Mounted':                      'HVB2FXY7J4DCLUFANSXPFD5K', // 1 Soundbar $100
  'I Need One Sound Bar Mounted':                        'HVB2FXY7J4DCLUFANSXPFD5K',
  'Mount Sound Bar':                                     'HVB2FXY7J4DCLUFANSXPFD5K',
  'Mount Soundbar':                                      'HVB2FXY7J4DCLUFANSXPFD5K',
  'Mount Soundbar ':                                     'HVB2FXY7J4DCLUFANSXPFD5K', // trailing space variant
  'I Need Two Sound Bars Mounted':                       '7HOG7EI2MG6OILS3MAHXX25M', // 2 Soundbars $200

  // ── Soundbar brackets (REGULAR, taxable in MN) ───────────────────────────
  // Square items: "Soundbar Mounting Bracket" / "Premium Soundbar Mounting Bracket"
  'Soundbar Mounting Bracket':                           'KUMC7O6HO5DST6JBLJIVBUHF', // $50
  'Buy Sound Bar Mounting Bracket':                      'KUMC7O6HO5DST6JBLJIVBUHF',
  'Yes - Give me a standard sound bar mounting bracket.':'KUMC7O6HO5DST6JBLJIVBUHF',
  'Purchase Soundbar Mounting Bracket':                  'KUMC7O6HO5DST6JBLJIVBUHF',
  'Yes - Give me a premium sound bar mounting bracket.': 'QHUSXQ26RPN4RTA4XYFZ72CM', // Premium Soundbar Bracket $100

  // ── Soundbar cord concealing (maps to exterior concealing service) ────────
  'Conceal Sound Bar Cords As Well':                     'IWQQAUULEAVV3AME5HSRB56Z', // Exterior Concealing Standard $75

  // ── In-wall cord concealing (APPOINTMENTS_SERVICE) ───────────────────────
  // Square item: "Cord Concealing – In-Wall" (WTOJ5OLNW7MULFPYRNQW56F3)
  'In-Wall Concealing (And Install An Outlet Behind TV)':                              'UNHHA5ESDCV7JUDH5EMHIFVZ', // Drywall + Outlet $250
  'Install New Outlet & Hide Cords In Wall':                                           'UNHHA5ESDCV7JUDH5EMHIFVZ',
  'In-Wall Concealing (Drywall)':                                                      '3CARZMA4DWQROXSRPWJRCO3L', // Drywall $250
  'In Wall Cord Concealing Through Drywall Fireplace Cavity':                          'DM5VQTXV456O7QKI6KHVTDWG', // Through Fireplace $350
  'In Wall Cord Concealing Through Drywall Fireplace':                                 'DM5VQTXV456O7QKI6KHVTDWG',
  'In Wall Cord Concealing Through Plaster Fireplace':                                 'DM5VQTXV456O7QKI6KHVTDWG',
  'In-Wall Concealing Through A Fireplace (Drywall Exterior) And Install An Outlet Behind TV': 'DM5VQTXV456O7QKI6KHVTDWG',
  'In-Wall Concealing Through A Fireplace (Drywall) And Install An Outlet Behind TV':  'DM5VQTXV456O7QKI6KHVTDWG',
  'In-Wall Concealing Through Brick Fireplace':                                        'DM5VQTXV456O7QKI6KHVTDWG',
  'In Wall Cord Concealing & Installing Outlet Through Stone Fireplace':               'DM5VQTXV456O7QKI6KHVTDWG',
  'In Wall Cord Concealing & Installing Outlet Through Brick Fireplace':               'DM5VQTXV456O7QKI6KHVTDWG',
  'In Wall Cord Concealing With Soundbar Cords':                                       'XYH7FSYYKZO6OF755ERB6BI3', // With Soundbar $300
  'Conceal Cords Through Already Existing Conduit':                                    'WHX4TXZ5SZVO4NIDBMVUUY4C', // Through Conduit $50
  'Concealing Through Existing Conduit':                                               'WHX4TXZ5SZVO4NIDBMVUUY4C',

  // ── Exterior cord concealing (APPOINTMENTS_SERVICE) ──────────────────────
  // Square item: "Cord Concealing – Exterior" (M6VI2UEOR462UOYAR43ZZZCJ)
  'Exterior Concealing (Not above fireplace.)':          'IWQQAUULEAVV3AME5HSRB56Z', // Standard $75
  'Exterior Cord Concealing (Not around fireplace.)':    'IWQQAUULEAVV3AME5HSRB56Z',
  'Exterior Concealing':                                 'IWQQAUULEAVV3AME5HSRB56Z',
  'Exterior Concealing Around A Fireplace':              'IBWPIY7NZVO4YLMB5Q5PNPKC', // Around Fireplace $125
  'Exterior Concealing Around A Brick Fireplace':        'IBWPIY7NZVO4YLMB5Q5PNPKC',
  'Exterior Cord Concealing Around Fireplace':           'IBWPIY7NZVO4YLMB5Q5PNPKC',

  // ── Recessed power bridge (APPOINTMENTS_SERVICE) ─────────────────────────
  // Square item: "Recessed Power Bridge Installation" (BJKRV645JPTTHROHCYQNKP64)
  'Recessed Power Bridge Installation':                                                'N4KBR74BGIRNIDYVSAI3YUNN', // $750
  'Recessed Outlet & Cords Concealed Through Wall':                                    'N4KBR74BGIRNIDYVSAI3YUNN',
  'Recessed Box and Electrical Outlet Installation Behind TV (Drywall)':               'N4KBR74BGIRNIDYVSAI3YUNN',
  'Recessed Box and Electrical Outlet Installation Behind TV (Plaster)':               'N4KBR74BGIRNIDYVSAI3YUNN',
  'Recessed Box Behind TV to Store Components (With Electrical)':                      'N4KBR74BGIRNIDYVSAI3YUNN',
  'Recessed Box Behind TV (Drywall) to Store Components (With Electrical)':            'N4KBR74BGIRNIDYVSAI3YUNN',
  'Recessed Box and Electrical Outlet Installation Behind TV':                         'N4KBR74BGIRNIDYVSAI3YUNN',
  'Yes - I Need the RB100 Installed':                                                  'N4KBR74BGIRNIDYVSAI3YUNN',

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

  // ── Wall surface surcharge (APPOINTMENTS_SERVICE) ────────────────────────
  // Square item: "Wall Surface Surcharge" (CDMC4GCCSNNMMC3SXUQJWKYK)
  'Plaster':                                            'VQOSFODLG5AGMD5XJ3OEWVJ3', // $50
  'Plaster Walls':                                      'VQOSFODLG5AGMD5XJ3OEWVJ3',
  'Plaster Wall':                                       'VQOSFODLG5AGMD5XJ3OEWVJ3',
  'Brick':                                              'IJI3Q75TILAX6EMMEUQZIHIE', // $100
  'Brick Walls':                                        'IJI3Q75TILAX6EMMEUQZIHIE',
  'Brick Wall':                                         'IJI3Q75TILAX6EMMEUQZIHIE',
  'Stone':                                              'OZCBEPL2WU6CUM5EOCU4ZYDC', // $150
  'Stone Wall':                                         'OZCBEPL2WU6CUM5EOCU4ZYDC',
  'Stone Walls':                                        'OZCBEPL2WU6CUM5EOCU4ZYDC',
  'Porcelain Tile':                                     '2RLFPQ6RSJXRZA2GXOAHYYTQ', // $150
  'Ceramic Tile':                                       '2RLFPQ6RSJXRZA2GXOAHYYTQ',
  'Tile Wall':                                          '2RLFPQ6RSJXRZA2GXOAHYYTQ',

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

/** Strip ZenBooker quantity prefix from option text: "1 x 75 Inches" → "75 Inches" */
function stripQuantityPrefix(text) {
  if (!text) return text;
  return text.replace(/^\d+\s*x\s+/i, '').trim();
}

/** Check if an option name represents a "none/no" selection — skip these. */
function isNoSelection(name) {
  const lower = name.toLowerCase().trim();
  return (
    lower === 'no' || lower === 'none' || lower === 'other' ||
    lower.startsWith('no ') || lower.startsWith('do not need') ||
    lower.startsWith('i have one') || lower.startsWith('i do not') ||
    lower.startsWith('no thanks') || lower.startsWith('no, ') ||
    lower.includes('only the mantel mount installation') ||
    lower.includes('just the mounting') || lower.includes('not needed')
  );
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

// ============================================================================
// BUILD LINE ITEMS — fully synchronous, zero catalog API calls
// ============================================================================

function buildLineItems(serviceName, optionNames) {
  const lineItems = [];
  const addedIds = new Set(); // prevent duplicate variation IDs

  function addVariation(variationId, label) {
    if (!variationId) return false;
    if (addedIds.has(variationId)) {
      console.log(`  ↩ Skipping duplicate variation ${variationId} (${label})`);
      return false;
    }
    addedIds.add(variationId);
    lineItems.push({ catalog_object_id: variationId, quantity: '1', label });
    console.log(`  ✓ ${label} → ${variationId}`);
    return true;
  }

  // 1) Map the top-level service → main variation (size option selects which)
  const serviceEntry = MAIN_SERVICE_MAP[serviceName];
  if (serviceEntry) {
    let chosenId = serviceEntry._default;
    for (const optName of optionNames) {
      if (serviceEntry[optName]) {
        chosenId = serviceEntry[optName];
        console.log(`  📐 Size match: "${optName}"`);
        break;
      }
    }
    addVariation(chosenId, `Service: ${serviceName}`);
  } else if (serviceName) {
    console.warn(`  ✗ Unknown service: "${serviceName}" — adding freeform`);
    lineItems.push({
      name: serviceName, quantity: '1',
      base_price_money: { amount: 0, currency: 'USD' },
    });
  }

  // 2) Map each selected option → add-on variation (skip sizes already handled)
  for (const optName of optionNames) {
    if (isNoSelection(optName)) continue;
    // Skip if this option was a service-level size selector
    if (serviceEntry?.[optName]) continue;

    const variationId = OPTION_MAP[optName];
    if (variationId) {
      addVariation(variationId, `Option: ${optName}`);
    } else {
      // Unknown option — log it and add freeform so nothing is lost
      console.warn(`  ? Unknown option: "${optName}" — adding freeform`);
      lineItems.push({
        name: optName, quantity: '1',
        base_price_money: { amount: 0, currency: 'USD' },
      });
    }
  }

  return lineItems;
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

async function createSquareCustomer({ firstName, lastName, email, phone, note }) {
  try {
    const body = {};
    if (firstName) body.given_name    = firstName;
    if (lastName)  body.family_name   = lastName;
    if (email)     body.email_address = email;
    const cleanPhone = sanitizePhone(phone);
    if (cleanPhone) body.phone_number = cleanPhone;
    if (note)      body.note          = note;
    const resp = await axios.post(`${SQUARE_BASE}/customers`, body, { headers: squareHeaders() });
    return resp.data?.customer || null;
  } catch (err) {
    console.error('Square customer create failed:', err.response?.data || err.message);
    return null;
  }
}

async function createSquareBooking({ locationId, startAt, customerId, teamMemberId, lineItems, catalogInfo, address, durationMinutes, customerNote, sellerNote, idempotencyKey }) {
  try {
    // Build an appointment segment for each bookable (APPOINTMENTS_SERVICE) item.
    // Non-bookable items (REGULAR / physical products like brackets) go in seller_note.
    const segments = [];
    const nonBookableLabels = [];

    for (const item of lineItems || []) {
      const info = catalogInfo?.[item.catalog_object_id];
      if (!item.catalog_object_id) {
        // Freeform item (no catalog ID) — include label in seller note
        if (item.name) nonBookableLabels.push(item.name);
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
        // REGULAR item (bracket/hardware) — can't be an appointment segment
        nonBookableLabels.push(item.label || item.catalog_object_id);
        console.log(`  📦 Item (non-bookable): ${item.label || item.catalog_object_id}`);
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

    // Build seller note: ZenBooker job ref + any non-bookable (taxable) items
    let finalSellerNote = sellerNote || '';
    if (nonBookableLabels.length > 0) {
      finalSellerNote += `\nItems to add (taxable): ${nonBookableLabels.join(', ')}`;
    }
    if (finalSellerNote.trim()) booking.seller_note = finalSellerNote.trim();

    console.log(`Square booking: ${segments.length} segment(s), ${nonBookableLabels.length} item(s) in note`);
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
    service_fields_count: (payload?.data?.service_fields || payload?.service_fields || []).length,
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

    // Normalise option list → array of strings
    // ZenBooker sends service_fields: [{field_name, selected_options: [{text}]}]
    const optionNames = [];
    if (Array.isArray(rawOptions)) {
      rawOptions.forEach(item => {
        // service_fields format: { field_name, selected_options: [{text, price, ...}] }
        if (item?.selected_options && Array.isArray(item.selected_options)) {
          item.selected_options.forEach(opt => {
            // Prefer display_label (clean name) over text (which has "1 x " prefix for checkboxes)
            const raw = (opt?.display_label || opt?.text || '').trim();
            const n = stripQuantityPrefix(raw); // safety fallback if display_label missing
            if (n) optionNames.push(n);
          });
        } else {
          // fallback: legacy { name, price } or string
          const n = extractOptionName(item);
          if (n) optionNames.push(n);
        }
      });
    }

    // Technician lookup
    const techSquareId = lookupTech(providerName);

    console.log('Extracted:', {
      jobId, eventType, serviceName,
      email:        email     ? `${email.slice(0,3)}***`   : null,
      phone:        phone     ? `***${phone.slice(-4)}`    : null,
      firstName:    firstName ? `${firstName[0]}***`       : null,
      scheduledAt, totalAmount,
      providerName, techSquareId,
      jobStreet, jobCity, jobState, jobZip, jobDuration,
      optionCount: optionNames.length,
      options: optionNames,
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
        providerName ? `Tech: ${providerName}`     : null,
      ].filter(Boolean).join(' | ');
      customer = await createSquareCustomer({ firstName, lastName, email, phone, note });
      console.log(customer ? `Square customer created: ${customer.id}` : 'Customer creation FAILED');
    }

    // Build line items once — used by both booking and order
    const lineItems = buildLineItems(serviceName, optionNames);
    const primaryVariationId = lineItems[0]?.catalog_object_id || null;

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
        sellerNote:      `ZenBooker Job: ${jobId}`,
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
      techName:         providerName   || null,
    });

  } catch (err) {
    console.error('ZenBooker→Square error:', err.message, err.stack);
    return res.status(200).json({ processed: false, error: err.message });
  }
}
