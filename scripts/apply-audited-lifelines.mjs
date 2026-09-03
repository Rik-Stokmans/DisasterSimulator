#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const networkPath = resolve(dataDirectory, 'transport-network.json')
const ferryPath = resolve(dataDirectory, 'transit/transit-routes-ferry.geojson')
const transportContextPaths = [
  resolve(dataDirectory, 'transport-roads.geojson'),
  resolve(dataDirectory, 'transport-rail.geojson'),
  resolve(dataDirectory, 'transport-stations.geojson'),
]

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const auditedLifelines = [
  {
    id: 'gtfs-ferry-wpd-holwerd-ameland',
    routeName: 'Holwerd - Ameland',
    from: 'GM1970',
    to: 'GM0060',
    // Generalized balancing units, deliberately not passengers, vehicles or trips.
    nominalCapacity: 60,
    supportedServices: ['mobility', 'supply'],
    audit: 'GM0060-MOB-001',
  },
  {
    id: 'gtfs-ferry-teso-den-helder-texel',
    routeName: 'TESO',
    from: 'GM0400',
    to: 'GM0448',
    // Generalized balancing units, deliberately not passengers, vehicles or trips.
    nominalCapacity: 60,
    supportedServices: ['mobility', 'supply'],
    audit: 'GM0400-FERRY-001',
    sourceUrl: 'https://www.teso.nl/afvaarttijden/',
    statusSemantics:
      'GTFS supplies feed-valid schedule geometry; the human-readable TESO page is timestamped context only. Live and scenario-time sailing, capacity, priority and future continuity remain unknown.',
  },
  {
    id: 'audited-ferry-kessel-reuver',
    routeName: 'Veerpont Kessel–Reuver',
    from: 'GM1894',
    to: 'GM0889',
    // Generalized balancing units, deliberately not passengers, vehicles or trips.
    nominalCapacity: 55,
    supportedServices: ['mobility', 'supply'],
    audit: 'GM0889-MOB-001',
    source: 'Gemeente Beesel service identity; BGT landing and connection geometry',
    sourceUrl: 'https://www.beesel.nl/inwoners/veerpont/',
    geometrySource:
      'BGT OGC API wegdeel/overbruggingsdeel, queried 2026-09-02; municipal source holders G1894/G0889',
    coordinates: [
      [6.049102665626017, 51.28785632787993],
      [6.050200000000000, 51.28849000000000],
      [6.054581496685451, 51.29007577186082],
      [6.057274762008930, 51.29064167594436],
    ],
  },
  {
    id: 'audited-ferry-bergen-vierlingsbeek',
    routeName: 'Veerpont Bergen–Vierlingsbeek',
    from: 'GM0893',
    to: 'GM1982',
    // Generalized balancing units, deliberately not passengers, vehicles or trips.
    nominalCapacity: 55,
    supportedServices: ['mobility', 'supply'],
    audit: 'GM0893-MOB-001',
    source: 'Gemeente Bergen high-water guidance; NWB ferry geometry',
    sourceUrl: 'https://www.bergen.nl/vragen-en-antwoorden',
    statusSourceUrl: 'https://www.vierlingsbeek-bergen.nl/index.php?pagina=nieuws',
    geometrySource:
      'RWS NWB OGC API wegvakken 600438076/600438081, queried 2026-09-02; municipal managers GM1982/GM0893; road type VDA',
    statusSemantics:
      'Public operator page is human-readable context only; current and scenario-time open/closed state remain unknown.',
    coordinates: [
      [6.0242837649312815, 51.597273138098736],
      [6.025164784314425, 51.59761628780036],
      [6.0261683590316215, 51.597990817031665],
    ],
  },
  {
    id: 'audited-ferry-broekhuizen-arcen',
    routeName: 'Veerpont Broekhuizen–Arcen',
    from: 'GM1507',
    to: 'GM0983',
    // Generalized balancing units, deliberately not tonnes, vehicles or trips.
    nominalCapacity: 55,
    supportedServices: ['mobility', 'supply'],
    audit: 'GM1507-MAAS-FERRIES-001',
    source: 'Kadaster TOP10NL vehicle-ferry geometry; Ton Paulus operator service identity',
    sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/broekhuizen-arcen',
    geometrySource:
      'Kadaster BRT TOP10NL OGC API wegdeel_hartlijn feature 4357b003-a3ef-5b9e-b7e2-b1cb77892f47; typeweg veerverbinding, hoofdverkeersgebruik gemengd verkeer; retrieved 2026-09-03',
    statusSourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/broekhuizen-arcen',
    statusSemantics:
      'The operator page reported a temporary urgent-repair outage when retrieved 2026-09-03, but publishes no issue time, expiry, API or update cadence. It remains timestamped context and cannot close this route at an unbound scenario T+0–T+72.',
    sourceFeatureIds: ['BRT-TOP10NL-4357b003-a3ef-5b9e-b7e2-b1cb77892f47'],
    physicalCorridorId: 'BRT-TOP10NL-ferry-broekhuizen-arcen',
    corridorIdentityStatus: 'resolved',
    operatorPhysicalLimits: {
      loadCapacityTonnes: 80,
      maxVehicleWeightTonnes: 40,
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/broekhuizen-arcen',
      retrievedAt: '2026-09-03T05:37:25Z',
      simulationEffect: 'context-only',
      note: 'Physical loading limits are not throughput and do not calibrate the 55 scenario-unit edge.',
    },
    observedOperationalStatus: {
      state: 'reported-temporarily-out-of-service',
      reason: 'urgent repair',
      publisher: 'Ton Paulus Veerbedrijf',
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/broekhuizen-arcen',
      retrievedAt: '2026-09-03T05:37:25Z',
      issueTime: null,
      validThrough: null,
      machineReadable: false,
      simulationEffect: 'context-only',
      temporalSemantics: 'Retrieval-time observation only; future continuity and scenario-time state are unknown.',
    },
    publishedScheduleContext: {
      timeZone: 'Europe/Amsterdam',
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/broekhuizen-arcen',
      retrievedAt: '2026-09-03T05:37:25Z',
      simulationEffect: 'context-only',
      periods: [
        {
          dateRange: '01 April–30 September',
          mondayToFriday: '06:30–22:00',
          saturday: '07:30–22:00',
          sundayAndHolidays: '09:00–22:00',
        },
        {
          dateRange: '01 October–31 March',
          mondayToFriday: '06:30–22:00',
          saturday: '07:30–22:00',
          sundayAndHolidays: '09:00–22:00',
        },
      ],
      note: 'Recurring published hours are context-only until scenario date, local start time, exceptions and live status are jointly resolved.',
    },
    coordinates: [
      [6.165829494570197, 51.48651252064045],
      [6.166722321301496, 51.48659881405064],
      [6.167953716139788, 51.48673349800271],
    ],
  },
  {
    id: 'audited-ferry-lottum-lomm',
    routeName: 'Veerpont Lottum–Lomm',
    from: 'GM1507',
    to: 'GM0983',
    // Generalized balancing units, deliberately not tonnes, vehicles or trips.
    nominalCapacity: 55,
    supportedServices: ['mobility', 'supply'],
    audit: 'GM1507-MAAS-FERRIES-001',
    source: 'Kadaster TOP10NL vehicle-ferry geometry; Ton Paulus operator service identity',
    sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/lottum-lomm',
    geometrySource:
      'Kadaster BRT TOP10NL OGC API wegdeel_hartlijn feature a752514d-4328-5a29-b0a7-972e080eb030; typeweg veerverbinding, hoofdverkeersgebruik gemengd verkeer; retrieved 2026-09-03',
    statusSourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/lottum-lomm',
    statusSemantics:
      'The operator page reported a temporary repair outage when retrieved 2026-09-03, but publishes no issue time, expiry, API or update cadence. It remains timestamped context and cannot close this route at an unbound scenario T+0–T+72.',
    sourceFeatureIds: ['BRT-TOP10NL-a752514d-4328-5a29-b0a7-972e080eb030'],
    physicalCorridorId: 'BRT-TOP10NL-ferry-lottum-lomm',
    corridorIdentityStatus: 'resolved',
    operatorPhysicalLimits: {
      loadCapacityTonnes: 50,
      maxVehicleWeightTonnes: 25,
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/lottum-lomm',
      retrievedAt: '2026-09-03T05:37:25Z',
      simulationEffect: 'context-only',
      note: 'Physical loading limits are not throughput and do not calibrate the 55 scenario-unit edge.',
    },
    observedOperationalStatus: {
      state: 'reported-temporarily-out-of-service',
      reason: 'repair',
      publisher: 'Ton Paulus Veerbedrijf',
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/lottum-lomm',
      retrievedAt: '2026-09-03T05:37:25Z',
      issueTime: null,
      validThrough: null,
      machineReadable: false,
      simulationEffect: 'context-only',
      temporalSemantics: 'Retrieval-time observation only; future continuity and scenario-time state are unknown.',
    },
    publishedScheduleContext: {
      timeZone: 'Europe/Amsterdam',
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/lottum-lomm',
      retrievedAt: '2026-09-03T05:37:25Z',
      simulationEffect: 'context-only',
      periods: [
        {
          dateRange: '01 April–30 September',
          mondayToFriday: '07:00–21:00',
          saturday: '09:00–21:00',
          sundayAndHolidays: '09:00–21:00',
        },
        {
          dateRange: '01 October–31 March',
          mondayToFriday: '07:00–19:00',
          saturday: '09:00–19:00',
          sundayAndHolidays: '09:00–19:00',
        },
      ],
      note: 'Recurring published hours are context-only until scenario date, local start time, exceptions and live status are jointly resolved.',
    },
    coordinates: [
      [6.17241157983427, 51.45924882979318],
      [6.173039192379165, 51.458982465747134],
      [6.173732107993351, 51.45869099212138],
      [6.174357427055665, 51.458458480004325],
    ],
  },
  {
    id: 'audited-ferry-velden-grubbenvorst',
    routeName: 'Veerpont Velden–Grubbenvorst',
    from: 'GM1507',
    to: 'GM0983',
    // Generalized balancing units, deliberately not tonnes, vehicles or trips.
    nominalCapacity: 55,
    supportedServices: ['mobility', 'supply'],
    audit: 'GM1507-MAAS-FERRIES-001',
    source: 'Kadaster TOP10NL vehicle-ferry geometry; Ton Paulus operator service identity',
    sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/velden-grubbenvorst',
    geometrySource:
      'Kadaster BRT TOP10NL OGC API wegdeel_hartlijn feature 59dcf3af-5efc-5928-86f7-e724a9760fdb; typeweg veerverbinding, hoofdverkeersgebruik gemengd verkeer; retrieved 2026-09-03',
    statusSourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/velden-grubbenvorst',
    statusSemantics:
      'The operator page reported a temporary technical-failure outage when retrieved 2026-09-03, but publishes no issue time, expiry, API or update cadence. It remains timestamped context and cannot close this route at an unbound scenario T+0–T+72.',
    sourceFeatureIds: ['BRT-TOP10NL-59dcf3af-5efc-5928-86f7-e724a9760fdb'],
    physicalCorridorId: 'BRT-TOP10NL-ferry-velden-grubbenvorst',
    corridorIdentityStatus: 'resolved',
    operatorPhysicalLimits: {
      loadCapacityTonnes: 50,
      maxVehicleWeightTonnes: 25,
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/velden-grubbenvorst',
      retrievedAt: '2026-09-03T05:37:25Z',
      simulationEffect: 'context-only',
      note: 'Physical loading limits are not throughput and do not calibrate the 55 scenario-unit edge.',
    },
    observedOperationalStatus: {
      state: 'reported-temporarily-out-of-service',
      reason: 'technical failure',
      publisher: 'Ton Paulus Veerbedrijf',
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/velden-grubbenvorst',
      retrievedAt: '2026-09-03T05:37:25Z',
      issueTime: null,
      validThrough: null,
      machineReadable: false,
      simulationEffect: 'context-only',
      temporalSemantics: 'Retrieval-time observation only; future continuity and scenario-time state are unknown.',
    },
    publishedScheduleContext: {
      timeZone: 'Europe/Amsterdam',
      sourceUrl: 'https://www.tonpaulusveerbedrijf.nl/veerdiensten/velden-grubbenvorst',
      retrievedAt: '2026-09-03T05:37:25Z',
      simulationEffect: 'context-only',
      periods: [
        {
          dateRange: '01 April–30 September',
          mondayToFriday: '07:00–21:00',
          saturday: '09:00–21:00',
          sundayAndHolidays: '09:00–21:00',
        },
        {
          dateRange: '01 October–31 March',
          mondayToFriday: '07:00–19:00',
          saturday: '09:00–19:00',
          sundayAndHolidays: '09:00–19:00',
        },
      ],
      note: 'Recurring published hours are context-only until scenario date, local start time, exceptions and live status are jointly resolved.',
    },
    coordinates: [
      [6.155950077081992, 51.41985514427759],
      [6.156671378091909, 51.41962657110755],
      [6.157960454491159, 51.419126174779855],
    ],
  },
  {
    id: 'audited-road-rijndijk-angeren-doornenburg',
    routeName: 'Rijndijk Angeren–Doornenburg',
    from: 'GM1705',
    to: 'GM1705',
    // An internal display corridor: physical existence and closure are known,
    // but no compatible scenario throughput or emergency-role state exists.
    nominalCapacity: 0,
    capacitySemantics: 'unknown',
    affectsSimulation: false,
    mode: 'local',
    supportedServices: ['mobility', 'supply'],
    audit: 'GM1705-RIJNDIJK-001',
    source: 'Rijkswaterstaat NWB geometry; Gemeente Lingewaard valid-time notice',
    sourceUrl:
      'https://samen.lingewaard.nl/p/Dijkversterking/i/05tYK/afsluiting-rijndijk-vanwege-realisatie-bouwweg-via15',
    geometrySource:
      'RWS NWB WFS sections 389272008/391270006, queried 2026-09-03; simplified exact centreline vertices between Zahnstraat/Scherpekamp and Krakkedel',
    statusSourceUrl:
      'https://samen.lingewaard.nl/p/Dijkversterking/i/05tYK/afsluiting-rijndijk-vanwege-realisatie-bouwweg-via15',
    statusSemantics:
      'NWB establishes the internal Rijndijk segment and the municipality establishes the dated closure and N838 detour. Direction, mode exceptions, emergency priority, queue and detour throughput remain Unknown; this context-only route is excluded from causal transfers.',
    sourceFeatureIds: ['NWB-389272008', 'NWB-391270006'],
    physicalCorridorId: 'audited-Rijndijk-Angeren-Doornenburg',
    corridorIdentityStatus: 'resolved',
    coordinates: [
      [5.964357686014614, 51.914801480426746],
      [5.965640631144825, 51.91360460288935],
      [5.9663290847609165, 51.91262101389038],
      [5.967868554075476, 51.91148760329383],
      [5.969242534260071, 51.9107562393847],
      [5.973229196702692, 51.90880703295748],
      [5.976171222496057, 51.90687911133896],
      [5.978788201189053, 51.905602587051284],
      [5.9788928907315135, 51.905351248289605],
    ],
  },
  {
    id: 'audited-road-lage-rijndijk-spanjaardsbrug',
    routeName: 'Lage Rijndijk / Spanjaardsbrug',
    from: 'GM0546',
    to: 'GM0547',
    // NWB proves the local crossing geometry, but the public notice does not
    // provide a transferable scenario-unit capacity or complete modal graph.
    nominalCapacity: 0,
    capacitySemantics: 'unknown',
    affectsSimulation: false,
    mode: 'local',
    supportedServices: ['mobility', 'supply'],
    audit: 'GM0547-CURRENT-ROUTE-001',
    source: 'Rijkswaterstaat NWB geometry; Gemeente Leiderdorp valid-time notice',
    sourceUrl:
      'https://www.leiderdorp.nl/inwoner/nieuws/artikel/spanjaardsbrug-dicht-voor-autoverkeer-tot-en-met-11-september',
    geometrySource:
      'RWS NWB WFS Lage Rijndijk sections, queried 2026-09-03; municipal managers GM0546/GM0547; FRC 5/6 centreline chain',
    statusSourceUrl:
      'https://www.leiderdorp.nl/inwoner/nieuws/artikel/spanjaardsbrug-dicht-voor-autoverkeer-tot-en-met-11-september',
    statusSemantics:
      'NWB establishes the local Leiden–Leiderdorp crossing. The municipal notice establishes a dated, mode- and direction-specific restriction only; scenario throughput, queues, detour capacity and post-expiry state remain Unknown. This context-only route is excluded from causal transfers.',
    sourceFeatureIds: [
      'NWB-189328027',
      'NWB-600731554',
      'NWB-600731555',
      'NWB-189328029',
      'NWB-600731557',
      'NWB-600731556',
      'NWB-189328031',
      'NWB-189328032',
      'NWB-189328033',
      'NWB-600732116',
      'NWB-600732117',
      'NWB-190328040',
      'NWB-190328041',
      'NWB-190328038',
      'NWB-601260768',
      'NWB-601260769',
      'NWB-190328122',
      'NWB-600420705',
    ],
    physicalCorridorId: 'audited-Lage-Rijndijk-Spanjaardsbrug',
    corridorIdentityStatus: 'resolved',
    coordinates: [
      [4.50548057019025, 52.16176230951758],
      [4.506141254328755, 52.161786561063934],
      [4.5064600437214875, 52.16178391432142],
      [4.507828053181819, 52.16175003984283],
      [4.508612094644301, 52.161687172392135],
      [4.509196901011912, 52.161640717063705],
      [4.509753741007678, 52.161601172406364],
      [4.510345399992956, 52.1615597518001],
      [4.511249614237878, 52.16151165396286],
      [4.511298413129096, 52.161509661211674],
      [4.512142804746164, 52.161507447652944],
      [4.512981554135068, 52.16146909423326],
      [4.513596390197705, 52.161377862478055],
      [4.513827046571147, 52.161343950533144],
      [4.514460405191266, 52.16124780078623],
      [4.514733414663187, 52.16121212396854],
      [4.51514222010171, 52.16117456032476],
    ],
  },
  {
    id: 'audited-road-n210-algerabrug',
    routeName: 'N210 / Algerabrug',
    from: 'GM0502',
    to: 'GM0542',
    // Generalized balancing units, deliberately not vehicles per hour.
    nominalCapacity: 150,
    mode: 'regional',
    supportedServices: ['mobility', 'supply'],
    audit: 'GM0502-MOBILITY-001',
    source: 'Rijkswaterstaat NWB geometry; Provincie Zuid-Holland Algeracorridor agreement',
    sourceUrl:
      'https://www.zuid-holland.nl/publish/besluitenattachments/bestuursovereenkomst-algera-corridor-en-langzaam-verkeerverbinding/bestuursovereenkomst-algeracorridor-en-langzaam-verkeerverbinding-versie-3-9-van.pdf',
    geometrySource:
      'RWS NWB WFS wegvakken 198273080/198273045, retrieved 2026-09-02; source street name Algerabrug; provincial agreement supplies N210 corridor context',
    statusSemantics:
      'Monthly CC0 road geometry and a 2023 corridor agreement are static context; current and scenario-time passability, throughput and bridge state remain unknown.',
    sourceFeatureIds: ['NWB-198273080', 'NWB-198273045'],
    physicalCorridorId: 'audited-N210-Algerabrug',
    corridorIdentityStatus: 'resolved',
    coordinates: [
      [4.5777910259413215, 51.917235676135959],
      [4.5783525509664651, 51.917113481195955],
      [4.5795068144640103, 51.916861010034353],
      [4.5803095908533180, 51.916687888137730],
      [4.5805421381605536, 51.916632495132234],
      [4.5806946119331631, 51.916592282778574],
      [4.5808229932291518, 51.916550017416426],
    ],
  },
  {
    id: 'audited-road-n630-goirle-tilburg',
    routeName: 'N630',
    from: 'GM0785',
    to: 'GM0855',
    // Generalized balancing units, deliberately not vehicles per hour.
    nominalCapacity: 150,
    mode: 'regional',
    supportedServices: ['mobility', 'supply'],
    audit: 'GM0785-ZERO-TRANSPORT-001',
    source: 'Rijkswaterstaat NWB geometry; Gemeente Goirle route identity',
    sourceUrl:
      'https://raad.goirle.nl/Vergaderingen/Lijst-Ingekomen-Stukken/2025/25-maart/19%3A30/Informatie-van-B-W-voor-kennisgeving-aannemen/C1-Bijlage-1-bij-rib-18-3-2025-Verkeerscirculatie-Goirle.pdf',
    geometrySource:
      'RWS NWB WFS wegvakken 600770839/262187028, retrieved 2026-09-03; shared junction 262187068; source street name Turnhoutsebaan; municipal managers GM0785/GM0855; road type RB and FRC 3',
    statusSemantics:
      'Monthly CC0 NWB geometry plus municipal N630 route evidence establish the Goirle-Tilburg crossing only. Current and scenario-time passability, direction, throughput, A58 access and Belgian N12/Poppel/Turnhout continuation remain unknown.',
    sourceFeatureIds: ['NWB-600770839', 'NWB-262187028'],
    physicalCorridorId: 'audited-N630-Turnhoutsebaan',
    corridorIdentityStatus: 'resolved',
    coordinates: [
      [5.04435078269667, 51.530671333296844],
      [5.0444498584092505, 51.53081072736267],
      [5.044605355330653, 51.53110953203503],
      [5.044690532480355, 51.531281105970145],
      [5.044750519618744, 51.53141044911403],
      [5.0448851505730286, 51.531713312658674],
      [5.044963980044678, 51.531886036317495],
      [5.045044398092107, 51.532058405023456],
      [5.045361259606617, 51.53267928156005],
      [5.045521993547802, 51.53300010814759],
      [5.045647461382693, 51.53325782079745],
      [5.045728749833775, 51.53343010166161],
      [5.045768407069211, 51.533516430646586],
    ],
  },
]

