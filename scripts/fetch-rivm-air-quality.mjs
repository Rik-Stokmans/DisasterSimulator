#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const outputDirectory = resolve(dataDirectory, 'public-context')
const outputPath = resolve(outputDirectory, 'rivm-air-quality-pm25.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')
const apiRoot = 'https://api.luchtmeetnet.nl/open_api'
const portalUrl = 'https://www.luchtmeetnet.nl/'
const officialDataPage = 'https://data.rivm.nl/data/luchtmeetnet/'
const metadataUrl = `${officialDataPage}Metadata/luchtmeetnet_meetlocaties.csv`
const readmeUrl = `${officialDataPage}readme.pdf`
const components = ['PM25', 'PM10', 'NO2', 'O3', 'SO2']
const observationWindowHours = 6

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

function parseDelimited(text, delimiter, label) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
    } else if (character === '"') {
      quoted = true
    } else if (character === delimiter) {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) throw new Error(`${label} ends inside a quoted field`)
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''))
    rows.push(row)
  }
  const dataRows = rows.filter((values) => !values[0]?.startsWith('#') && values.some(Boolean))
  const headers = dataRows.shift()?.map((header) => header.replace(/^\ufeff/, '')) ?? []
  if (!headers.length || new Set(headers).size !== headers.length) {
    throw new Error(`${label} has missing or duplicate headers`)
  }
  return dataRows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
  )
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
  if (matches.length > 1) throw new Error(`Luchtmeetnet point ${point.join(',')} intersects multiple municipalities`)
  return matches[0] ?? null
}

async function fetchMeasurements(component, start, end) {
  const records = []
  const rawHash = createHash('sha256')
  let page = 1
  let lastPage = 1
  do {
    const parameters = new URLSearchParams({
      formula: component,
      start,
      end,
      page: String(page),
      per_page: '1000',
    })
    const response = await fetchWithRetry(
      `${apiRoot}/measurements?${parameters}`,
      `Luchtmeetnet ${component} measurements page ${page}`,
    )
    const buffer = Buffer.from(await response.arrayBuffer())
    rawHash.update(buffer)
    const payload = JSON.parse(buffer.toString('utf8'))
    if (!Array.isArray(payload.data)) throw new Error(`Luchtmeetnet ${component} payload has no data array`)
    records.push(...payload.data)
    lastPage = Number(payload.pagination?.last_page) || 1
    page += 1
  } while (page <= lastPage && page <= 20)
  if (page <= lastPage) throw new Error(`Luchtmeetnet ${component} pagination exceeded safety limit`)
  return { records, pages: lastPage, sha256: rawHash.digest('hex') }
}

function latestByStation(records) {
  const latest = new Map()
  for (const record of records) {
    if (!record.station_number || !Number.isFinite(Number(record.value)) || !record.timestamp_measured) continue
    const current = latest.get(record.station_number)
    if (!current || Date.parse(record.timestamp_measured) > Date.parse(current.timestamp_measured)) {
      latest.set(record.station_number, record)
    }
  }
  return latest
}

const retrievedAt = new Date().toISOString()
const end = retrievedAt
const start = new Date(Date.parse(retrievedAt) - observationWindowHours * 60 * 60 * 1000).toISOString()
const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
const municipalityLookup = municipalityIndex(municipalityCollection)

const metadataResponse = await fetchWithRetry(metadataUrl, 'Luchtmeetnet station metadata')
const metadataBuffer = Buffer.from(await metadataResponse.arrayBuffer())
const metadataText = metadataBuffer.toString('utf8')
const exportHeader = /^#export;(.+)$/m.exec(metadataText)?.[1] ?? 'unknown export'
const metadataRows = parseDelimited(metadataText, ';', 'Luchtmeetnet station metadata')
const activeMetadata = new Map()
for (const row of metadataRows) {
  const endedAt = row.meetlocatie_einddatumtijd ? Date.parse(row.meetlocatie_einddatumtijd) : Number.POSITIVE_INFINITY
  if (Number.isNaN(endedAt) || endedAt >= Date.parse(retrievedAt)) activeMetadata.set(row.meetlocatie_id, row)
}

