import { gunzipSync } from 'node:zlib'

export const NDW_CURRENT_SITUATIONS_URL = 'https://opendata.ndw.nu/actueel_beeld.xml.gz'

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 96 * 1024 * 1024

const decodeEntities = (value) => value
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'")
  .trim()

const tagValue = (block, localName) => {
  const match = new RegExp(
    `<[A-Za-z0-9_-]+:${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</[A-Za-z0-9_-]+:${localName}>`,
  ).exec(block)
  return match ? decodeEntities(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) : null
}

const tagBlock = (block, localName) => {
  const match = new RegExp(
    `<[A-Za-z0-9_-]+:${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</[A-Za-z0-9_-]+:${localName}>`,
  ).exec(block)
  return match?.[1] ?? ''
}

const isoOrNull = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

const geometryForRecord = (record) => {
  const lineStrings = [...record.matchAll(/<loc:posList(?:\s[^>]*)?>([\s\S]*?)<\/loc:posList>/g)]
    .map((match) => match[1].trim().split(/\s+/).map(Number))
    .filter((values) => values.length >= 4 && values.length % 2 === 0 && values.every(Number.isFinite))
    .map((values) => {
      const coordinates = []
      for (let index = 0; index < values.length; index += 2) {
        // DATEX II's WGS 84 posList uses latitude, longitude order.
        coordinates.push([values[index + 1], values[index]])
      }
      return coordinates
    })
    .filter((coordinates) => coordinates.every(
      ([longitude, latitude]) =>
        longitude >= 2.5 && longitude <= 8.0 && latitude >= 50.5 && latitude <= 54.0,
    ))
    .sort((left, right) => right.length - left.length)
  if (lineStrings[0]) return { type: 'LineString', coordinates: lineStrings[0] }

  const latitude = Number(tagValue(record, 'latitude'))
  const longitude = Number(tagValue(record, 'longitude'))
  if (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    longitude >= 2.5 && longitude <= 8.0 &&
    latitude >= 50.5 && latitude <= 54.0
  ) {
    return { type: 'Point', coordinates: [longitude, latitude] }
  }
  return null
}

const eventTypeTags = [
  'roadOrCarriagewayOrLaneManagementType',
  'accidentType',
  'obstructionType',
  'vehicleObstructionType',
  'environmentalObstructionType',
  'weatherRelatedRoadConditionType',
  'nonWeatherRelatedRoadConditionType',
  'abnormalTrafficType',
  'publicEventType',
  'disturbanceActivityType',
  'constructionWorksType',
  'maintenanceWorksType',
  'speedManagementType',
  'generalNetworkManagementType',
]

/**
 * Converts the public NDW DATEX II gzip into a client-safe GeoJSON collection.
 * Confidential and non-real messages are never emitted, and records outside
 * the feed publication time through T+72 are removed.
 */
