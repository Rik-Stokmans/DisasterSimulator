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
const outputPath = resolve(outputDirectory, 'rws-waterinfo-forecasts.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')
const apiRoot = 'https://waterinfo.rws.nl/api/forecast/maptype'
const publicPortal = 'https://waterinfo.rws.nl/'
const officialCatalogue = 'https://data.overheid.nl/dataset/79082-verwachting-waterstanden-en-afvoeren'
const officialWaterPage = 'https://www.rijkswaterstaat.nl/water/waterdata/waterstanden-en-afvoeren-rivieren'
const useAndLicensePage = 'https://waterinfo-extra.rws.nl/monitoring/gebruik-data/'

proj4.defs(
  'EPSG:25831',
  '+proj=utm +zone=31 +ellps=GRS80 +units=m +no_defs +type=crs',
)

const forecastDefinitions = [
  {
    mapType: 'waterhoogte',
    forecastType: 'water-level',
    expectedUnit: 'cm',
    expectedParameterFragment: 'waterhoogte___20verwachting',
  },
  {
    mapType: 'waterafvoer',
    forecastType: 'discharge',
    expectedUnit: 'm3/s',
    expectedParameterFragment: 'debiet___20verwachting',
  },
]

// These are simulator decision checkpoints, not claims that the source has a
// single model cycle at these exact leads. The public endpoint returns values
// whose valid time falls within each rolling interval.
const leadWindows = [
  { startHours: 0, endHours: 1 },
  { startHours: 5, endHours: 6 },
  { startHours: 11, endHours: 12 },
  { startHours: 23, endHours: 24 },
  { startHours: 47, endHours: 48 },
  { startHours: 71, endHours: 72 },
]

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

async function fetchWithRetry(url, label) {
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'NL-Resilience-Lab public-data refresh',
        },
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
  if (matches.length > 1) {
    throw new Error(`Waterinfo forecast point ${point.join(',')} intersects multiple municipalities`)
  }
  return matches[0] ?? null
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
const municipalityLookup = municipalityIndex(municipalityCollection)
const retrievedAt = new Date().toISOString()
const features = []
const snapshots = []
const responses = {}
const municipalityCodes = new Set()
const featureIdentities = new Set()