// Road aliases are now derived from retained NWB `wegnummer` corridor identity
// in fetch-realism-data.mjs. Keep this hook for future manual corrections that
// have primary evidence beyond the publisher topology.
const auditedRoadAliases = [
  {
    from: 'GM0388',
    to: 'GM0995',
    canonicalName: 'N307',
    aliases: ['Markermeerdijk', 'Markerwaarddijk'],
    audit: 'GM0388-NETWORK-001',
  },
  {
    from: 'GM1924',
    to: 'GM1963',
    canonicalName: 'A29',
    aliases: ['A4'],
    audit: 'GM1924-ROAD-IDENTITY-001',
    renameSingleAlias: true,
  },
  {
    from: 'GM1709',
    to: 'GM1924',
    canonicalName: 'A29',
    aliases: ['A4'],
    audit: 'GM1924-ROAD-IDENTITY-001',
    renameSingleAlias: true,
  },
]

// Provenance for a hand-audited short boundary continuation belongs to the
// exact logical corridor, never to every municipality through global source
// metadata. This record proves how the selected NWB sections close the
// crossing; it does not infer a route label, utility topology or live state.
const auditedBoundaryConnectorProvenance = [
  {
    municipalities: ['GM0267', 'GM0313'],
    physicalCorridorId: 'NWB-road-806',
    sourceFeatureIds: ['NWB-601359433', 'NWB-311342002'],
    audit: 'GM0313-MOBILITY-FACILITY-001',
    note:
      'NWB wvk 311342002 closes the published N806/Bunschoterweg Bunschoten-Nijkerk boundary crossing; no route label, utility topology or live passability is inferred from the continuation.',
  },
]

