import { gzipSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const municipalityPath = resolve(here, '../apps/web/public/data/netherlands-municipalities.geojson')
const outputPath = resolve(here, '../apps/web/public/data/public-context/knmi-weather-warnings.geojson.gz')

const DATASET = 'waarschuwingen_nederland_48h'
const DATASET_VERSION = '1.0'
const API_BASE = 'https://api.dataplatform.knmi.nl/open-data/v1'
const DATASET_PAGE = 'https://dataplatform.knmi.nl/catalog/datasets/index.html?x-dataset=waarschuwingen_nederland_48h&x-dataset-version=1.0'
const WARNING_PAGE = 'https://www.knmi.nl/nederland-nu/weer/waarschuwingen'
const ANONYMOUS_KEY = 'eyJvcmciOiI1ZTU1NGUxOTI3NGE5NjAwMDEyYTNlYjEiLCJpZCI6IjUzYTg1ZDBhMmQ5YzRkYzJiYWNlNzQ4NTQ2Zjk4ODExIiwiaCI6Im11cm11cjEyOCJ9'
const API_KEY = process.env.KNMI_OPEN_DATA_API_KEY ?? process.env.KNMI_API_KEY ?? ANONYMOUS_KEY

const provinceLocationCodes = {
  PV20: 'GR',
  PV21: 'FR',
  PV22: 'DR',
  PV23: 'OV',
  PV24: 'FL',
  PV25: 'GL',
  PV26: 'UT',
  PV27: 'NH',
  PV28: 'ZH',
  PV29: 'ZE',
  PV30: 'NB',
  PV31: 'LB',
}

const warningLabels = {
  0: 'No warning',
  1: 'Code yellow',
  2: 'Code orange',
  3: 'Code red',
}

const phenomenonLabels = {
  thunderstorm: 'Thunderstorms',
  rain: 'Heavy rain',
  visibility: 'Reduced visibility',
  fog: 'Fog',
  wind: 'Wind',
  windgusts: 'Wind gusts',
  gust: 'Wind gusts',
  heat: 'Heat',
  heatstress: 'Heat stress',
  cold: 'Cold',
  snow: 'Snow',
  iciness: 'Icy conditions',
  tornado: 'Tornadoes',
  waterspout: 'Wind/waterspouts',
}

function decodeXmlText(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function blocks(value, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  return [...value.matchAll(pattern)].map((match) => match[1])
}

function tagText(value, tag) {
  const block = blocks(value, tag)[0]
  return block === undefined ? null : decodeXmlText(block)
}

function amsterdamLocalToUtc(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  const [, year, month, day, hour, minute, second = '00'] = match
  const guess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(guess))
  const zoneName = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00'
  const offsetMatch = zoneName.match(/GMT([+-])(\d{2}):(\d{2})/)
  const offsetMinutes = offsetMatch
    ? (offsetMatch[1] === '+' ? 1 : -1) *
      (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]))
    : 0
  return new Date(guess - offsetMinutes * 60_000).toISOString()
}

export function parseKnmiWarningsXml(xml) {
  const slots = []
  const locationCodes = new Set(Object.values(provinceLocationCodes))
  locationCodes.add('WAE')
  locationCodes.add('WAB')

  for (const timeslice of blocks(xml, 'timeslice')) {
    const localTime = tagText(timeslice, 'timeslice_id')
    const validFrom = localTime ? amsterdamLocalToUtc(localTime) : null
    if (!validFrom) continue
    for (const phenomenon of blocks(timeslice, 'phenomenon')) {
      const phenomenonId = tagText(phenomenon, 'phenomenon_id')?.toLowerCase() ?? 'unknown'
      for (const location of blocks(phenomenon, 'location')) {
        const locationCode = tagText(location, 'location_id')?.toUpperCase()
        const level = Number(tagText(location, 'location_warning_status'))
        if (!locationCode || !locationCodes.has(locationCode)) continue
        if (!Number.isInteger(level) || level < 0 || level > 3) continue
        const texts = [...new Set(blocks(location, 'text_data').map(decodeXmlText).filter(Boolean))]
        slots.push({ locationCode, phenomenonId, level, texts, validFrom })
      }
    }
  }

  if (!slots.length) throw new Error('KNMI warning XML contains no recognized hourly location records')
  const grouped = new Map()
  for (const slot of slots.filter((item) => item.level > 0)) {
    const key = [slot.locationCode, slot.phenomenonId, slot.level, slot.texts.join('\n')].join('|')
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(slot)
  }

  const warnings = []
  for (const group of grouped.values()) {
    group.sort((left, right) => left.validFrom.localeCompare(right.validFrom))
    let period = []
    const flush = () => {
      if (!period.length) return
      const first = period[0]
      const last = period.at(-1)
      warnings.push({
        locationCode: first.locationCode,
        phenomenonId: first.phenomenonId,
        phenomenonLabel:
          phenomenonLabels[first.phenomenonId] ?? first.phenomenonId.replaceAll('_', ' '),
        level: first.level,
        levelLabel: warningLabels[first.level],
        validFrom: first.validFrom,
        validThrough: new Date(Date.parse(last.validFrom) + 60 * 60_000).toISOString(),
        slotCount: period.length,
        texts: first.texts,
      })
      period = []
    }
    for (const slot of group) {
      const previous = period.at(-1)
      if (previous && Date.parse(slot.validFrom) - Date.parse(previous.validFrom) > 90 * 60_000) flush()
      period.push(slot)
    }
    flush()
  }
  warnings.sort((left, right) =>
    left.validFrom.localeCompare(right.validFrom) || right.level - left.level,
  )

  const slotTimes = slots.map((slot) => slot.validFrom).sort()
  return {
    warnings,
    maxLevelByLocation: Object.fromEntries(
      [...locationCodes].map((code) => [
        code,
        Math.max(0, ...warnings.filter((warning) => warning.locationCode === code).map((warning) => warning.level)),
      ]),
    ),
    windowStart: slotTimes[0],
    windowEnd: new Date(Date.parse(slotTimes.at(-1)) + 60 * 60_000).toISOString(),
    slotCount: new Set(slotTimes).size,
  }
}

