#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const fail = (message) => {
  throw new Error(message)
}

const numericRecordsEqual = (left = {}, right = {}) => {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  )
}

const polygonCounts = (geometry) => {
  const polygons = geometry?.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon'
      ? geometry.coordinates
      : []
  const rings = polygons.reduce((sum, polygon) => sum + polygon.length, 0)
  return { components: polygons.length, rings, holes: rings - polygons.length }
}

const municipalityCollection = await readJson(
  resolve(dataDirectory, 'netherlands-municipalities.geojson'),
)
const municipalityCodes = new Set(
  municipalityCollection.features.map((feature) => feature.properties.code),
)
if (municipalityCodes.size !== 342) fail(`Expected 342 municipalities; found ${municipalityCodes.size}`)

const regionFiles = (await readdir(resolve(dataDirectory, 'regions')))
  .filter((name) => /^GM\d{4}\.json$/.test(name))
  .sort()
if (regionFiles.length !== municipalityCodes.size) {
  fail(`Expected one region file per municipality; found ${regionFiles.length}`)
}

let neighborhoods = 0
let places = 0
for (const file of regionFiles) {
  const code = file.slice(0, 6)
  const bundle = await readJson(resolve(dataDirectory, 'regions', file))
  if (bundle.municipalityCode !== code || !municipalityCodes.has(code)) {
    fail(`${file} has an invalid municipality identity`)
  }
  neighborhoods += bundle.neighborhoods.features.length
  places += bundle.places.features.length
  for (const feature of bundle.neighborhoods.features) {
    if (feature.properties.municipalityCode !== code) {
      fail(`${feature.id} is stored under the wrong municipality`)
    }
    const statistics = Object.values(feature.properties.statistics)
    if (statistics.length !== 36) fail(`${feature.id} does not have 36 statistics`)
    if (statistics.some((value) => typeof value === 'number' && value < 0)) {
      fail(`${feature.id} still contains a negative CBS missing-value sentinel`)
    }
  }
  if (code === 'GM0744') {
    const operationalFeature = bundle.operationalBoundary?.features?.[0]
    const operationalCounts = polygonCounts(operationalFeature?.geometry)
    if (
      bundle.operationalBoundary?.features?.length !== 1 ||
      operationalFeature?.properties?.sourceCollection !== 'gemeente_niet_gegeneraliseerd' ||
      operationalCounts.components !== 9 ||
      operationalCounts.rings !== 31 ||
      operationalCounts.holes !== 22
    ) {
      fail('GM0744 operational boundary no longer preserves its 9 components and 22 enclave holes')
    }
    const buitengebied = bundle.neighborhoods.features.find(
      (feature) => feature.id === 'BU07440107',
    )
    const buitengebiedCounts = polygonCounts(buitengebied?.geometry)
    if (
      buitengebiedCounts.components !== 8 ||
      buitengebiedCounts.rings !== 20 ||
      buitengebiedCounts.holes !== 12 ||
      !bundle.source?.neighborhoods?.endsWith('/buurt_niet_gegeneraliseerd')
    ) {
      fail('GM0744 audited neighbourhood geometry has lost its full-resolution enclave topology')
    }
  }
}
if (neighborhoods !== 14_729) fail(`Expected 14,729 2025 buurten; found ${neighborhoods}`)

const safetyRegions = await readJson(resolve(dataDirectory, 'safety-regions.geojson'))
const safetyRegionMunicipalities = safetyRegions.features.flatMap(
  (feature) => feature.properties.municipalityCodes,
)
if (safetyRegions.features.length !== 25) {
  fail(`Expected 25 safety regions; found ${safetyRegions.features.length}`)
}
if (
  safetyRegionMunicipalities.length !== municipalityCodes.size ||
  new Set(safetyRegionMunicipalities).size !== municipalityCodes.size ||
  safetyRegionMunicipalities.some((code) => !municipalityCodes.has(code))
) {
  fail('Safety-region membership does not cover every municipality exactly once')
}

const settlementDirectory = resolve(dataDirectory, 'settlements')
const settlementManifest = await readJson(resolve(settlementDirectory, 'manifest.json'))
const settlementFiles = (await readdir(settlementDirectory))
  .filter((name) => /^GM\d{4}\.geojson$/.test(name))
  .sort()
const settlementIds = new Set()
let settlements = 0
for (const file of settlementFiles) {
  const code = file.slice(0, 6)
  const collection = await readJson(resolve(settlementDirectory, file))
  for (const feature of collection.features) {
    if (feature.properties.municipalityCode !== code) {
      fail(`${feature.id} is stored under the wrong settlement municipality`)
    }
    if (settlementIds.has(feature.id)) fail(`Duplicate settlement ID ${feature.id}`)
    settlementIds.add(feature.id)
    settlements += 1
  }
}
if (settlementFiles.length !== 342) fail(`Expected 342 settlement files; found ${settlementFiles.length}`)
if (settlements !== settlementManifest.totals.retainedFeatures) {
  fail(`Settlement manifest says ${settlementManifest.totals.retainedFeatures}; found ${settlements}`)
}

const transport = await readJson(resolve(dataDirectory, 'transport-network.json'))
const transportRestrictions = await readJson(
  resolve(dataDirectory, 'public-context/transport-restrictions.json'),
)
const allowedRouteModes = new Set(['trunk', 'regional', 'local', 'ferry'])
const allowedRouteServices = new Set(['power', 'water', 'drainage', 'gas', 'telecom', 'mobility', 'facilities', 'supply'])
for (const route of transport.routes) {
  const isContextOnlyUnknownRoute =
    route.affectsSimulation === false &&
    route.capacitySemantics === 'unknown' &&
    route.nominalCapacity === 0
  if (
    !municipalityCodes.has(route.from) ||
    !municipalityCodes.has(route.to) ||
    (route.from === route.to && !isContextOnlyUnknownRoute) ||
    route.coordinates.length < 2 ||
    !Number.isFinite(route.nominalCapacity) ||
    route.nominalCapacity < 0 ||
    (route.nominalCapacity === 0 && !isContextOnlyUnknownRoute)
  ) {
    fail(`Invalid transport route ${route.id}`)
  }
  if (
    route.affectsSimulation === false &&
    (!isContextOnlyUnknownRoute || !route.statusSemantics?.includes('remain Unknown'))
  ) {
    fail(`Context-only route ${route.id} lacks fail-closed capacity/status semantics`)
  }
  if (route.affectsSimulation !== false && route.capacitySemantics === 'unknown') {
    fail(`Causal route ${route.id} has unknown capacity semantics`)
  }
  if (!allowedRouteModes.has(route.mode)) fail(`Invalid route mode on ${route.id}`)
  if (route.supportedServices !== undefined) {
    if (
      !Array.isArray(route.supportedServices) ||
      route.supportedServices.length === 0 ||
      new Set(route.supportedServices).size !== route.supportedServices.length ||
      route.supportedServices.some((service) => !allowedRouteServices.has(service))
    ) {
      fail(`Invalid supported-services restriction on ${route.id}`)
    }
  }
  if (/^A[0-9]+$/.test(route.name) && (route.mode !== 'trunk' || route.nominalCapacity !== 260)) {
    fail(`Motorway route ${route.id} lost its signed trunk classification`)
  }
  if (/^N[0-9]+$/.test(route.name) && (route.mode !== 'regional' || route.nominalCapacity !== 150)) {
    fail(`N-road route ${route.id} lost its signed regional classification`)
  }
  if (route.source === 'NWB' && (!Array.isArray(route.sourceFeatureIds) || route.sourceFeatureIds.length < 2)) {
    fail(`NWB route ${route.id} does not retain its contributing wvk identities`)
  }
  if (
    route.source === 'NWB' &&
    route.affectsSimulation !== false &&
    route.capacitySemantics !== 'scenario-units'
  ) {
    fail(`NWB route ${route.id} does not label nominal capacity as scenario units`)
  }
  for (const field of [
    'sourceSignedRoadNumbers',
    'sourceAdministrativeRoadNumbers',
    'sourceRoadPartClasses',
  ]) {
    if (
      route[field] !== undefined &&
      (!Array.isArray(route[field]) ||
        route[field].length === 0 ||
        route[field].some((value) => typeof value !== 'string' || value.length === 0) ||
        new Set(route[field]).size !== route[field].length)
    ) {
      fail(`Invalid or duplicated ${field} provenance on ${route.id}`)
    }
  }
  if (
    route.source === 'NWB' &&
    route.physicalCorridorId &&
    !['resolved', 'ambiguous'].includes(route.corridorIdentityStatus)
  ) {
    fail(`NWB route ${route.id} does not declare corridor identity confidence`)
  }
  if (
    route.corridorIdentityStatus === 'ambiguous' &&
    !route.physicalCorridorId?.endsWith(`--${route.name}`)
  ) {
    fail(`Ambiguous NWB route ${route.id} does not preserve its route designation in identity`)
  }
}

if (!transport.source?.topologySemantics?.includes('not additive capacity')) {
  fail('Transport source does not declare physical-corridor co-designation semantics')
}
if (!transport.source?.topologySemantics?.includes('consecutive series edges')) {
  fail('Transport source does not declare shared-section series semantics')
}
const nwbPhysicalCorridors = new Set()
for (const route of transport.routes.filter((candidate) => candidate.source === 'NWB')) {
  if (!route.physicalCorridorId) continue
  const key = `${[route.from, route.to].sort().join('--')}--${route.physicalCorridorId}`
  if (nwbPhysicalCorridors.has(key)) fail(`Duplicate NWB physical corridor capacity remains on ${key}`)
  nwbPhysicalCorridors.add(key)
}

const eindhovenValkenswaardRoutes = transport.routes.filter(
  (route) =>
    route.source === 'NWB' &&
    [route.from, route.to].sort().join('--') === ['GM0772', 'GM0866'].sort().join('--'),
)
const eindhovenA2 = eindhovenValkenswaardRoutes.find((route) => route.name === 'A2')
if (
  eindhovenValkenswaardRoutes.length !== 3 ||
  JSON.stringify(eindhovenValkenswaardRoutes.map((route) => route.name).sort()) !==
    JSON.stringify(['A2', 'A67', 'N2']) ||
  !eindhovenA2 ||
  !eindhovenA2.sourceFeatureIds?.includes('NWB-325158020') ||
  !eindhovenA2.sourceFeatureIds?.includes('NWB-326158032') ||
  !eindhovenA2.sourceSignedRoadNumbers?.includes('A2') ||
  !eindhovenA2.sourceAdministrativeRoadNumbers?.includes('RW2') ||
  !eindhovenA2.sourceRoadPartClasses?.includes('OPR') ||
  eindhovenA2.mode !== 'trunk' ||
  eindhovenA2.nominalCapacity !== 260 ||
  eindhovenA2.capacitySemantics !== 'scenario-units' ||
  JSON.stringify(eindhovenA2.supportedServices) !== JSON.stringify(['mobility', 'supply'])
) {
  fail('Eindhoven A2 ramp provenance remains a false independent 002 corridor')
}

const goereeA29Pairs = [
  ['GM1924', 'GM1963'].sort().join('--'),
  ['GM1709', 'GM1924'].sort().join('--'),
].sort()
const goereeA29 = transport.routes.filter(
  (route) =>
    route.source === 'NWB' &&
    goereeA29Pairs.includes([route.from, route.to].sort().join('--')) &&
    (route.name === 'A29' || route.aliases?.includes('A4')),
)
if (
  goereeA29.length !== 2 ||
  JSON.stringify(goereeA29.map((route) => [route.from, route.to].sort().join('--')).sort()) !==
    JSON.stringify(goereeA29Pairs) ||
  goereeA29.some(
    (route) =>
      route.name !== 'A29' ||
      !route.aliases?.includes('A4') ||
      JSON.stringify(route.sourceSignedRoadNumbers) !== JSON.stringify(['A29']) ||
      !route.sourceAdministrativeRoadNumbers?.includes('RW4') ||
      route.physicalCorridorId !== 'NWB-road-4' ||
      route.mode !== 'trunk' ||
      route.nominalCapacity !== 260 ||
      route.capacitySemantics !== 'scenario-units' ||
      !(Array.isArray(route.audit) && route.audit.includes('GM1924-ROAD-IDENTITY-001')),
  )
) {
  fail('Goeree-Overflakkee eastern NWB crossings are not labelled as signed A29 with RW4/A4 provenance')
}

const enkhuizenLelystadRoutes = transport.routes.filter(
  (route) =>
    route.source === 'NWB' &&
    [route.from, route.to].sort().join('--') === ['GM0388', 'GM0995'].sort().join('--'),
)
const enkhuizenN307 = enkhuizenLelystadRoutes[0]
if (
  enkhuizenLelystadRoutes.length !== 1 ||
  enkhuizenN307?.name !== 'N307' ||
  JSON.stringify(enkhuizenN307.aliases) !==
    JSON.stringify(['Markermeerdijk', 'Markerwaarddijk']) ||
  ![
    'NWB-296445006',
    'NWB-296445012',
    'NWB-600135510',
    'NWB-601298392',
    'NWB-601298394',
    'NWB-601298396',
    'NWB-601645248',
    'NWB-601645557',
  ].every((id) => enkhuizenN307.sourceFeatureIds?.includes(id)) ||
  !['HR', 'PAR', 'RB'].every((roadPartClass) =>
    enkhuizenN307.sourceRoadPartClasses?.includes(roadPartClass)) ||
  enkhuizenN307.physicalCorridorId !== 'NWB-road-307' ||
  enkhuizenN307.nominalCapacity !== 150 ||
  enkhuizenN307.capacitySemantics !== 'scenario-units' ||
  JSON.stringify(enkhuizenN307.supportedServices) !== JSON.stringify(['mobility', 'supply']) ||
  !(Array.isArray(enkhuizenN307.audit) && enkhuizenN307.audit.includes('GM0388-NETWORK-001'))
) {
  fail('Enkhuizen-Lelystad Houtribdijk remains duplicated as additive route-name fragments')
}

const deurneSharedN279 = transport.routes.filter(
  (route) =>
    route.source === 'NWB' &&
    route.physicalCorridorId === 'NWB-road-279' &&
    route.sourceFeatureIds?.includes('NWB-357167009'),
)
const deurneSharedPairs = deurneSharedN279
  .map((route) => [route.from, route.to].sort().join('--'))
  .sort()
if (
  deurneSharedN279.length !== 2 ||
  JSON.stringify(deurneSharedPairs) !== JSON.stringify([
    ['GM0743', 'GM0762'].sort().join('--'),
    ['GM0762', 'GM0794'].sort().join('--'),
  ].sort()) ||
  deurneSharedN279.some(
    (route) =>
      route.nominalCapacity !== 150 ||
      route.capacitySemantics !== 'scenario-units' ||
      route.sharedSectionProvenance?.sourceFeatureId !== 'NWB-357167009' ||
      route.sharedSectionProvenance?.relation !== 'series-corridor' ||
      route.sharedSectionProvenance?.audit !== 'GM0762-NETWORK-001' ||
      !route.sharedSectionProvenance?.note?.includes('not parallel capacity'),
  )
) {
  fail('Deurne N279 shared section is not constrained to two audited series edges')
}
if (!transport.source?.auditedSharedSections?.includes('never independent or additive')) {
  fail('Transport source does not expose audited shared-section semantics')
}