// The same Deurne-side N279 section closes two consecutive municipal-junction
// connectors. These are series edges through GM0762, not two parallel roads or
// two additive 150-unit capacities. Preserve the shared identity explicitly so
// downstream consumers cannot mistake repeated source provenance for duplication.
const auditedSharedSectionProvenance = [
  {
    sourceFeatureId: 'NWB-357167009',
    physicalCorridorId: 'NWB-road-279',
    municipalities: ['GM0743', 'GM0762', 'GM0794'],
    relation: 'series-corridor',
    audit: 'GM0762-NETWORK-001',
    note:
      'NWB section 357167009 participates in the Asten–Deurne and Deurne–Helmond series connectors. Each 150-unit value is an edge ceiling in one continuous N279 corridor; they are not parallel capacity and must not be summed as two independent roads.',
  },
]

function pathDistanceKm(coordinates) {
  let distance = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const [fromLon, fromLat] = coordinates[index - 1]
    const [toLon, toLat] = coordinates[index]
    const latitude = ((fromLat + toLat) / 2) * Math.PI / 180
    const dx = (toLon - fromLon) * 111.32 * Math.cos(latitude)
    const dy = (toLat - fromLat) * 110.57
    distance += Math.hypot(dx, dy)
  }
  return Math.round(distance * 100) / 100
}

