#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const outputDirectory = resolve(dataDirectory, 'public-context')
const outputPath = resolve(outputDirectory, 'knmi-seismic-events.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')
const serviceRoot = 'https://rdsa.knmi.nl/fdsnws/event/1'
const dataPortalUrl = 'https://rdsa.knmi.nl/'
const observationWindowDays = 365
const bounds = { west: 3, south: 50.5, east: 7.5, north: 53.8 }
const includedEventTypes = new Set(['earthquake', 'induced or triggered event'])

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
  const candidates = index.filter(({ bounds: municipalityBounds }) =>
    point[0] >= municipalityBounds[0] && point[0] <= municipalityBounds[2] &&
    point[1] >= municipalityBounds[1] && point[1] <= municipalityBounds[3]
  )
  const matches = candidates.filter(({ geometry }) => geometryContains(point, geometry))
  if (matches.length > 1) {
    throw new Error(`KNMI seismic point ${point.join(',')} intersects multiple municipalities`)
  }
  return matches[0] ?? null
}

function normalizedUtcTime(value) {
  if (typeof value !== 'string' || !value) return null
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  const parsed = Date.parse(hasZone ? value : `${value}Z`)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

const retrievedAt = new Date().toISOString()
const requestedEnd = retrievedAt
const requestedStart = new Date(
  Date.parse(retrievedAt) - observationWindowDays * 24 * 60 * 60 * 1_000,
).toISOString()
const parameters = new URLSearchParams({
  format: 'json',
  starttime: requestedStart,
  endtime: requestedEnd,
  minlatitude: String(bounds.south),
  maxlatitude: String(bounds.north),
  minlongitude: String(bounds.west),
  maxlongitude: String(bounds.east),
  orderby: 'time',
  limit: '1000',
})
const queryUrl = `${serviceRoot}/query?${parameters}`
const response = await fetch(queryUrl, {
  headers: { 'User-Agent': 'NL-Resilience-Lab public-data refresh' },
})
if (!response.ok) throw new Error(`KNMI FDSN event service returned ${response.status}`)
const responseBuffer = Buffer.from(await response.arrayBuffer())
const payload = JSON.parse(responseBuffer.toString('utf8'))
if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
  throw new Error('KNMI FDSN event response is not a GeoJSON FeatureCollection')
}
if (payload.features.length >= 1000) {
  throw new Error('KNMI FDSN query reached its safety limit; pagination is required')
}

const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
const municipalityLookup = municipalityIndex(municipalityCollection)
const municipalityCodes = new Set()
const excludedByType = {}
let assignedEvents = 0
const features = []

for (const sourceFeature of payload.features) {
  const sourceProperties = sourceFeature.properties ?? {}
  const eventType = sourceProperties.event_type
  if (!includedEventTypes.has(eventType)) {
    const key = typeof eventType === 'string' && eventType ? eventType : 'unknown'
    excludedByType[key] = (excludedByType[key] ?? 0) + 1
    continue
  }
  const coordinates = sourceFeature.geometry?.coordinates?.slice(0, 2)
  const observedAt = normalizedUtcTime(sourceProperties.time)
  const magnitude = Number(sourceProperties.mag)
  const depthKm = Number(sourceProperties.depth)
  if (
    sourceFeature.geometry?.type !== 'Point' ||
    coordinates?.length !== 2 ||
    !coordinates.every(Number.isFinite) ||
    !observedAt ||
    !Number.isFinite(magnitude) ||
    !Number.isFinite(depthKm)
  ) {
    throw new Error(`Invalid KNMI seismic event ${sourceFeature.id ?? 'without id'}`)
  }
  const municipality = containingMunicipality(coordinates, municipalityLookup)
  if (municipality) {
    assignedEvents += 1
    municipalityCodes.add(municipality.code)
  }
  const id = String(sourceFeature.id ?? sourceProperties.event_id ?? '').trim()
  if (!id) throw new Error('KNMI seismic event has no stable event identifier')
  features.push({
    type: 'Feature',
    id: `knmi-event-${id.toLowerCase()}`,
    geometry: { type: 'Point', coordinates },
    properties: {
      eventId: id,
      observedAt,
      publishedTime: sourceProperties.time,
      magnitude,
      magnitudeType: sourceProperties.mag_type ?? null,
      depthKm,
      eventType,
      location: sourceProperties.location ?? 'Unnamed location',
      reviewStatus: sourceProperties.status ?? 'unknown',
      evaluationMode: sourceProperties.mode ?? 'unknown',
      contributor: sourceProperties.contributor ?? 'KNMI',
      municipalityCode: municipality?.code ?? null,
      municipalityName: municipality?.name ?? null,
      municipalityAssignment: municipality
        ? 'CBS 2025 generalized polygon containment'
        : 'outside generalized municipality polygon',
    },
  })
}

