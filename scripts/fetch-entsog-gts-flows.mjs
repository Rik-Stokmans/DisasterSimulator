#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = resolve(here, '../apps/web/public/data/public-context')
const outputPath = resolve(outputDirectory, 'entsog-gts-physical-flow.json.gz')

const apiRoot = 'https://transparency.entsog.eu/api/v1/operationaldatas'
const operatorKey = 'NL-TSO-0001'
const operatorLabel = 'GTS'
const apiManualUrl =
  'https://transparency.entsog.eu/api/archiveDirectories/8/api-manual/ENTSOG_TP_API_UserManual_v3.0.pdf'
const termsUrl =
  'https://transparency.entsog.eu/pdf/TRA0394_20161115_ENTSOG_TP_Privacy_TC_of_Use_Rev_3.pdf'
const disclaimerUrl =
  'https://transparency.entsog.eu/pdf/LGT0291_160927_Disclaimer_for_ENTSOG_TP_Rev.pdf'
const gtsExplanationUrl =
  'https://www.gasunietransportservices.nl/netwerk-operations/transparency/dataport/toelichting-netwerkpunten'

const sleep = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

function dateParameter(date) {
  return date.toISOString().slice(0, 10)
}

export function gtsFlowFreshness(periodTo, retrievedAt) {
  const periodEnd = Date.parse(periodTo)
  const retrieval = Date.parse(retrievedAt)
  if (!Number.isFinite(periodEnd) || !Number.isFinite(retrieval)) {
    throw new Error('ENTSOG GTS flow timestamps are invalid')
  }
  const ageMinutes = Math.max(0, Math.round((retrieval - periodEnd) / 60_000))
  return {
    ageMinutesAtRetrieval: ageMinutes,
    statusAtRetrieval: ageMinutes <= 180 ? 'fresh' : ageMinutes <= 720 ? 'delayed' : 'stale',
  }
}

