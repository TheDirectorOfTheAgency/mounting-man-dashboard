// lib/install-post-locations.mjs
//
// City → Webflow location item + metro area for install-post seeds.
//
// Rows mirror cloud/install-post-runner/references/location-ids.md (MN, with
// metro areas) and the Houston-area item_ids in location-slugs.json (TX, no
// metro-area option). tests/install-post-locations.test.mjs fails if either
// reference drifts from these tables. Exact city match only: a near miss is an
// unknown city, never a guessed neighbour.

const MN_LOCATIONS = [
  ['Afton', '69755520332be77d9139234c', 'East Metro'],
  ['Anoka', '6975585ea160037d2ae647c3', 'North Metro'],
  ['Apple Valley', '6975547cba8cb205bd691d25', 'South Metro'],
  ['Arden Hills', '697555ae51dfbb8e6af2d41c', 'North Metro'],
  ['Blaine', '6975584de27d1e5ec92ab2f4', 'North Metro'],
  ['Bloomington', '69753dbe13f6f68b8e6092d3', 'South Metro'],
  ['Brooklyn Center', '69753f27e71a8d0dc5ec4993', 'North Metro'],
  ['Brooklyn Park', '69753f1e51dfbb8e6aef28f9', 'North Metro'],
  ['Burnsville', '69755473c822789f48fd5d61', 'South Metro'],
  ['Centerville', '697558be538e16c3efced850', 'North Metro'],
  ['Champlin', '69755866e27d1e5ec92ac363', 'North Metro'],
  ['Chanhassen', '69753e09ae02659ef01b60ff', 'West Metro'],
  ['Chaska', '69753e33de6de09edc3a32b8', 'West Metro'],
  ['Circle Pines', '697558aee27d1e5ec92af0eb', 'North Metro'],
  ['Columbia Heights', '69755838538e16c3efcec2d7', 'North Metro'],
  ['Coon Rapids', '6975585577a46b93a08538a2', 'North Metro'],
  ['Corcoran', '6976b94758452744285534cd', 'North Metro'],
  ['Cottage Grove', '6975553b51dfbb8e6af2cde9', 'East Metro'],
  ['Crystal', '69753f393f7593d21cf10a94', 'North Metro'],
  ['Dayton', '6975586fe27d1e5ec92aca78', 'North Metro'],
  ['Deephaven', '69753e52e71a8d0dc5ec1239', 'West Metro'],
  ['Dellwood', '69755561538e16c3efcdd7a8', 'East Metro'],
  ['Eagan', '69753e8fe27d1e5ec9251755', 'South Metro'],
  ['Eden Prairie', '69753d794476545a9655d476', 'West Metro'],
  ['Edina', '69753d44705aef6b38415bc8', 'South Metro'],
  ['Elko New Market', '697554a10f8b72f2c61d6ee9', 'South Metro'],
  ['Excelsior', '69753e664476545a96564a68', 'West Metro'],
  ['Falcon Heights', '697555e21e09c224b786cb23', 'North Metro'],
  ['Farmington', '697554997b8e24e2830ca902', 'South Metro'],
  ['Forest Lake', '697558d53ff188cbbd8b0a30', 'North Metro'],
  ['Fridley', '697555f2180a049e822a4249', 'North Metro'],
  ['Golden Valley', '69753da813f6f68b8e608c89', 'West Metro'],
  ['Greenwood', '69753f60506f3f44d48653eb', 'West Metro'],
  ['Ham Lake', '697558cd26b88fe8a794fe4d', 'North Metro'],
  ['Hastings', '69bb643abcff0dfc4b42758a', 'East Metro'],
  ['Hopkins', '69753d64ae02659ef01ae070', 'West Metro'],
  ['Hugo', '69c7489a3104062c1ce79506', 'East Metro'],
  ['Independence', '69755447cf48f95b582c5431', 'West Metro'],
  ['Inver Grove Heights', '697554b677a46b93a08491b9', 'South Metro'],
  ['Lake Elmo', '6975550051dfbb8e6af2b574', 'East Metro'],
  ['Lakeville', '69755486d3a1cd94d908f559', 'South Metro'],
  ['Lauderdale', '697555eae27d1e5ec9291597', 'North Metro'],
  ['Lilydale', '697554d2ae7d0b6c9db8e203', 'South Metro'],
  ['Lino Lakes', '697558b630fbcf10bd0d82fb', 'North Metro'],
  ['Little Canada', '69755577180a049e822a1254', 'North Metro'],
  ['Long Lake', '69755450786657c02e752493', 'West Metro'],
  ['Mahtomedi', '6975555813b041d96154c351', 'East Metro'],
  ['Maple Grove', '69753d8c144971a9951a9f27', 'North Metro'],
  ['Maple Plain', '69755887332be77d913994d9', 'West Metro'],
  ['Maplewood', '697554eec822789f48fd9315', 'East Metro'],
  ['Medina', '69753f4c506f3f44d486424f', 'West Metro'],
  ['Mendota Heights', '697554aa0f8b72f2c61d71ba', 'South Metro'],
  ['Minneapolis', '69753d27de6de09edc399df3', 'Twin Cities'],
  ['Minnetonka', '69753d6fde6de09edc39c51a', 'West Metro'],
  ['Minnetrista', '6975543e332be77d9138e05f', 'West Metro'],
  ['Mound', '69753f734e38623fe27d49aa', 'West Metro'],
  ['Mounds View', '69755899332be77d913999ef', 'North Metro'],
  ['New Brighton', '697558a5e27d1e5ec92aea8a', 'North Metro'],
  ['New Hope', '69753f314e38623fe27d4047', 'North Metro'],
  ['Newport', '69755546786657c02e7579b9', 'East Metro'],
  ['North St. Paul', '69755569144971a99520c6b5', 'East Metro'],
  ['Oakdale', '697554f877a46b93a084aaca', 'East Metro'],
  ['Orono', '69753d833fc97c73539d5109', 'West Metro'],
  ['Osseo', '6975587fde6de09edc3f030e', 'North Metro'],
  ['Plymouth', '69753d96506f3f44d485b74b', 'West Metro'],
  ['Prior Lake', '69753f7b7b8e24e28307c7df', 'South Metro'],
  ['Richfield', '69753dd13fc97c73539d7a2a', 'South Metro'],
  ['Robbinsdale', '69753f42947bb9fb60f0436e', 'North Metro'],
  ['Rogers', '697558769b4fe0a35f350090', 'North Metro'],
  ['Rosemount', '69755491786657c02e753298', 'South Metro'],
  ['Roseville', '697555d97b8e24e2830d7298', 'North Metro'],
  ['Savage', '6975546b26b88fe8a7948905', 'South Metro'],
  ['Shakopee', '69753e40ba8cb205bd6561c0', 'South Metro'],
  ['Shoreview', '697555a5e81c50bff6b9aa29', 'North Metro'],
  ['Shorewood', '69753e4a7b8e24e283074f60', 'West Metro'],
  ['South St. Paul', '697554c0332be77d91391d6b', 'South Metro'],
  ['Spring Lake Park', '6975584302f3ba9bdb8c08be', 'North Metro'],
  ['Spring Park', '69753f6a506f3f44d4865aec', 'West Metro'],
  ['St Michael', '69c6a2b2a606a59852b37d1e', ''],
  ['St. Anthony', '6975589177a46b93a0853c7f', 'North Metro'],
  ['St. Louis Park', '69753dc87b8e24e283073129', 'West Metro'],
  ['St. Paul', '69753d31e27d1e5ec924da12', 'East Metro'],
  ['St. Paul Park', '697555503ff188cbbd89e289', 'East Metro'],
  ['Stillwater', '697555189b4fe0a35f3465c4', 'East Metro'],
  ['Sunfish Lake', '697554db7b8e24e2830cceaa', 'South Metro'],
  ['Tonka Bay', '69753f577b8e24e28307ad65', 'West Metro'],
  ['Vadnais Heights', '6975558ee808f6aa0ff9d9a8', 'North Metro'],
  ['Victoria', '6975545913f6f68b8e65f1e2', 'West Metro'],
  ['Waconia', '697554621e09c224b7863d47', 'West Metro'],
  ['Wayzata', '69753d4ee27d1e5ec924df7f', 'West Metro'],
  ['West St. Paul', '697554c9cf48f95b582c8de1', 'South Metro'],
  ['White Bear Lake', '69753e00e92e5d5f06e0e0f4', 'East Metro'],
  ['Woodbury', '69753dda506f3f44d485cfc8', 'East Metro'],
  ['Woodland', '697554350f8b72f2c61d4a79', 'West Metro'],
];

