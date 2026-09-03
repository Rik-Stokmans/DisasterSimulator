#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { File, ready } from 'h5wasm/node'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const outputDirectory = resolve(dataDirectory, 'public-context')
const outputPath = resolve(outputDirectory, 'knmi-weather-observations.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')

const datasetName = '10-minute-in-situ-meteorological-observations'
const datasetVersion = '1.0'
const apiRoot = 'https://api.dataplatform.knmi.nl/open-data/v1'
const datasetPage = `https://dataplatform.knmi.nl/dataset/${datasetName}-1-0`
const apiUrl = `${apiRoot}/datasets/${datasetName}/versions/${datasetVersion}/files`
const platformNewsUrl = 'https://developer.dataplatform.knmi.nl/news'

// KNMI publishes this shared, quota-limited anonymous key in its official API
// documentation. A registered deployment key should always take precedence.
const anonymousKey = 'eyJvcmciOiI1ZTU1NGUxOTI3NGE5NjAwMDEyYTNlYjEiLCJpZCI6IjUzYTg1ZDBhMmQ5YzRkYzJiYWNlNzQ4NTQ2Zjk4ODExIiwiaCI6Im11cm11cjEyOCJ9'

const apiKey = process.env.KNMI_OPEN_DATA_API_KEY ?? process.env.KNMI_API_KEY ?? anonymousKey
const europeanBounds = { west: 2.5, south: 50.5, east: 7.6, north: 55.6 }

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

async function fetchChecked(url, options, label, attempts = 4) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (response.ok) return response
      const body = (await response.text()).slice(0, 240)
      lastError = new Error(`${label} returned ${response.status}: ${body}`)
      if (response.status !== 429 && response.status < 500) break
      const retryAfterHeader = response.headers.get('retry-after')
      const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader)
      await sleep(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(10_000, retryAfterSeconds * 1_000)
        : 750 * (2 ** attempt))
    } catch (error) {
      lastError = error
      await sleep(750 * (2 ** attempt))
    }
  }
  throw lastError ?? new Error(`${label} failed`)
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
  const matches = index.filter(({ bounds, geometry }) =>
    point[0] >= bounds[0] && point[0] <= bounds[2] &&
    point[1] >= bounds[1] && point[1] <= bounds[3] &&
    geometryContains(point, geometry))
  if (matches.length > 1) {
    throw new Error(`KNMI weather station ${point.join(',')} intersects multiple municipalities`)
  }
  return matches[0] ?? null
}

export function finiteOrNull(value, minimum, maximum, digits = 3) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function secondsSince1950ToIso(seconds) {
  if (!Number.isFinite(seconds)) throw new Error('KNMI observation file has no valid time coordinate')
  const timestamp = Date.UTC(1950, 0, 1) + seconds * 1_000
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) throw new Error('KNMI observation time cannot be converted')
  return date.toISOString()
}

export function observationFreshness(observationTime, retrievedAt) {
  const ageMinutes = Math.max(0, Math.round((Date.parse(retrievedAt) - Date.parse(observationTime)) / 60_000))
  return {
    ageMinutesAtRetrieval: ageMinutes,
    statusAtRetrieval: ageMinutes <= 45 ? 'fresh' : ageMinutes <= 180 ? 'delayed' : 'stale',
  }
}

function vector(file, name, expectedLength) {
  const dataset = file.get(name)
  if (!dataset) throw new Error(`KNMI observation file is missing ${name}`)
  const values = Array.from(dataset.value)
  if (values.length !== expectedLength) {
    throw new Error(`KNMI ${name} has ${values.length} values; expected ${expectedLength}`)
  }
  return values
}