const [network, ferries] = await Promise.all([readJson(networkPath), readJson(ferryPath)])
const municipalityCodes = new Set(
  (await readJson(resolve(dataDirectory, 'netherlands-municipalities.geojson')))
    .features.map((feature) => feature.properties.code),
)

const auditedIds = new Set(auditedLifelines.map((link) => link.id))
network.routes = network.routes.filter((route) => !auditedIds.has(route.id))
for (const route of network.routes) {
  delete route.sharedSectionProvenance
  if (route.source === 'NWB') route.capacitySemantics = 'scenario-units'
  for (const field of [
    'sourceSignedRoadNumbers',
    'sourceAdministrativeRoadNumbers',
    'sourceRoadPartClasses',
  ]) {
    if (Array.isArray(route[field])) route[field] = [...new Set(route[field])].sort()
  }
}

// NWB proves that this N216 boundary crossing exists and classifies both source
// sections as VDA (ferry). The operator publishes a recurring timetable and
// vehicle capability, but neither source supplies scenario-time operation or a
// defensible throughput. Keep the physical connection visible and traceable,
// while excluding it from transfers until a time-valid adapter exists.
const schoonhovenGelkenesFerry = network.routes.find(
  (route) =>
    route.id === 'nwb-link-933-GM1931-GM1978' &&
    [route.from, route.to].sort().join('--') === ['GM1931', 'GM1978'].sort().join('--') &&
    ['NWB-600441023', 'NWB-600441055'].every((id) => route.sourceFeatureIds?.includes(id)),
)
if (!schoonhovenGelkenesFerry) {
  throw new Error('Audited N216 Schoonhoven–Gelkenes NWB ferry crossing not found')
}
Object.assign(schoonhovenGelkenesFerry, {
  name: 'N216 / Veerdienst Schoonhoven–Gelkenes',
  sourceUrl: 'https://www.veerdienst-schoonhoven.nl/over-de-veerdienst.html',
  geometrySource:
    'Rijkswaterstaat NWB sections 600441023/600441055; road-part class VDA; monthly CC0 topology',
  statusSourceUrl: 'https://www.veerdienst-schoonhoven.nl/dienstregeling.html',
  statusSemantics:
    'NWB class VDA and the operator pages establish a vehicle ferry and recurring published timetable only. Scenario-time sailing, queue, priority, accessibility and throughput remain Unknown; this context-only route is excluded from simulation.',
  mode: 'ferry',
  nominalCapacity: 0,
  capacitySemantics: 'unknown',
  affectsSimulation: false,
  physicalCorridorId: 'audited-N216-Schoonhoven-Gelkenes',
  corridorIdentityStatus: 'resolved',
  supportedServices: ['mobility', 'supply'],
  publishedScheduleContext: {
    timeZone: 'Europe/Amsterdam',
    sourceUrl: 'https://www.veerdienst-schoonhoven.nl/dienstregeling.html',
    retrievedAt: '2026-09-03T06:19:50Z',
    simulationEffect: 'context-only',
    periods: [
      {
        dateRange: 'Normal published timetable; holiday and outage exceptions unresolved',
        mondayToFriday:
          '05:00–00:00; 4 departures/hour 05:00–06:00 and 20:00–00:00, approximately 6/hour 06:00–20:00; two vessels in published weekday peaks outside named holidays',
        saturday:
          '05:00–00:00; 4 departures/hour 05:00–06:00 and 20:00–00:00, approximately 6/hour 06:00–20:00',
        sundayAndHolidays:
          '05:00–00:00 normally; Christmas and New Year use exceptions not resolved here',
      },
    ],
    note:
      'Published frequency is schedule context, not observed sailings, carrying capacity, waiting time or guaranteed emergency access. It has no numeric simulation effect.',
  },
  audit: [
    ...new Set([
      ...(Array.isArray(schoonhovenGelkenesFerry.audit)
        ? schoonhovenGelkenesFerry.audit
        : schoonhovenGelkenesFerry.audit
          ? [schoonhovenGelkenesFerry.audit]
          : []),
      'GM1931-FERRY-ACCESS-001',
    ]),
  ],
})

