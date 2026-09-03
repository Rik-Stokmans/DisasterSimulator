#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const outputDirectory = resolve(dataDirectory, 'public-context')
const outputPath = resolve(outputDirectory, 'duo-education-locations.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')
const packageId = 'c416acd1-e083-4ec6-9203-3b20f98fe143'
const datasetPage = `https://onderwijsdata.duo.nl/dataset/${packageId}`
const packageApi = `https://onderwijsdata.duo.nl/api/3/action/package_show?id=${packageId}`
const requiredResources = [
  'onderwijslocaties',
  'onderwijslocatiegebruiken',
  'relaties_onderwijslocatiegebruiken_vestigingserkenningen',
  'vestigingserkenningen',
]
const europeanNetherlandsBounds = [3, 50.6, 7.4, 53.7]

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

function parseCsv(text, label) {
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
    } else if (character === ',') {
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
  if (quoted) throw new Error(`${label} ends inside a quoted CSV field`)
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''))
    rows.push(row)
  }
  const headers = rows.shift()?.map((header) => header.replace(/^\ufeff/, '')) ?? []
  if (!headers.length || new Set(headers).size !== headers.length) {
    throw new Error(`${label} has missing or duplicate CSV headers`)
  }
  return {
    headers,
    rows: rows
      .filter((values) => values.some(Boolean))
      .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))),
  }
}

function requireHeaders(table, names, label) {
  for (const name of names) {
    if (!table.headers.includes(name)) throw new Error(`${label} is missing ${name}`)
  }
}

function amsterdamDate(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function activeOn(start, end, date) {
  return (!start || start <= date) && (!end || end > date)
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
    ) {
      inside = !inside
    }
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
  if (matches.length > 1) throw new Error(`Education point ${point.join(',')} intersects multiple municipalities`)
  return matches[0] ?? null
}

const frameworkLabels = {
  WEC: 'special education',
  WPO: 'primary education',
  WVO: 'secondary education',
  WEB: 'vocational or adult education',
  WHW: 'higher education',
}
const frameworkPriority = ['WEC', 'WPO', 'WVO', 'WEB', 'WHW']

const retrievedAt = new Date().toISOString()
const effectiveDate = amsterdamDate(new Date(retrievedAt))
const metadataResponse = await fetchWithRetry(packageApi, 'DUO RIO package metadata')
const metadata = await metadataResponse.json()
if (
  metadata.success !== true ||
  metadata.result?.id !== packageId ||
  metadata.result?.organization?.name !== 'duo' ||
  metadata.result?.license_id !== 'cc-by'
) {
  throw new Error('DUO RIO package identity or license changed unexpectedly')
}