for (const definition of forecastDefinitions) {
  for (const leadWindow of leadWindows) {
    const snapshotId = `${definition.forecastType}-t${String(leadWindow.endHours).padStart(2, '0')}`
    const parameters = new URLSearchParams({
      mapType: definition.mapType,
      start: String(leadWindow.startHours),
      end: String(leadWindow.endHours),
    })
    const url = `${apiRoot}?${parameters}`
    const response = await fetchWithRetry(url, `Waterinfo ${snapshotId}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const payload = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(payload.features)) {
      throw new Error(`Waterinfo ${snapshotId} payload has no features array`)
    }
    const forecastParameterKeys = Object.keys(payload.properties?.parameters ?? {})
    if (!forecastParameterKeys.some((key) => key.toLowerCase().includes(definition.expectedParameterFragment))) {
      throw new Error(`Waterinfo ${snapshotId} no longer declares its expected forecast parameter`)
    }

    const snapshotFeatureStart = features.length
    let sourceMeasurements = 0
    let assignedToMunicipality = 0
    const validTimes = []

    for (const sourceFeature of payload.features) {
      if (
        sourceFeature.geometry?.type !== 'Point' ||
        sourceFeature.crs?.properties?.name !== 'EPSG:25831' ||
        !sourceFeature.geometry.coordinates?.every(Number.isFinite)
      ) continue
      const coordinates = proj4('EPSG:25831', 'EPSG:4326', sourceFeature.geometry.coordinates)
      const municipality = containingMunicipality(coordinates, municipalityLookup)
      if (municipality) municipalityCodes.add(municipality.code)

      for (const measurement of sourceFeature.properties?.measurements ?? []) {
        sourceMeasurements += 1
        const value = Number(measurement.latestValue)
        const validAtMs = Date.parse(measurement.dateTime)
        if (!Number.isFinite(value) || !Number.isFinite(validAtMs)) continue
        if (measurement.unitCode !== definition.expectedUnit) {
          throw new Error(
            `Waterinfo ${snapshotId} unit changed from ${definition.expectedUnit} to ${measurement.unitCode}`,
          )
        }
        if (municipality) assignedToMunicipality += 1
        validTimes.push(new Date(validAtMs).toISOString())
        const identity = `${snapshotId}-${safeId(measurement.locationCode)}-${safeId(measurement.parameterId)}`
        if (featureIdentities.has(identity)) {
          throw new Error(`Duplicate Waterinfo forecast identity ${identity}`)
        }
        featureIdentities.add(identity)
        features.push({
          type: 'Feature',
          id: `waterinfo-forecast-${identity}`,
          geometry: { type: 'Point', coordinates },
          properties: {
            snapshotId,
            forecastType: definition.forecastType,
            mapType: definition.mapType,
            requestedLeadStartHours: leadWindow.startHours,
            requestedLeadEndHours: leadWindow.endHours,
            locationCode: measurement.locationCode,
            name: sourceFeature.properties.name,
            value,
            validAt: new Date(validAtMs).toISOString(),
            possiblyFaulty: measurement.possiblyFaulty === true,
            unitCode: measurement.unitCode,
            verticalDatum: measurement.qualityCode ?? null,
            sourceParameterId: measurement.parameterId,
            forecastParameterId: forecastParameterKeys[0] ?? null,
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

    validTimes.sort()
    snapshots.push({
      id: snapshotId,
      forecastType: definition.forecastType,
      mapType: definition.mapType,
      requestedLeadStartHours: leadWindow.startHours,
      requestedLeadEndHours: leadWindow.endHours,
      returnedFeatures: features.length - snapshotFeatureStart,
      sourceMeasurements,
      assignedToMunicipalityPolygon: assignedToMunicipality,
      outsideMunicipalityPolygon: features.length - snapshotFeatureStart - assignedToMunicipality,
      validTimeRange: validTimes.length
        ? { earliest: validTimes[0], latest: validTimes.at(-1) }
        : null,
      noData: payload.features.length === 0,
    })
    responses[snapshotId] = {
      url,
      responseTime: response.headers.get('date'),
      cacheControl: response.headers.get('cache-control'),
      forecastParameterKeys,
      sourceFeatureCount: payload.features.length,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
}

features.sort((left, right) => String(left.id).localeCompare(String(right.id)))
const allValidTimes = features.map((feature) => feature.properties.validAt).sort()
const output = {
  type: 'FeatureCollection',
  evidenceClass: 'official-forecast',
  affectsSimulation: false,
  retrievedAt,
  issueTime: null,
  issueTimeStatus:
    'The public rolling-map endpoint does not publish one model-cycle issue time; response time, requested lead window and per-value valid time are retained instead.',
  counts: {
    forecasts: features.length,
    waterLevelForecasts: features.filter(
      (feature) => feature.properties.forecastType === 'water-level',
    ).length,
    dischargeForecasts: features.filter(
      (feature) => feature.properties.forecastType === 'discharge',
    ).length,
    municipalitiesRepresented: municipalityCodes.size,
  },
  validTimeRange: allValidTimes.length
    ? { earliest: allValidTimes[0], latest: allValidTimes.at(-1) }
    : null,
  snapshots,
  source: {
    id: 'rws-waterinfo-rolling-water-level-discharge-forecasts',
    publisher: 'Rijkswaterstaat',
    title: 'Waterinfo public forecast water levels and discharges',
    url: publicPortal,
    apiUrl: apiRoot,
    officialCatalogue,
    officialWaterPage,
    useAndLicensePage,
    retrievedAt,
    license: 'CC0 1.0 / public domain as catalogued; verify component-specific exceptions',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    coverage:
      'Rolling public forecast points returned at T+1, +6, +12, +24, +48 and +72 request windows. Coverage declines by horizon and differs for water level and discharge.',
    serviceContract:
      'Public Waterinfo frontend JSON endpoint; it is useful but not documented as a stable external API contract and must be schema-monitored with a last-known-good cache.',
    caveat:
      'Forecast points are issued public guidance, not observations, inundation depths, defence states or municipal predictions. They do not affect the simulation until a governed adapter explicitly binds valid time, station and scenario boundary conditions. An empty horizon is NoData, never zero water or zero hazard.',
    responses,
  },
  processing: {
    sourceCrs: 'EPSG:25831',
    outputCrs: 'EPSG:4326',
    transformation: 'proj4 ETRS89 / UTM zone 31N to WGS84',
    checkpointWindows: leadWindows,
    municipalityAssignment:
      'Point-in-polygon against the CBS 2025 generalized municipality snapshot; outside points remain unassigned.',
    noDataRule:
      'A missing location, empty response horizon, null forecast field or absent municipality assignment remains Unknown/NoData and is never converted to zero, normal or safe.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, gzipSync(JSON.stringify(output), { level: 9 }))
const outputStat = await stat(outputPath)
console.log(JSON.stringify({
  output: outputPath,
  compressedBytes: outputStat.size,
  counts: output.counts,
  snapshots: output.snapshots.map((snapshot) => ({
    id: snapshot.id,
    returnedFeatures: snapshot.returnedFeatures,
    validTimeRange: snapshot.validTimeRange,
    noData: snapshot.noData,
  })),
  validTimeRange: output.validTimeRange,
}, null, 2))