for (const correction of auditedRoadAliases) {
  const matchesPair = (route) =>
    [route.from, route.to].sort().join('--') === [correction.from, correction.to].sort().join('--')
  let canonical = network.routes.find(
    (route) => matchesPair(route) && route.name === correction.canonicalName,
  )
  let aliasRoutes = network.routes.filter(
    (route) => matchesPair(route) && correction.aliases.includes(route.name),
  )
  let renamedSingleAlias = false
  if (!canonical && correction.renameSingleAlias && aliasRoutes.length === 1) {
    canonical = aliasRoutes[0]
    canonical.name = correction.canonicalName
    aliasRoutes = []
    renamedSingleAlias = true
  }
  if (!canonical) {
    throw new Error(
      `Canonical audited road ${correction.canonicalName} not found for ${correction.from}-${correction.to}`,
    )
  }
  if (
    !renamedSingleAlias &&
    aliasRoutes.length === 0 &&
    !correction.aliases.every((alias) => canonical.aliases?.includes(alias))
  ) {
    throw new Error(
      `Audited road aliases ${correction.aliases.join(', ')} not found for ${correction.from}-${correction.to}`,
    )
  }
  network.routes = network.routes.filter((route) => !aliasRoutes.includes(route))
  canonical.aliases = [...new Set([...(canonical.aliases ?? []), ...correction.aliases])]
    .filter((alias) => alias !== canonical.name)
    .sort()
  canonical.sourceFeatureIds = [
    ...new Set([
      ...(canonical.sourceFeatureIds ?? []),
      ...aliasRoutes.flatMap((route) => route.sourceFeatureIds ?? []),
    ]),
  ].sort()
  for (const field of [
    'sourceSignedRoadNumbers',
    'sourceAdministrativeRoadNumbers',
    'sourceRoadPartClasses',
  ]) {
    canonical[field] = [
      ...new Set([
        ...(canonical[field] ?? []),
        ...aliasRoutes.flatMap((route) => route[field] ?? []),
      ]),
    ].sort()
    if (canonical[field].length === 0) delete canonical[field]
  }
  canonical.audit = [...new Set([...(Array.isArray(canonical.audit) ? canonical.audit : canonical.audit ? [canonical.audit] : []), correction.audit])]
}