const waterAssetBuffer = await readFile(
  resolve(dataDirectory, 'public-context/water-assets.geojson.gz'),
)
const waterAssets = JSON.parse(gunzipSync(waterAssetBuffer).toString('utf8'))
const waterAssetTypes = new Set([
  'surface-water-pump',
  'weir',
  'sluice',
  'sewer-pump',
  'wastewater-treatment',
])
if (
  waterAssets.type !== 'FeatureCollection' ||
  waterAssets.evidenceClass !== 'official-context' ||
  waterAssets.affectsSimulation !== false ||
  waterAssets.source?.coverage !== 'partial' ||
  !Number.isFinite(Date.parse(waterAssets.source?.retrievedAt)) ||
  waterAssets.source?.services?.length !== 2 ||
  waterAssets.source.services.some((service) => service.license !== 'CC BY-SA 4.0') ||
  waterAssets.municipalityAssignment?.method !==
    'point-in-polygon against CBS 2025 non-generalized municipality geometry' ||
  waterAssets.municipalityAssignment?.boundaryEdition !== 2025 ||
  !Number.isFinite(Date.parse(waterAssets.municipalityAssignment?.boundaryInstant)) ||
  !waterAssets.municipalityAssignment?.boundarySource?.endsWith(
    '/collections/gemeente_niet_gegeneraliseerd',
  ) ||
  waterAssets.municipalityAssignment?.boundaryLicense !== 'CC BY 4.0' ||
  !waterAssets.municipalityAssignment?.noDataRule?.includes('never means absent')
) {
  fail('Public water-asset evidence metadata is incomplete or misleading')
}
if (
  waterAssets.features.length < 60_000 ||
  Object.values(waterAssets.counts).reduce((sum, count) => sum + count, 0) !==
    waterAssets.features.length ||
  new Set(waterAssets.features.map((feature) => feature.id)).size !== waterAssets.features.length
) {
  fail('Public water-asset snapshot is incomplete or contains duplicate IDs')
}
let assignedWaterAssets = 0
let outsideWaterAssets = 0
let ambiguousWaterAssets = 0
const waterAssetMunicipalities = new Set()
const geertruidenbergWaterAssets = {
  'surface-water-pump': 0,
  weir: 0,
  sluice: 0,
  'sewer-pump': 0,
  'wastewater-treatment': 0,
}
for (const feature of waterAssets.features) {
  const municipalityCode = feature.properties?.municipalityCode
  const municipalityName = feature.properties?.municipalityName
  const municipalityAssignment = feature.properties?.municipalityAssignment
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length < 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    !waterAssetTypes.has(feature.properties?.assetType) ||
    !['imwa-water-control', 'damo-wastewater'].includes(feature.properties?.sourceId)
  ) {
    fail(`Invalid public water asset ${feature.id}`)
  }
  if (municipalityCode !== null) {
    if (
      !municipalityCodes.has(municipalityCode) ||
      typeof municipalityName !== 'string' ||
      municipalityName.length === 0 ||
      municipalityAssignment !== 'CBS 2025 non-generalized polygon containment'
    ) {
      fail(`Invalid municipality assignment on public water asset ${feature.id}`)
    }
    assignedWaterAssets += 1
    waterAssetMunicipalities.add(municipalityCode)
    if (municipalityCode === 'GM0779') {
      geertruidenbergWaterAssets[feature.properties.assetType] += 1
    }
  } else {
    if (municipalityName !== null) {
      fail(`Unassigned public water asset ${feature.id} retains a municipality name`)
    }
    if (municipalityAssignment === 'outside CBS 2025 municipality polygons') {
      outsideWaterAssets += 1
    } else if (municipalityAssignment === 'ambiguous shared municipality boundary') {
      ambiguousWaterAssets += 1
    } else {
      fail(`Public water asset ${feature.id} has an invalid no-data assignment state`)
    }
  }
}
if (
  assignedWaterAssets !== waterAssets.municipalityAssignment.assignedToMunicipalityPolygon ||
  outsideWaterAssets !== waterAssets.municipalityAssignment.outsideMunicipalityPolygon ||
  ambiguousWaterAssets !== waterAssets.municipalityAssignment.ambiguousSharedBoundary ||
  waterAssetMunicipalities.size !== waterAssets.municipalityAssignment.municipalitiesRepresented ||
  assignedWaterAssets + outsideWaterAssets + ambiguousWaterAssets !== waterAssets.features.length
) {
  fail('Public water-asset municipality assignment totals do not reconcile')
}
if (
  geertruidenbergWaterAssets['surface-water-pump'] < 13 ||
  geertruidenbergWaterAssets.weir < 21 ||
  geertruidenbergWaterAssets.sluice < 4 ||
  geertruidenbergWaterAssets['sewer-pump'] < 4
) {
  fail(
    `Geertruidenberg water-asset coverage regressed: ${JSON.stringify(geertruidenbergWaterAssets)}`,
  )
}

const governmentServiceBuffer = await readFile(
  resolve(dataDirectory, 'public-context/government-service-locations.geojson.gz'),
)
const governmentServices = JSON.parse(gunzipSync(governmentServiceBuffer).toString('utf8'))
const governmentServiceTypes = new Set(['public-order-and-safety', 'public-administration'])
if (
  governmentServices.type !== 'FeatureCollection' ||
  governmentServices.evidenceClass !== 'official-context' ||
  governmentServices.affectsSimulation !== false ||
  governmentServices.source?.coverage !== 'partial' ||
  governmentServices.source?.license !== 'Public Domain Mark 1.0' ||
  !Number.isFinite(Date.parse(governmentServices.source?.retrievedAt))
) {
  fail('Public governmental-service evidence metadata is incomplete or misleading')
}
if (
  governmentServices.features.length < 2_800 ||
  Object.values(governmentServices.counts).reduce((sum, count) => sum + count, 0) !==
    governmentServices.features.length ||
  new Set(governmentServices.features.map((feature) => feature.id)).size !==
    governmentServices.features.length
) {
  fail('Public governmental-service snapshot is incomplete or contains duplicate IDs')
}
for (const feature of governmentServices.features) {
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length < 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    !governmentServiceTypes.has(feature.properties?.facilityType)
  ) {
    fail(`Invalid public governmental-service location ${feature.id}`)
  }
}

const acuteCareBuffer = await readFile(
  resolve(dataDirectory, 'public-context/rivm-acute-care-locations.geojson.gz'),
)
const acuteCare = JSON.parse(gunzipSync(acuteCareBuffer).toString('utf8'))
if (
  acuteCare.type !== 'FeatureCollection' ||
  acuteCare.evidenceClass !== 'official-context' ||
  acuteCare.affectsSimulation !== false ||
  acuteCare.source?.id !== 'rivm-acute-care-questionnaire-2026-v1.1' ||
  acuteCare.source?.license !== 'CC0 1.0' ||
  acuteCare.source?.publicationDate !== '2026-07-03' ||
  acuteCare.source?.version !== '1.1' ||
  !/^[0-9a-f]{64}$/.test(acuteCare.source?.inputSha256 ?? '') ||
  !Number.isFinite(Date.parse(acuteCare.source?.retrievedAt)) ||
  acuteCare.geocoding?.license !== 'Public Domain Mark 1.0'
) {
  fail('RIVM acute-care evidence metadata is incomplete or misleading')
}
if (
  acuteCare.features.length !== 79 ||
  acuteCare.counts?.emergencyDepartments !== 79 ||
  acuteCare.counts?.open247 !== 76 ||
  acuteCare.counts?.limitedHours !== 3 ||
  acuteCare.counts?.acuteObstetrics !== 71 ||
  new Set(acuteCare.features.map((feature) => feature.id)).size !== 79
) {
  fail('RIVM acute-care role counts changed or contain duplicate IDs')
}
for (const feature of acuteCare.features) {
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    feature.geometry.coordinates[0] < 3 || feature.geometry.coordinates[0] > 7.5 ||
    feature.geometry.coordinates[1] < 50.7 || feature.geometry.coordinates[1] > 53.7 ||
    feature.properties?.facilityType !== 'emergency-department' ||
    !municipalityCodes.has(feature.properties?.municipalityCode) ||
    !/^[0-9]{4}[A-Z]{2}$/.test(feature.properties?.postcode ?? '') ||
    !(feature.properties?.treatmentRoomsReported > 0) ||
    !(feature.properties?.emergencyVisits2025Reported > 0) ||
    !['exact postcode and house number', 'postcode and address-range midpoint'].includes(
      feature.properties?.geocoderMatchMethod,
    )
  ) {
    fail(`Invalid RIVM acute-care location ${feature.id}`)
  }
}

const educationLocationBuffer = await readFile(
  resolve(dataDirectory, 'public-context/duo-education-locations.geojson.gz'),
)
const educationLocations = JSON.parse(gunzipSync(educationLocationBuffer).toString('utf8'))
const expectedEducationResources = [
  'onderwijslocaties',
  'onderwijslocatiegebruiken',
  'relaties_onderwijslocatiegebruiken_vestigingserkenningen',
  'vestigingserkenningen',
]
if (
  educationLocations.type !== 'FeatureCollection' ||
  educationLocations.evidenceClass !== 'official-context' ||
  educationLocations.affectsSimulation !== false ||
  educationLocations.source?.id !== 'c416acd1-e083-4ec6-9203-3b20f98fe143' ||
  educationLocations.source?.publisher !== 'Dienst Uitvoering Onderwijs (DUO)' ||
  educationLocations.source?.licenseId !== 'cc-by' ||
  !educationLocations.source?.license?.includes('version unspecified') ||
  !Number.isFinite(Date.parse(educationLocations.source?.retrievedAt)) ||
  !/^\d{4}-\d{2}-\d{2}$/.test(educationLocations.source?.snapshotDate ?? '') ||
  !/^\d{4}-\d{2}-\d{2}$/.test(educationLocations.effectiveDate ?? '') ||
  educationLocations.source?.resources?.length !== expectedEducationResources.length ||
  !educationLocations.source?.coverageNote?.includes('not student presence') ||
  educationLocations.processing?.mapScopeBounds?.join(',') !== '3,50.6,7.4,53.7'
) {
  fail('DUO RIO education-location evidence metadata is incomplete or misleading')
}
for (const [index, name] of expectedEducationResources.entries()) {
  const resource = educationLocations.source.resources[index]
  if (
    resource.name !== name ||
    !(resource.bytes > 0) ||
    !/^[0-9a-f]{64}$/.test(resource.sha256 ?? '') ||
    !Number.isFinite(Date.parse(resource.lastModified)) ||
    !resource.url?.startsWith('https://onderwijsdata.duo.nl/')
  ) {
    fail(`Invalid DUO RIO source manifest entry ${name}`)
  }
}
const educationTypes = new Set([
  'special education',
  'primary education',
  'secondary education',
  'vocational or adult education',
  'higher education',
  'other registered education',
])
const educationFrameworks = ['WEC', 'WPO', 'WVO', 'WEB', 'WHW']
const recomputedFrameworkCounts = Object.fromEntries(educationFrameworks.map((framework) => [framework, 0]))
const educationMunicipalityCodes = new Set()
let linkedEducationLocations = 0
let assignedEducationLocations = 0
for (const feature of educationLocations.features) {
  const frameworks = feature.properties?.legalFrameworks
    ? feature.properties.legalFrameworks.split(' · ')
    : []
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    feature.geometry.coordinates[0] < 3 || feature.geometry.coordinates[0] > 7.4 ||
    feature.geometry.coordinates[1] < 50.6 || feature.geometry.coordinates[1] > 53.7 ||
    feature.properties?.facilityType !== 'education-location' ||
    !educationTypes.has(feature.properties?.educationType) ||
    !/^\d{3}X\d{3}$/.test(feature.properties?.locationCode ?? '') ||
    !(feature.properties?.activeUseCount > 0) ||
    !(feature.properties?.recognizedBranchCount >= 0) ||
    frameworks.some((framework) => !educationFrameworks.includes(framework)) ||
    (feature.properties?.recognizedBranchCount > 0) !== (frameworks.length > 0)
  ) {
    fail(`Invalid DUO RIO education location ${feature.id}`)
  }
  if (frameworks.length) linkedEducationLocations += 1
  for (const framework of frameworks) recomputedFrameworkCounts[framework] += 1
  if (feature.properties.municipalityCode !== null) {
    if (!municipalityCodes.has(feature.properties.municipalityCode)) {
      fail(`DUO RIO location ${feature.id} has invalid municipality ${feature.properties.municipalityCode}`)
    }
    assignedEducationLocations += 1
    educationMunicipalityCodes.add(feature.properties.municipalityCode)
  }
}
if (
  educationLocations.features.length < 12_000 ||
  educationLocations.features.length !== educationLocations.counts?.mapScopeLocations ||
  educationLocations.counts.activeLocationsAtSource - educationLocations.features.length !==
    educationLocations.counts.excludedOutsideEuropeanNetherlands ||
  linkedEducationLocations !== educationLocations.counts.linkedToCurrentRecognition ||
  educationLocations.features.length - linkedEducationLocations !== educationLocations.counts.registeredUseOnly ||
  assignedEducationLocations !== educationLocations.counts.assignedToMunicipalityPolygon ||
  educationLocations.features.length - assignedEducationLocations !== educationLocations.counts.outsideMunicipalityPolygon ||
  educationMunicipalityCodes.size !== 342 ||
  educationLocations.counts.municipalitiesRepresented !== 342 ||
  JSON.stringify(recomputedFrameworkCounts) !== JSON.stringify(educationLocations.counts.byLegalFramework) ||
  new Set(educationLocations.features.map((feature) => feature.id)).size !== educationLocations.features.length
) {
  fail('DUO RIO education-location counts, coverage or IDs are inconsistent')
}

