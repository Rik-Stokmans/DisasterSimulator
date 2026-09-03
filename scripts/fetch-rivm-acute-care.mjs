#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = resolve(here, '../apps/web/public/data/public-context')
const outputPath = resolve(outputDirectory, 'rivm-acute-care-locations.geojson.gz')
const datasetPage =
  'https://datacatalogus.rivm.nl/dataset.xhtml?persistentId=doi:10.21945/8E767B2D-9CED-4A85-A95D-3AC1A608C663'
const downloadUrl =
  'https://data.rivm.nl/meta/srv/api/records/afbdf4b9-00f0-4d4e-a67e-fd3bbc8c833c/attachments/Antwoorden%20vragenlijst%202026%20tbv%20data.rivm.nl.zip'
const geocoderUrl = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free'

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

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    decodeXml(
      [...match[1].matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((textMatch) => textMatch[1])
        .join(''),
    ),
  )
}

function parseWorksheet(xml, sharedStrings) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row[^>]*r="([0-9]+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1])
    if (rowNumber < 4) continue
    const values = {}
    for (const cellMatch of rowMatch[2].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const column = /r="([A-Z]+)[0-9]+"/.exec(cellMatch[1])?.[1]
      if (!column || !['A', 'B', 'C', 'D', 'E', 'H', 'M', 'N'].includes(column)) continue
      const rawValue = /<v>([\s\S]*?)<\/v>/.exec(cellMatch[2])?.[1] ?? ''
      values[column] = cellMatch[1].includes('t="s"')
        ? sharedStrings[Number(rawValue)] ?? ''
        : rawValue
    }
    if (values.A && values.B && values.C && values.D) rows.push({ rowNumber, ...values })
  }
  return rows
}

function normalizedPostcode(value) {
  return value.replace(/\s+/g, '').toUpperCase()
}

function pointCoordinates(value) {
  const match = /^POINT\((-?[0-9.]+) (-?[0-9.]+)\)$/.exec(value ?? '')
  if (!match) return null
  const coordinates = [Number(match[1]), Number(match[2])]
  return coordinates.every(Number.isFinite) ? coordinates : null
}

async function geocode(row) {
  const postcode = normalizedPostcode(row.D)
  const rangeMatch = /\b([0-9]{1,5})\s*-\s*([0-9]{1,5})\b/.exec(row.C)
  const houseNumber = Number(/([0-9]{1,5})/.exec(row.C)?.[1])
  if (!/^[0-9]{4}[A-Z]{2}$/.test(postcode) || !Number.isFinite(houseNumber)) {
    throw new Error(`Cannot derive an exact BAG query from RIVM row ${row.rowNumber}`)
  }
  const parameters = new URLSearchParams({
    rows: '5',
    fl: 'id,weergavenaam,centroide_ll,postcode,huisnummer,gemeentecode,gemeentenaam',
  })
  parameters.append('fq', 'type:adres')
  parameters.append('fq', `postcode:${postcode}`)
  if (!rangeMatch) parameters.append('fq', `huisnummer:${houseNumber}`)
  const response = await fetchWithRetry(`${geocoderUrl}?${parameters}`, `PDOK geocode row ${row.rowNumber}`)
  const data = await response.json()
  const candidates = data.response?.docs ?? []
  const postcodeCandidates = candidates.filter(
    (candidate) =>
      normalizedPostcode(candidate.postcode ?? '') === postcode &&
      pointCoordinates(candidate.centroide_ll),
  )
  const match = rangeMatch
    ? postcodeCandidates
        .filter((candidate) =>
          Number(candidate.huisnummer) >= Number(rangeMatch[1]) &&
          Number(candidate.huisnummer) <= Number(rangeMatch[2]),
        )
        .sort((left, right) =>
          Math.abs(Number(left.huisnummer) - (Number(rangeMatch[1]) + Number(rangeMatch[2])) / 2) -
          Math.abs(Number(right.huisnummer) - (Number(rangeMatch[1]) + Number(rangeMatch[2])) / 2),
        )[0]
    : postcodeCandidates.find((candidate) => Number(candidate.huisnummer) === houseNumber)
  if (!match) throw new Error(`No exact BAG address match for RIVM row ${row.rowNumber}: ${row.C}, ${row.D}`)
  return {
    match,
    coordinates: pointCoordinates(match.centroide_ll),
    matchMethod: rangeMatch ? 'postcode and address-range midpoint' : 'exact postcode and house number',
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await mapper(values[index], index)
      }
    }),
  )
  return results
}

const retrievedAt = new Date().toISOString()
const response = await fetchWithRetry(downloadUrl, 'RIVM acute-care questionnaire')
const archive = Buffer.from(await response.arrayBuffer())
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nl-resilience-rivm-'))