export async function parseKnmiObservationFile(filePath, municipalities, fileMetadata) {
  await ready
  const file = new File(filePath, 'r')
  try {
    const title = file.attrs.title?.value
    if (title !== 'Near real-time 10-minute automated in-situ ground-based meteorological surface observations in the Netherlands') {
      throw new Error(`Unexpected KNMI observation product title: ${String(title)}`)
    }

    const stationIds = Array.from(file.get('station')?.value ?? [])
    const count = stationIds.length
    if (count < 50 || count > 100) throw new Error(`Unexpected KNMI station count: ${count}`)

    const stationNames = vector(file, 'stationname', count)
    const wsiIds = vector(file, 'wsi', count)
    const latitudes = vector(file, 'lat', count)
    const longitudes = vector(file, 'lon', count)
    const heights = vector(file, 'height', count)
    const temperature = vector(file, 'ta', count)
    const humidity = vector(file, 'rh', count)
    const windDirection = vector(file, 'dd', count)
    const windSpeed = vector(file, 'ff', count)
    const windGust = vector(file, 'gff', count)
    const rainfallLastHour = vector(file, 'R1H', count)
    const precipitationIntensity = vector(file, 'rg', count)
    const visibility = vector(file, 'vv', count)
    const pressure = vector(file, 'pp', count)
    const observationTime = secondsSince1950ToIso(Array.from(file.get('time')?.value ?? [])[0])
    const index = municipalityIndex(municipalities)

    const records = stationIds.map((stationId, stationIndex) => ({
      stationId: String(stationId),
      stationName: String(stationNames[stationIndex]),
      wsiId: String(wsiIds[stationIndex]),
      coordinates: [Number(longitudes[stationIndex]), Number(latitudes[stationIndex])],
      stationHeightM: finiteOrNull(Number(heights[stationIndex]), -100, 1_000, 2),
      airTemperatureC: finiteOrNull(Number(temperature[stationIndex]), -60, 60, 1),
      relativeHumidityPct: finiteOrNull(Number(humidity[stationIndex]), 0, 100, 1),
      windDirectionDeg: finiteOrNull(Number(windDirection[stationIndex]), 0, 360, 1),
      windSpeedMs: finiteOrNull(Number(windSpeed[stationIndex]), 0, 100, 2),
      windGustMs: finiteOrNull(Number(windGust[stationIndex]), 0, 120, 2),
      rainfallLastHourMm: finiteOrNull(Number(rainfallLastHour[stationIndex]), 0, 300, 3),
      precipitationIntensityMmH: finiteOrNull(Number(precipitationIntensity[stationIndex]), 0, 500, 3),
      visibilityM: finiteOrNull(Number(visibility[stationIndex]), 0, 200_000, 0),
      seaLevelPressureHpa: finiteOrNull(Number(pressure[stationIndex]), 800, 1_100, 2),
    }))

    const europeanRecords = records.filter(({ coordinates: [longitude, latitude] }) =>
      longitude >= europeanBounds.west && longitude <= europeanBounds.east &&
      latitude >= europeanBounds.south && latitude <= europeanBounds.north)
    const features = europeanRecords.map((record) => {
      const municipality = containingMunicipality(record.coordinates, index)
      return {
        type: 'Feature',
        id: `knmi-weather-${record.stationId}`,
        geometry: { type: 'Point', coordinates: record.coordinates },
        properties: {
          stationId: record.stationId,
          wsiId: record.wsiId,
          stationName: record.stationName,
          observationTime,
          stationHeightM: record.stationHeightM,
          airTemperatureC: record.airTemperatureC,
          relativeHumidityPct: record.relativeHumidityPct,
          windDirectionDeg: record.windDirectionDeg,
          windSpeedMs: record.windSpeedMs,
          windGustMs: record.windGustMs,
          rainfallLastHourMm: record.rainfallLastHourMm,
          precipitationIntensityMmH: record.precipitationIntensityMmH,
          visibilityM: record.visibilityM,
          seaLevelPressureHpa: record.seaLevelPressureHpa,
          windLabel: record.windGustMs === null ? 'No gust value' : `${record.windGustMs.toFixed(1)} m/s gust`,
          rainLabel: record.rainfallLastHourMm === null ? 'No 1 h rain value' : `${record.rainfallLastHourMm.toFixed(1)} mm / 1 h`,
          temperatureLabel: record.airTemperatureC === null ? 'No temperature value' : `${record.airTemperatureC.toFixed(1)} °C`,
          municipalityCode: municipality?.code ?? null,
          municipalityName: municipality?.name ?? null,
          municipalityAssignment: municipality
            ? 'CBS 2025 generalized polygon containment'
            : 'outside generalized municipality polygon',
        },
      }
    })

    const availableByVariable = Object.fromEntries([
      ['airTemperatureC', 'airTemperatureC'],
      ['relativeHumidityPct', 'relativeHumidityPct'],
      ['windDirectionDeg', 'windDirectionDeg'],
      ['windSpeedMs', 'windSpeedMs'],
      ['windGustMs', 'windGustMs'],
      ['rainfallLastHourMm', 'rainfallLastHourMm'],
      ['precipitationIntensityMmH', 'precipitationIntensityMmH'],
      ['visibilityM', 'visibilityM'],
      ['seaLevelPressureHpa', 'seaLevelPressureHpa'],
    ].map(([key, property]) => [key, features.filter((feature) => feature.properties[property] !== null).length]))
    const retrievedAt = fileMetadata.retrievedAt

    return {
      type: 'FeatureCollection',
      name: 'KNMI near-real-time 10-minute weather station observations',
      evidenceClass: 'observed-context',
      affectsSimulation: false,
      observationTime,
      freshness: observationFreshness(observationTime, retrievedAt),
      coverageNote: 'Sparse fixed stations, airport sites, coastal wind masts and offshore platforms; points are not a continuous municipal weather field.',
      features,
      source: {
        id: `${datasetName}-${datasetVersion}`,
        publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)',
        datasetPage,
        apiUrl,
        platformNewsUrl,
        license: 'CC BY 4.0',
        updateCadence: '10 minutes',
        sourceFile: fileMetadata.filename,
        sourceCreated: fileMetadata.created,
        sourceLastModified: fileMetadata.lastModified,
        sourceBytes: fileMetadata.bytes,
        sourceSha256: fileMetadata.sha256,
        retrievedAt,
        intervalSemantics: 'Timestamp marks the end of the preceding 10-minute measurement interval in UTC.',
        role: 'Observed station context only; never interpolated, projected through T+72 or applied to scenario forcing automatically.',
        caveat: 'Variables can be absent per station and files can be revised with missing data for seven days. Platform incidents can delay updates, so observation time and freshness must remain visible.',
      },
      counts: {
        sourceStationRecords: count,
        europeanNetherlandsStations: features.length,
        excludedCaribbeanStations: count - features.length,
        assignedToMunicipalityPolygon: features.filter((feature) => feature.properties.municipalityCode).length,
        outsideMunicipalityPolygon: features.filter((feature) => !feature.properties.municipalityCode).length,
        availableByVariable,
      },
    }
  } finally {
    file.close()
  }
}