const antennaSiteBuffer = await readFile(
  resolve(dataDirectory, 'public-context/rdi-antenna-sites.geojson.gz'),
)
const antennaSites = JSON.parse(gunzipSync(antennaSiteBuffer).toString('utf8'))
const antennaCategories = new Set([
  'mobile communication',
  'fixed link',
  'broadcast',
  'other mobile',
  'radio amateur',
  'other registered antenna',
])
if (
  antennaSites.type !== 'FeatureCollection' ||
  antennaSites.evidenceClass !== 'official-context' ||
  antennaSites.affectsSimulation !== false ||
  antennaSites.source?.id !== 'rdi-antenneregister-antenna-installations' ||
  antennaSites.source?.collection !== 'ms:Antennes' ||
  !Number.isFinite(Date.parse(antennaSites.source?.retrievedAt)) ||
  !antennaSites.source?.license?.includes('reuse licence not stated') ||
  !antennaSites.source?.coverageNote?.includes('not radio coverage') ||
  antennaSites.source?.rawPages < 2 ||
  !/^[0-9a-f]{64}$/.test(antennaSites.source?.rawSha256 ?? '') ||
  !/^[0-9a-f]{64}$/.test(antennaSites.source?.capabilitiesSha256 ?? '') ||
  antennaSites.processing?.sourceCrs !== 'EPSG:28992' ||
  antennaSites.processing?.outputCrs !== 'EPSG:4326'
) {
  fail('RDI Antenneregister evidence metadata is incomplete or misleading')
}
const antennaMunicipalityCodes = new Set()
const recomputedAntennaCounts = {
  antennasRepresented: 0,
  mobileCommunicationSites: 0,
  fixedLinkSites: 0,
  broadcastSites: 0,
  otherMobileSites: 0,
  radioAmateurSites: 0,
  has2gSites: 0,
  has3gSites: 0,
  has4gSites: 0,
  has5gSites: 0,
  assignedToMunicipalityPolygon: 0,
}
const recomputedAntennaCategories = {}
for (const feature of antennaSites.features) {
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    feature.geometry.coordinates[0] < 2.5 || feature.geometry.coordinates[0] > 7.6 ||
    feature.geometry.coordinates[1] < 50.5 || feature.geometry.coordinates[1] > 56 ||
    feature.properties?.facilityType !== 'antenna-installation' ||
    !antennaCategories.has(feature.properties?.primaryCategory) ||
    !(feature.properties?.antennaCount > 0) ||
    typeof feature.properties?.sourceSiteId !== 'string'
  ) {
    fail(`Invalid RDI antenna installation ${feature.id}`)
  }
  recomputedAntennaCounts.antennasRepresented += feature.properties.antennaCount
  for (const [property, countName] of [
    ['mobileCommunication', 'mobileCommunicationSites'],
    ['fixedLink', 'fixedLinkSites'],
    ['broadcast', 'broadcastSites'],
    ['otherMobile', 'otherMobileSites'],
    ['radioAmateur', 'radioAmateurSites'],
    ['has2g', 'has2gSites'],
    ['has3g', 'has3gSites'],
    ['has4g', 'has4gSites'],
    ['has5g', 'has5gSites'],
  ]) {
    if (feature.properties[property]) recomputedAntennaCounts[countName] += 1
  }
  const category = feature.properties.primaryCategory
  recomputedAntennaCategories[category] = (recomputedAntennaCategories[category] ?? 0) + 1
  if (feature.properties.municipalityCode !== null) {
    if (!municipalityCodes.has(feature.properties.municipalityCode)) {
      fail(`RDI antenna ${feature.id} has invalid municipality ${feature.properties.municipalityCode}`)
    }
    recomputedAntennaCounts.assignedToMunicipalityPolygon += 1
    antennaMunicipalityCodes.add(feature.properties.municipalityCode)
  }
}
if (
  antennaSites.features.length < 20_000 ||
  antennaSites.features.length !== antennaSites.counts?.antennaInstallations ||
  antennaSites.counts.sourceRecords - antennaSites.features.length !==
    antennaSites.counts.duplicateSourceRecordsRemoved ||
  antennaSites.features.length - recomputedAntennaCounts.assignedToMunicipalityPolygon !==
    antennaSites.counts.outsideMunicipalityPolygon ||
  antennaMunicipalityCodes.size !== 342 ||
  antennaSites.counts.municipalitiesRepresented !== 342 ||
  Object.entries(recomputedAntennaCounts).some(([name, value]) => antennaSites.counts[name] !== value) ||
  JSON.stringify(Object.fromEntries(Object.entries(recomputedAntennaCategories).sort())) !==
    JSON.stringify(antennaSites.counts.byPrimaryCategory) ||
  new Set(antennaSites.features.map((feature) => feature.id)).size !== antennaSites.features.length
) {
  fail('RDI Antenneregister counts, coverage or IDs are inconsistent')
}

const airQualityBuffer = await readFile(
  resolve(dataDirectory, 'public-context/rivm-air-quality-pm25.geojson.gz'),
)
const airQuality = JSON.parse(gunzipSync(airQualityBuffer).toString('utf8'))
const airWindowStartMs = Date.parse(airQuality.observationWindow?.requestedStart)
const airWindowEndMs = Date.parse(airQuality.observationWindow?.requestedEnd)
const oldestAirObservationMs = Date.parse(airQuality.observationWindow?.oldestMappedObservation)
const newestAirObservationMs = Date.parse(airQuality.observationWindow?.newestMappedObservation)
const airComponents = ['PM25', 'PM10', 'NO2', 'O3', 'SO2']
if (
  airQuality.type !== 'FeatureCollection' ||
  airQuality.evidenceClass !== 'observed-context' ||
  airQuality.affectsSimulation !== false ||
  airQuality.source?.id !== 'rivm-luchtmeetnet-indicative-pm25' ||
  !airQuality.source?.validationStatus?.includes('indicative') ||
  !airQuality.source?.license?.includes('no standard reuse licence stated') ||
  !airQuality.source?.license?.includes('no rights may be derived') ||
  !airQuality.source?.caveat?.includes('not a national continuous surface') ||
  !/^[0-9a-f]{64}$/.test(airQuality.source?.metadataSha256 ?? '') ||
  !Number.isFinite(Date.parse(airQuality.source?.retrievedAt)) ||
  airQuality.observationWindow?.hours !== 6 ||
  !Number.isFinite(airWindowStartMs) ||
  !Number.isFinite(airWindowEndMs) ||
  !Number.isFinite(oldestAirObservationMs) ||
  !Number.isFinite(newestAirObservationMs) ||
  airWindowEndMs - airWindowStartMs !== 6 * 60 * 60 * 1_000 ||
  oldestAirObservationMs < airWindowStartMs ||
  newestAirObservationMs > airWindowEndMs ||
  oldestAirObservationMs > newestAirObservationMs
) {
  fail('RIVM Luchtmeetnet evidence metadata, observation window or non-causal role is misleading')
}
for (const component of airComponents) {
  const response = airQuality.source?.measurementResponses?.[component]
  if (
    !(response?.pages >= 1) ||
    !(response?.records >= 0) ||
    !/^[0-9a-f]{64}$/.test(response?.sha256 ?? '') ||
    response.records !== airQuality.counts?.measurementsFetched?.[component]
  ) {
    fail(`Invalid RIVM Luchtmeetnet ${component} response manifest`)
  }
}
const airMunicipalityCodes = new Set()
let assignedAirStations = 0
let computedOldestAirObservationMs = Number.POSITIVE_INFINITY
let computedNewestAirObservationMs = Number.NEGATIVE_INFINITY
for (const feature of airQuality.features) {
  const properties = feature.properties ?? {}
  const observationMs = Date.parse(properties.observedAt)
  const intervalStartMs = Date.parse(properties.intervalStart)
  const intervalEndMs = Date.parse(properties.intervalEnd)
  const optionalValues = [
    properties.pm10UgM3,
    properties.no2UgM3,
    properties.o3UgM3,
    properties.so2UgM3,
  ]
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    feature.geometry.coordinates[0] < 2.5 || feature.geometry.coordinates[0] > 8 ||
    feature.geometry.coordinates[1] < 50.5 || feature.geometry.coordinates[1] > 54.5 ||
    !/^NL\d{5}$/.test(properties.stationNumber ?? '') ||
    !Number.isFinite(properties.pm25UgM3) ||
    optionalValues.some((value) => value !== null && !Number.isFinite(value)) ||
    !Number.isFinite(observationMs) ||
    !Number.isFinite(intervalStartMs) ||
    !Number.isFinite(intervalEndMs) ||
    observationMs < airWindowStartMs || observationMs > airWindowEndMs ||
    intervalStartMs > intervalEndMs ||
    intervalEndMs !== observationMs
  ) {
    fail(`Invalid RIVM Luchtmeetnet station observation ${feature.id}`)
  }
  computedOldestAirObservationMs = Math.min(computedOldestAirObservationMs, observationMs)
  computedNewestAirObservationMs = Math.max(computedNewestAirObservationMs, observationMs)
  if (properties.municipalityCode !== null) {
    if (
      !municipalityCodes.has(properties.municipalityCode) ||
      properties.municipalityAssignment !== 'CBS 2025 generalized polygon containment'
    ) {
      fail(`RIVM Luchtmeetnet station ${feature.id} has invalid municipality assignment`)
    }
    assignedAirStations += 1
    airMunicipalityCodes.add(properties.municipalityCode)
  } else if (properties.municipalityAssignment !== 'outside generalized municipality polygon') {
    fail(`RIVM Luchtmeetnet station ${feature.id} has an ambiguous no-data assignment`)
  }
}
if (
  airQuality.features.length < 40 ||
  airQuality.features.length > 150 ||
  airQuality.features.length !== airQuality.counts?.pm25StationsMapped ||
  airQuality.counts.pm25StationsReturned !==
    airQuality.counts.pm25StationsMapped + airQuality.counts.stationsMissingActiveMetadata ||
  assignedAirStations !== airQuality.counts.assignedToMunicipalityPolygon ||
  airQuality.features.length - assignedAirStations !== airQuality.counts.outsideMunicipalityPolygon ||
  airMunicipalityCodes.size !== airQuality.counts.municipalitiesRepresented ||
  computedOldestAirObservationMs !== oldestAirObservationMs ||
  computedNewestAirObservationMs !== newestAirObservationMs ||
  new Set(airQuality.features.map((feature) => feature.id)).size !== airQuality.features.length
) {
  fail('RIVM Luchtmeetnet station counts, municipal coverage, times or IDs are inconsistent')
}

const seismicBuffer = await readFile(
  resolve(dataDirectory, 'public-context/knmi-seismic-events.geojson.gz'),
)
const seismicEvents = JSON.parse(gunzipSync(seismicBuffer).toString('utf8'))
const seismicWindowStartMs = Date.parse(seismicEvents.observationWindow?.requestedStart)
const seismicWindowEndMs = Date.parse(seismicEvents.observationWindow?.requestedEnd)
const seismicOldestMs = Date.parse(seismicEvents.observationWindow?.oldestEvent)
const seismicNewestMs = Date.parse(seismicEvents.observationWindow?.newestEvent)
if (
  seismicEvents.type !== 'FeatureCollection' ||
  seismicEvents.evidenceClass !== 'observed-context' ||
  seismicEvents.affectsSimulation !== false ||
  seismicEvents.source?.id !== 'knmi-fdsn-seismic-events' ||
  seismicEvents.source?.publisher !== 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)' ||
  !seismicEvents.source?.serviceUrl?.startsWith('https://rdsa.knmi.nl/fdsnws/event/1') ||
  !seismicEvents.source?.license?.includes('CC BY 4.0') ||
  !seismicEvents.source?.caveat?.includes('not a ground-motion surface') ||
  !seismicEvents.processing?.noDataRule?.includes('never zero seismic hazard') ||
  seismicEvents.observationWindow?.days !== 365 ||
  !Number.isFinite(seismicWindowStartMs) ||
  !Number.isFinite(seismicWindowEndMs) ||
  seismicWindowEndMs - seismicWindowStartMs !== 365 * 24 * 60 * 60 * 1_000 ||
  !Number.isFinite(Date.parse(seismicEvents.retrievedAt)) ||
  !/^[0-9a-f]{64}$/.test(seismicEvents.source?.responseSha256 ?? '') ||
  !(seismicEvents.source?.responseBytes > 1_000)
) {
  fail('KNMI seismic-event evidence metadata or non-causal role is incomplete')
}
const allowedSeismicTypes = new Set(['earthquake', 'induced or triggered event'])
const seismicMunicipalityCodes = new Set()
const recomputedSeismicTypes = { earthquake: 0, 'induced or triggered event': 0 }
const recomputedSeismicReviews = {}
let assignedSeismicEvents = 0
let computedOldestSeismicMs = Number.POSITIVE_INFINITY
let computedNewestSeismicMs = Number.NEGATIVE_INFINITY
for (const feature of seismicEvents.features) {
  const properties = feature.properties ?? {}
  const coordinates = feature.geometry?.coordinates ?? []
  const observedAtMs = Date.parse(properties.observedAt)
  if (
    feature.geometry?.type !== 'Point' ||
    coordinates.length !== 2 ||
    !coordinates.every(Number.isFinite) ||
    coordinates[0] < seismicEvents.bounds.west || coordinates[0] > seismicEvents.bounds.east ||
    coordinates[1] < seismicEvents.bounds.south || coordinates[1] > seismicEvents.bounds.north ||
    !allowedSeismicTypes.has(properties.eventType) ||
    !Number.isFinite(properties.magnitude) ||
    !Number.isFinite(properties.depthKm) ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs < seismicWindowStartMs || observedAtMs > seismicWindowEndMs ||
    typeof properties.eventId !== 'string' || !properties.eventId ||
    feature.id !== `knmi-event-${properties.eventId.toLowerCase()}` ||
    typeof properties.reviewStatus !== 'string' || !properties.reviewStatus
  ) {
    fail(`Invalid KNMI seismic event ${feature.id}`)
  }
  recomputedSeismicTypes[properties.eventType] += 1
  recomputedSeismicReviews[properties.reviewStatus] =
    (recomputedSeismicReviews[properties.reviewStatus] ?? 0) + 1
  computedOldestSeismicMs = Math.min(computedOldestSeismicMs, observedAtMs)
  computedNewestSeismicMs = Math.max(computedNewestSeismicMs, observedAtMs)
  if (properties.municipalityCode !== null) {
    if (
      !municipalityCodes.has(properties.municipalityCode) ||
      properties.municipalityAssignment !== 'CBS 2025 generalized polygon containment'
    ) {
      fail(`KNMI seismic event ${feature.id} has invalid municipality assignment`)
    }
    assignedSeismicEvents += 1
    seismicMunicipalityCodes.add(properties.municipalityCode)
  } else if (properties.municipalityAssignment !== 'outside generalized municipality polygon') {
    fail(`KNMI seismic event ${feature.id} has ambiguous outside-coverage semantics`)
  }
}
if (
  seismicEvents.features.length < 10 ||
  seismicEvents.features.length > 300 ||
  seismicEvents.features.length !== seismicEvents.counts?.includedSeismicEvents ||
  seismicEvents.counts.sourceEvents !==
    seismicEvents.counts.includedSeismicEvents + seismicEvents.counts.excludedNonSeismicEvents ||
  !numericRecordsEqual(recomputedSeismicTypes, seismicEvents.counts.byEventType) ||
  !numericRecordsEqual(recomputedSeismicReviews, seismicEvents.counts.byReviewStatus) ||
  assignedSeismicEvents !== seismicEvents.counts.assignedToMunicipalityPolygon ||
  seismicEvents.features.length - assignedSeismicEvents !== seismicEvents.counts.outsideMunicipalityPolygon ||
  seismicMunicipalityCodes.size !== seismicEvents.counts.municipalitiesRepresented ||
  computedOldestSeismicMs !== seismicOldestMs ||
  computedNewestSeismicMs !== seismicNewestMs ||
  new Set(seismicEvents.features.map((feature) => feature.id)).size !== seismicEvents.features.length
) {
  fail('KNMI seismic-event counts, coverage, times or IDs are inconsistent')
}