for (const link of auditedLifelines) {
  if (!municipalityCodes.has(link.from) || !municipalityCodes.has(link.to)) {
    throw new Error(`Unknown municipality on audited lifeline ${link.id}`)
  }
  const feature = link.coordinates
    ? null
    : ferries.features.find(
        (candidate) => candidate.properties?.route_name === link.routeName,
      )
  const coordinates = link.coordinates ?? feature?.geometry?.coordinates
  if (!coordinates || coordinates.length < 2) {
    throw new Error(`Audited ferry geometry not found for ${link.routeName}`)
  }
  network.routes.push({
    id: link.id,
    name: link.routeName,
    source: link.source ?? 'OVapi GTFS (derived from NDOV operator data)',
    ...(link.sourceUrl ? { sourceUrl: link.sourceUrl } : {}),
    ...(link.geometrySource ? { geometrySource: link.geometrySource } : {}),
    ...(link.statusSourceUrl ? { statusSourceUrl: link.statusSourceUrl } : {}),
    ...(link.statusSemantics ? { statusSemantics: link.statusSemantics } : {}),
    ...(link.operatorPhysicalLimits ? { operatorPhysicalLimits: link.operatorPhysicalLimits } : {}),
    ...(link.observedOperationalStatus
      ? { observedOperationalStatus: link.observedOperationalStatus }
      : {}),
    ...(link.publishedScheduleContext
      ? { publishedScheduleContext: link.publishedScheduleContext }
      : {}),
    ...(link.sourceFeatureIds ? { sourceFeatureIds: link.sourceFeatureIds } : {}),
    ...(link.physicalCorridorId ? { physicalCorridorId: link.physicalCorridorId } : {}),
    ...(link.corridorIdentityStatus
      ? { corridorIdentityStatus: link.corridorIdentityStatus }
      : {}),
    from: link.from,
    to: link.to,
    coordinates,
    nominalCapacity: link.nominalCapacity,
    mode: link.mode ?? 'ferry',
    distanceKm: pathDistanceKm(coordinates),
    supportedServices: link.supportedServices,
    capacitySemantics: link.capacitySemantics ?? 'scenario-units',
    ...(link.affectsSimulation === false ? { affectsSimulation: false } : {}),
    audit: link.audit,
  })
}

