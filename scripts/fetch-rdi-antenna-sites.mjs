#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import proj4 from 'proj4'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const outputDirectory = resolve(dataDirectory, 'public-context')
const outputPath = resolve(outputDirectory, 'rdi-antenna-sites.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')
const serviceUrl = 'https://antenneregister.nl/mapserver/wfs/'
const registerPage = 'https://antenneregister.nl/'
const officialPage = 'https://www.rdi.nl/onderwerpen/telecommunicatie/antennes-en-antenneregister'
const rulesPage = 'https://www.rdi.nl/onderwerpen/telecommunicatie/telecommunicatiewet/regels-antenneregister'
const pageSize = 2_000

proj4.defs(
  'EPSG:28992',
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
)

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
    await wait(500 * 2 ** attempt)
  }
  throw lastError
}

function ringContains(point, ring) {
  const [x, y] = point
  let inside = false
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
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
  return ringContains(point, polygon[0]) && !polygon.slice(1).some((ring) => ringContains(point, ring))
}

function geometryContains(point, geometry) {
  if (geometry.type === 'Polygon') return polygonContains(point, geometry.coordinates)
  return geometry.coordinates.some((polygon) => polygonContains(point, polygon))
}

function geometryCoordinates(geometry) {
  return geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.coordinates.flat(2)
}