const waterinfoBuffer = await readFile(
  resolve(dataDirectory, 'public-context/rws-waterinfo-observations.geojson.gz'),
)
const waterinfo = JSON.parse(gunzipSync(waterinfoBuffer).toString('utf8'))
const waterinfoRetrievalMs = Date.parse(waterinfo.retrievedAt)
if (
  waterinfo.type !== 'FeatureCollection' ||
  waterinfo.evidenceClass !== 'observed-context' ||
  waterinfo.affectsSimulation !== false ||
  waterinfo.source?.id !== 'rws-waterinfo-latest-water-level-discharge' ||
  waterinfo.source?.publisher !== 'Rijkswaterstaat' ||
  !waterinfo.source?.license?.startsWith('CC0') ||
  !waterinfo.source?.serviceLevel?.includes('not a mission-critical') ||
  !waterinfo.source?.caveat?.includes('not a hydraulic surface') ||
  !waterinfo.processing?.noDataRule?.includes('never converted to a zero') ||
  waterinfo.processing?.sourceCrs !== 'EPSG:25831' ||
  waterinfo.processing?.outputCrs !== 'EPSG:4326' ||
  !Number.isFinite(waterinfoRetrievalMs)
) {
  fail('Rijkswaterstaat Waterinfo evidence metadata or non-causal role is incomplete')
}
for (const endpoint of ['waterhoogte', 'waterafvoer']) {
  const response = waterinfo.source?.responses?.[endpoint]
  if (
    !response?.url?.startsWith('https://waterinfo.rws.nl/api/point/latestmeasurement') ||
    !Number.isFinite(Date.parse(response?.responseTime)) ||
    !response?.cacheControl?.includes('max-age=300') ||
    !(response?.sourceLocations > 0) ||
    !(response?.bytes > 1_000) ||
    !/^[0-9a-f]{64}$/.test(response?.sha256 ?? '') ||
    response.sourceLocations !== waterinfo.counts?.sourceLocations?.[endpoint]
  ) {
    fail(`Invalid Rijkswaterstaat Waterinfo ${endpoint} response manifest`)
  }
}
const recomputedWaterinfoFreshness = { fresh: 0, delayed: 0, stale: 0 }
const waterinfoMunicipalityCodes = new Set()
const waterinfoIdentityCounts = new Map()
let recomputedWaterLevels = 0
let recomputedDischarges = 0
let recomputedFaultyWaterinfo = 0
let assignedWaterinfo = 0
let oldestWaterinfoMs = Number.POSITIVE_INFINITY
let newestWaterinfoMs = Number.NEGATIVE_INFINITY
for (const feature of waterinfo.features) {
  const properties = feature.properties ?? {}
  const observedAtMs = Date.parse(properties.observedAt)
  const computedAgeMinutes = Math.max(0, Math.round((waterinfoRetrievalMs - observedAtMs) / 60_000))
  const computedFreshness = computedAgeMinutes <= 90
    ? 'fresh'
    : computedAgeMinutes <= 360
      ? 'delayed'
      : 'stale'
  const validTypeAndUnit =
    (properties.observationType === 'water-level' &&
      properties.endpointParameter === 'waterhoogte' && properties.unitCode === 'cm') ||
    (properties.observationType === 'discharge' &&
      properties.endpointParameter === 'waterafvoer' && properties.unitCode === 'm3/s')
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    feature.geometry.coordinates[0] < 2.5 || feature.geometry.coordinates[0] > 8 ||
    feature.geometry.coordinates[1] < 50.5 || feature.geometry.coordinates[1] > 56 ||
    !validTypeAndUnit ||
    typeof properties.locationCode !== 'string' ||
    !properties.locationCode ||
    typeof properties.name !== 'string' ||
    !properties.name ||
    !Number.isFinite(properties.latestValue) ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs > waterinfoRetrievalMs + 60_000 ||
    properties.ageMinutesAtRetrieval !== computedAgeMinutes ||
    properties.freshness !== computedFreshness ||
    (properties.measurementColor !== null &&
      !/^#[0-9a-f]{6}$/i.test(properties.measurementColor))
  ) {
    fail(`Invalid Rijkswaterstaat Waterinfo observation ${feature.id}`)
  }
  recomputedWaterinfoFreshness[computedFreshness] += 1
  const waterinfoIdentity = [
    properties.observationType,
    properties.locationCode,
    properties.sourceParameterId,
    properties.verticalDatum,
  ].join('|')
  waterinfoIdentityCounts.set(
    waterinfoIdentity,
    (waterinfoIdentityCounts.get(waterinfoIdentity) ?? 0) + 1,
  )
  if (properties.observationType === 'water-level') recomputedWaterLevels += 1
  else recomputedDischarges += 1
  if (properties.possiblyFaulty) recomputedFaultyWaterinfo += 1
  oldestWaterinfoMs = Math.min(oldestWaterinfoMs, observedAtMs)
  newestWaterinfoMs = Math.max(newestWaterinfoMs, observedAtMs)
  if (properties.municipalityCode !== null) {
    if (
      !municipalityCodes.has(properties.municipalityCode) ||
      properties.municipalityAssignment !== 'CBS 2025 generalized polygon containment'
    ) {
      fail(`Waterinfo observation ${feature.id} has invalid municipality assignment`)
    }
    assignedWaterinfo += 1
    waterinfoMunicipalityCodes.add(properties.municipalityCode)
  } else if (properties.municipalityAssignment !== 'outside generalized municipality polygon') {
    fail(`Waterinfo observation ${feature.id} has ambiguous outside-coverage semantics`)
  }
}
if (
  waterinfo.features.length < 250 ||
  waterinfo.features.length > 500 ||
  waterinfo.features.length !== waterinfo.counts?.observations ||
  recomputedWaterLevels !== waterinfo.counts.waterLevelObservations ||
  recomputedDischarges !== waterinfo.counts.dischargeObservations ||
  recomputedWaterLevels + recomputedDischarges !== waterinfo.features.length ||
  JSON.stringify(recomputedWaterinfoFreshness) !== JSON.stringify(waterinfo.counts.freshness) ||
  recomputedFaultyWaterinfo !== waterinfo.counts.possiblyFaultyObservations ||
  [...waterinfoIdentityCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0) !==
    waterinfo.counts.duplicateObservationIdentities ||
  assignedWaterinfo !== waterinfo.counts.assignedToMunicipalityPolygon ||
  waterinfo.features.length - assignedWaterinfo !== waterinfo.counts.outsideMunicipalityPolygon ||
  waterinfoMunicipalityCodes.size !== waterinfo.counts.municipalitiesRepresented ||
  oldestWaterinfoMs !== Date.parse(waterinfo.observationRange?.oldest) ||
  newestWaterinfoMs !== Date.parse(waterinfo.observationRange?.newest) ||
  new Set(waterinfo.features.map((feature) => feature.id)).size !== waterinfo.features.length
) {
  fail('Rijkswaterstaat Waterinfo counts, freshness, coverage, times or IDs are inconsistent')
}

const waterForecastBuffer = await readFile(
  resolve(dataDirectory, 'public-context/rws-waterinfo-forecasts.geojson.gz'),
)
const waterForecasts = JSON.parse(gunzipSync(waterForecastBuffer).toString('utf8'))
const waterForecastRetrievalMs = Date.parse(waterForecasts.retrievedAt)
if (
  waterForecasts.type !== 'FeatureCollection' ||
  waterForecasts.evidenceClass !== 'official-forecast' ||
  waterForecasts.affectsSimulation !== false ||
  waterForecasts.issueTime !== null ||
  !waterForecasts.issueTimeStatus?.includes('does not publish one model-cycle issue time') ||
  waterForecasts.source?.id !== 'rws-waterinfo-rolling-water-level-discharge-forecasts' ||
  waterForecasts.source?.publisher !== 'Rijkswaterstaat' ||
  !waterForecasts.source?.license?.startsWith('CC0 1.0') ||
  !waterForecasts.source?.serviceContract?.includes('not documented as a stable external API') ||
  !waterForecasts.source?.caveat?.includes('An empty horizon is NoData') ||
  !waterForecasts.processing?.noDataRule?.includes('never converted to zero') ||
  waterForecasts.processing?.sourceCrs !== 'EPSG:25831' ||
  waterForecasts.processing?.outputCrs !== 'EPSG:4326' ||
  !Number.isFinite(waterForecastRetrievalMs)
) {
  fail('Rijkswaterstaat Waterinfo forecast evidence metadata or non-causal role is incomplete')
}

const expectedWaterForecastWindows = [
  { startHours: 0, endHours: 1 },
  { startHours: 5, endHours: 6 },
  { startHours: 11, endHours: 12 },
  { startHours: 23, endHours: 24 },
  { startHours: 47, endHours: 48 },
  { startHours: 71, endHours: 72 },
]
if (
  JSON.stringify(waterForecasts.processing?.checkpointWindows) !==
  JSON.stringify(expectedWaterForecastWindows)
) {
  fail('Rijkswaterstaat Waterinfo forecast checkpoint contract changed')
}

const expectedWaterForecastSnapshots = new Map()
for (const forecastDefinition of [
  { forecastType: 'water-level', mapType: 'waterhoogte', unitCode: 'cm' },
  { forecastType: 'discharge', mapType: 'waterafvoer', unitCode: 'm3/s' },
]) {
  for (const window of expectedWaterForecastWindows) {
    const id = `${forecastDefinition.forecastType}-t${String(window.endHours).padStart(2, '0')}`
    expectedWaterForecastSnapshots.set(id, { ...forecastDefinition, ...window })
  }
}
if (
  waterForecasts.snapshots?.length !== expectedWaterForecastSnapshots.size ||
  new Set(waterForecasts.snapshots?.map((snapshot) => snapshot.id)).size !==
    expectedWaterForecastSnapshots.size
) {
  fail('Rijkswaterstaat Waterinfo forecast snapshot manifest is incomplete or duplicated')
}

const waterForecastSnapshots = new Map()
for (const snapshot of waterForecasts.snapshots) {
  const expected = expectedWaterForecastSnapshots.get(snapshot.id)
  const response = waterForecasts.source?.responses?.[snapshot.id]
  let responseUrl
  try {
    responseUrl = new URL(response?.url)
  } catch {
    responseUrl = null
  }
  if (
    !expected ||
    snapshot.forecastType !== expected.forecastType ||
    snapshot.mapType !== expected.mapType ||
    snapshot.requestedLeadStartHours !== expected.startHours ||
    snapshot.requestedLeadEndHours !== expected.endHours ||
    !Number.isInteger(snapshot.returnedFeatures) ||
    snapshot.returnedFeatures < 0 ||
    !Number.isInteger(snapshot.sourceMeasurements) ||
    snapshot.sourceMeasurements < snapshot.returnedFeatures ||
    snapshot.assignedToMunicipalityPolygon + snapshot.outsideMunicipalityPolygon !==
      snapshot.returnedFeatures ||
    snapshot.noData !== (response?.sourceFeatureCount === 0) ||
    (snapshot.noData &&
      (snapshot.returnedFeatures !== 0 || snapshot.sourceMeasurements !== 0 ||
        snapshot.validTimeRange !== null)) ||
    (!snapshot.noData && snapshot.returnedFeatures === 0) ||
    responseUrl?.origin !== 'https://waterinfo.rws.nl' ||
    responseUrl?.pathname !== '/api/forecast/maptype' ||
    responseUrl?.searchParams.get('mapType') !== expected.mapType ||
    Number(responseUrl?.searchParams.get('start')) !== expected.startHours ||
    Number(responseUrl?.searchParams.get('end')) !== expected.endHours ||
    (response?.responseTime !== null && !Number.isFinite(Date.parse(response?.responseTime))) ||
    !(response?.bytes > 200) ||
    !/^[0-9a-f]{64}$/.test(response?.sha256 ?? '') ||
    !response?.forecastParameterKeys?.some((key) => key.toLowerCase().includes('verwachting'))
  ) {
    fail(`Invalid Rijkswaterstaat Waterinfo forecast snapshot ${snapshot.id}`)
  }
  waterForecastSnapshots.set(snapshot.id, { snapshot, expected })
}

const recomputedWaterForecastCounts = { 'water-level': 0, discharge: 0 }
const recomputedWaterForecastMunicipalities = new Set()
const recomputedWaterForecastSnapshotCounts = new Map()
let earliestWaterForecastMs = Number.POSITIVE_INFINITY
let latestWaterForecastMs = Number.NEGATIVE_INFINITY
for (const feature of waterForecasts.features) {
  const properties = feature.properties ?? {}
  const snapshotEntry = waterForecastSnapshots.get(properties.snapshotId)
  const validAtMs = Date.parse(properties.validAt)
  const validTypeAndUnit =
    (properties.forecastType === 'water-level' &&
      properties.mapType === 'waterhoogte' && properties.unitCode === 'cm') ||
    (properties.forecastType === 'discharge' &&
      properties.mapType === 'waterafvoer' && properties.unitCode === 'm3/s')
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    feature.geometry.coordinates[0] < 2.5 || feature.geometry.coordinates[0] > 8 ||
    feature.geometry.coordinates[1] < 50.5 || feature.geometry.coordinates[1] > 56 ||
    !snapshotEntry ||
    !validTypeAndUnit ||
    properties.forecastType !== snapshotEntry.expected.forecastType ||
    properties.mapType !== snapshotEntry.expected.mapType ||
    properties.requestedLeadStartHours !== snapshotEntry.expected.startHours ||
    properties.requestedLeadEndHours !== snapshotEntry.expected.endHours ||
    typeof properties.locationCode !== 'string' || !properties.locationCode ||
    typeof properties.name !== 'string' || !properties.name ||
    !Number.isFinite(properties.value) ||
    !Number.isFinite(validAtMs) ||
    validAtMs < waterForecastRetrievalMs - 15 * 60_000 ||
    validAtMs > waterForecastRetrievalMs + 73 * 60 * 60_000 ||
    typeof properties.sourceParameterId !== 'string' || !properties.sourceParameterId ||
    typeof properties.forecastParameterId !== 'string' ||
    !properties.forecastParameterId.toLowerCase().includes('verwachting') ||
    (properties.measurementColor !== null &&
      !/^#[0-9a-f]{6}$/i.test(properties.measurementColor))
  ) {
    fail(`Invalid Rijkswaterstaat Waterinfo forecast feature ${feature.id}`)
  }
  recomputedWaterForecastCounts[properties.forecastType] += 1
  recomputedWaterForecastSnapshotCounts.set(
    properties.snapshotId,
    (recomputedWaterForecastSnapshotCounts.get(properties.snapshotId) ?? 0) + 1,
  )
  earliestWaterForecastMs = Math.min(earliestWaterForecastMs, validAtMs)
  latestWaterForecastMs = Math.max(latestWaterForecastMs, validAtMs)
  if (properties.municipalityCode !== null) {
    if (
      !municipalityCodes.has(properties.municipalityCode) ||
      properties.municipalityAssignment !== 'CBS 2025 generalized polygon containment'
    ) {
      fail(`Waterinfo forecast ${feature.id} has invalid municipality assignment`)
    }
    recomputedWaterForecastMunicipalities.add(properties.municipalityCode)
  } else if (properties.municipalityAssignment !== 'outside generalized municipality polygon') {
    fail(`Waterinfo forecast ${feature.id} has ambiguous outside-coverage semantics`)
  }
}

