#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = resolve(here, '../apps/web/public/data/public-context')
const outputPath = resolve(outputDirectory, 'government-service-locations.geojson.gz')
const base = 'https://api.pdok.nl/kvk/overheidsdiensten-geharmoniseerd/ogc/v1'
const collections = [
  { id: 'public_order_and_safety', type: 'public-order-and-safety' },
  { id: 'public_administration_office', type: 'public-administration' },
]

async function getJson(url, label) {
  const response = await fetch(url, {
    headers: { accept: 'application/geo+json, application/json' },
  })
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${await response.text()}`)
  return response.json()
}

async function fetchCollection(collection) {
  const features = []
  let next = `${base}/collections/${collection.id}/items?f=json&limit=1000`
  while (next) {
    const data = await getJson(next, collection.id)
    features.push(...(data.features ?? []))
    next = data.links?.find(
      (link) => link.rel === 'next' && (link.type?.includes('json') || link.href?.includes('f=json')),
    )?.href
    process.stdout.write(`\r${collection.id}: ${features.length.toLocaleString('en')} features`)
  }
  process.stdout.write('\n')
  return features
}

const retrievedAt = new Date().toISOString()
const features = []
const counts = {}
for (const collection of collections) {
  const sourceFeatures = await fetchCollection(collection)
  const compact = sourceFeatures.flatMap((feature) => {
    if (feature.geometry?.type !== 'Point' || feature.geometry.coordinates.length < 2) return []
    const [longitude, latitude] = feature.geometry.coordinates
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return []
    const properties = feature.properties ?? {}
    return [{
      type: 'Feature',
      id: `${collection.id === 'public_order_and_safety' ? 's' : 'a'}:${feature.id}`,
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: {
        facilityType: collection.type,
        locality: properties.address_area || null,
        postcode: properties.postcode || null,
        street: properties.thoroughfare || null,
        houseNumber: properties.locator_designator || null,
        registryIdentifier: properties.identifier || null,
        registeredAt: properties.begin_lifespan_version || null,
        sourceCollection: collection.id,
      },
    }]
  })
  counts[collection.type] = compact.length
  features.push(...compact)
}

features.sort((left, right) => String(left.id).localeCompare(String(right.id)))
if (new Set(features.map((feature) => feature.id)).size !== features.length) {
  throw new Error('Duplicate governmental-service feature IDs after normalization')
}

const output = {
  type: 'FeatureCollection',
  evidenceClass: 'official-context',
  affectsSimulation: false,
  counts,
  source: {
    id: 'kvk-governmental-services-inspire',
    publisher: 'Kamer van Koophandel / PDOK',
    url: base,
    license: 'Public Domain Mark 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/deed.nl',
    retrievedAt,
    coverage: 'partial',
    coverageNote:
      'INSPIRE registry subset with coarse service classes. A registered address is not evidence of emergency role, staffing, opening, capacity or incident availability.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
const uncompressed = Buffer.from(`${JSON.stringify(output)}\n`)
const compressed = gzipSync(uncompressed, { level: 9 })
await writeFile(outputPath, compressed)
console.log(JSON.stringify({
  outputPath,
  features: features.length,
  counts,
  uncompressedBytes: uncompressed.length,
  compressedBytes: compressed.length,
}, null, 2))