try {
  const archivePath = join(temporaryDirectory, 'rivm-acute-care.zip')
  await writeFile(archivePath, archive)
  const entries = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const workbookEntry = entries.find((entry) => entry.toLowerCase().endsWith('.xlsx'))
  if (!workbookEntry) throw new Error('RIVM archive does not contain the expected XLSX workbook')
  const workbookPath = join(temporaryDirectory, 'rivm-acute-care.xlsx')
  const workbook = execFileSync('unzip', ['-p', archivePath, workbookEntry])
  await writeFile(workbookPath, workbook)
  const sharedStrings = parseSharedStrings(
    execFileSync('unzip', ['-p', workbookPath, 'xl/sharedStrings.xml'], { encoding: 'utf8' }),
  )
  const rows = parseWorksheet(
    execFileSync('unzip', ['-p', workbookPath, 'xl/worksheets/sheet2.xml'], { encoding: 'utf8' }),
    sharedStrings,
  )
  if (rows.length !== 79) throw new Error(`Expected 79 RIVM emergency-department rows; found ${rows.length}`)

  const located = await mapWithConcurrency(rows, 4, async (row, index) => {
    const location = await geocode(row)
    process.stdout.write(`\rRIVM acute-care BAG matches: ${index + 1}/${rows.length}`)
    return { row, ...location }
  })
  process.stdout.write('\n')

  const features = located.map(({ row, match, coordinates, matchMethod }) => {
    const emergencyOpen247 = row.H.includes('24 uur per dag 7 dagen per week')
    const acuteObstetrics = row.E.includes('acute verloskunde') && !row.E.includes('geen acute verloskunde')
    const postcode = normalizedPostcode(row.D)
    const municipalityCode = /^\d{4}$/.test(match.gemeentecode ?? '')
      ? `GM${match.gemeentecode}`
      : null
    return {
      type: 'Feature',
      id: `rivm-seh-${postcode.toLowerCase()}-${createHash('sha1').update(row.A).digest('hex').slice(0, 8)}`,
      geometry: { type: 'Point', coordinates },
      properties: {
        facilityType: 'emergency-department',
        name: row.A.trim(),
        locality: row.B.trim(),
        address: row.C.trim(),
        postcode,
        municipalityCode,
        municipalityName: match.gemeentenaam ?? null,
        emergencyOpen247,
        acuteObstetrics,
        treatmentRoomsReported: row.M === '' ? null : Number(row.M),
        emergencyVisits2025Reported: row.N === '' ? null : Number(row.N),
        offeringDescription: row.E.trim(),
        openingDescription: row.H.trim(),
        sourceRow: row.rowNumber,
        geocoderRecordId: match.id,
        geocoderMatchMethod: matchMethod,
      },
    }
  })
  features.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  if (
    new Set(features.map((feature) => feature.id)).size !== features.length ||
    features.some((feature) =>
      !feature.geometry.coordinates.every(Number.isFinite) ||
      !Number.isFinite(feature.properties.treatmentRoomsReported) ||
      !Number.isFinite(feature.properties.emergencyVisits2025Reported) ||
      !feature.properties.municipalityCode
    )
  ) {
    throw new Error('Normalized RIVM acute-care feature set is incomplete')
  }

  const counts = {
    emergencyDepartments: features.length,
    open247: features.filter((feature) => feature.properties.emergencyOpen247).length,
    limitedHours: features.filter((feature) => !feature.properties.emergencyOpen247).length,
    acuteObstetrics: features.filter((feature) => feature.properties.acuteObstetrics).length,
  }
  if (counts.open247 !== 76 || counts.limitedHours !== 3 || counts.acuteObstetrics !== 71) {
    throw new Error(`RIVM role counts changed unexpectedly: ${JSON.stringify(counts)}`)
  }

  const output = {
    type: 'FeatureCollection',
    evidenceClass: 'official-context',
    affectsSimulation: false,
    counts,
    source: {
      id: 'rivm-acute-care-questionnaire-2026-v1.1',
      publisher: 'Rijksinstituut voor Volksgezondheid en Milieu (RIVM)',
      title: 'RIVM Vragenlijst aanbod SEH’s en Acute Verloskunde 2026',
      url: datasetPage,
      downloadUrl,
      doi: '10.21945/8E767B2D-9CED-4A85-A95D-3AC1A608C663',
      version: '1.1',
      publicationDate: '2026-07-03',
      retrievedAt,
      license: 'CC0 1.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      inputSha256: createHash('sha256').update(archive).digest('hex'),
      coverage: 'national-questionnaire',
      coverageNote:
        'Hospital-level questionnaire responses identify SEH and acute-obstetric offer, reported treatment rooms and 2025 visits. They are dated context, not live occupancy, staffing, diversion, generator endurance, incident capacity or a restoration commitment.',
    },
    geocoding: {
      publisher: 'PDOK / BAG via Locatieserver',
      url: geocoderUrl,
      retrievedAt,
      matchMethod: 'exact normalized postcode and house number; declared address ranges use the closest BAG number to the range midpoint',
      license: 'Public Domain Mark 1.0',
    },
    features,
  }

  await mkdir(outputDirectory, { recursive: true })
  const uncompressed = Buffer.from(`${JSON.stringify(output)}\n`)
  const compressed = gzipSync(uncompressed, { level: 9 })
  await writeFile(outputPath, compressed)
  console.log(JSON.stringify({
    outputPath,
    counts,
    uncompressedBytes: uncompressed.length,
    compressedBytes: compressed.length,
  }, null, 2))
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