for (const [snapshotId, { snapshot }] of waterForecastSnapshots) {
  const snapshotFeatures = waterForecasts.features.filter(
    (feature) => feature.properties.snapshotId === snapshotId,
  )
  const snapshotTimes = snapshotFeatures.map((feature) => Date.parse(feature.properties.validAt))
  if (
    (recomputedWaterForecastSnapshotCounts.get(snapshotId) ?? 0) !== snapshot.returnedFeatures ||
    (snapshotTimes.length > 0 &&
      (Math.min(...snapshotTimes) !== Date.parse(snapshot.validTimeRange?.earliest) ||
        Math.max(...snapshotTimes) !== Date.parse(snapshot.validTimeRange?.latest)))
  ) {
    fail(`Rijkswaterstaat Waterinfo forecast ${snapshotId} counts or valid times disagree`)
  }
}

if (
  waterForecasts.features.length < 100 ||
  waterForecasts.features.length !== waterForecasts.counts?.forecasts ||
  recomputedWaterForecastCounts['water-level'] !== waterForecasts.counts.waterLevelForecasts ||
  recomputedWaterForecastCounts.discharge !== waterForecasts.counts.dischargeForecasts ||
  recomputedWaterForecastMunicipalities.size !== waterForecasts.counts.municipalitiesRepresented ||
  earliestWaterForecastMs !== Date.parse(waterForecasts.validTimeRange?.earliest) ||
  latestWaterForecastMs !== Date.parse(waterForecasts.validTimeRange?.latest) ||
  new Set(waterForecasts.features.map((feature) => feature.id)).size !==
    waterForecasts.features.length ||
  !(waterForecastSnapshots.get('water-level-t01')?.snapshot.returnedFeatures > 0) ||
  !(waterForecastSnapshots.get('discharge-t01')?.snapshot.returnedFeatures > 0)
) {
  fail('Rijkswaterstaat Waterinfo forecast counts, coverage, times or IDs are inconsistent')
}

const capacityContextBuffer = await readFile(
  resolve(dataDirectory, 'public-context/nbnl-capacity-samples.geojson.gz'),
)
const capacityContext = JSON.parse(gunzipSync(capacityContextBuffer).toString('utf8'))
if (
  capacityContext.type !== 'FeatureCollection' ||
  capacityContext.evidenceClass !== 'official-context' ||
  capacityContext.affectsSimulation !== false ||
  capacityContext.source?.id !== 'nbnl-capacity-map-municipality-samples' ||
  capacityContext.source?.publisher !== 'Netbeheer Nederland / Partners in Energie' ||
  !capacityContext.source?.mapUrl?.startsWith('https://data.partnersinenergie.nl/capaciteitskaart/') ||
  !capacityContext.source?.apiFindUrl?.endsWith('/api/servicearea/find') ||
  !capacityContext.source?.apiGetUrl?.endsWith('/api/servicearea/get') ||
  !capacityContext.source?.accessMethod?.includes('not contractually documented') ||
  !capacityContext.source?.license?.includes('exact dataset licence identifier was not found') ||
  !capacityContext.source?.caveat?.includes('not outage telemetry') ||
  !capacityContext.sampling?.noDataRule?.includes('never converted to zero') ||
  !capacityContext.sampling?.geometrySemantics?.includes('not a substation') ||
  !Number.isFinite(Date.parse(capacityContext.retrievedAt))
) {
  fail('Netbeheer Nederland capacity-context metadata or non-causal role is incomplete')
}
const capacityMunicipalities = new Set()
let sampledCapacityMunicipalities = 0
let noCapacityMatch = 0
for (const feature of capacityContext.features) {
  const properties = feature.properties ?? {}
  const nullableMetrics = [
    properties.existingWithdrawalMw,
    properties.requiredWithdrawalMw,
    properties.queueWithdrawalMw,
    properties.uniqueRequestsWithdrawal,
    properties.existingInjectionMw,
    properties.requiredInjectionMw,
    properties.queueInjectionMw,
    properties.uniqueRequestsInjection,
    properties.projectCount,
    properties.earliestProjectYear,
  ]
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    !municipalityCodes.has(properties.municipalityCode) ||
    !/^\d{4}[A-Z]{2}$/.test(properties.samplePostcode ?? '') ||
    !['sampled', 'no-published-match'].includes(properties.sampleStatus) ||
    nullableMetrics.some((value) => value !== null && (!Number.isFinite(value) || value < 0)) ||
    (properties.tennetWithdrawalClass !== null &&
      ![-1, 0, 1, 2, 3].includes(properties.tennetWithdrawalClass)) ||
    (properties.tennetInjectionClass !== null &&
      ![-1, 0, 1, 2, 3].includes(properties.tennetInjectionClass))
  ) {
    fail(`Invalid Netbeheer Nederland municipality sample ${feature.id}`)
  }
  if (capacityMunicipalities.has(properties.municipalityCode)) {
    fail(`Duplicate Netbeheer Nederland municipality sample ${properties.municipalityCode}`)
  }
  capacityMunicipalities.add(properties.municipalityCode)
  if (properties.sampleStatus === 'sampled') {
    sampledCapacityMunicipalities += 1
    if (
      typeof properties.serviceAreaId !== 'string' ||
      !properties.serviceAreaId ||
      typeof properties.regionalGridOperator !== 'string' ||
      !properties.regionalGridOperator
    ) {
      fail(`Incomplete sampled Netbeheer Nederland context ${feature.id}`)
    }
  } else {
    noCapacityMatch += 1
    if (
      properties.serviceAreaId !== null ||
      properties.regionalGridOperator !== null ||
      nullableMetrics.some((value) => value !== null)
    ) {
      fail(`Netbeheer Nederland no-match feature fabricates values ${feature.id}`)
    }
  }
}
if (
  capacityContext.features.length !== municipalityCodes.size ||
  capacityMunicipalities.size !== municipalityCodes.size ||
  sampledCapacityMunicipalities < 300 ||
  sampledCapacityMunicipalities !== capacityContext.counts?.sampledMunicipalities ||
  noCapacityMatch !== capacityContext.counts?.noPublishedMatch ||
  sampledCapacityMunicipalities + noCapacityMatch !== capacityContext.features.length ||
  new Set(capacityContext.features.map((feature) => feature.id)).size !==
    capacityContext.features.length
) {
  fail('Netbeheer Nederland capacity-context counts, coverage or IDs are inconsistent')
}

const gtsFlowBuffer = await readFile(
  resolve(dataDirectory, 'public-context/entsog-gts-physical-flow.json.gz'),
)
const gtsFlow = JSON.parse(gunzipSync(gtsFlowBuffer).toString('utf8'))
const gtsPeriodFrom = Date.parse(gtsFlow.observationPeriod?.from)
const gtsPeriodTo = Date.parse(gtsFlow.observationPeriod?.to)
const gtsRetrievedAt = Date.parse(gtsFlow.source?.retrievedAt)
if (
  gtsFlow.evidenceClass !== 'observed-context' ||
  gtsFlow.affectsSimulation !== false ||
  gtsFlow.operator?.key !== 'NL-TSO-0001' ||
  gtsFlow.operator?.label !== 'GTS' ||
  gtsFlow.source?.id !== 'entsog-gts-hourly-physical-flow' ||
  !gtsFlow.source?.apiUrl?.startsWith('https://transparency.entsog.eu/api/v1/operationaldatas?') ||
  !gtsFlow.source?.termsUrl?.startsWith('https://transparency.entsog.eu/') ||
  !gtsFlow.source?.disclaimerUrl?.startsWith('https://transparency.entsog.eu/') ||
  !gtsFlow.source?.gtsExplanationUrl?.startsWith('https://www.gasunietransportservices.nl/') ||
  !gtsFlow.source?.terms?.includes('no standard open-data licence is claimed') ||
  !gtsFlow.source?.noDataRule?.includes('numeric zero is retained') ||
  !gtsFlow.source?.geometrySemantics?.includes('No point geometry is drawn') ||
  !gtsFlow.source?.role?.includes('never used to infer municipal distribution') ||
  !Number.isInteger(gtsFlow.source?.rawBytes) ||
  gtsFlow.source.rawBytes < 10_000 ||
  !/^[a-f0-9]{64}$/.test(gtsFlow.source?.rawSha256 ?? '') ||
  !Number.isFinite(gtsPeriodFrom) ||
  !Number.isFinite(gtsPeriodTo) ||
  !Number.isFinite(gtsRetrievedAt) ||
  gtsPeriodTo - gtsPeriodFrom !== 60 * 60 * 1_000 ||
  gtsPeriodTo > gtsRetrievedAt + 60_000 ||
  !['fresh', 'delayed', 'stale'].includes(gtsFlow.freshness?.statusAtRetrieval)
) {
  fail('ENTSOG GTS flow evidence metadata or non-causal role is incomplete')
}
const gtsIds = new Set()
const gtsPointKeys = new Set()
const gtsFlowStatuses = {}
let gtsZeroFlows = 0
let precedingGtsValue = Number.POSITIVE_INFINITY
for (const record of gtsFlow.records ?? []) {
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.pointKey !== 'string' ||
    !record.pointKey ||
    typeof record.pointLabel !== 'string' ||
    !record.pointLabel ||
    typeof record.direction !== 'string' ||
    !record.direction ||
    !Number.isFinite(record.valueKwhPerHour) ||
    record.valueKwhPerHour < 0 ||
    record.periodFrom !== gtsFlow.observationPeriod.from ||
    record.periodTo !== gtsFlow.observationPeriod.to ||
    typeof record.flowStatus !== 'string' ||
    !record.flowStatus ||
    record.valueKwhPerHour > precedingGtsValue
  ) {
    fail(`Invalid ENTSOG GTS directional record ${String(record.id)}`)
  }
  if (gtsIds.has(record.id)) fail(`Duplicate ENTSOG GTS directional record ${record.id}`)
  gtsIds.add(record.id)
  gtsPointKeys.add(record.pointKey)
  if (record.valueKwhPerHour === 0) gtsZeroFlows += 1
  gtsFlowStatuses[record.flowStatus] = (gtsFlowStatuses[record.flowStatus] ?? 0) + 1
  precedingGtsValue = record.valueKwhPerHour
}
if (
  gtsFlow.records.length < 20 ||
  gtsFlow.records.length > 150 ||
  gtsFlow.records.length !== gtsFlow.counts?.numericDirectionalRecords ||
  gtsPointKeys.size !== gtsFlow.counts?.uniquePointKeys ||
  gtsZeroFlows !== gtsFlow.counts?.zeroDirectionalRecords ||
  gtsFlow.counts.recordsAtObservationHour !==
    gtsFlow.counts.numericDirectionalRecords + gtsFlow.counts.missingOrNaAtObservationHour ||
  !numericRecordsEqual(gtsFlowStatuses, gtsFlow.counts?.byFlowStatus)
) {
  fail('ENTSOG GTS flow counts, point identities, zero semantics or ordering are inconsistent')
}

const roadSituationBuffer = await readFile(
  resolve(dataDirectory, 'public-context/ndw-road-situations.geojson.gz'),
)
const roadSituations = JSON.parse(gunzipSync(roadSituationBuffer).toString('utf8'))
const roadPublicationMs = Date.parse(roadSituations.source?.publicationTime)
const roadHorizonMs = roadPublicationMs + 72 * 60 * 60 * 1_000
if (
  roadSituations.type !== 'FeatureCollection' ||
  roadSituations.evidenceClass !== 'observed-context' ||
  roadSituations.affectsSimulation !== false ||
  roadSituations.source?.id !== 'ndw-datex3-current-situations' ||
  roadSituations.source?.validityWindowHours !== 72 ||
  !Number.isFinite(roadPublicationMs) ||
  !Number.isFinite(Date.parse(roadSituations.source?.retrievedAt))
) {
  fail('NDW road-situation evidence metadata is incomplete or misleading')
}
if (
  roadSituations.features.length < 1_000 ||
  new Set(roadSituations.features.map((feature) => feature.id)).size !==
    roadSituations.features.length
) {
  fail('NDW road-situation snapshot is unexpectedly small or contains duplicate IDs')
}
for (const feature of roadSituations.features) {
  const coordinates = feature.geometry?.type === 'Point'
    ? [feature.geometry.coordinates]
    : feature.geometry?.type === 'LineString'
      ? feature.geometry.coordinates
      : []
  const startMs = feature.properties?.startTime
    ? Date.parse(feature.properties.startTime)
    : null
  const endMs = feature.properties?.endTime
    ? Date.parse(feature.properties.endTime)
    : null
  if (
    coordinates.length === 0 ||
    coordinates.some(([longitude, latitude]) =>
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      longitude < 2.5 || longitude > 8 ||
      latitude < 50.5 || latitude > 54
    ) ||
    feature.properties?.informationStatus !== 'real' ||
    feature.properties?.confidentiality !== 'noRestriction' ||
    (startMs !== null && (!Number.isFinite(startMs) || startMs > roadHorizonMs)) ||
    (endMs !== null && (!Number.isFinite(endMs) || endMs < roadPublicationMs))
  ) {
    fail(`Invalid or out-of-window NDW road situation ${feature.id}`)
  }
}

const radarMetadata = await readJson(
  resolve(dataDirectory, 'public-context/knmi-radar.json'),
)
const radarImage = await readFile(
  resolve(dataDirectory, 'public-context/knmi-radar.png'),
)
const radarObservationMs = Date.parse(radarMetadata.observationTime)
const radarRetrievalMs = Date.parse(radarMetadata.retrievedAt)
const radarDigest = createHash('sha256').update(radarImage).digest('hex')
const expectedRadarBounds = { west: 3.2, south: 50.7, east: 7.3, north: 53.7 }
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
if (
  radarMetadata.evidenceClass !== 'observed-context' ||
  radarMetadata.affectsSimulation !== false ||
  radarMetadata.source?.id !== 'knmi-radar-reflectivity-composites-2.0' ||
  radarMetadata.source?.license !== 'CC BY 4.0' ||
  radarMetadata.source?.updateCadence !== '5 minutes' ||
  !radarMetadata.source?.temporalCoverage?.endsWith('/PT5M') ||
  radarMetadata.imageRequest?.crs !== 'EPSG:3857' ||
  radarMetadata.imageRequest?.width !== 1_024 ||
  radarMetadata.imageRequest?.height !== 1_024 ||
  !Number.isFinite(radarObservationMs) ||
  !Number.isFinite(radarRetrievalMs) ||
  radarObservationMs > radarRetrievalMs ||
  radarRetrievalMs - radarObservationMs > 60 * 60 * 1_000 ||
  JSON.stringify(radarMetadata.bounds) !== JSON.stringify(expectedRadarBounds)
) {
  fail('KNMI radar evidence metadata is incomplete, stale or misleading')
}
if (
  radarImage.length < 24 ||
  !radarImage.subarray(0, pngSignature.length).equals(pngSignature) ||
  radarImage.readUInt32BE(16) !== 1_024 ||
  radarImage.readUInt32BE(20) !== 1_024 ||
  radarMetadata.image?.width !== 1_024 ||
  radarMetadata.image?.height !== 1_024 ||
  radarMetadata.image?.bytes !== radarImage.length ||
  radarMetadata.image?.sha256 !== radarDigest ||
  radarMetadata.image?.layer !== 'precipitation'
) {
  fail('KNMI radar PNG does not match its declared dimensions, bytes or checksum')
}

