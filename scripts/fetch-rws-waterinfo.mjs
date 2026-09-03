#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import proj4 from 'proj4'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const outputDirectory = resolve(dataDirectory, 'public-context')
const outputPath = resolve(outputDirectory, 'rws-waterinfo-observations.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')
const apiRoot = 'https://waterinfo.rws.nl/api/point/latestmeasurement'
const publicPortal = 'https://waterinfo.rws.nl/'
const officialDataPage = 'https://www.rijkswaterstaat.nl/water/waterdata'
const useAndLicensePage = 'https://waterinfo-extra.rws.nl/monitoring/gebruik-data/'
const measurementNetworkPage = 'https://waterinfo-extra.rws.nl/monitoring/waterkwantiteit/'

proj4.defs(
  'EPSG:25831',
  '+proj=utm +zone=31 +ellps=GRS80 +units=m +no_defs +type=crs',
)

const endpointDefinitions = [
  { parameter: 'waterhoogte', observationType: 'water-level' },
  { parameter: 'waterafvoer', observationType: 'discharge' },
]

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
  if (matches.length > 1) throw new Error(`Waterinfo point ${point.join(',')} intersects multiple municipalities`)
  return matches[0] ?? null
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function freshnessForAge(ageMinutes) {
  if (ageMinutes <= 90) return 'fresh'
  if (ageMinutes <= 360) return 'delayed'
  return 'stale'
}

const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
const municipalityLookup = municipalityIndex(municipalityCollection)
const responses = []

