#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = resolve(here, '../apps/web/public/data/public-context')
const outputPath = resolve(outputDirectory, 'water-assets.geojson.gz')
const municipalityBoundaryBase = 'https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1'
const municipalityBoundaryEdition = '2025-07-01T00:00:00Z'

const services = [
  {
    id: 'imwa-water-control',
    publisher: 'Het Waterschapshuis / Dutch water boards',
    base: 'https://api.pdok.nl/hwh/waterschappen-kunstwerken-imwa/ogc/v2',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/deed.nl',
    collections: [
      { id: 'gemaal', type: 'surface-water-pump' },
      { id: 'stuw', type: 'weir' },
      { id: 'sluis', type: 'sluice' },
    ],
  },
  {
    id: 'damo-wastewater',
    publisher: 'Het Waterschapshuis / Dutch water boards',
    base: 'https://api.pdok.nl/hwh/waterschappen-waterketen-damo/ogc/v1',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/deed.nl',
    collections: [
      { id: 'rioolgemaal', type: 'sewer-pump' },
      { id: 'rwzi', type: 'wastewater-treatment' },
    ],
  },
]

async function getJson(url, label) {
  const response = await fetch(url, {
    headers: { accept: 'application/geo+json, application/json' },
  })
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${await response.text()}`)
  return response.json()
}

async function fetchCollection(service, collection) {
  const features = []
  let next = `${service.base}/collections/${collection.id}/items?f=json&limit=1000`
  let page = 0
  while (next) {
    const data = await getJson(next, `${service.id}/${collection.id}`)
    features.push(...(data.features ?? []))
    next = data.links?.find(
      (link) => link.rel === 'next' && (link.type?.includes('json') || link.href?.includes('f=json')),
    )?.href
    page += 1
    process.stdout.write(`\r${collection.id}: ${features.length.toLocaleString('en')} features (${page} pages)`)
  }
  process.stdout.write('\n')
  return features
}

async function fetchMunicipalityBoundaries() {
  const features = []
  const first = new URL(
    `${municipalityBoundaryBase}/collections/gemeente_niet_gegeneraliseerd/items`,
  )
  first.searchParams.set('f', 'json')
  first.searchParams.set('limit', '1000')
  first.searchParams.set('datetime', municipalityBoundaryEdition)
  let next = first.toString()
  while (next) {
    const data = await getJson(next, 'CBS non-generalized municipality boundaries')
    features.push(...(data.features ?? []))
    next = data.links?.find(
      (link) => link.rel === 'next' && (link.type?.includes('json') || link.href?.includes('f=json')),
    )?.href
  }
  const current = features.filter(
    (feature) =>
      feature.properties?.jaarcode === 2025 &&
      /^GM\d{4}$/.test(feature.properties?.statcode ?? '') &&
      (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon'),
  )
  if (current.length !== 342 || new Set(current.map((feature) => feature.properties.statcode)).size !== 342) {
    throw new Error(`Expected 342 unique CBS 2025 municipality boundaries, received ${current.length}`)
  }
  return current
}

function ringContains(point, ring) {
  const [x, y] = point
  let inside = false
  for (
    let current = 0, previous = ring.length - 1;
    current < ring.length;
    previous = current, current += 1
  ) {
    const [currentX, currentY] = ring[current]
    const [previousX, previousY] = ring[previous]
    if (
      (currentY > y) !== (previousY > y) &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
    ) inside = !inside
  }
  return inside
}

function polygonContains(point, polygon) {
  return ringContains(point, polygon[0]) &&
    !polygon.slice(1).some((ring) => ringContains(point, ring))
}

function geometryContains(point, geometry) {
  return geometry.type === 'Polygon'
    ? polygonContains(point, geometry.coordinates)
    : geometry.coordinates.some((polygon) => polygonContains(point, polygon))
}

function geometryCoordinates(geometry) {
  return geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.coordinates.flat(2)
}

function municipalityIndex(features) {
  return features.map((feature) => {
    const coordinates = geometryCoordinates(feature.geometry)
    return {
      code: feature.properties.statcode,
      name: feature.properties.statnaam,
      geometry: feature.geometry,
      bounds: [
        Math.min(...coordinates.map((coordinate) => coordinate[0])),
        Math.min(...coordinates.map((coordinate) => coordinate[1])),
        Math.max(...coordinates.map((coordinate) => coordinate[0])),
        Math.max(...coordinates.map((coordinate) => coordinate[1])),
      ],
    }
  })
}

function containingMunicipalities(point, index) {
  return index.filter(
    ({ bounds, geometry }) =>
      point[0] >= bounds[0] &&
      point[0] <= bounds[2] &&
      point[1] >= bounds[1] &&
      point[1] <= bounds[3] &&
      geometryContains(point, geometry),
  )
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compactFeature(feature, service, collection, municipalityBoundaries) {
  if (feature.geometry?.type !== 'Point' || feature.geometry.coordinates.length < 2) return null
  const [longitude, latitude] = feature.geometry.coordinates
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null
  const properties = feature.properties ?? {}
  const municipalityMatches = containingMunicipalities([longitude, latitude], municipalityBoundaries)
  const municipality = municipalityMatches.length === 1 ? municipalityMatches[0] : null
  const capacity =
    finiteNumber(properties.maximalecapaciteit) ??
    finiteNumber(properties.capaciteithuidig) ??
    finiteNumber(properties.capaciteitontwerp) ??
    finiteNumber(properties.capaciteitgeinstalleerd)
  return {
    type: 'Feature',
    id: `${service.id === 'imwa-water-control' ? 'i' : 'd'}:${collection.id}:${feature.id}`,
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: {
      assetType: collection.type,
      name: properties.naam || properties.code || null,
      code: properties.code || null,
      manager: properties.waterbeheerder || properties.beheerder || properties.eigenaar || null,
      status: properties.statusobject || null,
      function: properties.functiegemaal || properties.hoofdfunctiestuw || properties.typesluis || properties.typerwzi || properties.typerioolgemaal || null,
      capacity,
      registeredAt: properties.tijdstipregistratie || properties.datuminwinning || null,
      sourceId: service.id,
      sourceCollection: collection.id,
      municipalityCode: municipality?.code ?? null,
      municipalityName: municipality?.name ?? null,
      municipalityAssignment:
        municipalityMatches.length === 1
          ? 'CBS 2025 non-generalized polygon containment'
          : municipalityMatches.length > 1
            ? 'ambiguous shared municipality boundary'
            : 'outside CBS 2025 municipality polygons',
    },
  }
}

const retrievedAt = new Date().toISOString()
const municipalityFeatures = await fetchMunicipalityBoundaries()
const municipalityBoundaries = municipalityIndex(municipalityFeatures)
const features = []
const counts = {}
for (const service of services) {
  for (const collection of service.collections) {
    const sourceFeatures = await fetchCollection(service, collection)
    const compact = sourceFeatures
      .map((feature) => compactFeature(feature, service, collection, municipalityBoundaries))
      .filter(Boolean)
    counts[collection.type] = compact.length
    features.push(...compact)
  }
}

const assignedFeatures = features.filter((feature) => feature.properties.municipalityCode !== null)
const ambiguousFeatures = features.filter(
  (feature) => feature.properties.municipalityAssignment === 'ambiguous shared municipality boundary',
)
const municipalitiesRepresented = new Set(
  assignedFeatures.map((feature) => feature.properties.municipalityCode),
).size

features.sort((left, right) => String(left.id).localeCompare(String(right.id)))
if (new Set(features.map((feature) => feature.id)).size !== features.length) {
  throw new Error('Duplicate public water-asset IDs after normalization')
}

const collection = {
  type: 'FeatureCollection',
  evidenceClass: 'official-context',
  affectsSimulation: false,
  counts,
  municipalityAssignment: {
    method: 'point-in-polygon against CBS 2025 non-generalized municipality geometry',
    boundaryEdition: 2025,
    boundaryInstant: municipalityBoundaryEdition,
    boundarySource: `${municipalityBoundaryBase}/collections/gemeente_niet_gegeneraliseerd`,
    boundaryLicense: 'CC BY 4.0',
    assignedToMunicipalityPolygon: assignedFeatures.length,
    outsideMunicipalityPolygon: features.length - assignedFeatures.length - ambiguousFeatures.length,
    ambiguousSharedBoundary: ambiguousFeatures.length,
    municipalitiesRepresented,
    noDataRule:
      'Outside and ambiguous boundary points remain unassigned; unassigned never means absent, inactive or safe.',
  },
  source: {
    retrievedAt,
    coverage: 'partial',
    coverageNote:
      'National aggregation of water-board submissions; the publishers state that completeness varies by contributing water board.',
    services: services.map((service) => ({
      id: service.id,
      publisher: service.publisher,
      url: service.base,
      license: service.license,
      licenseUrl: service.licenseUrl,
      collections: service.collections.map((collection) => collection.id),
    })),
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
const uncompressed = Buffer.from(`${JSON.stringify(collection)}\n`)
const compressed = gzipSync(uncompressed, { level: 9 })
await writeFile(outputPath, compressed)
console.log(JSON.stringify({
  outputPath,
  features: features.length,
  counts,
  municipalityAssignment: collection.municipalityAssignment,
  uncompressedBytes: uncompressed.length,
  compressedBytes: compressed.length,
}, null, 2))