// Remove the former global note from both old snapshots and new regenerations,
// then attach each annotation only to its verified corridor.
delete network.source.auditedBoundaryConnectors
for (const provenance of auditedBoundaryConnectorProvenance) {
  const route = network.routes.find(
    (candidate) =>
      [candidate.from, candidate.to].sort().join('--') ===
        [...provenance.municipalities].sort().join('--') &&
      candidate.physicalCorridorId === provenance.physicalCorridorId &&
      provenance.sourceFeatureIds.every((id) => candidate.sourceFeatureIds?.includes(id)),
  )
  if (!route) {
    throw new Error(
      `Audited boundary connector not found for ${provenance.municipalities.join('-')} ${provenance.physicalCorridorId}`,
    )
  }
  route.auditProvenance = provenance
}

for (const provenance of auditedSharedSectionProvenance) {
  const routes = network.routes.filter(
    (candidate) =>
      candidate.physicalCorridorId === provenance.physicalCorridorId &&
      candidate.sourceFeatureIds?.includes(provenance.sourceFeatureId) &&
      provenance.municipalities.includes(candidate.from) &&
      provenance.municipalities.includes(candidate.to),
  )
  const pairs = routes.map((route) => [route.from, route.to].sort().join('--')).sort()
  const expectedPairs = [
    ['GM0743', 'GM0762'].sort().join('--'),
    ['GM0762', 'GM0794'].sort().join('--'),
  ].sort()
  if (routes.length !== 2 || JSON.stringify(pairs) !== JSON.stringify(expectedPairs)) {
    throw new Error(`Audited shared section ${provenance.sourceFeatureId} does not resolve to its two series edges`)
  }
  const routeIds = routes.map((route) => route.id).sort()
  for (const route of routes) {
    route.sharedSectionProvenance = {
      sourceFeatureId: provenance.sourceFeatureId,
      relation: provenance.relation,
      routes: routeIds,
      audit: provenance.audit,
      note: provenance.note,
    }
  }
}