const measurementResults = await Promise.all(
  components.map((component) => fetchMeasurements(component, start, end)),
)
const latest = Object.fromEntries(
  components.map((component, index) => [component, latestByStation(measurementResults[index].records)]),
)
const pm25Stations = [...latest.PM25.keys()].sort()
const municipalityCodes = new Set()
let assignedStations = 0
let missingMetadata = 0
const features = []
for (const stationNumber of pm25Stations) {
  const metadata = activeMetadata.get(stationNumber)
  if (!metadata) {
    missingMetadata += 1
    continue
  }
  const coordinates = [Number(metadata.lengtegraad), Number(metadata.breedtegraad)]
  if (!coordinates.every(Number.isFinite)) continue
  const municipality = containingMunicipality(coordinates, municipalityLookup)
  if (municipality) {
    assignedStations += 1
    municipalityCodes.add(municipality.code)
  }
  const measurements = Object.fromEntries(
    components.map((component) => [component, latest[component].get(stationNumber) ?? null]),
  )
  const pm25 = measurements.PM25
  features.push({
    type: 'Feature',
    id: `luchtmeetnet-${stationNumber.toLowerCase()}`,
    geometry: { type: 'Point', coordinates },
    properties: {
      stationNumber,
      name: metadata.meetlocatie_naam || stationNumber,
      locality: metadata.meetlocatie_plaatsnaam || null,
      networkId: metadata.bron_id || null,
      pm25UgM3: Number(pm25.value),
      pm10UgM3: measurements.PM10 ? Number(measurements.PM10.value) : null,
      no2UgM3: measurements.NO2 ? Number(measurements.NO2.value) : null,
      o3UgM3: measurements.O3 ? Number(measurements.O3.value) : null,
      so2UgM3: measurements.SO2 ? Number(measurements.SO2.value) : null,
      observedAt: pm25.timestamp_measured,
      intervalStart: pm25.timestamp_measured_start,
      intervalEnd: pm25.timestamp_measured_end,
      municipalityCode: municipality?.code ?? null,
      municipalityName: municipality?.name ?? null,
      municipalityAssignment: municipality
        ? 'CBS 2025 generalized polygon containment'
        : 'outside generalized municipality polygon',
    },
  })
}
features.sort((left, right) => String(left.id).localeCompare(String(right.id)))

const observedTimes = features.map((feature) => Date.parse(feature.properties.observedAt))
const counts = {
  activeMetadataLocations: activeMetadata.size,
  pm25StationsReturned: pm25Stations.length,
  pm25StationsMapped: features.length,
  stationsMissingActiveMetadata: missingMetadata,
  assignedToMunicipalityPolygon: assignedStations,
  outsideMunicipalityPolygon: features.length - assignedStations,
  municipalitiesRepresented: municipalityCodes.size,
  measurementsFetched: Object.fromEntries(
    components.map((component, index) => [component, measurementResults[index].records.length]),
  ),
}
if (
  features.length < 40 ||
  counts.assignedToMunicipalityPolygon < 35 ||
  observedTimes.some((time) => !Number.isFinite(time) || time < Date.parse(start) || time > Date.parse(end) + 60 * 60 * 1000)
) throw new Error(`Luchtmeetnet coverage changed unexpectedly: ${JSON.stringify(counts)}`)

const output = {
  type: 'FeatureCollection',
  evidenceClass: 'observed-context',
  affectsSimulation: false,
  observationWindow: {
    requestedStart: start,
    requestedEnd: end,
    oldestMappedObservation: new Date(Math.min(...observedTimes)).toISOString(),
    newestMappedObservation: new Date(Math.max(...observedTimes)).toISOString(),
    hours: observationWindowHours,
  },
  counts,
  source: {
    id: 'rivm-luchtmeetnet-indicative-pm25',
    publisher: 'RIVM with participating GGD and environmental monitoring networks',
    title: 'Luchtmeetnet indicative hourly air-quality measurements',
    url: portalUrl,
    apiUrl: apiRoot,
    officialDataPage,
    metadataUrl,
    readmeUrl,
    retrievedAt,
    responseTime: metadataResponse.headers.get('date'),
    updateCadence: 'hourly measurements; delivery timing varies by participating network',
    validationStatus: 'indicative current measurements; not the ratified accredited annual dataset',
    license: 'no standard reuse licence stated; free service from which no rights may be derived',
    coverage: 'PM2.5 stations returning a measurement in the six-hour deployment window',
    caveat:
      'Station readings are local, indicative observations and can be revised. They are not a national continuous surface, exposure assessment, source attribution, smoke plume, forecast or scenario-time value.',
    metadataExport: exportHeader,
    metadataSha256: createHash('sha256').update(metadataBuffer).digest('hex'),
    measurementResponses: Object.fromEntries(
      components.map((component, index) => [component, {
        pages: measurementResults[index].pages,
        records: measurementResults[index].records.length,
        sha256: measurementResults[index].sha256,
      }]),
    ),
  },
  processing: {
    selection: 'latest PM2.5 observation per station within the six-hour deployment window',
    coPollutants: 'latest value within the same requested window when available; null otherwise',
    rawValues: 'values are preserved as published, including below-detection negative values',
    municipalityAssignment:
      'Point-in-polygon against the coherent CBS 2025 generalized municipality snapshot; out-of-polygon stations remain unassigned.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, gzipSync(`${JSON.stringify(output)}\n`, { level: 9 }))
console.log(JSON.stringify({ outputPath, bytes: (await stat(outputPath)).size, counts }, null, 2))