const precipitationProbability = await readJson(
  resolve(dataDirectory, 'public-context/knmi-precipitation-probability.json'),
)
const precipitationReferenceMs = Date.parse(precipitationProbability.referenceTime)
const precipitationRetrievalMs = Date.parse(precipitationProbability.retrievedAt)
const expectedPrecipitationLeads = [1, 3, 6]
if (
  precipitationProbability.evidenceClass !== 'official-forecast' ||
  precipitationProbability.affectsSimulation !== false ||
  precipitationProbability.thresholdMmH !== 3 ||
  precipitationProbability.source?.id !==
    'seamless_precipitation_ensemble_forecast_probabilities-1.0' ||
  precipitationProbability.source?.publisher !==
    'Koninklijk Nederlands Meteorologisch Instituut (KNMI)' ||
  precipitationProbability.source?.license !== 'CC BY 4.0' ||
  precipitationProbability.source?.productStatus !== 'pilot' ||
  precipitationProbability.source?.updateCadence !== '5 minutes' ||
  precipitationProbability.source?.forecastHorizonHours !== 6 ||
  precipitationProbability.source?.gridResolutionKm !== 1 ||
  !precipitationProbability.source?.thresholdOptionsMmH?.includes(3) ||
  !precipitationProbability.source?.noDataSemantics?.includes('NoData/unknown') ||
  !precipitationProbability.source?.caveat?.includes('not extrapolated to T+72') ||
  !Number.isFinite(precipitationReferenceMs) ||
  !Number.isFinite(precipitationRetrievalMs) ||
  precipitationReferenceMs > precipitationRetrievalMs ||
  precipitationRetrievalMs - precipitationReferenceMs > 2 * 60 * 60 * 1_000 ||
  JSON.stringify(precipitationProbability.bounds) !== JSON.stringify(expectedRadarBounds) ||
  precipitationProbability.imageRequest?.crs !== 'EPSG:3857' ||
  precipitationProbability.imageRequest?.width !== 1_024 ||
  precipitationProbability.imageRequest?.height !== 1_024 ||
  JSON.stringify(precipitationProbability.checkpoints?.map(({ leadHours }) => leadHours)) !==
    JSON.stringify(expectedPrecipitationLeads)
) {
  fail('KNMI precipitation-probability metadata is incomplete, stale or misleading')
}

for (const checkpoint of precipitationProbability.checkpoints) {
  const image = await readFile(resolve(dataDirectory, checkpoint.path.replace(/^data\//, '')))
  const validTimeMs = Date.parse(checkpoint.validTime)
  const digest = createHash('sha256').update(image).digest('hex')
  if (
    validTimeMs !== precipitationReferenceMs + checkpoint.leadHours * 60 * 60 * 1_000 ||
    image.length < 24 ||
    !image.subarray(0, pngSignature.length).equals(pngSignature) ||
    image.readUInt32BE(16) !== 1_024 ||
    image.readUInt32BE(20) !== 1_024 ||
    checkpoint.width !== 1_024 ||
    checkpoint.height !== 1_024 ||
    checkpoint.bytes !== image.length ||
    checkpoint.sha256 !== digest ||
    checkpoint.path !==
      `data/public-context/knmi-precipitation-probability-t-plus-${checkpoint.leadHours}.png`
  ) {
    fail(`Invalid KNMI precipitation-probability T+${checkpoint.leadHours} artifact`)
  }
}

const weatherObservations = JSON.parse(
  gunzipSync(
    await readFile(
      resolve(dataDirectory, 'public-context/knmi-weather-observations.geojson.gz'),
    ),
  ).toString('utf8'),
)
const weatherObservationMs = Date.parse(weatherObservations.observationTime)
const weatherObservationRetrievalMs = Date.parse(weatherObservations.source?.retrievedAt)
const weatherObservationAgeMinutes = Math.max(
  0,
  Math.round((weatherObservationRetrievalMs - weatherObservationMs) / 60_000),
)
const weatherFreshness = weatherObservationAgeMinutes <= 45
  ? 'fresh'
  : weatherObservationAgeMinutes <= 180
    ? 'delayed'
    : 'stale'
if (
  weatherObservations.type !== 'FeatureCollection' ||
  weatherObservations.evidenceClass !== 'observed-context' ||
  weatherObservations.affectsSimulation !== false ||
  weatherObservations.source?.id !== '10-minute-in-situ-meteorological-observations-1.0' ||
  weatherObservations.source?.publisher !== 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)' ||
  weatherObservations.source?.license !== 'CC BY 4.0' ||
  weatherObservations.source?.updateCadence !== '10 minutes' ||
  !weatherObservations.source?.role?.includes('never interpolated') ||
  !weatherObservations.source?.caveat?.includes('seven days') ||
  !/^KMDS__OPER_P___10M_OBS_L2_\d{12}\.nc$/.test(weatherObservations.source?.sourceFile ?? '') ||
  !Number.isFinite(Date.parse(weatherObservations.source?.sourceCreated)) ||
  !Number.isFinite(Date.parse(weatherObservations.source?.sourceLastModified)) ||
  !Number.isInteger(weatherObservations.source?.sourceBytes) ||
  weatherObservations.source.sourceBytes < 100_000 ||
  !/^[a-f0-9]{64}$/.test(weatherObservations.source?.sourceSha256 ?? '') ||
  !Number.isFinite(weatherObservationMs) ||
  !Number.isFinite(weatherObservationRetrievalMs) ||
  weatherObservationMs > weatherObservationRetrievalMs ||
  weatherObservations.freshness?.ageMinutesAtRetrieval !== weatherObservationAgeMinutes ||
  weatherObservations.freshness?.statusAtRetrieval !== weatherFreshness
) {
  fail('KNMI weather-observation evidence metadata is incomplete or misleading')
}

const weatherVariables = {
  airTemperatureC: [-60, 60],
  relativeHumidityPct: [0, 100],
  windDirectionDeg: [0, 360],
  windSpeedMs: [0, 100],
  windGustMs: [0, 120],
  rainfallLastHourMm: [0, 300],
  precipitationIntensityMmH: [0, 500],
  visibilityM: [0, 200_000],
  seaLevelPressureHpa: [800, 1_100],
}
const computedWeatherAvailability = Object.fromEntries(
  Object.keys(weatherVariables).map((variable) => [variable, 0]),
)
let assignedWeatherStations = 0
for (const feature of weatherObservations.features ?? []) {
  const properties = feature.properties ?? {}
  if (
    feature.geometry?.type !== 'Point' ||
    feature.geometry.coordinates.length !== 2 ||
    !feature.geometry.coordinates.every(Number.isFinite) ||
    feature.geometry.coordinates[0] < 2.5 || feature.geometry.coordinates[0] > 7.6 ||
    feature.geometry.coordinates[1] < 50.5 || feature.geometry.coordinates[1] > 55.6 ||
    !/^06\d{3}$/.test(properties.stationId ?? '') ||
    !/^0-\d+-0-06\d{3}$/.test(properties.wsiId ?? '') ||
    !properties.stationName ||
    Date.parse(properties.observationTime) !== weatherObservationMs ||
    !properties.windLabel ||
    !properties.rainLabel ||
    !properties.temperatureLabel
  ) {
    fail(`Invalid KNMI weather station ${feature.id}`)
  }
  for (const [variable, [minimum, maximum]] of Object.entries(weatherVariables)) {
    const value = properties[variable]
    if (value === null) continue
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      fail(`Invalid KNMI ${variable} at ${properties.stationId}`)
    }
    computedWeatherAvailability[variable] += 1
  }
  if (properties.municipalityCode !== null) {
    if (
      !municipalityCodes.has(properties.municipalityCode) ||
      properties.municipalityAssignment !== 'CBS 2025 generalized polygon containment'
    ) {
      fail(`KNMI station ${properties.stationId} has an invalid municipality assignment`)
    }
    assignedWeatherStations += 1
  } else if (properties.municipalityAssignment !== 'outside generalized municipality polygon') {
    fail(`KNMI station ${properties.stationId} has an ambiguous outside-coverage state`)
  }
}
if (
  weatherObservations.features.length < 50 ||
  weatherObservations.features.length > 70 ||
  weatherObservations.features.length !== weatherObservations.counts?.europeanNetherlandsStations ||
  weatherObservations.counts?.sourceStationRecords !==
    weatherObservations.counts.europeanNetherlandsStations +
    weatherObservations.counts.excludedCaribbeanStations ||
  assignedWeatherStations !== weatherObservations.counts?.assignedToMunicipalityPolygon ||
  weatherObservations.features.length - assignedWeatherStations !==
    weatherObservations.counts?.outsideMunicipalityPolygon ||
  !numericRecordsEqual(computedWeatherAvailability, weatherObservations.counts?.availableByVariable) ||
  new Set(weatherObservations.features.map((feature) => feature.id)).size !==
    weatherObservations.features.length
) {
  fail('KNMI weather-station counts, coverage, variables or IDs are inconsistent')
}

const weatherWarnings = JSON.parse(
  gunzipSync(
    await readFile(
      resolve(dataDirectory, 'public-context/knmi-weather-warnings.geojson.gz'),
    ),
  ).toString('utf8'),
)
const warningWindowStart = Date.parse(weatherWarnings.warningWindow?.start)
const warningWindowEnd = Date.parse(weatherWarnings.warningWindow?.end)
const warningLevels = { 0: 'No warning', 1: 'Code yellow', 2: 'Code orange', 3: 'Code red' }
if (
  weatherWarnings.type !== 'FeatureCollection' ||
  weatherWarnings.evidenceClass !== 'official-context' ||
  weatherWarnings.affectsSimulation !== false ||
  weatherWarnings.coverage !== 'twelve-provinces' ||
  weatherWarnings.features?.length !== 12 ||
  weatherWarnings.source?.id !== 'waarschuwingen_nederland_48h-1.0' ||
  weatherWarnings.source?.publisher !== 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)' ||
  weatherWarnings.source?.license !== 'CC BY 4.0' ||
  weatherWarnings.source?.horizonHours !== 48 ||
  !weatherWarnings.source?.role?.includes('does not affect the simulation') ||
  !Number.isFinite(warningWindowStart) ||
  !Number.isFinite(warningWindowEnd) ||
  warningWindowEnd <= warningWindowStart ||
  warningWindowEnd - warningWindowStart > 49 * 60 * 60 * 1_000
) {
  fail('KNMI weather-warning evidence metadata is incomplete or misleading')
}
const warningProvinceCodes = new Set()
const warningMunicipalityCodes = []
for (const feature of weatherWarnings.features) {
  const properties = feature.properties ?? {}
  if (
    !/^PV\d{2}$/.test(properties.provinceCode) ||
    warningProvinceCodes.has(properties.provinceCode) ||
    !/^([A-Z]{2,3})$/.test(properties.knmiLocationCode) ||
    !Number.isInteger(properties.warningLevel) ||
    properties.warningLevel < 0 ||
    properties.warningLevel > 3 ||
    properties.warningLevelLabel !== warningLevels[properties.warningLevel] ||
    !Array.isArray(properties.municipalityCodes) ||
    !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)
  ) {
    fail(`Invalid KNMI warning province feature ${feature.id}`)
  }
  warningProvinceCodes.add(properties.provinceCode)
  warningMunicipalityCodes.push(...properties.municipalityCodes)
}
const assignedWarningMunicipalities = new Set(warningMunicipalityCodes)
if (
  warningMunicipalityCodes.length !== municipalityCodes.size ||
  assignedWarningMunicipalities.size !== municipalityCodes.size ||
  [...assignedWarningMunicipalities].some((code) => !municipalityCodes.has(code))
) {
  fail('KNMI province-warning geometry does not assign every municipality exactly once')
}
for (const warning of weatherWarnings.warnings ?? []) {
  const validFrom = Date.parse(warning.validFrom)
  const validThrough = Date.parse(warning.validThrough)
  if (
    !/^[A-Z]{2,3}$/.test(warning.locationCode) ||
    !Number.isInteger(warning.level) ||
    warning.level < 1 ||
    warning.level > 3 ||
    warning.levelLabel !== warningLevels[warning.level] ||
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validThrough) ||
    validFrom < warningWindowStart ||
    validThrough > warningWindowEnd ||
    validThrough <= validFrom ||
    !Array.isArray(warning.texts)
  ) {
    fail(`Invalid KNMI warning period for ${warning.locationCode ?? 'unknown location'}`)
  }
}
const provincesWithWarnings = weatherWarnings.features.filter(
  (feature) => feature.properties.warningLevel > 0,
).length
if (
  weatherWarnings.counts?.provinces !== 12 ||
  weatherWarnings.counts?.warningPeriods !== weatherWarnings.warnings.length ||
  weatherWarnings.counts?.provincesWithWarnings !== provincesWithWarnings
) {
  fail('KNMI weather-warning counts do not reconcile')
}
if (
  weatherWarnings.source.retrievalMode === 'official-html-explicit-no-warning-fallback' &&
  (weatherWarnings.warnings.length !== 0 ||
    provincesWithWarnings !== 0 ||
    weatherWarnings.source.sourceFile !== null ||
    !Number.isFinite(Date.parse(weatherWarnings.source.fallbackIssueTime)))
) {
  fail('KNMI HTML fallback may only establish an explicit timestamped zero-warning snapshot')
}

const amelandFerry = transport.routes.find((route) => route.id === 'gtfs-ferry-wpd-holwerd-ameland')
if (
  !amelandFerry ||
  amelandFerry.from !== 'GM1970' ||
  amelandFerry.to !== 'GM0060' ||
  amelandFerry.mode !== 'ferry' ||
  amelandFerry.capacitySemantics !== 'scenario-units' ||
  JSON.stringify(amelandFerry.supportedServices) !== JSON.stringify(['mobility', 'supply'])
) {
  fail('Missing audited Holwerd–Ameland mobility/supply ferry lifeline')
}

