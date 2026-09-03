#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = resolve(here, '../apps/web/public/data/public-context')
const imagePath = resolve(outputDirectory, 'knmi-radar.png')
const metadataPath = resolve(outputDirectory, 'knmi-radar.json')
const endpoint = 'https://anonymous.api.dataplatform.knmi.nl/wms/adaguc-server'
const dataset = 'radar_reflectivity_composites'
const datasetPage = 'https://dataplatform.knmi.nl/dataset/access/radar-reflectivity-composites-2-0'
const bounds = { west: 3.2, south: 50.7, east: 7.3, north: 53.7 }
const width = 1_024
const height = 1_024

function toWebMercator([longitude, latitude]) {
  const earthRadius = 20_037_508.342789244
  const x = longitude * earthRadius / 180
  const y = Math.log(Math.tan((90 + latitude) * Math.PI / 360)) / (Math.PI / 180) * earthRadius / 180
  return [x, y]
}

const [projectedWest, projectedSouth] = toWebMercator([bounds.west, bounds.south])
const [projectedEast, projectedNorth] = toWebMercator([bounds.east, bounds.north])

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

async function fetchWithRetry(url, label) {
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'NL-Resilience-Lab public-data refresh' },
      })
      if (response.ok) return response
      lastError = new Error(`${label} returned ${response.status}`)
      if (response.status !== 429 && response.status < 500) throw lastError
    } catch (error) {
      lastError = error
    }
    await wait(1_500 * 2 ** attempt)
  }
  throw lastError
}

const capabilitiesParameters = new URLSearchParams({
  DATASET: dataset,
  SERVICE: 'WMS',
  request: 'GetCapabilities',
})
const capabilitiesResponse = await fetchWithRetry(
  `${endpoint}?${capabilitiesParameters}`,
  'KNMI radar WMS capabilities',
)
const capabilities = await capabilitiesResponse.text()
if (!/<Name>precipitation<\/Name>/.test(capabilities)) {
  throw new Error('KNMI radar WMS no longer exposes the precipitation layer')
}
const timeDimension = /<Dimension\s+name="time"[^>]*default="([^"]+)"[^>]*>([^<]+)<\/Dimension>/.exec(
  capabilities,
)
if (!timeDimension || !Number.isFinite(Date.parse(timeDimension[1]))) {
  throw new Error('KNMI radar WMS capabilities do not expose a valid default time')
}
const observationTime = new Date(timeDimension[1]).toISOString()

// The anonymous service is limited to one request per second per IP. Keep the
// deployment refresh comfortably below that instead of letting every browser
// request a separate WMS tile pyramid.
await wait(1_200)

const mapParameters = new URLSearchParams({
  DATASET: dataset,
  SERVICE: 'WMS',
  REQUEST: 'GetMap',
  VERSION: '1.3.0',
  LAYERS: 'precipitation',
  STYLES: 'precip-smooth-white-to-purple/bilinear',
  // Explicit Web Mercator avoids the current service's transposed CRS:84
  // bounding-box metadata and matches MapLibre's rendered image projection.
  CRS: 'EPSG:3857',
  BBOX: `${projectedWest},${projectedSouth},${projectedEast},${projectedNorth}`,
  WIDTH: String(width),
  HEIGHT: String(height),
  FORMAT: 'image/png',
  TRANSPARENT: 'TRUE',
  TIME: observationTime,
})
const imageResponse = await fetchWithRetry(
  `${endpoint}?${mapParameters}`,
  'KNMI radar WMS image',
)
const contentType = imageResponse.headers.get('content-type') ?? ''
if (!contentType.toLowerCase().includes('image/png')) {
  throw new Error(`KNMI radar WMS returned ${contentType || 'an unknown content type'}`)
}
const image = Buffer.from(await imageResponse.arrayBuffer())
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
if (
  image.length < 24 ||
  !image.subarray(0, pngSignature.length).equals(pngSignature) ||
  image.readUInt32BE(16) !== width ||
  image.readUInt32BE(20) !== height
) {
  throw new Error('KNMI radar WMS did not return the expected 1024 × 1024 PNG')
}

const retrievedAt = new Date().toISOString()
const metadata = {
  evidenceClass: 'observed-context',
  affectsSimulation: false,
  observationTime,
  retrievedAt,
  bounds,
  imageRequest: {
    crs: 'EPSG:3857',
    bbox: [projectedWest, projectedSouth, projectedEast, projectedNorth],
    width,
    height,
  },
  image: {
    path: 'data/public-context/knmi-radar.png',
    width,
    height,
    bytes: image.length,
    sha256: createHash('sha256').update(image).digest('hex'),
    layer: 'precipitation',
    style: 'precip-smooth-white-to-purple/bilinear',
  },
  source: {
    id: 'knmi-radar-reflectivity-composites-2.0',
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)',
    url: datasetPage,
    serviceUrl: endpoint,
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    updateCadence: '5 minutes',
    temporalCoverage: timeDimension[2],
    coverage:
      'Latest WMS default-time precipitation rendering over the Netherlands bounding box.',
    caveat:
      'Near-real-time radar context can contain missing values or artefacts. It is not aligned to the scenario clock, is not a 72-hour forecast, and does not affect simulated hazard or service state.',
  },
}

await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  writeFile(imagePath, image),
  writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
])
process.stdout.write(`${JSON.stringify({ imagePath, metadataPath, observationTime, bytes: image.length }, null, 2)}\n`)