const TX_LOCATIONS = [
  ['Afton Oaks', '697cc153f89ca065a24d9e17'],
  ['Aldine', '697cc63660c550782742d823'],
  ['Alief', '697c2d86191537be67a8013a'],
  ['Alvin', '697cbf250ef13dc6f0822043'],
  ['Arcola', '697cc285f3417bed00e34633'],
  ['Atascocita', '697c2e543ff5a5060b861923'],
  ['Baytown', '697c2e543ff5a5060b86192a'],
  ['Bellaire', '697be33dfef54091be68724b'],
  ['Bellaire Triangle', '697c2e7b2106598d4229a7bf'],
  ['Braeburn', '697cc162e39b99e762c0d16a'],
  ['Braeswood Place', '697cbf3daa399a5b2502ebbd'],
  ['Briarforest', '697cbf3daa399a5b2502ebc4'],
  ['Bunker Hill Village', '697cc142a4c77be63f06bd1a'],
  ['Champions', '697cbf0c22e8bb96f9951bf0'],
  ['Channelview', '697cc225d85f8d6f4a10677c'],
  ['Chinatown Houston', '697c2d86191537be67a80148'],
  ['Cinco Ranch', '697c2e7b2106598d4229a7aa'],
  ['Clear Lake', '697be4ffb95671cb4da75711'],
  ['Cloverleaf', '697cc649e103d5537264549f'],
  ['Conroe', '697c2e543ff5a5060b861915'],
  ['Copperfield', '697cc196e39b99e762c0effa'],
  ['Crosby', '697cc196e39b99e762c0f00f'],
  ['Cypress', '697be40a18ffecaa05f46bc8'],
  ['Deer Park', '697cbf250ef13dc6f0822035'],
  ['Dickinson', '697cc24fe39b99e762c151c6'],
  ['Downtown Houston', '697c2d5d62610bf49fe95a69'],
  ['EaDo', '697c2d5d62610bf49fe95a62'],
  ['Eagle Springs', '697cc225d85f8d6f4a106775'],
  ['El Lago', '697cc239b10d4097c95e926e'],
  ['Energy Corridor', '697c2e7b2106598d4229a7c6'],
  ['Fairfield', '697cc196e39b99e762c0f001'],
  ['Fall Creek', '697cc225d85f8d6f4a10676e'],
  ['First Colony', '697cc4d41622d8bd3e115e60'],
  ['Fondren Southwest', '697cc162e39b99e762c0d163'],
  ['Fresno', '697cc285f3417bed00e34625'],
  ['Friendswood', '697be3adfef54091be68e22e'],
  ['Fulshear', '697cbf3daa399a5b2502ebaf'],
  ['Galena Park', '697cc627155a20f71330ba72'],
  ['Galleria', '697c2d2d2b9ef66e78bb350f'],
  ['Garden Oaks', '697c2e7b2106598d4229a7b8'],
  ['Gleannloch Farms', '697cc2075af9d6139bc9bd71'],
  ['Greater Heights', '697c2d5d62610bf49fe95a70'],
  ['Greatwood', '697cc29123e5eabbfc4d4342'],
  ['Greenspoint', '697cc649e103d553726454a6'],
  ['Greenway Plaza', '697c2d86191537be67a8014f'],
  ['Gulfton', '697cc153f89ca065a24d9e1e'],
  ['Hedwig Village', '697cc142a4c77be63f06bd21'],
  ['Highlands', '697cc63660c550782742d815'],
  ['Houston Heights', '697c2d2d2b9ef66e78bb3501'],
  ['Humble', '697be4a5f90a0f8fb6d4f200'],
  ['Hunters Creek Village', '697cc142a4c77be63f06bd28'],
  ['Independence Heights', '697cc6633b3f1d6cae20433e'],
  ['Iowa Colony', '697cc26d8d09f41125d6ed40'],
  ['Jacinto City', '697cc627155a20f71330ba6b'],
  ['Jersey Village', '697c2e3062610bf49fea1aec'],
  ['Kashmere Gardens', '697cc6633b3f1d6cae204345'],
  ['Katy', '697be372cde90a7d2f22b82f'],
  ['Kemah', '697cbf250ef13dc6f0822027'],
  ['Kingwood', '697be3dfd3ebbc782449ee8f'],
  ['Klein', '697cbf3daa399a5b2502ebcb'],
  ['La Marque', '697cc26d8d09f41125d6ed32'],
  ['La Porte', '697cbf250ef13dc6f082202e'],
  ['League City', '697be4bd863466355ae59a41'],
  ['Magnolia', '697c2e543ff5a5060b86191c'],
  ['Manvel', '697cbf250ef13dc6f082203c'],
  ['Medical Center', '697c2d2d2b9ef66e78bb3516'],
  ['Memorial', '697be30049a2a519c7752fc4'],
  ['Memorial City', '697cc649e103d553726454ad'],
  ['Meyerland', '697c2e0976c4be78fb68325a'],
  ['Midtown Houston', '697c2d2d2b9ef66e78bb3508'],
  ['Missouri City', '697be3c749a2a519c7757019'],
  ['Mont Belvieu', '697cc239b10d4097c95e9260'],
  ['Montrose', '697c2d2d2b9ef66e78bb34fa'],
  ['Museum District', '697cbef44c1428ae1fe9491f'],
  ['Nassau Bay', '697cc239b10d4097c95e9267'],
  ['Near Northside', '697c2e0976c4be78fb68326f'],
  ['New Caney', '697cc1825af9d6139bc96259'],
  ['New Territory', '697cc29123e5eabbfc4d4349'],
  ['Northline', '697cc6878d3d37f763e01deb'],
  ['Oak Forest', '697c2e7b2106598d4229a7b1'],
  ['Oak Ridge North', '697cc1731622d8bd3e108f77'],
  ['Pasadena', '697c2e3062610bf49fea1ad0'],
  ['Pearland', '697be389101608c10bb5379d'],
  ['Pecan Grove', '697cc4d41622d8bd3e115e67'],
  ['Piney Point Village', '697cc1311622d8bd3e107670'],
  ['Porter', '697cc1825af9d6139bc96252'],
  ['Post Oak', '697cc1731622d8bd3e108f69'],
  ['Rice Village', '697c2d5d62610bf49fe95a5b'],
  ['Richmond', '697be4534a5e689b5b27893f'],
  ['River Oaks', '697be2e50afe4cdac8a3a1bb'],
  ['Rosenberg', '697c2e543ff5a5060b861931'],
  ['Santa Fe', '697cc26d8d09f41125d6ed39'],
  ['Seabrook', '697cbf0c22e8bb96f9951c05'],
  ['Sharpstown', '697c2d5d62610bf49fe95a77'],
  ['Shenandoah', '697cc1731622d8bd3e108f70'],
  ['Shoreacres', '697cc63660c550782742d81c'],
  ['Sienna', '697cc285f3417bed00e3462c'],
  ['South Houston', '697cc627155a20f71330ba64'],
  ['Southside Place', '697c2e0976c4be78fb683261'],
  ['Spring', '697be46dfef54091be699f30'],
  ['Spring Branch', '697cbef44c1428ae1fe94903'],
  ['Spring Valley Village', '697cc153f89ca065a24d9e10'],
  ['Stafford', '697c2e3062610bf49fea1ade'],
  ['Sugar Land', '697be35202a5b243359676d1'],
  ['Summerwood', '697cc2075af9d6139bc9bd78'],
  ['Tanglewood', '697be32724ba025a9c527ee4'],
  ['Taylor Lake Village', '697cc24fe39b99e762c151bf'],
  ['Texas City', '697cc24fe39b99e762c151cd'],
  ['The Woodlands', '697be2f32a6feb5338f3aa4b'],
  ['Third Ward', '697c2e0976c4be78fb683268'],
  ['Timbergrove', '697cc6633b3f1d6cae204337'],
  ['Tomball', '697be4232a6feb5338f411b2'],
  ['Upper Kirby', '697c2d86191537be67a80156'],
  ['Vintage Park', '697cc196e39b99e762c0f008'],
  ['Washington Avenue', '697c2e0976c4be78fb683253'],
  ['Webster', '697c2e3062610bf49fea1ad7'],
  ['West University Place', '697be30f327026f82f6aa4e3'],
  ['Westbury', '697cbf3daa399a5b2502ebb6'],
  ['Westchase', '697c2d86191537be67a80141'],
  ['Weston Lakes', '697cc4d41622d8bd3e115e6e'],
  ['Willis', '697cc1825af9d6139bc96260'],
  ['Willow Meadows', '697cc162e39b99e762c0d171'],
  ['Willowbrook', '697cbf0c22e8bb96f9951bf7'],
];