network.routes.sort((left, right) => left.id.localeCompare(right.id))
network.source.auditedLifelines =
  'OVapi GTFS, BGT/NWB and BRT TOP10NL transport geometry plus municipality/operator identity evidence; observed human-readable status remains context-only without issue/expiry time; generalized scenario capacity'
network.source.auditedRoadAliases =
  'RWS NWB wegnummer-based physical-corridor normalization plus municipality-audited signed-name corrections and non-additive route-name fragments; aliases retain source provenance and never add capacity'
network.source.topologySemantics =
  'NWB junction topology; A/N routes and international/numeric co-designations sharing one unambiguous wegnummer are one physical corridor, not additive capacity. A source section may support consecutive series edges at a municipal junction; those edge ceilings are not parallel capacity and must never be summed as independent corridors.'
network.source.auditedSharedSections =
  'Repeated NWB section provenance is permitted only for audited consecutive series edges; it is never independent or additive corridor capacity.'
const transportContexts = await Promise.all(transportContextPaths.map(readJson))
for (const collection of transportContexts) delete collection.source?.auditedBoundaryConnectors
await Promise.all([
  writeFile(networkPath, JSON.stringify(network)),
  ...transportContexts.map((collection, index) =>
    writeFile(transportContextPaths[index], `${JSON.stringify(collection)}\n`),
  ),
])

console.log(JSON.stringify({
  auditedLifelines: auditedLifelines.length,
  auditedRoadAliases: auditedRoadAliases.length,
  auditedBoundaryConnectors: auditedBoundaryConnectorProvenance.length,
  auditedSharedSections: auditedSharedSectionProvenance.length,
  routes: network.routes.length,
}, null, 2))
