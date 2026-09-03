import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const municipalityPath = resolve(
  here,
  '../apps/web/public/data/netherlands-municipalities.geojson',
)
const outputDirectory = resolve(here, '../apps/web/public/data/settlements')

const apiBase = 'https://api.pdok.nl/kadaster/brt-top10nl/ogc/v1'
const collectionIds = ['plaats_vlak', 'plaats_multivlak']
const retainedTypes = new Set(['woonkern', 'deelkern', 'gehucht', 'buurtschap'])

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

async function fetchJson(url, label, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json, application/geo+json' },
      })
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1))
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message}`)
}

async function fetchCollection(collectionId) {
  const startUrl = new URL(`${apiBase}/collections/${collectionId}/items`)
  startUrl.searchParams.set('f', 'json')
  startUrl.searchParams.set('limit', '1000')

  const seenUrls = new Set()
  const features = []
  let nextUrl = startUrl.toString()
  let pages = 0

  while (nextUrl) {
    if (seenUrls.has(nextUrl)) {
      throw new Error(`${collectionId} pagination returned a repeated next URL`)
    }
    seenUrls.add(nextUrl)

    const page = await fetchJson(nextUrl, `${collectionId} page ${pages + 1}`)
    if (page.type !== 'FeatureCollection' || !Array.isArray(page.features)) {
      throw new Error(`${collectionId} returned an invalid GeoJSON FeatureCollection`)
    }
    features.push(...page.features)
    pages += 1

    const nextLink = page.links?.find((link) => link.rel === 'next')
    nextUrl = nextLink?.href ?? null
  }

  return { collectionId, features, pages, startUrl: startUrl.toString() }
}

function coordinatesEach(coordinates, callback) {
  if (typeof coordinates?.[0] === 'number') {
    callback(coordinates)
    return
  }
  for (const child of coordinates ?? []) coordinatesEach(child, callback)
}

function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  coordinatesEach(geometry.coordinates, ([longitude, latitude]) => {
    bounds[0] = Math.min(bounds[0], longitude)
    bounds[1] = Math.min(bounds[1], latitude)
    bounds[2] = Math.max(bounds[2], longitude)
    bounds[3] = Math.max(bounds[3], latitude)
  })
  if (!bounds.every(Number.isFinite)) throw new Error('Encountered an empty geometry')
  return bounds
}

function boundsContain(bounds, [longitude, latitude], epsilon = 1e-11) {
  return (
    longitude >= bounds[0] - epsilon &&
    longitude <= bounds[2] + epsilon &&
    latitude >= bounds[1] - epsilon &&
    latitude <= bounds[3] + epsilon
  )
}

function boundsIntersect(left, right) {
  return !(
    left[2] < right[0] ||
    left[0] > right[2] ||
    left[3] < right[1] ||
    left[1] > right[3]
  )
}

function pointInRing(point, ring) {
  let inside = false
  for (let index = 0; index < ring.length; index += 1) {
    const currentPoint = ring[index]
    const previousPoint = ring[(index + ring.length - 1) % ring.length]
    const crossesLatitude = currentPoint[1] > point[1] !== previousPoint[1] > point[1]
    if (!crossesLatitude) continue
    const crossingLongitude =
      ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) /
        (previousPoint[1] - currentPoint[1]) +
      currentPoint[0]
    if (point[0] < crossingLongitude) inside = !inside
  }
  return inside
}

function pointInPolygon(point, rings) {
  if (!rings[0] || !pointInRing(point, rings[0])) return false
  for (let index = 1; index < rings.length; index += 1) {
    if (pointInRing(point, rings[index])) return false
  }
  return true
}

function ringSignedArea(ring) {
  let area = 0
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1]
  }
  return area / 2
}

function polygonArea(rings) {
  if (!rings[0]) return 0
  const outerArea = Math.abs(ringSignedArea(rings[0]))
  const holeArea = rings
    .slice(1)
    .reduce((total, ring) => total + Math.abs(ringSignedArea(ring)), 0)
  return Math.max(0, outerArea - holeArea)
}

function ringCentroid(ring) {
  let crossTotal = 0
  let longitudeTotal = 0
  let latitudeTotal = 0
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index]
    const [x2, y2] = ring[index + 1]
    const cross = x1 * y2 - x2 * y1
    crossTotal += cross
    longitudeTotal += (x1 + x2) * cross
    latitudeTotal += (y1 + y2) * cross
  }
  if (Math.abs(crossTotal) < 1e-15) return null
  return [longitudeTotal / (3 * crossTotal), latitudeTotal / (3 * crossTotal)]
}

function scanlineInteriorPoint(rings, bounds) {
  const latitudeFractions = [0.5, 0.382, 0.618, 0.25, 0.75, 0.125, 0.875]
  let best = null

  for (const fraction of latitudeFractions) {
    const latitude = bounds[1] + (bounds[3] - bounds[1]) * fraction
    const intersections = []
    for (const ring of rings) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const start = ring[index]
        const end = ring[index + 1]
        if (start[1] > latitude === end[1] > latitude) continue
        intersections.push(
          start[0] + ((latitude - start[1]) * (end[0] - start[0])) / (end[1] - start[1]),
        )
      }
    }
    intersections.sort((left, right) => left - right)
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const width = intersections[index + 1] - intersections[index]
      const candidate = [(intersections[index] + intersections[index + 1]) / 2, latitude]
      if (width > (best?.width ?? -1) && pointInPolygon(candidate, rings)) {
        best = { point: candidate, width }
      }
    }
  }
  return best?.point ?? null
}

function polygonInteriorPoint(rings) {
  const polygonGeometry = { type: 'Polygon', coordinates: rings }
  const bounds = geometryBounds(polygonGeometry)
  const centroid = ringCentroid(rings[0])
  if (centroid && pointInPolygon(centroid, rings)) return centroid

  const boundsCenter = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
  if (pointInPolygon(boundsCenter, rings)) return boundsCenter

  const scanlinePoint = scanlineInteriorPoint(rings, bounds)
  if (scanlinePoint) return scanlinePoint

  for (let row = 0; row < 17; row += 1) {
    for (let column = 0; column < 17; column += 1) {
      const candidate = [
        bounds[0] + (bounds[2] - bounds[0]) * ((column + 0.5) / 17),
        bounds[1] + (bounds[3] - bounds[1]) * ((row + 0.5) / 17),
      ]
      if (pointInPolygon(candidate, rings)) return candidate
    }
  }

  // Boundary points are valid for the final containment fallback.
  return [rings[0][0][0], rings[0][0][1]]
}

function geometryPolygons(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  throw new Error(`Unsupported geometry type: ${geometry.type}`)
}

const containmentRegressionRing = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
]
if (
  !pointInRing([0.5, 0.5], containmentRegressionRing) ||
  pointInRing([1.5, 0.5], containmentRegressionRing)
) {
  throw new Error('Settlement point-in-ring regression check failed')
}

function prepareGeometry(geometry) {
  const polygons = geometryPolygons(geometry).map((rings) => {
    const polygonGeometry = { type: 'Polygon', coordinates: rings }
    return {
      rings,
      bounds: geometryBounds(polygonGeometry),
      area: polygonArea(rings),
    }
  })
  return { bounds: geometryBounds(geometry), polygons }
}

function pointInPreparedGeometry(point, prepared) {
  return prepared.polygons.some(
    (polygon) =>
      boundsContain(polygon.bounds, point) && pointInPolygon(point, polygon.rings),
  )
}

function geometryInteriorPoint(prepared) {
  const largestPolygon = [...prepared.polygons].sort((left, right) => right.area - left.area)[0]
  return polygonInteriorPoint(largestPolygon.rings)
}

function assignMunicipality(settlementPrepared, municipalities) {
  const representativePoint = geometryInteriorPoint(settlementPrepared)
  let candidates = municipalities.filter((municipality) =>
    boundsIntersect(settlementPrepared.bounds, municipality.prepared.bounds),
  )
  if (candidates.length === 0) candidates = municipalities

  const representativeMatches = candidates.filter(
    (municipality) =>
      boundsContain(municipality.prepared.bounds, representativePoint) &&
      pointInPreparedGeometry(representativePoint, municipality.prepared),
  )
  if (representativeMatches.length === 1) {
    return {
      municipality: representativeMatches[0],
      method: 'point-in-polygon',
      representativePoint,
    }
  }

  return { municipality: null, method: 'unresolved', representativePoint }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
  return results
}

async function resolveWithOfficialBuurt(point) {
  const epsilon = 1e-7
  const url = new URL(
    'https://api.pdok.nl/cbs/wijken-en-buurten-2025/ogc/v1/collections/buurten/items',
  )
  url.searchParams.set('f', 'json')
  url.searchParams.set('limit', '20')
  url.searchParams.set(
    'bbox',
    [
      point[0] - epsilon,
      point[1] - epsilon,
      point[0] + epsilon,
      point[1] + epsilon,
    ].join(','),
  )

  const response = await fetchJson(url, '2025 buurt fallback')
  const candidates = response.features
    .map((feature) => ({
      code: feature.properties?.gemeentecode,
      name: feature.properties?.gemeentenaam,
      water: feature.properties?.water,
      contains: pointInPreparedGeometry(point, prepareGeometry(feature.geometry)),
    }))
    .filter(({ code }) => typeof code === 'string')
    .sort(
      (left, right) =>
        Number(right.contains) - Number(left.contains) ||
        ['NEE', 'JA', 'B'].indexOf(left.water) - ['NEE', 'JA', 'B'].indexOf(right.water) ||
        left.code.localeCompare(right.code),
    )

  if (candidates.length === 0) {
    throw new Error(`No 2025 CBS buurt contains fallback point ${point.join(',')}`)
  }
  return { ...candidates[0], url: url.toString() }
}

function stripExtraDimensions(coordinates) {
  if (typeof coordinates?.[0] === 'number') return [coordinates[0], coordinates[1]]
  return coordinates.map(stripExtraDimensions)
}

function normalizedGeometry(geometry) {
  return { type: geometry.type, coordinates: stripExtraDimensions(geometry.coordinates) }
}

function stringOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizedPopulation(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeFeature(feature, collectionId) {
  const properties = feature.properties ?? {}
  const localId = String(properties.lokaal_id ?? feature.id)
  const namespace = stringOrNull(properties.namespace) ?? 'NL.TOP10NL'
  const nameNl = stringOrNull(properties.naamnl)
  const nameOfficial = stringOrNull(properties.naamofficieel)
  const nameFrisian = stringOrNull(properties.naamfries)
  return {
    key: `${namespace}:${localId}`,
    sourceFeatureId: String(feature.id),
    sourceCollection: collectionId,
    localId,
    name: nameOfficial ?? nameNl ?? nameFrisian ?? `Unnamed settlement ${localId}`,
    nameNl,
    nameOfficial,
    nameFrisian,
    settlementType: properties.typegebied,
    population: normalizedPopulation(properties.aantalinwoners),
    builtUp: properties.bebouwdekom === 'ja',
    bagPlace: properties.isbagwoonplaats === 'ja',
    sourceDate: stringOrNull(properties.bronactualiteit),
    geometry: normalizedGeometry(feature.geometry),
  }
}

function incrementCount(record, key, increment = 1) {
  record[key] = (record[key] ?? 0) + increment
}

function collectionBounds(features) {
  if (features.length === 0) return null
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  for (const feature of features) {
    const featureBounds = geometryBounds(feature.geometry)
    bounds[0] = Math.min(bounds[0], featureBounds[0])
    bounds[1] = Math.min(bounds[1], featureBounds[1])
    bounds[2] = Math.max(bounds[2], featureBounds[2])
    bounds[3] = Math.max(bounds[3], featureBounds[3])
  }
  return bounds
}

const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
if (municipalityCollection.source?.boundaryEdition !== 2025) {
  throw new Error(
    `Settlement ingestion requires 2025 municipality boundaries; found ${municipalityCollection.source?.boundaryEdition ?? 'unknown'}`,
  )
}

const municipalities = municipalityCollection.features
  .map((feature) => {
    if (feature.properties.boundaryEdition !== 2025) {
      throw new Error(`${feature.properties.code} does not use 2025 boundaries`)
    }
    return {
      code: feature.properties.code,
      name: feature.properties.name,
      center: feature.properties.center,
      geometry: feature.geometry,
      prepared: prepareGeometry(feature.geometry),
    }
  })
  .sort((left, right) => left.code.localeCompare(right.code))

const [apiMetadata, ...collectionResults] = await Promise.all([
  fetchJson(`${apiBase}/api?f=json`, 'TOP10NL API metadata'),
  ...collectionIds.map(async (collectionId) => {
    const [collection, metadata] = await Promise.all([
      fetchCollection(collectionId),
      fetchJson(`${apiBase}/collections/${collectionId}?f=json`, `${collectionId} metadata`),
    ])
    return { ...collection, metadata }
  }),
])

const normalizedById = new Map()
let duplicateCount = 0
const collectionStatistics = []

for (const result of collectionResults) {
  let retained = 0
  for (const feature of result.features) {
    if (!retainedTypes.has(feature.properties?.typegebied)) continue
    retained += 1
    const normalized = normalizeFeature(feature, result.collectionId)
    const previous = normalizedById.get(normalized.key)
    if (previous) {
      const sameFeature =
        previous.settlementType === normalized.settlementType &&
        previous.name === normalized.name &&
        JSON.stringify(previous.geometry) === JSON.stringify(normalized.geometry)
      if (!sameFeature) {
        throw new Error(`Conflicting TOP10NL features share stable key ${normalized.key}`)
      }
      duplicateCount += 1
      continue
    }
    normalizedById.set(normalized.key, normalized)
  }
  collectionStatistics.push({
    id: result.collectionId,
    itemsUrl: result.startUrl,
    schemaUrl: `${apiBase}/collections/${result.collectionId}/schema?f=json`,
    updatedAt: result.metadata.links?.find((link) => link.rel === 'self')?.updated ?? null,
    pages: result.pages,
    fetched: result.features.length,
    retained,
  })
}

const settlements = [...normalizedById.values()].sort((left, right) =>
  left.key.localeCompare(right.key),
)
const assignmentsByMunicipality = new Map(
  municipalities.map((municipality) => [municipality.code, []]),
)
const assignmentMethods = {}
const countsByType = {}
const sourceDates = new Set()
const excludedForeignByType = {}
let foreignFeaturesExcluded = 0

for (const settlement of settlements) {
  if (settlement.sourceDate) sourceDates.add(settlement.sourceDate)
}

const preliminaryAssignments = settlements.map((settlement) => {
  const prepared = prepareGeometry(settlement.geometry)
  const assignment = assignMunicipality(prepared, municipalities)
  return { settlement, assignment }
})

const unresolvedAssignments = preliminaryAssignments.filter(
  ({ assignment }) => !assignment.municipality,
)
const officialFallbackResults = await mapWithConcurrency(
  unresolvedAssignments,
  6,
  ({ assignment }) => resolveWithOfficialBuurt(assignment.representativePoint),
)
const officialFallbackBySettlement = new Map(
  unresolvedAssignments.map(({ settlement }, index) => [
    settlement.key,
    officialFallbackResults[index],
  ]),
)

for (const { settlement, assignment } of preliminaryAssignments) {
  let municipality = assignment.municipality
  let assignmentMethod = assignment.method

  if (!municipality) {
    const officialFallback = officialFallbackBySettlement.get(settlement.key)
    if (officialFallback.code === 'GM0998' || officialFallback.water === 'B') {
      foreignFeaturesExcluded += 1
      incrementCount(excludedForeignByType, settlement.settlementType)
      continue
    }
    municipality = municipalities.find(({ code }) => code === officialFallback.code)
    if (!municipality) {
      throw new Error(
        `${settlement.key} resolved to unknown municipality ${officialFallback.code}`,
      )
    }
    assignmentMethod = 'official-buurt-point'
  }

  incrementCount(assignmentMethods, assignmentMethod)
  incrementCount(countsByType, settlement.settlementType)

  assignmentsByMunicipality.get(municipality.code).push({
    type: 'Feature',
    id: settlement.key,
    geometry: settlement.geometry,
    properties: {
      id: settlement.key,
      localId: settlement.localId,
      name: settlement.name,
      nameNl: settlement.nameNl,
      nameOfficial: settlement.nameOfficial,
      nameFrisian: settlement.nameFrisian,
      settlementType: settlement.settlementType,
      population: settlement.population,
      builtUp: settlement.builtUp,
      bagPlace: settlement.bagPlace,
      municipalityCode: municipality.code,
      municipalityName: municipality.name,
      sourceDate: settlement.sourceDate,
      sourceCollection: settlement.sourceCollection,
      assignmentMethod,
    },
  })
}

const generatedAt = new Date().toISOString()
const license = apiMetadata.info?.license ?? {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/deed.nl',
}
const contentHash = createHash('sha256')
const municipalityEntries = []
let totalOutputBytes = 0

await mkdir(outputDirectory, { recursive: true })

for (const municipality of municipalities) {
  const features = assignmentsByMunicipality.get(municipality.code)
  features.sort(
    (left, right) =>
      left.properties.settlementType.localeCompare(right.properties.settlementType) ||
      left.properties.name.localeCompare(right.properties.name, 'nl') ||
      String(left.id).localeCompare(String(right.id)),
  )
  const featureCounts = {}
  for (const feature of features) incrementCount(featureCounts, feature.properties.settlementType)

  const bbox = collectionBounds(features)
  const output = {
    type: 'FeatureCollection',
    name: `TOP10NL settlements in ${municipality.name}`,
    ...(bbox ? { bbox } : {}),
    source: {
      dataset: 'BRT TOP10NL',
      api: apiBase,
      license,
      sourceDates: [...sourceDates].sort(),
      retrievedAt: generatedAt,
      municipalityBoundaryEdition: 2025,
      geometrySimplified: false,
    },
    features,
  }
  const serialized = `${JSON.stringify(output)}\n`
  const bytes = Buffer.byteLength(serialized)
  totalOutputBytes += bytes
  contentHash.update(municipality.code)
  contentHash.update(JSON.stringify(features))
  await writeFile(resolve(outputDirectory, `${municipality.code}.geojson`), serialized, 'utf8')

  municipalityEntries.push({
    code: municipality.code,
    name: municipality.name,
    file: `${municipality.code}.geojson`,
    count: features.length,
    countsByType: featureCounts,
    bytes,
  })
}

const manifest = {
  schemaVersion: 1,
  generatedAt,
  dataset: {
    name: apiMetadata.info?.title ?? 'BRT TOP10NL',
    provider: 'Kadaster / PDOK',
    api: apiBase,
    license,
    sourceDates: [...sourceDates].sort(),
    collections: collectionStatistics,
  },
  municipalitySource: municipalityCollection.source,
  processing: {
    retainedTypes: [...retainedTypes],
    geometrySimplified: false,
    coordinateDimensions: 2,
    dedupeKey: 'namespace + lokaal_id',
    duplicateCount,
    assignment:
      'A deterministic point-on-surface is tested against exact 2025 municipality polygons. Points outside or ambiguously on generalized boundaries are resolved against full 2025 CBS buurt geometry; GM0998/Buitenland features are excluded.',
    officialFallback:
      'https://api.pdok.nl/cbs/wijken-en-buurten-2025/ogc/v1/collections/buurten/items',
    assignmentMethods,
    foreignFeaturesExcluded,
    excludedForeignByType,
  },
  totals: {
    sourceFeatures: collectionStatistics.reduce((total, item) => total + item.fetched, 0),
    candidateFeatures: settlements.length,
    retainedFeatures: settlements.length - foreignFeaturesExcluded,
    municipalities: municipalityEntries.length,
    outputBytes: totalOutputBytes,
    countsByType,
  },
  contentSha256: contentHash.digest('hex'),
  municipalities: municipalityEntries,
}

await writeFile(
  resolve(outputDirectory, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

const largestFiles = [...municipalityEntries]
  .sort((left, right) => right.bytes - left.bytes)
  .slice(0, 5)
  .map(({ code, name, count, bytes }) => ({ code, name, count, bytes }))

console.log(
  JSON.stringify(
    {
      sourceFeatures: manifest.totals.sourceFeatures,
      candidateFeatures: manifest.totals.candidateFeatures,
      retainedFeatures: manifest.totals.retainedFeatures,
      foreignFeaturesExcluded,
      excludedForeignByType,
      duplicateCount,
      countsByType,
      assignmentMethods,
      municipalityFiles: municipalityEntries.length,
      totalOutputMiB: Number((totalOutputBytes / 1024 / 1024).toFixed(2)),
      largestFiles,
      manifest: resolve(outputDirectory, 'manifest.json'),
    },
    null,
    2,
  ),
)