const STATE_NAMES = Object.freeze({ minnesota: 'MN', texas: 'TX' });

export function locationCityKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/\bsaint\s+/g, 'st ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stateCode(value) {
  const text = String(value || '').trim().replace(/\./g, '').toLowerCase();
  if (!text) return '';
  return STATE_NAMES[text] || text.toUpperCase();
}

const BY_CITY = new Map();
for (const [city, locationId, metroArea] of MN_LOCATIONS) {
  BY_CITY.set(locationCityKey(city), Object.freeze({ city, locationId, metroArea, state: 'MN' }));
}
for (const [city, locationId] of TX_LOCATIONS) {
  BY_CITY.set(locationCityKey(city), Object.freeze({ city, locationId, metroArea: '', state: 'TX' }));
}

export const INSTALL_POST_LOCATIONS = Object.freeze([...BY_CITY.values()]);

/**
 * The location row for a staged city, or null when the city is not a known
 * service location. A seed state that disagrees with the row's state (an
 * Austin or Wisconsin job with a same-named city) is also unknown.
 */
export function lookupInstallLocation(city, { state } = {}) {
  const row = BY_CITY.get(locationCityKey(city));
  if (!row) return null;
  const code = stateCode(state);
  if (code && code !== row.state) return null;
  return row;
}

/** Seed `location-id` / `metro-area` for a city; blank strings when unknown. */
export function installLocationSeedFields(city, { state } = {}) {
  const row = lookupInstallLocation(city, { state });
  return {
    'location-id': row ? row.locationId : '',
    'metro-area': row ? row.metroArea : '',
  };
}