async function fetchChecked(url, init, label, attempts = 1) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, init)
    if (response.ok) return response
    const detail = (await response.text()).slice(0, 240)
    lastError = new Error(`${label} returned ${response.status}: ${detail}`)
    if (response.status !== 429 || attempt === attempts) break
    const retryAfter = Number(response.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter)
      ? Math.min(10_000, retryAfter * 1_000)
      : attempt * 2_000
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))
  }
  throw lastError
}

async function fetchStructuredWarnings() {
  const headers = { Authorization: API_KEY }
  const listUrl = new URL(`${API_BASE}/datasets/${DATASET}/versions/${DATASET_VERSION}/files`)
  listUrl.searchParams.set('maxKeys', '10')
  listUrl.searchParams.set('sorting', 'desc')
  listUrl.searchParams.set('orderBy', 'lastModified')
  const listResponse = await fetchChecked(listUrl, { headers }, 'KNMI warning file listing', 3)
  const listing = await listResponse.json()
  const file = listing.files?.find((candidate) => candidate.filename?.toLowerCase().endsWith('.xml'))
  if (!file) throw new Error('KNMI warning listing contains no recent XML file')
  const fileUrl = `${API_BASE}/datasets/${DATASET}/versions/${DATASET_VERSION}/files/${encodeURIComponent(file.filename)}/url`
  const urlResponse = await fetchChecked(fileUrl, { headers }, 'KNMI warning download URL', 3)
  const urlPayload = await urlResponse.json()
  if (!urlPayload.temporaryDownloadUrl) throw new Error('KNMI did not return a temporary download URL')
  const xmlResponse = await fetchChecked(
    urlPayload.temporaryDownloadUrl,
    undefined,
    'KNMI warning XML download',
  )
  const parsed = parseKnmiWarningsXml(await xmlResponse.text())
  return {
    ...parsed,
    retrievalMode: 'open-data-api',
    sourceFile: file.filename,
    sourceLastModified: file.lastModified,
    fallbackIssueTime: null,
  }
}

async function fetchExplicitNoWarningFallback(apiError) {
  const response = await fetchChecked(WARNING_PAGE, undefined, 'KNMI warning webpage')
  const html = await response.text()
  const explicitNoWarning =
    /<h2>\s*Er zijn geen waarschuwingen\s*<\/h2>/i.test(html) &&
    /Er zijn momenteel geen waarschuwingen van kracht\./i.test(html)
  if (!explicitNoWarning) throw apiError
  const issue = html.match(/Uitgifte:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s+uur\s+LT/i)
  if (!issue) throw new Error('KNMI webpage says no warnings but exposes no parseable issue time')
  const [, day, month, year, hour, minute] = issue
  const fallbackIssueTime = amsterdamLocalToUtc(`${year}-${month}-${day}T${hour}:${minute}:00`)
  return {
    warnings: [],
    maxLevelByLocation: Object.fromEntries(
      [...new Set([...Object.values(provinceLocationCodes), 'WAE', 'WAB'])].map((code) => [code, 0]),
    ),
    windowStart: fallbackIssueTime,
    windowEnd: new Date(Date.parse(fallbackIssueTime) + 48 * 60 * 60_000).toISOString(),
    slotCount: 0,
    retrievalMode: 'official-html-explicit-no-warning-fallback',
    sourceFile: null,
    sourceLastModified: null,
    fallbackIssueTime,
  }
}