export function parseNdwCurrentSituations(
  compressedInput,
  { sourceLastModified = null, retrievedAt = new Date().toISOString() } = {},
) {
  const compressed = Buffer.from(compressedInput)
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error(`NDW current-situation payload exceeds ${MAX_COMPRESSED_BYTES} bytes`)
  }
  const xml = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8')
  const publicationTime = isoOrNull(tagValue(xml, 'publicationTime'))
  if (!publicationTime) throw new Error('NDW current-situation feed has no valid publication time')
  const publicationMs = Date.parse(publicationTime)
  const validWindowEndMs = publicationMs + 72 * 60 * 60 * 1_000

  const situationPattern = /<sit:situation\b([^>]*)>([\s\S]*?)<\/sit:situation>/g
  const recordPattern = /<sit:situationRecord\b([^>]*)>([\s\S]*?)<\/sit:situationRecord>/g
  const features = []
  let totalSituations = 0
  let confidentialSituations = 0
  let outsideWindowRecords = 0
  let missingGeometryRecords = 0

  for (const situationMatch of xml.matchAll(situationPattern)) {
    totalSituations += 1
    const [situationAttributes, situation] = situationMatch.slice(1)
    const confidentiality = tagValue(situation, 'confidentiality')
    if (confidentiality !== 'noRestriction') {
      confidentialSituations += 1
      continue
    }
    if (tagValue(situation, 'informationStatus') !== 'real') continue
    const situationId = /\bid="([^"]+)"/.exec(situationAttributes)?.[1] ?? `situation-${totalSituations}`
    const severity = tagValue(situation, 'overallSeverity') ?? 'unknown'
    const situationVersionTime = isoOrNull(tagValue(situation, 'situationVersionTime'))

    let recordIndex = 0
    for (const recordMatch of situation.matchAll(recordPattern)) {
      recordIndex += 1
      const [recordAttributes, record] = recordMatch.slice(1)
      const startTime = isoOrNull(tagValue(record, 'overallStartTime'))
      const endTime = isoOrNull(tagValue(record, 'overallEndTime'))
      if (
        (startTime && Date.parse(startTime) > validWindowEndMs) ||
        (endTime && Date.parse(endTime) < publicationMs)
      ) {
        outsideWindowRecords += 1
        continue
      }
      const geometry = geometryForRecord(record)
      if (!geometry) {
        missingGeometryRecords += 1
        continue
      }
      const recordId = /\bid="([^"]+)"/.exec(recordAttributes)?.[1] ?? `${situationId}:${recordIndex}`
      const recordClass = /\bxsi:type="sit:([^"]+)"/.exec(recordAttributes)?.[1] ?? 'SituationRecord'
      const eventType = eventTypeTags
        .map((tag) => tagValue(record, tag))
        .find(Boolean) ?? recordClass
      const sourceBlock = tagBlock(record, 'sourceName')
      const source = tagValue(sourceBlock, 'value')
      features.push({
        type: 'Feature',
        id: recordId,
        geometry,
        properties: {
          situationId,
          recordId,
          recordClass,
          eventType,
          severity,
          probability: tagValue(record, 'probabilityOfOccurrence'),
          source,
          startTime,
          endTime,
          versionTime: isoOrNull(tagValue(record, 'situationRecordVersionTime')) ?? situationVersionTime,
          validityStatus: tagValue(record, 'validityStatus'),
          informationStatus: 'real',
          confidentiality: 'noRestriction',
        },
      })
    }
  }

  return {
    type: 'FeatureCollection',
    features,
    evidenceClass: 'observed-context',
    affectsSimulation: false,
    source: {
      id: 'ndw-datex3-current-situations',
      publisher: 'Nationaal Dataportaal Wegverkeer (NDW)',
      url: NDW_CURRENT_SITUATIONS_URL,
      documentation: 'https://docs.ndw.nu/dataformaten/datex2-v3/situatieberichten/actueel-beeld/',
      license: 'CC0 unless otherwise stated by NDW',
      licenseUrl: 'https://www.ndw.nu/service/copyright',
      publicationTime,
      sourceLastModified,
      retrievedAt,
      validityWindowHours: 72,
      coverage:
        'Real, no-restriction DATEX II records intersecting publication time through T+72 and carrying usable WGS84 geometry.',
      caveat:
        'Some supplier messages are unvalidated. Observed current-picture context does not alter scenario routes until scenario time and location matching are explicitly enabled.',
    },
    processing: {
      totalSituations,
      confidentialSituationsExcluded: confidentialSituations,
      recordsOutside72HoursExcluded: outsideWindowRecords,
      recordsWithoutUsableGeometryExcluded: missingGeometryRecords,
    },
  }
}

export async function fetchNdwCurrentSituations({ signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(NDW_CURRENT_SITUATIONS_URL, { signal })
  if (!response.ok) throw new Error(`NDW current-situation feed returned ${response.status}`)
  const compressed = Buffer.from(await response.arrayBuffer())
  const collection = parseNdwCurrentSituations(compressed, {
    sourceLastModified: response.headers.get('last-modified'),
    retrievedAt: new Date().toISOString(),
  })
  return { collection, compressedBytes: compressed.byteLength }
}