const resourceByName = new Map(metadata.result.resources.map((resource) => [resource.name, resource]))
const resources = requiredResources.map((name) => {
  const resource = resourceByName.get(name)
  if (!resource?.url || resource.format !== 'CSV' || !resource.last_modified) {
    throw new Error(`DUO RIO resource ${name} is missing, undated or not CSV`)
  }
  return resource
})
const downloaded = await Promise.all(resources.map(async (resource) => {
  const response = await fetchWithRetry(resource.url, `DUO RIO ${resource.name}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    name: resource.name,
    url: resource.url,
    lastModified: resource.last_modified,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    table: parseCsv(buffer.toString('utf8'), resource.name),
  }
}))
const table = Object.fromEntries(downloaded.map((resource) => [resource.name, resource.table]))

requireHeaders(table.onderwijslocaties, [
  'ONDERWIJSLOCATIECODE', 'BAG_ID', 'GPS_LATITUDE', 'GPS_LONGITUDE', 'STRAATNAAM',
  'HUISNUMMER', 'HUISNUMMERTOEVOEGING', 'POSTCODE', 'PLAATSNAAM',
], 'onderwijslocaties')
requireHeaders(table.onderwijslocatiegebruiken, [
  'ONDERWIJSLOCATIECODE', 'ONDERWIJSBESTUURID', 'INBEDRIJFDATUM', 'UITBEDRIJFDATUM',
], 'onderwijslocatiegebruiken')
requireHeaders(table.relaties_onderwijslocatiegebruiken_vestigingserkenningen, [
  'ONDERWIJSLOCATIECODE', 'VESTIGINGSCODE', 'BEGINDATUM', 'EINDDATUM',
], 'relaties_onderwijslocatiegebruiken_vestigingserkenningen')
requireHeaders(table.vestigingserkenningen, [
  'VESTIGINGSCODE', 'BEGINDATUM', 'EINDDATUM', 'IN_BEDRIJFDATUM', 'UIT_BEDRIJFDATUM',
  'BEGINDATUM_PERIODE', 'EINDDATUM_PERIODE', 'VERKORTE_NAAM', 'VOLLEDIGE_NAAM', 'WET',
], 'vestigingserkenningen')

const activeUses = table.onderwijslocatiegebruiken.rows.filter((row) =>
  activeOn(row.INBEDRIJFDATUM, row.UITBEDRIJFDATUM, effectiveDate)
)
const useByLocation = new Map()
for (const use of activeUses) {
  if (!useByLocation.has(use.ONDERWIJSLOCATIECODE)) useByLocation.set(use.ONDERWIJSLOCATIECODE, [])
  useByLocation.get(use.ONDERWIJSLOCATIECODE).push(use)
}

const activeRecognitionRows = table.vestigingserkenningen.rows.filter((row) =>
  activeOn(row.BEGINDATUM, row.EINDDATUM, effectiveDate) &&
  activeOn(row.IN_BEDRIJFDATUM, row.UIT_BEDRIJFDATUM, effectiveDate) &&
  activeOn(row.BEGINDATUM_PERIODE, row.EINDDATUM_PERIODE, effectiveDate)
)
const recognitionByCode = new Map()
for (const recognition of activeRecognitionRows) {
  if (recognitionByCode.has(recognition.VESTIGINGSCODE)) {
    throw new Error(`Multiple current recognition rows for ${recognition.VESTIGINGSCODE}`)
  }
  recognitionByCode.set(recognition.VESTIGINGSCODE, recognition)
}

const recognitionCodesByLocation = new Map()
for (const relation of table.relaties_onderwijslocatiegebruiken_vestigingserkenningen.rows) {
  if (
    !activeOn(relation.BEGINDATUM, relation.EINDDATUM, effectiveDate) ||
    !recognitionByCode.has(relation.VESTIGINGSCODE)
  ) continue
  if (!recognitionCodesByLocation.has(relation.ONDERWIJSLOCATIECODE)) {
    recognitionCodesByLocation.set(relation.ONDERWIJSLOCATIECODE, new Set())
  }
  recognitionCodesByLocation.get(relation.ONDERWIJSLOCATIECODE).add(relation.VESTIGINGSCODE)
}

const municipalities = JSON.parse(await readFile(municipalityPath, 'utf8'))
if (municipalities.features.length !== 342) throw new Error('Expected the coherent 342-municipality 2025 snapshot')
const municipalityLookup = municipalityIndex(municipalities)
const [west, south, east, north] = europeanNetherlandsBounds
const sourceActiveLocations = table.onderwijslocaties.rows.filter((row) => useByLocation.has(row.ONDERWIJSLOCATIECODE))
const scopedLocations = sourceActiveLocations.filter((row) => {
  const longitude = Number(row.GPS_LONGITUDE)
  const latitude = Number(row.GPS_LATITUDE)
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north
})
if (scopedLocations.length < 12_000 || new Set(scopedLocations.map((row) => row.ONDERWIJSLOCATIECODE)).size !== scopedLocations.length) {
  throw new Error(`DUO active education-location scope changed unexpectedly: ${scopedLocations.length}`)
}

const byLegalFramework = Object.fromEntries(Object.keys(frameworkLabels).map((framework) => [framework, 0]))
const municipalityCodes = new Set()
let typedLocations = 0
let assignedLocations = 0
const features = scopedLocations.map((location) => {
  const coordinates = [Number(location.GPS_LONGITUDE), Number(location.GPS_LATITUDE)]
  if (!coordinates.every(Number.isFinite)) throw new Error(`Invalid coordinates for ${location.ONDERWIJSLOCATIECODE}`)
  const municipality = containingMunicipality(coordinates, municipalityLookup)
  if (municipality) {
    municipalityCodes.add(municipality.code)
    assignedLocations += 1
  }
  const recognitionCodes = [...(recognitionCodesByLocation.get(location.ONDERWIJSLOCATIECODE) ?? [])].sort()
  const recognitions = recognitionCodes.map((code) => recognitionByCode.get(code))
  const frameworks = [...new Set(recognitions.map((recognition) => recognition.WET).filter((law) => frameworkLabels[law]))]
    .sort((left, right) => frameworkPriority.indexOf(left) - frameworkPriority.indexOf(right))
  if (recognitions.length) typedLocations += 1
  for (const framework of frameworks) byLegalFramework[framework] += 1
  const names = [...new Set(recognitions
    .map((recognition) => recognition.VERKORTE_NAAM || recognition.VOLLEDIGE_NAAM)
    .filter(Boolean))]
  const uses = useByLocation.get(location.ONDERWIJSLOCATIECODE)
  const primaryFramework = frameworks[0] ?? null
  const house = `${location.HUISNUMMER}${location.HUISNUMMERTOEVOEGING || ''}`
  const address = [location.STRAATNAAM && house ? `${location.STRAATNAAM} ${house}` : location.STRAATNAAM, location.POSTCODE, location.PLAATSNAAM]
    .filter(Boolean)
    .join(', ')
  return {
    type: 'Feature',
    id: `duo-rio-${location.ONDERWIJSLOCATIECODE.toLowerCase()}`,
    geometry: { type: 'Point', coordinates },
    properties: {
      facilityType: 'education-location',
      educationType: primaryFramework ? frameworkLabels[primaryFramework] : 'other registered education',
      name: names[0] ?? `RIO education location ${location.ONDERWIJSLOCATIECODE}`,
      additionalNames: names.slice(1).join(' · '),
      locationCode: location.ONDERWIJSLOCATIECODE,
      bagId: location.BAG_ID || null,
      address: address || null,
      locality: location.PLAATSNAAM || null,
      postcode: location.POSTCODE || null,
      municipalityCode: municipality?.code ?? null,
      municipalityName: municipality?.name ?? null,
      municipalityAssignment: municipality ? 'CBS 2025 generalized polygon containment' : 'outside generalized municipality polygon',
      legalFrameworks: frameworks.join(' · '),
      activeUseCount: uses.length,
      recognizedBranchCount: recognitionCodes.length,
    },
  }
})
features.sort((left, right) => String(left.id).localeCompare(String(right.id)))

const snapshotDate = downloaded
  .map((resource) => resource.lastModified)
  .sort()
  .at(-1)
  .slice(0, 10)
const counts = {
  activeLocationsAtSource: sourceActiveLocations.length,
  mapScopeLocations: features.length,
  excludedOutsideEuropeanNetherlands: sourceActiveLocations.length - features.length,
  linkedToCurrentRecognition: typedLocations,
  registeredUseOnly: features.length - typedLocations,
  assignedToMunicipalityPolygon: assignedLocations,
  outsideMunicipalityPolygon: features.length - assignedLocations,
  municipalitiesRepresented: municipalityCodes.size,
  byLegalFramework,
}
if (
  counts.excludedOutsideEuropeanNetherlands < 1 ||
  counts.linkedToCurrentRecognition < 9_000 ||
  counts.municipalitiesRepresented !== 342
) {
  throw new Error(`DUO education-location coverage changed unexpectedly: ${JSON.stringify(counts)}`)
}

const output = {
  type: 'FeatureCollection',
  evidenceClass: 'official-context',
  affectsSimulation: false,
  effectiveDate,
  counts,
  source: {
    id: packageId,
    publisher: 'Dienst Uitvoering Onderwijs (DUO)',
    title: metadata.result.title,
    url: datasetPage,
    apiUrl: packageApi,
    snapshotDate,
    retrievedAt,
    refreshCadence: 'daily; DUO states the files are complete at approximately 06:15 Europe/Amsterdam',
    license: 'Creative Commons Attribution (version unspecified by publisher)',
    licenseId: metadata.result.license_id,
    licenseUrl: metadata.result.license_url,
    coverage: 'European Netherlands map scope',
    coverageNote:
      'Current RIO location-use records inside the European Netherlands map extent. RIO locations are BAG-linked where available and education organizations remain responsible for supplied data quality. Locations identify registered education use, not student presence, shelter designation, accessibility, capacity, staffing, supplies, generator endurance or live operating status.',
    resources: downloaded.map(({ name, url, lastModified, bytes, sha256 }) => ({
      name,
      url,
      lastModified,
      bytes,
      sha256,
    })),
  },
  processing: {
    temporalSelection:
      'start date is empty or on/before effectiveDate; end date is empty or after effectiveDate for location use, location-recognition relation and recognition periods',
    mapScopeBounds: europeanNetherlandsBounds,
    municipalityAssignment:
      'Point-in-polygon against the coherent CBS 2025 generalized municipality snapshot; out-of-polygon locations remain visible with municipalityCode=null rather than being forced to a nearest municipality.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
const uncompressed = Buffer.from(`${JSON.stringify(output)}\n`)
const compressed = gzipSync(uncompressed, { level: 9 })
await writeFile(outputPath, compressed)
console.log(JSON.stringify({ outputPath, effectiveDate, snapshotDate, counts, uncompressedBytes: uncompressed.length, compressedBytes: compressed.length }, null, 2))