features.sort((left, right) =>
  Date.parse(right.properties.observedAt) - Date.parse(left.properties.observedAt) ||
  String(left.id).localeCompare(String(right.id)),
)
if (features.length < 10) {
  throw new Error(`KNMI seismic coverage changed unexpectedly: only ${features.length} events`)
}
const observedTimes = features.map((feature) => Date.parse(feature.properties.observedAt))
const reviewCounts = Object.fromEntries(
  [...new Set(features.map((feature) => feature.properties.reviewStatus))]
    .sort()
    .map((status) => [status, features.filter((feature) => feature.properties.reviewStatus === status).length]),
)
const eventTypeCounts = Object.fromEntries(
  [...includedEventTypes].map((type) => [type, features.filter((feature) => feature.properties.eventType === type).length]),
)
const output = {
  type: 'FeatureCollection',
  evidenceClass: 'observed-context',
  affectsSimulation: false,
  retrievedAt,
  observationWindow: {
    requestedStart,
    requestedEnd,
    oldestEvent: new Date(Math.min(...observedTimes)).toISOString(),
    newestEvent: new Date(Math.max(...observedTimes)).toISOString(),
    days: observationWindowDays,
  },
  bounds,
  counts: {
    sourceEvents: payload.features.length,
    includedSeismicEvents: features.length,
    excludedNonSeismicEvents: payload.features.length - features.length,
    excludedByType,
    byEventType: eventTypeCounts,
    byReviewStatus: reviewCounts,
    assignedToMunicipalityPolygon: assignedEvents,
    outsideMunicipalityPolygon: features.length - assignedEvents,
    municipalitiesRepresented: municipalityCodes.size,
  },
  source: {
    id: 'knmi-fdsn-seismic-events',
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)',
    title: 'KNMI FDSN earthquake-event source parameters',
    portalUrl: dataPortalUrl,
    serviceUrl: serviceRoot,
    queryUrl,
    responseTime: response.headers.get('date'),
    retrievedAt,
    updateCadence: 'event catalogue is automatically updated when events are published',
    license: 'CC BY 4.0 default RDSA licence where no dataset-specific terms are stated',
    coverage: '365-day event-origin catalogue within bbox 3.0–7.5 E, 50.5–53.8 N',
    caveat:
      'Event source parameters may be preliminary or revised. Points are not a ground-motion surface, felt intensity, building damage, probability, forecast or scenario-time input.',
    responseBytes: responseBuffer.length,
    responseSha256: createHash('sha256').update(responseBuffer).digest('hex'),
  },
  processing: {
    includedEventTypes: [...includedEventTypes],
    excludedEventTypes: 'controlled explosions, quarry blasts, sonic booms and unknown non-seismic types',
    timeSemantics: 'FDSN origin times are interpreted as UTC and retained alongside the published string',
    municipalityAssignment:
      'Point-in-polygon against the coherent CBS 2025 generalized municipality snapshot; border/offshore points can remain unassigned.',
    noDataRule:
      'No event assigned to a municipality means no catalogued source point in this time window, never zero seismic hazard or proof of safety.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, gzipSync(`${JSON.stringify(output)}\n`, { level: 9 }))
console.log(JSON.stringify({
  outputPath,
  bytes: (await stat(outputPath)).size,
  counts: output.counts,
  observationWindow: output.observationWindow,
}, null, 2))