function normalizedText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function normalizeGtsFlowPayload(payload, retrievedAt, rawMetadata = {}) {
  if (!payload || !Array.isArray(payload.operationaldatas)) {
    throw new Error('ENTSOG response contains no operationaldatas array')
  }
  if (
    payload.meta?.query?.operatorKey !== operatorKey ||
    payload.meta?.query?.periodType !== 'hour' ||
    !payload.meta?.query?.indicator?.includes('Physical Flow')
  ) {
    throw new Error('ENTSOG response does not match the requested GTS hourly physical-flow contract')
  }

  const allRows = payload.operationaldatas
  const numericRows = allRows.filter(
    (row) => typeof row.value === 'number' && Number.isFinite(row.value) && row.value >= 0,
  )
  if (!numericRows.length) throw new Error('ENTSOG response contains no non-negative numeric flow values')

  const observationTime = numericRows
    .map((row) => row.periodFrom)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1)
  if (!observationTime) throw new Error('ENTSOG response contains no valid numeric observation time')

  const periodRows = allRows.filter((row) => row.periodFrom === observationTime)
  const selectedRows = numericRows.filter((row) => row.periodFrom === observationTime)
  if (selectedRows.length < 20 || selectedRows.length > 150) {
    throw new Error(`Unexpected GTS latest-hour record count: ${selectedRows.length}`)
  }

  const ids = new Set()
  const records = selectedRows.map((row) => {
    if (
      row.operatorKey !== operatorKey ||
      row.operatorLabel !== operatorLabel ||
      row.indicator !== 'Physical Flow' ||
      row.periodType !== 'hour' ||
      row.unit !== 'kWh/h' ||
      !normalizedText(row.id) ||
      !normalizedText(row.pointKey) ||
      !normalizedText(row.pointLabel) ||
      !normalizedText(row.directionKey) ||
      !Number.isFinite(Date.parse(row.periodTo))
    ) {
      throw new Error(`Invalid GTS physical-flow record at ${String(row.pointKey)}`)
    }
    if (ids.has(row.id)) throw new Error(`Duplicate ENTSOG flow record ${row.id}`)
    ids.add(row.id)
    return {
      id: row.id,
      pointKey: row.pointKey,
      pointLabel: row.pointLabel,
      tsoItemIdentifier: normalizedText(row.tsoItemIdentifier),
      direction: row.directionKey,
      pointType: normalizedText(row.pointType),
      valueKwhPerHour: row.value,
      flowStatus: normalizedText(row.flowStatus) ?? 'Unspecified',
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      lastUpdatedAt: normalizedText(row.lastUpdateDateTime),
      remarks: normalizedText(row.itemRemarks) ?? normalizedText(row.generalRemarks),
    }
  }).sort((left, right) =>
    right.valueKwhPerHour - left.valueKwhPerHour ||
    left.pointLabel.localeCompare(right.pointLabel, 'en') ||
    left.direction.localeCompare(right.direction, 'en'),
  )

  const periodTo = records
    .map((record) => record.periodTo)
    .sort()
    .at(-1)
  const uniquePoints = new Set(records.map((record) => record.pointKey)).size
  if (uniquePoints < 10 || uniquePoints > 100) {
    throw new Error(`Unexpected GTS latest-hour point count: ${uniquePoints}`)
  }

  const freshness = gtsFlowFreshness(periodTo, retrievedAt)
  if (freshness.ageMinutesAtRetrieval > 48 * 60) {
    throw new Error(`Latest numeric GTS flow is ${freshness.ageMinutesAtRetrieval} minutes old`)
  }

  return {
    evidenceClass: 'observed-context',
    affectsSimulation: false,
    observationTime,
    observationPeriod: { from: observationTime, to: periodTo },
    freshness,
    operator: {
      key: operatorKey,
      label: operatorLabel,
      tsoEicCode: records.length
        ? normalizedText(selectedRows[0].tsoEicCode)
        : null,
    },
    records,
    counts: {
      apiRows: allRows.length,
      recordsAtObservationHour: periodRows.length,
      numericDirectionalRecords: records.length,
      missingOrNaAtObservationHour: periodRows.length - records.length,
      zeroDirectionalRecords: records.filter((record) => record.valueKwhPerHour === 0).length,
      uniquePointKeys: uniquePoints,
      byFlowStatus: Object.fromEntries(
        [...new Set(records.map((record) => record.flowStatus))]
          .sort()
          .map((status) => [status, records.filter((record) => record.flowStatus === status).length]),
      ),
    },
    source: {
      id: 'entsog-gts-hourly-physical-flow',
      publisher: 'European Network of Transmission System Operators for Gas (ENTSOG) / Gasunie Transport Services (GTS)',
      apiUrl: rawMetadata.apiUrl ?? apiRoot,
      apiManualUrl,
      termsUrl,
      disclaimerUrl,
      gtsExplanationUrl,
      retrievedAt,
      extractionDate: retrievedAt.slice(0, 10),
      rawBytes: rawMetadata.rawBytes ?? null,
      rawSha256: rawMetadata.rawSha256 ?? null,
      updateCadence: 'GTS states that flows and nominations are updated hourly after a processing delay.',
      terms: 'Reuse governed by the ENTSOG Transparency Platform Terms and Conditions of Use; no standard open-data licence is claimed here.',
      attribution: `Source: ENTSOG Transparency Platform, extraction date ${retrievedAt.slice(0, 10)}.`,
      coverage: 'Latest numeric hourly GTS directional records returned for public physical-flow points. ENTSOG records can include virtual, aggregated, storage, LNG, production, distribution and cross-border directions.',
      geometrySemantics: 'No point geometry is drawn: public Transparency Platform map coordinates do not provide a documented WGS84 coordinate contract for these records.',
      noDataRule: 'A numeric zero is retained as reported. Blank, N/A, missing and future placeholder rows remain missing and are never converted to zero.',
      role: 'Observed national transmission context only. Directional records are non-additive, provisional where labelled, unaligned to the scenario clock and never used to infer municipal distribution pressure, customer supply, outage or T+72 restoration.',
      caveat: 'ENTSOG and GTS do not warrant that public operational data are complete, timely or suitable for emergency decisions. Values can be revised and are not legally binding.',
    },
  }
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'NL-Resilience-Lab public-data refresh',
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok) return response
      const detail = (await response.text()).slice(0, 240)
      lastError = new Error(`ENTSOG GTS flow API returned ${response.status}: ${detail}`)
      if (response.status !== 429 && response.status < 500) break
    } catch (error) {
      lastError = error
    }
    if (attempt < attempts - 1) await sleep(500 * (attempt + 1))
  }
  throw lastError ?? new Error('ENTSOG GTS flow request failed')
}

export async function buildGtsFlowDataset(now = new Date()) {
  const from = new Date(now)
  from.setUTCDate(from.getUTCDate() - 1)
  const to = new Date(now)
  to.setUTCDate(to.getUTCDate() + 1)
  const parameters = new URLSearchParams({
    from: dateParameter(from),
    to: dateParameter(to),
    operatorKey,
    periodType: 'hour',
    indicator: 'Physical Flow',
    limit: '-1',
  })
  const apiUrl = `${apiRoot}?${parameters}`
  const response = await fetchWithRetry(apiUrl)
  const raw = Buffer.from(await response.arrayBuffer())
  const payload = JSON.parse(raw.toString('utf8'))
  const retrievedAt = new Date().toISOString()
  const output = normalizeGtsFlowPayload(payload, retrievedAt, {
    apiUrl,
    rawBytes: raw.length,
    rawSha256: createHash('sha256').update(raw).digest('hex'),
  })
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(outputPath, gzipSync(Buffer.from(JSON.stringify(output)), { level: 9 }))
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildGtsFlowDataset()
  console.log(JSON.stringify({
    outputPath,
    observationPeriod: output.observationPeriod,
    freshness: output.freshness,
    counts: output.counts,
  }, null, 2))
}