async function downloadLatestObservationFile() {
  const headers = { Authorization: apiKey }
  const listingResponse = await fetchChecked(
    `${apiUrl}?maxKeys=1&orderBy=created&sorting=desc`,
    { headers },
    'KNMI observation file listing',
  )
  const listing = await listingResponse.json()
  const fileMetadata = listing.files?.[0]
  if (!fileMetadata?.filename) throw new Error('KNMI observation listing contains no file')

  const urlResponse = await fetchChecked(
    `${apiUrl}/${encodeURIComponent(fileMetadata.filename)}/url`,
    { headers },
    'KNMI observation download URL',
  )
  const urlPayload = await urlResponse.json()
  if (!urlPayload.temporaryDownloadUrl) throw new Error('KNMI did not return an observation download URL')

  const downloadResponse = await fetchChecked(
    urlPayload.temporaryDownloadUrl,
    undefined,
    'KNMI observation NetCDF download',
  )
  const bytes = Buffer.from(await downloadResponse.arrayBuffer())
  if (bytes.length < 100_000 || !bytes.subarray(1, 4).equals(Buffer.from('HDF'))) {
    throw new Error(`KNMI observation download is not the expected HDF5 NetCDF file (${bytes.length} bytes)`)
  }
  return {
    bytes,
    metadata: {
      filename: fileMetadata.filename,
      created: fileMetadata.created,
      lastModified: fileMetadata.lastModified,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      retrievedAt: new Date().toISOString(),
    },
  }
}

export async function buildKnmiObservationDataset() {
  const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
  const { bytes, metadata } = await downloadLatestObservationFile()
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'disaster-knmi-observations-'))
  const temporaryPath = join(temporaryDirectory, metadata.filename)
  try {
    await writeFile(temporaryPath, bytes)
    const output = await parseKnmiObservationFile(temporaryPath, municipalityCollection, metadata)
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(outputPath, gzipSync(Buffer.from(JSON.stringify(output)), { level: 9 }))
    return output
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildKnmiObservationDataset()
  console.log(JSON.stringify({
    outputPath,
    observationTime: output.observationTime,
    freshness: output.freshness,
    stations: output.features.length,
    counts: output.counts,
  }, null, 2))
}