for (const definition of endpointDefinitions) {
  const url = `${apiRoot}?parameterId=${definition.parameter}`
  const response = await fetchWithRetry(url, `Waterinfo ${definition.parameter}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const payload = JSON.parse(buffer.toString('utf8'))
  if (!Array.isArray(payload.features)) {
    throw new Error(`Waterinfo ${definition.parameter} payload has no features array`)
  }
  responses.push({
    ...definition,
    url,
    payload,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    responseTime: response.headers.get('date'),
    cacheControl: response.headers.get('cache-control'),
  })
}

const retrievedAt = new Date().toISOString()
const retrievedAtMs = Date.parse(retrievedAt)
const features = []
const municipalityCodes = new Set()
const freshnessCounts = { fresh: 0, delayed: 0, stale: 0 }
const observationIdentityCounts = new Map()
let assignedObservations = 0
let possiblyFaultyObservations = 0
let duplicateObservationIdentities = 0

for (const response of responses) {
  for (const sourceFeature of response.payload.features) {
    if (
      sourceFeature.geometry?.type !== 'Point' ||
      sourceFeature.crs?.properties?.name !== 'EPSG:25831' ||
      !sourceFeature.geometry.coordinates?.every(Number.isFinite)
    ) continue
    const coordinates = proj4('EPSG:25831', 'EPSG:4326', sourceFeature.geometry.coordinates)
    const municipality = containingMunicipality(coordinates, municipalityLookup)
    if (municipality) {
      assignedObservations += sourceFeature.properties.measurements?.length ?? 0
      municipalityCodes.add(municipality.code)
    }
    for (const measurement of sourceFeature.properties.measurements ?? []) {
      const observedAtMs = Date.parse(measurement.dateTime)
      if (!Number.isFinite(observedAtMs) || !Number.isFinite(Number(measurement.latestValue))) continue
      const ageMinutesAtRetrieval = Math.max(0, Math.round((retrievedAtMs - observedAtMs) / 60_000))
      const freshness = freshnessForAge(ageMinutesAtRetrieval)
      freshnessCounts[freshness] += 1
      if (measurement.possiblyFaulty === true) possiblyFaultyObservations += 1
      const parameterIdentity = `${measurement.parameterId}-${measurement.qualityCode ?? measurement.unitCode}`
      const baseId = `waterinfo-${response.observationType}-${safeId(measurement.locationCode)}-${safeId(parameterIdentity)}`
      const identityOccurrence = observationIdentityCounts.get(baseId) ?? 0
      observationIdentityCounts.set(baseId, identityOccurrence + 1)
      if (identityOccurrence > 0) duplicateObservationIdentities += 1
      features.push({
        type: 'Feature',
        id: identityOccurrence === 0 ? baseId : `${baseId}-duplicate-${identityOccurrence + 1}`,
        geometry: { type: 'Point', coordinates },
        properties: {
          observationType: response.observationType,
          endpointParameter: response.parameter,
          locationCode: measurement.locationCode,
          name: sourceFeature.properties.name,
          latestValue: Number(measurement.latestValue),
          observedAt: measurement.dateTime,
          ageMinutesAtRetrieval,
          freshness,
          possiblyFaulty: measurement.possiblyFaulty === true,
          unitCode: measurement.unitCode,
          verticalDatum: measurement.qualityCode ?? null,
          sourceParameterId: measurement.parameterId,
          measurementClass: measurement.measurementLabel ?? 'Geen klasse-indeling',
          measurementColor: /^#[0-9a-f]{6}$/i.test(measurement.measurementColor ?? '')
            ? measurement.measurementColor
            : null,
          featured: sourceFeature.properties.featured === true,
          markerType: sourceFeature.properties.markerType ?? null,
          municipalityCode: municipality?.code ?? null,
          municipalityName: municipality?.name ?? null,
          municipalityAssignment: municipality
            ? 'CBS 2025 generalized polygon containment'
            : 'outside generalized municipality polygon',
        },
      })
    }
  }
}

features.sort((left, right) => String(left.id).localeCompare(String(right.id)))
const observationTimes = features.map((feature) => feature.properties.observedAt).sort()
const waterLevelObservations = features.filter(
  (feature) => feature.properties.observationType === 'water-level',
).length
const dischargeObservations = features.length - waterLevelObservations

const output = {
  type: 'FeatureCollection',
  evidenceClass: 'observed-context',
  affectsSimulation: false,
  retrievedAt,
  observationRange: {
    oldest: observationTimes[0],
    newest: observationTimes.at(-1),
  },
  counts: {
    observations: features.length,
    waterLevelObservations,
    dischargeObservations,
    sourceLocations: Object.fromEntries(
      responses.map((response) => [response.parameter, response.payload.features.length]),
    ),
    freshness: freshnessCounts,
    possiblyFaultyObservations,
    duplicateObservationIdentities,
    assignedToMunicipalityPolygon: assignedObservations,
    outsideMunicipalityPolygon: features.length - assignedObservations,
    municipalitiesRepresented: municipalityCodes.size,
  },
  source: {
    id: 'rws-waterinfo-latest-water-level-discharge',
    publisher: 'Rijkswaterstaat',
    title: 'Waterinfo latest public water-level and discharge measurements',
    url: publicPortal,
    officialDataPage,
    useAndLicensePage,
    measurementNetworkPage,
    retrievedAt,
    updateCadence: 'LMW measurements are generally produced every 10 minutes; individual latest records can be delayed or stale',
    apiCache: 'public max-age 300 seconds at retrieval',
    license: 'CC0 unless an individual component states otherwise',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    serviceLevel: 'public Waterinfo is not a mission-critical Rijkswaterstaat application',
    coverage: 'latest observations returned by the public Waterinfo water-level and discharge map endpoints; point coverage is not every Dutch water body',
    caveat: 'Values are local observations with publisher class and possible-fault flags. They are not a hydraulic surface, threshold exceedance outside the labelled station, breach, inundation depth, scenario forecast or operational instruction.',
    responses: Object.fromEntries(
      responses.map((response) => [response.parameter, {
        url: response.url,
        responseTime: response.responseTime,
        cacheControl: response.cacheControl,
        sourceLocations: response.payload.features.length,
        bytes: response.bytes,
        sha256: response.sha256,
      }]),
    ),
  },
  processing: {
    sourceCrs: 'EPSG:25831',
    outputCrs: 'EPSG:4326',
    transformation: 'proj4 ETRS89 / UTM zone 31N to WGS84',
    duplicateIdentityRule: 'Source observations sharing location, parameter and datum are retained with a deterministic occurrence suffix rather than silently dropped.',
    freshness: 'fresh <=90 minutes; delayed >90 and <=360 minutes; stale >360 minutes at deployment retrieval',
    municipalityAssignment: 'Point-in-polygon against the coherent CBS 2025 generalized municipality snapshot; out-of-polygon observations remain unassigned.',
    noDataRule: 'Absence of a nearby or municipal observation is never converted to a zero water level, zero discharge or safe condition.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, gzipSync(JSON.stringify(output), { level: 9 }))
const outputStat = await stat(outputPath)
console.log(JSON.stringify({
  output: outputPath,
  compressedBytes: outputStat.size,
  observations: output.counts.observations,
  waterLevelObservations,
  dischargeObservations,
  freshness: freshnessCounts,
  possiblyFaultyObservations,
  duplicateObservationIdentities,
  assignedToMunicipalityPolygon: assignedObservations,
  municipalitiesRepresented: municipalityCodes.size,
  observationRange: output.observationRange,
}, null, 2))