function municipalityIndex(collection) {
  return collection.features.map((feature) => {
    const coordinates = geometryCoordinates(feature.geometry)
    return {
      code: feature.properties.code,
      name: feature.properties.name,
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

function containingMunicipality(point, index) {
  const candidates = index.filter(({ bounds }) =>
    point[0] >= bounds[0] && point[0] <= bounds[2] && point[1] >= bounds[1] && point[1] <= bounds[3]
  )
  const matches = candidates.filter(({ geometry }) => geometryContains(point, geometry))
  if (matches.length > 1) throw new Error(`RDI antenna point ${point.join(',')} intersects multiple municipalities`)
  return matches[0] ?? null
}

function enabled(value) {
  return Number(value) > 0
}

function primaryCategory(properties) {
  if (enabled(properties.MOBIELE_COMMUNICATIE)) return 'mobile communication'
  if (enabled(properties.VASTE_VERB)) return 'fixed link'
  if (enabled(properties.OMROEP)) return 'broadcast'
  if (enabled(properties.OVERIGMOBIEL)) return 'other mobile'
  if (enabled(properties.ZENDAMATEURS)) return 'radio amateur'
  return 'other registered antenna'
}

async function fetchPage(startIndex) {
  const parameters = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'ms:Antennes',
    outputFormat: 'application/json',
    srsName: 'EPSG:28992',
    count: String(pageSize),
    startIndex: String(startIndex),
    sortBy: 'ID',
  })
  const response = await fetchWithRetry(`${serviceUrl}?${parameters}`, `RDI WFS page ${startIndex}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const collection = JSON.parse(buffer.toString('utf8'))
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`RDI WFS page ${startIndex} did not return a GeoJSON FeatureCollection`)
  }
  return { buffer, collection }
}

const retrievedAt = new Date().toISOString()
const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
const municipalityLookup = municipalityIndex(municipalityCollection)
const sourceFeatures = []
const rawHash = createHash('sha256')
let pageCount = 0
for (let startIndex = 0; pageCount < 40; startIndex += pageSize) {
  const page = await fetchPage(startIndex)
  pageCount += 1
  rawHash.update(page.buffer)
  sourceFeatures.push(...page.collection.features)
  process.stdout.write(`\rRDI antenna WFS pages: ${pageCount} · records: ${sourceFeatures.length}`)
  if (page.collection.features.length < pageSize) break
}
process.stdout.write('\n')
if (pageCount === 40 || sourceFeatures.length < 20_000) {
  throw new Error(`RDI WFS pagination is incomplete: ${pageCount} pages, ${sourceFeatures.length} records`)
}

const uniqueSourceSites = new Map()
for (const feature of sourceFeatures) {
  const [x, y] = feature.geometry?.coordinates ?? []
  const id = feature.properties?.ID
  if (!Number.isFinite(x) || !Number.isFinite(y) || id === null || id === undefined) continue
  const key = `${id}:${x}:${y}`
  if (!uniqueSourceSites.has(key)) uniqueSourceSites.set(key, feature)
}

const municipalityCodes = new Set()
let assignedSites = 0
const features = [...uniqueSourceSites.values()].map((feature) => {
  const properties = feature.properties
  const [x, y] = feature.geometry.coordinates
  const coordinates = proj4('EPSG:28992', 'EPSG:4326', [x, y])
  const municipality = containingMunicipality(coordinates, municipalityLookup)
  if (municipality) {
    assignedSites += 1
    municipalityCodes.add(municipality.code)
  }
  return {
    type: 'Feature',
    id: `rdi-antenna-${properties.ID}-${x}-${y}`,
    geometry: { type: 'Point', coordinates },
    properties: {
      facilityType: 'antenna-installation',
      sourceSiteId: String(properties.ID),
      primaryCategory: primaryCategory(properties),
      antennaCount: Number(properties.AANTAL) || 0,
      technologySummary: properties.HOOFDSOORT || null,
      has2g: enabled(properties.TWEEG),
      has3g: enabled(properties.DRIEG),
      has4g: enabled(properties.VIERG),
      has5g: enabled(properties.VIJFG),
      mobileCommunication: enabled(properties.MOBIELE_COMMUNICATIE),
      broadcast: enabled(properties.OMROEP),
      otherMobile: enabled(properties.OVERIGMOBIEL),
      fixedLink: enabled(properties.VASTE_VERB),
      radioAmateur: enabled(properties.ZENDAMATEURS),
      smallCellIndicator: properties.SMALL_CELL_INDICATOR || null,
      postcode: properties.POSTCODE || null,
      registeredMunicipalityName: properties.GEMEENTE || null,
      municipalityCode: municipality?.code ?? null,
      municipalityName: municipality?.name ?? null,
      municipalityAssignment: municipality
        ? 'CBS 2025 generalized polygon containment'
        : 'outside generalized municipality polygon',
    },
  }
})
features.sort((left, right) => String(left.id).localeCompare(String(right.id)))

const categoryCounts = Object.fromEntries(
  [...new Set(features.map((feature) => feature.properties.primaryCategory))]
    .sort()
    .map((category) => [category, features.filter((feature) => feature.properties.primaryCategory === category).length]),
)
const counts = {
  sourceRecords: sourceFeatures.length,
  duplicateSourceRecordsRemoved: sourceFeatures.length - features.length,
  antennaInstallations: features.length,
  antennasRepresented: features.reduce((total, feature) => total + feature.properties.antennaCount, 0),
  mobileCommunicationSites: features.filter((feature) => feature.properties.mobileCommunication).length,
  fixedLinkSites: features.filter((feature) => feature.properties.fixedLink).length,
  broadcastSites: features.filter((feature) => feature.properties.broadcast).length,
  otherMobileSites: features.filter((feature) => feature.properties.otherMobile).length,
  radioAmateurSites: features.filter((feature) => feature.properties.radioAmateur).length,
  has2gSites: features.filter((feature) => feature.properties.has2g).length,
  has3gSites: features.filter((feature) => feature.properties.has3g).length,
  has4gSites: features.filter((feature) => feature.properties.has4g).length,
  has5gSites: features.filter((feature) => feature.properties.has5g).length,
  assignedToMunicipalityPolygon: assignedSites,
  outsideMunicipalityPolygon: features.length - assignedSites,
  municipalitiesRepresented: municipalityCodes.size,
  byPrimaryCategory: categoryCounts,
}
if (
  counts.antennaInstallations < 20_000 ||
  counts.mobileCommunicationSites < 5_000 ||
  counts.municipalitiesRepresented < 300
) throw new Error(`RDI antenna coverage changed unexpectedly: ${JSON.stringify(counts)}`)

const capabilitiesResponse = await fetchWithRetry(
  `${serviceUrl}?service=WFS&version=2.0.0&request=GetCapabilities`,
  'RDI WFS capabilities',
)
const capabilities = Buffer.from(await capabilitiesResponse.arrayBuffer())
const capabilitiesText = capabilities.toString('utf8')
if (
  !capabilitiesText.includes('Dataset met actuele informatie over alle antenne-installaties in Nederland') ||
  !capabilitiesText.includes('<ows:Fees>none</ows:Fees>') ||
  !capabilitiesText.includes('<ows:AccessConstraints>none</ows:AccessConstraints>')
) throw new Error('RDI WFS identity or access constraints changed unexpectedly')

const output = {
  type: 'FeatureCollection',
  evidenceClass: 'official-context',
  affectsSimulation: false,
  counts,
  source: {
    id: 'rdi-antenneregister-antenna-installations',
    publisher: 'Rijksinspectie Digitale Infrastructuur (RDI) / Antennebureau',
    title: 'Antenneregister – Antenne-installaties',
    url: registerPage,
    officialPage,
    rulesPage,
    serviceUrl,
    collection: 'ms:Antennes',
    retrievedAt,
    serviceTime: capabilitiesResponse.headers.get('date'),
    refreshCadence: 'not stated by the WFS service; refresh at deployment and retain retrievedAt',
    license: 'reuse licence not stated in service capabilities; fees none and access constraints none',
    licenseUrl: officialPage,
    coverage: 'public antenna installations in the statutory national register',
    coverageNote:
      'The register identifies installation locations and registered applications, not radio coverage, operator ownership, backhaul, capacity, traffic, power/backup, damage, congestion, availability or restoration. Installations outside a CBS polygon remain unassigned; no nearest municipality is fabricated.',
    rawPages: pageCount,
    rawSha256: rawHash.digest('hex'),
    capabilitiesSha256: createHash('sha256').update(capabilities).digest('hex'),
  },
  processing: {
    sourceCrs: 'EPSG:28992',
    outputCrs: 'EPSG:4326',
    transformation: 'proj4 EPSG:28992 to EPSG:4326',
    deduplication: 'exact source ID and RD coordinate; pagination overlap removed',
    municipalityAssignment:
      'Point-in-polygon against the coherent CBS 2025 generalized municipality snapshot; out-of-polygon sites retain municipalityCode=null.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
const uncompressed = Buffer.from(`${JSON.stringify(output)}\n`)
const compressed = gzipSync(uncompressed, { level: 9 })
await writeFile(outputPath, compressed)
console.log(JSON.stringify({ outputPath, counts, pageCount, uncompressedBytes: uncompressed.length, compressedBytes: compressed.length }, null, 2))