const denHelderTexelFerry = transport.routes.find(
  (route) => route.id === 'gtfs-ferry-teso-den-helder-texel',
)
if (
  !denHelderTexelFerry ||
  denHelderTexelFerry.from !== 'GM0400' ||
  denHelderTexelFerry.to !== 'GM0448' ||
  denHelderTexelFerry.mode !== 'ferry' ||
  denHelderTexelFerry.capacitySemantics !== 'scenario-units' ||
  denHelderTexelFerry.sourceUrl !== 'https://www.teso.nl/afvaarttijden/' ||
  !denHelderTexelFerry.statusSemantics?.includes('future continuity remain unknown') ||
  JSON.stringify(denHelderTexelFerry.supportedServices) !==
    JSON.stringify(['mobility', 'supply'])
) {
  fail('Missing or invalid audited Den Helder–Texel mobility/supply ferry lifeline')
}

const kesselReuverFerry = transport.routes.find(
  (route) => route.id === 'audited-ferry-kessel-reuver',
)
if (
  !kesselReuverFerry ||
  kesselReuverFerry.from !== 'GM1894' ||
  kesselReuverFerry.to !== 'GM0889' ||
  kesselReuverFerry.mode !== 'ferry' ||
  kesselReuverFerry.capacitySemantics !== 'scenario-units' ||
  kesselReuverFerry.sourceUrl !== 'https://www.beesel.nl/inwoners/veerpont/' ||
  JSON.stringify(kesselReuverFerry.supportedServices) !== JSON.stringify(['mobility', 'supply']) ||
  kesselReuverFerry.coordinates.length !== 4 ||
  kesselReuverFerry.distanceKm < 0.5 ||
  kesselReuverFerry.distanceKm > 0.8
) {
  fail('Missing or invalid audited Kessel–Reuver mobility/supply ferry lifeline')
}

const bergenVierlingsbeekFerry = transport.routes.find(
  (route) => route.id === 'audited-ferry-bergen-vierlingsbeek',
)
if (
  !bergenVierlingsbeekFerry ||
  bergenVierlingsbeekFerry.from !== 'GM0893' ||
  bergenVierlingsbeekFerry.to !== 'GM1982' ||
  bergenVierlingsbeekFerry.mode !== 'ferry' ||
  bergenVierlingsbeekFerry.capacitySemantics !== 'scenario-units' ||
  bergenVierlingsbeekFerry.sourceUrl !== 'https://www.bergen.nl/vragen-en-antwoorden' ||
  bergenVierlingsbeekFerry.statusSourceUrl !==
    'https://www.vierlingsbeek-bergen.nl/index.php?pagina=nieuws' ||
  !bergenVierlingsbeekFerry.statusSemantics?.includes('remain unknown') ||
  JSON.stringify(bergenVierlingsbeekFerry.supportedServices) !==
    JSON.stringify(['mobility', 'supply']) ||
  bergenVierlingsbeekFerry.coordinates.length !== 3 ||
  bergenVierlingsbeekFerry.distanceKm < 0.14 ||
  bergenVierlingsbeekFerry.distanceKm > 0.17
) {
  fail('Missing or invalid audited Bergen–Vierlingsbeek mobility/supply ferry lifeline')
}

const amsterdamOuderAmstelRoutes = transport.routes.filter(
  (route) =>
    [route.from, route.to].sort().join('--') === ['GM0363', 'GM0437'].sort().join('--') &&
    (route.name === 'A2' || route.name === 'A10' || route.name === 'E35' || route.aliases?.includes('E35')),
)
if (
  amsterdamOuderAmstelRoutes.length !== 2 ||
  !amsterdamOuderAmstelRoutes.some(
    (route) =>
      route.name === 'A2' &&
      route.physicalCorridorId === 'NWB-road-2' &&
      route.mode === 'trunk' &&
      route.nominalCapacity === 260 &&
      !route.aliases?.includes('E35'),
  ) ||
  !amsterdamOuderAmstelRoutes.some(
    (route) =>
      route.name === 'A10' &&
      route.physicalCorridorId === 'NWB-road-10' &&
      route.mode === 'trunk' &&
      route.nominalCapacity === 260 &&
      route.aliases?.includes('E35'),
  )
) {
  fail('Amsterdam E35 must retain its NWB road-10 identity without being merged into physical A2')
}

const bunnikUtrechtA27 = transport.routes.filter(
  (route) =>
    [route.from, route.to].sort().join('--') === ['GM0312', 'GM0344'].sort().join('--') &&
    route.physicalCorridorId === 'NWB-road-27',
)
if (
  bunnikUtrechtA27.length !== 1 ||
  bunnikUtrechtA27[0].name !== 'A27' ||
  bunnikUtrechtA27[0].mode !== 'trunk' ||
  bunnikUtrechtA27[0].nominalCapacity !== 260 ||
  bunnikUtrechtA27[0].physicalCorridorId !== 'NWB-road-27' ||
  !bunnikUtrechtA27[0].aliases?.includes('E30') ||
  !bunnikUtrechtA27[0].sourceFeatureIds?.includes('NWB-278309019')
) {
  fail('A27/E30 must be one traceable GM0312-GM0344 physical corridor with no duplicate capacity')
}
const bunnikUtrechtA28 = transport.routes.filter(
  (route) =>
    [route.from, route.to].sort().join('--') === ['GM0312', 'GM0344'].sort().join('--') &&
    route.physicalCorridorId === 'NWB-road-28',
)
if (
  bunnikUtrechtA28.length !== 1 ||
  bunnikUtrechtA28[0].name !== 'A28' ||
  bunnikUtrechtA28[0].mode !== 'trunk' ||
  bunnikUtrechtA28[0].nominalCapacity !== 260 ||
  !bunnikUtrechtA28[0].aliases?.includes('E30') ||
  !bunnikUtrechtA28[0].sourceFeatureIds?.includes('NWB-278309026')
) {
  fail('A28/E30 must be one traceable GM0312-GM0344 physical corridor with no duplicate capacity')
}

const bunschotenNijkerkN806 = transport.routes.filter(
  (route) =>
    [route.from, route.to].sort().join('--') === ['GM0313', 'GM0267'].sort().join('--') &&
    (route.name === 'N806' || route.aliases?.includes('N806')),
)
if (
  bunschotenNijkerkN806.length !== 1 ||
  bunschotenNijkerkN806[0].name !== 'N806' ||
  bunschotenNijkerkN806[0].mode !== 'regional' ||
  bunschotenNijkerkN806[0].nominalCapacity !== 150 ||
  bunschotenNijkerkN806[0].physicalCorridorId !== 'NWB-road-806' ||
  !bunschotenNijkerkN806[0].sourceFeatureIds?.includes('NWB-601359433') ||
  !bunschotenNijkerkN806[0].sourceFeatureIds?.includes('NWB-311342002')
) {
  fail('Missing source-traceable N806/Bunschoterweg GM0313-GM0267 boundary connector')
}
if (transport.source?.auditedBoundaryConnectors !== undefined) {
  fail('Route-specific boundary-connector provenance leaked into global transport metadata')
}
const boundaryConnectorAnnotations = transport.routes.filter((route) => route.auditProvenance)
if (
  boundaryConnectorAnnotations.length !== 1 ||
  boundaryConnectorAnnotations[0].id !== bunschotenNijkerkN806[0].id ||
  JSON.stringify(boundaryConnectorAnnotations[0].auditProvenance.municipalities) !==
    JSON.stringify(['GM0267', 'GM0313']) ||
  boundaryConnectorAnnotations[0].auditProvenance.physicalCorridorId !== 'NWB-road-806' ||
  !boundaryConnectorAnnotations[0].auditProvenance.note?.includes(
    'no route label, utility topology or live passability is inferred',
  )
) {
  fail('N806 boundary-connector provenance is not scoped to its exact route and municipalities')
}

const capelleKrimpenAlgerabrug = transport.routes.filter(
  (route) =>
    [route.from, route.to].sort().join('--') === ['GM0502', 'GM0542'].sort().join('--') &&
    route.id === 'audited-road-n210-algerabrug',
)
if (
  capelleKrimpenAlgerabrug.length !== 1 ||
  capelleKrimpenAlgerabrug[0].name !== 'N210 / Algerabrug' ||
  capelleKrimpenAlgerabrug[0].mode !== 'regional' ||
  capelleKrimpenAlgerabrug[0].nominalCapacity !== 150 ||
  capelleKrimpenAlgerabrug[0].capacitySemantics !== 'scenario-units' ||
  capelleKrimpenAlgerabrug[0].physicalCorridorId !== 'audited-N210-Algerabrug' ||
  JSON.stringify(capelleKrimpenAlgerabrug[0].sourceFeatureIds) !==
    JSON.stringify(['NWB-198273080', 'NWB-198273045']) ||
  JSON.stringify(capelleKrimpenAlgerabrug[0].supportedServices) !==
    JSON.stringify(['mobility', 'supply']) ||
  !capelleKrimpenAlgerabrug[0].statusSemantics?.includes('remain unknown')
) {
  fail('Missing source-traceable N210/Algerabrug GM0502-GM0542 mobility/supply connection')
}

const schoonhovenGelkenesFerry = transport.routes.filter(
  (route) =>
    route.id === 'nwb-link-933-GM1931-GM1978' &&
    [route.from, route.to].sort().join('--') === ['GM1931', 'GM1978'].sort().join('--'),
)
if (
  schoonhovenGelkenesFerry.length !== 1 ||
  schoonhovenGelkenesFerry[0].name !== 'N216 / Veerdienst Schoonhoven–Gelkenes' ||
  schoonhovenGelkenesFerry[0].mode !== 'ferry' ||
  schoonhovenGelkenesFerry[0].nominalCapacity !== 0 ||
  schoonhovenGelkenesFerry[0].capacitySemantics !== 'unknown' ||
  schoonhovenGelkenesFerry[0].affectsSimulation !== false ||
  schoonhovenGelkenesFerry[0].physicalCorridorId !==
    'audited-N216-Schoonhoven-Gelkenes' ||
  JSON.stringify(schoonhovenGelkenesFerry[0].sourceFeatureIds) !==
    JSON.stringify(['NWB-600441023', 'NWB-600441055']) ||
  JSON.stringify(schoonhovenGelkenesFerry[0].sourceRoadPartClasses) !==
    JSON.stringify(['VDA']) ||
  JSON.stringify(schoonhovenGelkenesFerry[0].supportedServices) !==
    JSON.stringify(['mobility', 'supply']) ||
  !schoonhovenGelkenesFerry[0].statusSemantics?.includes('excluded from simulation') ||
  schoonhovenGelkenesFerry[0].publishedScheduleContext?.simulationEffect !== 'context-only'
) {
  fail('N216 Schoonhoven-Gelkenes crossing is not a fail-closed, source-traceable ferry')
}

const leidenLeiderdorpSpanjaardsbrug = transport.routes.filter(
  (route) =>
    route.id === 'audited-road-lage-rijndijk-spanjaardsbrug' &&
    [route.from, route.to].sort().join('--') === ['GM0546', 'GM0547'].sort().join('--'),
)
if (
  leidenLeiderdorpSpanjaardsbrug.length !== 1 ||
  leidenLeiderdorpSpanjaardsbrug[0].name !== 'Lage Rijndijk / Spanjaardsbrug' ||
  leidenLeiderdorpSpanjaardsbrug[0].mode !== 'local' ||
  leidenLeiderdorpSpanjaardsbrug[0].nominalCapacity !== 0 ||
  leidenLeiderdorpSpanjaardsbrug[0].capacitySemantics !== 'unknown' ||
  leidenLeiderdorpSpanjaardsbrug[0].affectsSimulation !== false ||
  leidenLeiderdorpSpanjaardsbrug[0].physicalCorridorId !==
    'audited-Lage-Rijndijk-Spanjaardsbrug' ||
  !['NWB-190328122', 'NWB-600420705'].every((id) =>
    leidenLeiderdorpSpanjaardsbrug[0].sourceFeatureIds?.includes(id)) ||
  JSON.stringify(leidenLeiderdorpSpanjaardsbrug[0].supportedServices) !==
    JSON.stringify(['mobility', 'supply']) ||
  !leidenLeiderdorpSpanjaardsbrug[0].statusSemantics?.includes(
    'excluded from causal transfers',
  )
) {
  fail('Spanjaardsbrug crossing is not a fail-closed, source-traceable local route')
}

const lingewaardRijndijk = transport.routes.filter(
  (route) => route.id === 'audited-road-rijndijk-angeren-doornenburg',
)
if (
  lingewaardRijndijk.length !== 1 ||
  lingewaardRijndijk[0].name !== 'Rijndijk Angeren–Doornenburg' ||
  lingewaardRijndijk[0].from !== 'GM1705' ||
  lingewaardRijndijk[0].to !== 'GM1705' ||
  lingewaardRijndijk[0].mode !== 'local' ||
  lingewaardRijndijk[0].nominalCapacity !== 0 ||
  lingewaardRijndijk[0].capacitySemantics !== 'unknown' ||
  lingewaardRijndijk[0].affectsSimulation !== false ||
  lingewaardRijndijk[0].physicalCorridorId !== 'audited-Rijndijk-Angeren-Doornenburg' ||
  JSON.stringify(lingewaardRijndijk[0].sourceFeatureIds) !==
    JSON.stringify(['NWB-389272008', 'NWB-391270006']) ||
  JSON.stringify(lingewaardRijndijk[0].supportedServices) !==
    JSON.stringify(['mobility', 'supply']) ||
  !lingewaardRijndijk[0].statusSemantics?.includes('excluded from causal transfers')
) {
  fail('Lingewaard Rijndijk is not a fail-closed, source-traceable internal route')
}

const goirleTilburgN630 = transport.routes.filter(
  (route) =>
    [route.from, route.to].sort().join('--') === ['GM0785', 'GM0855'].sort().join('--') &&
    route.id === 'audited-road-n630-goirle-tilburg',
)
if (
  goirleTilburgN630.length !== 1 ||
  goirleTilburgN630[0].name !== 'N630' ||
  goirleTilburgN630[0].mode !== 'regional' ||
  goirleTilburgN630[0].nominalCapacity !== 150 ||
  goirleTilburgN630[0].capacitySemantics !== 'scenario-units' ||
  goirleTilburgN630[0].physicalCorridorId !== 'audited-N630-Turnhoutsebaan' ||
  goirleTilburgN630[0].corridorIdentityStatus !== 'resolved' ||
  JSON.stringify(goirleTilburgN630[0].sourceFeatureIds) !==
    JSON.stringify(['NWB-600770839', 'NWB-262187028']) ||
  JSON.stringify(goirleTilburgN630[0].supportedServices) !==
    JSON.stringify(['mobility', 'supply']) ||
  goirleTilburgN630[0].coordinates.length !== 13 ||
  goirleTilburgN630[0].distanceKm < 0.32 ||
  goirleTilburgN630[0].distanceKm > 0.35 ||
  !goirleTilburgN630[0].statusSemantics?.includes(
    'Belgian N12/Poppel/Turnhout continuation remain unknown',
  )
) {
  fail('Missing source-traceable N630 GM0785-GM0855 mobility/supply connection')
}

