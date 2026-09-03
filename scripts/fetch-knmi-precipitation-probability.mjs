#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = resolve(here, '../apps/web/public/data/public-context')
const metadataPath = resolve(outputDirectory, 'knmi-precipitation-probability.json')
const endpoint = 'https://anonymous.api.dataplatform.knmi.nl/wms/adaguc-server'
const dataset = 'seamless_precipitation_ensemble_forecast_probabilities'
const layer = dataset
const datasetPage =
  'https://dataplatform.knmi.nl/catalog/datasets/index.html?x-dataset=seamless_precipitation_ensemble_forecast_probabilities&x-dataset-version=1.0'
const bounds = { west: 3.2, south: 50.7, east: 7.3, north: 53.7 }
const width = 1_024
const height = 1_024
const thresholdMmH = 3
const style = 'probability-discrete-blue-to-purple/bilinear'
const requestedLeadHours = [1, 3, 6]

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

function readDimension(capabilities, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(
    `<Dimension\\s+name="${escapedName}"[^>]*default="([^"]+)"[^>]*>([^<]+)<\\/Dimension>`,
  ).exec(capabilities)
  if (!match) throw new Error(`KNMI forecast WMS does not expose the ${name} dimension`)
  return { defaultValue: match[1], values: match[2].trim() }
}

function parseIsoRange(value, name) {
  const [start, end, interval] = value.split('/')
  if (
    !start ||
    !end ||
    !interval ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end))
  ) {
    throw new Error(`KNMI ${name} dimension is not a valid ISO interval`)
  }
  return { start, end, interval }
}

const capabilitiesParameters = new URLSearchParams({
  DATASET: dataset,
  SERVICE: 'WMS',
  request: 'GetCapabilities',
})
const capabilitiesResponse = await fetchWithRetry(
  `${endpoint}?${capabilitiesParameters}`,
  'KNMI seamless-precipitation WMS capabilities',
)
const capabilities = await capabilitiesResponse.text()
if (!new RegExp(`<Name>${layer}<\\/Name>`).test(capabilities)) {
  throw new Error('KNMI forecast WMS no longer exposes the expected probability layer')
}
if (!capabilities.includes(`<Name>${style}</Name>`)) {
  throw new Error('KNMI forecast WMS no longer exposes the selected probability style')
}

const timeDimension = readDimension(capabilities, 'time')
const referenceDimension = readDimension(capabilities, 'reference_time')
const thresholdDimension = readDimension(capabilities, 'threshold')
const timeRange = parseIsoRange(timeDimension.values, 'time')
const referenceRange = parseIsoRange(referenceDimension.values, 'reference_time')
const thresholds = thresholdDimension.values.split(',').map(Number)
if (!thresholds.includes(thresholdMmH)) {
  throw new Error(`KNMI forecast WMS no longer exposes the ${thresholdMmH} mm/h threshold`)
}

const referenceTimeMs = Date.parse(referenceDimension.defaultValue)
if (!Number.isFinite(referenceTimeMs)) throw new Error('KNMI forecast reference time is invalid')
const referenceTime = new Date(referenceTimeMs).toISOString()
const maximumValidTimeMs = Date.parse(timeRange.end)
const checkpoints = requestedLeadHours.map((leadHours) => {
  const validTimeMs = referenceTimeMs + leadHours * 60 * 60 * 1_000
  if (validTimeMs > maximumValidTimeMs) {
    throw new Error(`KNMI latest complete cycle does not reach T+${leadHours}`)
  }
  return { leadHours, validTime: new Date(validTimeMs).toISOString() }
})

const images = []
for (const checkpoint of checkpoints) {
  // The anonymous WMS is quota-limited. Keep deployment refreshes below one
  // request per second rather than asking each browser for a tile pyramid.
  await wait(1_200)
  const mapParameters = new URLSearchParams({
    DATASET: dataset,
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: layer,
    STYLES: style,
    // The current service advertises CRS:84 bounds with transposed axes.
    // Requesting explicit Web Mercator removes that ambiguity and matches the
    // MapLibre image source projection used by the browser.
    CRS: 'EPSG:3857',
    BBOX: `${projectedWest},${projectedSouth},${projectedEast},${projectedNorth}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    TIME: checkpoint.validTime,
    DIM_REFERENCE_TIME: referenceTime,
    DIM_THRESHOLD: String(thresholdMmH),
  })
  const response = await fetchWithRetry(
    `${endpoint}?${mapParameters}`,
    `KNMI T+${checkpoint.leadHours} precipitation-probability image`,
  )
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('image/png')) {
    throw new Error(`KNMI forecast WMS returned ${contentType || 'an unknown content type'}`)
  }
  const image = Buffer.from(await response.arrayBuffer())
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (
    image.length < 24 ||
    !image.subarray(0, pngSignature.length).equals(pngSignature) ||
    image.readUInt32BE(16) !== width ||
    image.readUInt32BE(20) !== height
  ) {
    throw new Error(`KNMI T+${checkpoint.leadHours} response is not the expected 1024 × 1024 PNG`)
  }
  const fileName = `knmi-precipitation-probability-t-plus-${checkpoint.leadHours}.png`
  images.push({
    ...checkpoint,
    fileName,
    path: `data/public-context/${fileName}`,
    width,
    height,
    bytes: image.length,
    sha256: createHash('sha256').update(image).digest('hex'),
    image,
  })
}

const retrievedAt = new Date().toISOString()
const metadata = {
  evidenceClass: 'official-forecast',
  affectsSimulation: false,
  referenceTime,
  retrievedAt,
  thresholdMmH,
  probabilityMeaning: `Probability of five-minute precipitation intensity exceeding ${thresholdMmH} mm/h`,
  bounds,
  imageRequest: {
    crs: 'EPSG:3857',
    bbox: [projectedWest, projectedSouth, projectedEast, projectedNorth],
    width,
    height,
  },
  checkpoints: images.map(({ image: _image, fileName: _fileName, ...checkpoint }) => checkpoint),
  source: {
    id: 'seamless_precipitation_ensemble_forecast_probabilities-1.0',
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)',
    url: datasetPage,
    serviceUrl: endpoint,
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    productStatus: 'pilot',
    updateCadence: '5 minutes',
    forecastHorizonHours: 6,
    gridResolutionKm: 1,
    thresholdOptionsMmH: thresholds,
    timeDimension: timeDimension.values,
    referenceTimeDimension: referenceDimension.values,
    style,
    coverage:
      'National 1 km probability rendering at T+1, T+3 and T+6 from the latest complete reference cycle.',
    noDataSemantics:
      'Transparent or unrendered pixels remain NoData/unknown unless the publisher explicitly encodes a zero probability.',
    caveat:
      'This is an experimental probability product, not deterministic rainfall. It ends at T+6, is not extrapolated to T+72 and remains non-causal until its reference time is explicitly bound to the exercise clock.',
  },
}

await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  ...images.map(({ fileName, image }) => writeFile(resolve(outputDirectory, fileName), image)),
  writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`),
])

process.stdout.write(`${JSON.stringify({
  metadataPath,
  referenceTime,
  thresholdMmH,
  checkpoints: metadata.checkpoints.map(({ leadHours, validTime, bytes, sha256 }) => ({
    leadHours,
    validTime,
    bytes,
    sha256,
  })),
}, null, 2)}\n`)