function ringContains(point, ring) {
  let inside = false
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [currentX, currentY] = ring[current]
    const [previousX, previousY] = ring[previous]
    if (
      currentY > point[1] !== previousY > point[1] &&
      point[0] < ((previousX - currentX) * (point[1] - currentY)) / (previousY - currentY) + currentX
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

export async function buildKnmiWarningDataset() {
const provinceUrl = new URL(
  'https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1/collections/provincie_gegeneraliseerd/items',
)
provinceUrl.searchParams.set('f', 'json')
provinceUrl.searchParams.set('limit', '20')
provinceUrl.searchParams.set('datetime', '2025-07-01T00:00:00Z')

const [municipalities, provinceResponse, warnings] = await Promise.all([
  readFile(municipalityPath, 'utf8').then(JSON.parse),
  fetchChecked(provinceUrl, undefined, 'CBS/PDOK province geometry'),
  fetchStructuredWarnings().catch(fetchExplicitNoWarningFallback),
])
const provinces = await provinceResponse.json()
if (provinces.features?.length !== 12) {
  throw new Error(`Expected 12 CBS provinces, received ${provinces.features?.length ?? 0}`)
}

const collection = {
  type: 'FeatureCollection',
  name: 'KNMI 48-hour weather warnings on CBS 2025 province geometry',
  evidenceClass: 'official-context',
  affectsSimulation: false,
  coverage: 'twelve-provinces',
  coverageNote:
    'Province polygons cover the twelve land provinces. KNMI also issues separate water-area warnings; Wadden-area records are retained in the warnings array but are not rendered as province polygons.',
  source: {
    id: `${DATASET}-${DATASET_VERSION}`,
    publisher: 'Koninklijk Nederlands Meteorologisch Instituut (KNMI)',
    datasetPage: DATASET_PAGE,
    apiUrl: `${API_BASE}/datasets/${DATASET}/versions/${DATASET_VERSION}/files`,
    warningPage: WARNING_PAGE,
    license: 'CC BY 4.0',
    updateFrequency: 'continual',
    horizonHours: 48,
    sourceFile: warnings.sourceFile,
    sourceLastModified: warnings.sourceLastModified,
    fallbackIssueTime: warnings.fallbackIssueTime,
    retrievalMode: warnings.retrievalMode,
    retrievedAt: new Date().toISOString(),
    timeZone: 'Europe/Amsterdam',
    role:
      'Issued warning context only. It is not a gridded weather forecast, an incident footprint, a municipal impact estimate or a scenario-clock input and does not affect the simulation.',
  },
  warningWindow: {
    start: warnings.windowStart,
    end: warnings.windowEnd,
    hourlyTimeslices: warnings.slotCount,
  },
  counts: {
    provinces: 12,
    warningPeriods: warnings.warnings.length,
    provincesWithWarnings: Object.entries(provinceLocationCodes).filter(
      ([, locationCode]) => (warnings.maxLevelByLocation[locationCode] ?? 0) > 0,
    ).length,
    byLevel: {
      yellow: warnings.warnings.filter((warning) => warning.level === 1).length,
      orange: warnings.warnings.filter((warning) => warning.level === 2).length,
      red: warnings.warnings.filter((warning) => warning.level === 3).length,
    },
  },
  warnings: warnings.warnings,
  features: provinces.features.map((feature) => {
    const provinceCode = feature.properties.statcode
    const locationCode = provinceLocationCodes[provinceCode]
    if (!locationCode) throw new Error(`No KNMI location mapping for CBS province ${provinceCode}`)
    const municipalityCodes = municipalities.features
      .filter((municipality) =>
        Array.isArray(municipality.properties.center) &&
        geometryContains(municipality.properties.center, feature.geometry),
      )
      .map((municipality) => municipality.properties.code)
      .sort()
    const provinceWarnings = warnings.warnings.filter(
      (warning) => warning.locationCode === locationCode,
    )
    const level = warnings.maxLevelByLocation[locationCode] ?? 0
    return {
      type: 'Feature',
      id: provinceCode,
      geometry: feature.geometry,
      properties: {
        provinceCode,
        provinceName: feature.properties.statnaam,
        boundaryEdition: 2025,
        knmiLocationCode: locationCode,
        warningLevel: level,
        warningLevelLabel: warningLabels[level],
        warningPeriodCount: provinceWarnings.length,
        phenomena: [...new Set(provinceWarnings.map((warning) => warning.phenomenonLabel))],
        municipalityCodes,
      },
    }
  }),
}

const assignedMunicipalities = new Set(
  collection.features.flatMap((feature) => feature.properties.municipalityCodes),
)
if (assignedMunicipalities.size !== municipalities.features.length) {
  throw new Error(
    `Province assignment covers ${assignedMunicipalities.size}/${municipalities.features.length} municipalities`,
  )
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, gzipSync(Buffer.from(`${JSON.stringify(collection)}\n`), { level: 9 }))
console.log(JSON.stringify({
  provinces: collection.features.length,
  warningPeriods: collection.counts.warningPeriods,
  provincesWithWarnings: collection.counts.provincesWithWarnings,
  retrievalMode: collection.source.retrievalMode,
  sourceFile: collection.source.sourceFile,
  outputBytes: gzipSync(Buffer.from(JSON.stringify(collection)), { level: 9 }).byteLength,
}, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildKnmiWarningDataset()
}