if (
  transportRestrictions.schemaVersion !== '1.0.0' ||
  transportRestrictions.restrictions?.length !== 6 ||
  !transportRestrictions.source?.coverage?.includes('absence is Unknown') ||
  !transportRestrictions.source?.affectsSimulation?.includes(
    'Vehicle-class restrictions remain context-only',
  )
) {
  fail('Public route-restriction source metadata is incomplete or misleading')
}
for (const entry of transportRestrictions.restrictions) {
  const { match, restriction } = entry
  const matchingRoute = transport.routes.find((route) => {
    const pairMatches =
      [route.from, route.to].sort().join('--') === [match.from, match.to].sort().join('--')
    return pairMatches &&
      (!match.name || route.name === match.name) &&
      (!match.sourceFeatureIdsAny?.length ||
        match.sourceFeatureIdsAny.some((id) => route.sourceFeatureIds?.includes(id)))
  })
  if (
    !matchingRoute ||
    !/^\d{4}-\d{2}-\d{2}$/.test(restriction.validFrom) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(restriction.validThrough) ||
    restriction.validFrom > restriction.validThrough ||
    !['closed', 'vehicle-class-restricted'].includes(restriction.state) ||
    !['close-route', 'context-only'].includes(restriction.simulationEffect) ||
    !Array.isArray(restriction.affectedServices) ||
    restriction.affectedServices.length === 0 ||
    restriction.affectedServices.some((service) => !['mobility', 'supply'].includes(service)) ||
    !Number.isFinite(Date.parse(restriction.retrievedAt)) ||
    typeof restriction.sourceUrl !== 'string'
  ) {
    fail(`Invalid or unmatched public route restriction ${restriction.id}`)
  }
}
const a27MerwedebrugRestriction = transportRestrictions.restrictions.find(
  ({ restriction }) => restriction.id === 'rws-a27-merwedebrug-heavy-vehicle-2026',
)
if (
  a27MerwedebrugRestriction?.match.from !== 'GM0512' ||
  a27MerwedebrugRestriction?.match.to !== 'GM1959' ||
  a27MerwedebrugRestriction?.match.name !== 'A27' ||
  a27MerwedebrugRestriction?.restriction.state !== 'vehicle-class-restricted' ||
  a27MerwedebrugRestriction?.restriction.simulationEffect !== 'context-only' ||
  JSON.stringify(a27MerwedebrugRestriction?.restriction.affectedVehicleClasses) !==
    JSON.stringify(['trucks', 'touring coaches']) ||
  JSON.stringify(a27MerwedebrugRestriction?.restriction.unaffectedVehicleClasses) !==
    JSON.stringify(['passenger cars', 'scheduled buses', 'emergency services']) ||
  !a27MerwedebrugRestriction?.restriction.note?.includes('no invented numeric route-capacity effect') ||
  !a27MerwedebrugRestriction?.restriction.note?.includes('no later date is extrapolated')
) {
  fail('A27 Merwedebrug restriction lost vehicle-class or non-causal semantics')
}
const algerabrugRestriction = transportRestrictions.restrictions.find(
  ({ restriction }) => restriction.id === 'rws-algerabrug-ordinary-motor-closure-2026',
)
if (
  algerabrugRestriction?.match.from !== 'GM0502' ||
  algerabrugRestriction?.match.to !== 'GM0542' ||
  algerabrugRestriction?.match.name !== 'N210 / Algerabrug' ||
  JSON.stringify(algerabrugRestriction?.match.sourceFeatureIdsAny) !==
    JSON.stringify(['NWB-198273080', 'NWB-198273045']) ||
  algerabrugRestriction?.restriction.state !== 'vehicle-class-restricted' ||
  algerabrugRestriction?.restriction.simulationEffect !== 'context-only' ||
  algerabrugRestriction?.restriction.validFrom !== '2026-08-10' ||
  algerabrugRestriction?.restriction.validThrough !== '2026-09-07' ||
  JSON.stringify(algerabrugRestriction?.restriction.affectedVehicleClasses) !==
    JSON.stringify(['ordinary motor traffic']) ||
  JSON.stringify(algerabrugRestriction?.restriction.unaffectedVehicleClasses) !==
    JSON.stringify(['controlled emergency services']) ||
  !algerabrugRestriction?.restriction.note?.includes('date-only') ||
  !algerabrugRestriction?.restriction.note?.includes('never deletes the generalized edge') ||
  !algerabrugRestriction?.restriction.note?.includes('Unknown rather than guaranteed open')
) {
  fail('N210 Algerabrug restriction lost role, valid-time or non-causal semantics')
}
const spanjaardsbrugRestriction = transportRestrictions.restrictions.find(
  ({ restriction }) => restriction.id === 'leiderdorp-spanjaardsbrug-car-bus-closure-2026',
)
if (
  spanjaardsbrugRestriction?.match.from !== 'GM0546' ||
  spanjaardsbrugRestriction?.match.to !== 'GM0547' ||
  spanjaardsbrugRestriction?.match.name !== 'Lage Rijndijk / Spanjaardsbrug' ||
  JSON.stringify(spanjaardsbrugRestriction?.match.sourceFeatureIdsAny) !==
    JSON.stringify(['NWB-190328122', 'NWB-600420705']) ||
  spanjaardsbrugRestriction?.restriction.state !== 'vehicle-class-restricted' ||
  spanjaardsbrugRestriction?.restriction.simulationEffect !== 'context-only' ||
  spanjaardsbrugRestriction?.restriction.validFrom !== '2026-08-17' ||
  spanjaardsbrugRestriction?.restriction.validThrough !== '2026-09-11' ||
  JSON.stringify(spanjaardsbrugRestriction?.restriction.affectedVehicleClasses) !==
    JSON.stringify(['cars', 'scheduled buses']) ||
  JSON.stringify(spanjaardsbrugRestriction?.restriction.unaffectedVehicleClasses) !==
    JSON.stringify(['emergency services', 'cycles', 'mopeds']) ||
  !spanjaardsbrugRestriction?.restriction.note?.includes('excluded from causal transfers') ||
  !spanjaardsbrugRestriction?.restriction.note?.includes('Unknown rather than guaranteed open')
) {
  fail('Spanjaardsbrug restriction lost mode, valid-time or fail-closed semantics')
}
const kelperbrugRestriction = transportRestrictions.restrictions.find(
  ({ restriction }) => restriction.id === 'rws-n280-kelperbrug-heavy-vehicle-2026',
)
if (
  kelperbrugRestriction?.match.from !== 'GM0988' ||
  kelperbrugRestriction?.match.to !== 'GM1640' ||
  kelperbrugRestriction?.match.name !== 'N280' ||
  JSON.stringify(kelperbrugRestriction?.match.sourceFeatureIdsAny) !==
    JSON.stringify(['NWB-600948347', 'NWB-366121023']) ||
  kelperbrugRestriction?.restriction.state !== 'vehicle-class-restricted' ||
  kelperbrugRestriction?.restriction.simulationEffect !== 'context-only' ||
  kelperbrugRestriction?.restriction.validFrom !== '2026-06-09' ||
  kelperbrugRestriction?.restriction.validThrough !== '2026-09-03' ||
  JSON.stringify(kelperbrugRestriction?.restriction.affectedVehicleClasses) !==
    JSON.stringify(['trucks', 'agricultural vehicles', 'buses excluding scheduled public transport']) ||
  JSON.stringify(kelperbrugRestriction?.restriction.unaffectedVehicleClasses) !==
    JSON.stringify(['scheduled public transport', 'emergency services', 'passenger cars and other permitted traffic']) ||
  !kelperbrugRestriction?.restriction.note?.includes('no later state is extrapolated') ||
  !kelperbrugRestriction?.restriction.note?.includes('empty NDW match') ||
  !kelperbrugRestriction?.restriction.note?.includes('Unknown rather than proof')
) {
  fail('N280 Kelperbrug restriction lost vehicle, valid-time or fail-closed semantics')
}
const rijndijkRestriction = transportRestrictions.restrictions.find(
  ({ restriction }) => restriction.id === 'lingewaard-rijndijk-via15-closure-2026',
)
if (
  rijndijkRestriction?.match.from !== 'GM1705' ||
  rijndijkRestriction?.match.to !== 'GM1705' ||
  rijndijkRestriction?.match.name !== 'Rijndijk Angeren–Doornenburg' ||
  JSON.stringify(rijndijkRestriction?.match.sourceFeatureIdsAny) !==
    JSON.stringify(['NWB-389272008', 'NWB-391270006']) ||
  rijndijkRestriction?.restriction.state !== 'closed' ||
  rijndijkRestriction?.restriction.simulationEffect !== 'context-only' ||
  rijndijkRestriction?.restriction.validFrom !== '2026-08-24' ||
  rijndijkRestriction?.restriction.validThrough !== '2026-10-02' ||
  JSON.stringify(rijndijkRestriction?.restriction.affectedVehicleClasses) !==
    JSON.stringify(['through road traffic']) ||
  JSON.stringify(rijndijkRestriction?.restriction.detours) !==
    JSON.stringify(['Lodderhoeksestraat / N838']) ||
  !rijndijkRestriction?.restriction.note?.includes('excluded from causal transfers') ||
  !rijndijkRestriction?.restriction.note?.includes('empty NDW remains Unknown')
) {
  fail('Lingewaard Rijndijk restriction lost geometry, valid-time or fail-closed semantics')
}

const auditedA15Pairs = [
  ['GM0482', 'GM1978'],
  ['GM0214', 'GM0281'],
  ['GM0590', 'GM1978'],
  ['GM0599', 'GM0613'],
  ['GM0489', 'GM0613'],
]
for (const [from, to] of auditedA15Pairs) {
  const route = transport.routes.find(
    (candidate) =>
      candidate.name === 'A15' &&
      ((candidate.from === from && candidate.to === to) ||
        (candidate.from === to && candidate.to === from)),
  )
  if (!route || route.mode !== 'trunk' || route.nominalCapacity !== 260) {
    fail(`Missing audited A15 trunk link ${from}-${to}`)
  }
}

const signedRoadsByNumber = new Map()
for (const route of transport.routes) {
  const match = /^([AN])([0-9]+)$/.exec(route.name)
  if (!match) continue
  const number = String(Number(match[2]))
  if (!signedRoadsByNumber.has(number)) signedRoadsByNumber.set(number, new Set())
  signedRoadsByNumber.get(number).add(route.name)
}
for (const route of transport.routes) {
  if (!/^[0-9]+$/.test(route.name)) continue
  const signedCandidates = signedRoadsByNumber.get(String(Number(route.name))) ?? new Set()
  if (signedCandidates.size === 1) {
    fail(
      `Resolvable numeric road alias ${route.name} remains on ${route.id}; expected ${[...signedCandidates][0]}`,
    )
  }
}

const transitDirectory = resolve(dataDirectory, 'transit')
const transitManifest = await readJson(resolve(transitDirectory, 'transit-manifest.json'))
for (const [file, metadata] of Object.entries(transitManifest.files)) {
  const buffer = await readFile(resolve(transitDirectory, file))
  const digest = createHash('sha256').update(buffer).digest('hex')
  if (buffer.length !== metadata.bytes || digest !== metadata.sha256) {
    fail(`${file} does not match its transit manifest`)
  }
  const collection = JSON.parse(buffer.toString('utf8'))
  if (collection.features.length !== metadata.featureCount) {
    fail(`${file} feature count does not match its transit manifest`)
  }
}

console.log(
  JSON.stringify(
    {
      municipalities: municipalityCodes.size,
      regionFiles: regionFiles.length,
      neighborhoods,
      places,
      statisticsPerNeighborhood: 36,
      safetyRegions: safetyRegions.features.length,
      settlementFiles: settlementFiles.length,
      settlements,
      settlementAssignmentMethods: settlementManifest.processing.assignmentMethods,
      transportRoutes: transport.routes.length,
      transportMunicipalities: new Set(transport.routes.flatMap((route) => [route.from, route.to])).size,
      publicRouteRestrictions: transportRestrictions.restrictions.length,
      transitRoutes: transitManifest.counts.outputRouteGeometries,
      transitStops: transitManifest.counts.groupedStops,
      publicWaterAssets: waterAssets.features.length,
      publicWaterAssetCounts: waterAssets.counts,
      publicWaterAssetMunicipalityAssignment: waterAssets.municipalityAssignment,
      publicGovernmentServices: governmentServices.features.length,
      publicGovernmentServiceCounts: governmentServices.counts,
      publicAcuteCareLocations: acuteCare.features.length,
      publicAcuteCareCounts: acuteCare.counts,
      publicEducationLocations: educationLocations.features.length,
      publicEducationLocationCounts: educationLocations.counts,
      publicAntennaInstallations: antennaSites.features.length,
      publicAntennaCounts: antennaSites.counts,
      publicAirQualityStations: airQuality.features.length,
      publicAirQualityMunicipalities: airQuality.counts.municipalitiesRepresented,
      publicAirQualityObservationWindow: airQuality.observationWindow,
      publicSeismicEvents: seismicEvents.features.length,
      publicSeismicEventCounts: seismicEvents.counts,
      publicSeismicObservationWindow: seismicEvents.observationWindow,
      publicWaterinfoObservations: waterinfo.features.length,
      publicWaterinfoCounts: waterinfo.counts,
      publicWaterinfoObservationRange: waterinfo.observationRange,
      publicWaterinfoForecasts: waterForecasts.features.length,
      publicWaterinfoForecastCounts: waterForecasts.counts,
      publicWaterinfoForecastRange: waterForecasts.validTimeRange,
      publicWaterinfoForecastSnapshots: waterForecasts.snapshots.map((snapshot) => ({
        id: snapshot.id,
        returnedFeatures: snapshot.returnedFeatures,
        noData: snapshot.noData,
      })),
      publicCapacitySamples: capacityContext.features.length,
      publicCapacitySampleCounts: capacityContext.counts,
      publicGtsFlowRecords: gtsFlow.records.length,
      publicGtsFlowObservationPeriod: gtsFlow.observationPeriod,
      publicGtsFlowCounts: gtsFlow.counts,
      publicRoadSituations: roadSituations.features.length,
      publicRoadSituationPublicationTime: roadSituations.source.publicationTime,
      publicRadarObservationTime: radarMetadata.observationTime,
      publicRadarBytes: radarImage.length,
      publicWeatherObservationStations: weatherObservations.features.length,
      publicWeatherObservationTime: weatherObservations.observationTime,
      publicWeatherObservationCounts: weatherObservations.counts,
      publicWeatherWarningPeriods: weatherWarnings.warnings.length,
      publicWeatherWarningProvinces: weatherWarnings.features.length,
      publicWeatherWarningRetrievalMode: weatherWarnings.source.retrievalMode,
      status: 'valid',
    },
    null,
    2,
  ),
)
