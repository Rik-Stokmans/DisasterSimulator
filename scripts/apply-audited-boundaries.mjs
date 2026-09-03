import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const regionPath = resolve(here, '../apps/web/public/data/regions/GM0744.json')
const base = 'https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1'
const editionInstant = '2025-07-01T00:00:00Z'
const bounds = '4.7,51.3,5.1,51.6'

async function fetchCollection(collection) {
  const first = new URL(`${base}/collections/${collection}/items`)
  first.searchParams.set('f', 'json')
  first.searchParams.set('limit', '100')
  first.searchParams.set('datetime', editionInstant)
  first.searchParams.set('bbox', bounds)
  const features = []
  let next = first.toString()
  while (next) {
    const response = await fetch(next, {
      headers: { accept: 'application/geo+json, application/json' },
    })
    if (!response.ok) throw new Error(`${collection} returned ${response.status}`)
    const page = await response.json()
    if (!Array.isArray(page.features)) throw new Error(`${collection} returned no features`)
    features.push(...page.features)
    next = page.links?.find(
      (link) => link.rel === 'next' && String(link.type).includes('json'),
    )?.href
  }
  return features
}

function componentAndHoleCounts(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  return {
    components: polygons.length,
    holes: polygons.reduce((sum, polygon) => sum + Math.max(0, polygon.length - 1), 0),
  }
}

const bundle = JSON.parse(await readFile(regionPath, 'utf8'))
const [municipalityCandidates, neighborhoodCandidates] = await Promise.all([
  fetchCollection('gemeente_niet_gegeneraliseerd'),
  fetchCollection('buurt_niet_gegeneraliseerd'),
])
const municipality = municipalityCandidates.find(
  (feature) => feature.properties?.statcode === 'GM0744',
)
const neighborhoods = neighborhoodCandidates.filter(
  (feature) => feature.properties?.gm_code === 'GM0744',
)
if (!municipality) throw new Error('Full-resolution GM0744 municipality geometry not found')
if (neighborhoods.length !== 10) {
  throw new Error(`Expected 10 full-resolution GM0744 neighborhoods, received ${neighborhoods.length}`)
}
const municipalityCounts = componentAndHoleCounts(municipality.geometry)
if (municipalityCounts.components !== 9 || municipalityCounts.holes !== 22) {
  throw new Error(
    `Expected GM0744 geometry with 9 components and 22 holes, received ${municipalityCounts.components}/${municipalityCounts.holes}`,
  )
}

const fullNeighborhoodByCode = new Map(
  neighborhoods.map((feature) => [feature.properties.statcode, feature]),
)
bundle.neighborhoods.features = bundle.neighborhoods.features.map((feature) => {
  const source = fullNeighborhoodByCode.get(feature.properties.id)
  if (!source) throw new Error(`Missing full-resolution geometry for ${feature.properties.id}`)
  return { ...feature, geometry: source.geometry }
})
bundle.operationalBoundary = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    id: 'GM0744-operational',
    geometry: municipality.geometry,
    properties: {
      code: 'GM0744',
      name: 'Baarle-Nassau',
      edition: 2025,
      evidenceClass: 'official-context',
      sourceCollection: 'gemeente_niet_gegeneraliseerd',
    },
  }],
}
bundle.source = {
  ...bundle.source,
  neighborhoods: `${base}/collections/buurt_niet_gegeneraliseerd`,
  operationalBoundary: `${base}/collections/gemeente_niet_gegeneraliseerd`,
  boundaryUse:
    'Full-resolution audited override for city-scale containment and jurisdiction; national overview remains generalized.',
  boundaryLicense: 'CC BY 4.0',
  boundaryRetrievedAt: new Date().toISOString(),
}
await writeFile(regionPath, `${JSON.stringify(bundle)}\n`)
process.stdout.write(
  `GM0744 full boundary: ${municipalityCounts.components} components, ${municipalityCounts.holes} holes; ${neighborhoods.length} neighborhoods\n`,
)
