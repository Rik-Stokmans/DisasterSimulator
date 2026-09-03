#!/usr/bin/env node

import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dataDirectory = resolve(here, '../apps/web/public/data')
const outputDirectory = resolve(dataDirectory, 'public-context')
const outputPath = resolve(outputDirectory, 'nbnl-capacity-samples.geojson.gz')
const municipalityPath = resolve(dataDirectory, 'netherlands-municipalities.geojson')
const educationPath = resolve(outputDirectory, 'duo-education-locations.geojson.gz')
const apiRoot = 'https://data.partnersinenergie.nl/api/servicearea'
const mapUrl = 'https://data.partnersinenergie.nl/capaciteitskaart/totaal/afname'
const designUrl = 'https://modellen.netbeheernederland.nl/solution-designs/capaciteitskaart.html'
const concurrency = 5

function distanceSquared(left, right) {
  const latitude = ((left[1] + right[1]) / 2) * Math.PI / 180
  const dx = (left[0] - right[0]) * Math.cos(latitude)
  const dy = left[1] - right[1]
  return dx * dx + dy * dy
}

function numericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '-' || value.trim() === '') return null
  const parsed = Number(value.replace(/[^0-9,.-]/g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

function integerValue(value) {
  const parsed = numericValue(value)
  return parsed === null ? null : Math.round(parsed)
}

async function postJson(endpoint, body, { allowNotFound = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${apiRoot}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'NL-Resilience-Lab public-data refresh',
      },
      body: JSON.stringify(body),
    })
    if (allowNotFound && response.status === 404) return null
    if (response.ok) return response.json()
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350 * (attempt + 1)))
      continue
    }
    throw new Error(`Netbeheer Nederland ${endpoint} returned ${response.status}`)
  }
  throw new Error(`Netbeheer Nederland ${endpoint} retry budget exhausted`)
}

async function concurrentMap(items, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }))
  return results
}

const municipalityCollection = JSON.parse(await readFile(municipalityPath, 'utf8'))
const educationCollection = JSON.parse(
  gunzipSync(await readFile(educationPath)).toString('utf8'),
)
const educationByMunicipality = new Map()
for (const feature of educationCollection.features) {
  const code = feature.properties?.municipalityCode
  const postcode = feature.properties?.postcode
  if (
    typeof code !== 'string' ||
    !/^GM\d{4}$/.test(code) ||
    typeof postcode !== 'string' ||
    !/^\d{4}[A-Z]{2}$/.test(postcode) ||
    feature.geometry?.type !== 'Point'
  ) continue
  if (!educationByMunicipality.has(code)) educationByMunicipality.set(code, [])
  educationByMunicipality.get(code).push(feature)
}

const samples = municipalityCollection.features.map((municipality) => {
  const code = municipality.properties.code
  const candidates = educationByMunicipality.get(code) ?? []
  if (candidates.length === 0) {
    throw new Error(`No valid public DUO postcode available for ${code}`)
  }
  const center = municipality.properties.center
  const selected = candidates.reduce((best, candidate) =>
    distanceSquared(candidate.geometry.coordinates, center) <
      distanceSquared(best.geometry.coordinates, center)
      ? candidate
      : best,
  )
  return {
    municipalityCode: code,
    municipalityName: municipality.properties.name,
    municipalityCenter: center,
    location: selected,
  }
})

const serviceAreaRequests = new Map()
function serviceAreaDetails(id) {
  if (!serviceAreaRequests.has(id)) {
    serviceAreaRequests.set(id, postJson('get', { id }).then((payload) => payload.serviceArea ?? null))
  }
  return serviceAreaRequests.get(id)
}

const retrievedAt = new Date().toISOString()
let noPublishedMatch = 0
const features = await concurrentMap(samples, async (sample) => {
  const postcode = sample.location.properties.postcode
  const match = await postJson('find', {
    postalCode6: postcode,
    gridOperatorType: 'RNB',
    energyFlowDirection: 'WITHDRAWAL',
  }, { allowNotFound: true })
  const serviceAreaId = match?.serviceArea?.id
  if (!serviceAreaId) {
    noPublishedMatch += 1
    return {
      type: 'Feature',
      id: `nbnl-capacity-${sample.municipalityCode.toLowerCase()}`,
      geometry: sample.location.geometry,
      properties: {
        municipalityCode: sample.municipalityCode,
        municipalityName: sample.municipalityName,
        samplePostcode: postcode,
        sampleLocationCode: sample.location.properties.locationCode ?? null,
        sampleStatus: 'no-published-match',
        serviceAreaId: null,
        serviceAreaName: null,
        regionalGridOperator: null,
        existingWithdrawalMw: null,
        requiredWithdrawalMw: null,
        queueWithdrawalMw: null,
        uniqueRequestsWithdrawal: null,
        existingInjectionMw: null,
        requiredInjectionMw: null,
        queueInjectionMw: null,
        uniqueRequestsInjection: null,
        tennetWithdrawalClass: null,
        tennetInjectionClass: null,
        projectCount: null,
        earliestProjectYear: null,
      },
    }
  }

  const details = await serviceAreaDetails(serviceAreaId)
  if (!details) throw new Error(`No details returned for service area ${serviceAreaId}`)
  const projectYears = (details.projects ?? [])
    .map((project) => Number(project.year))
    .filter(Number.isFinite)
  return {
    type: 'Feature',
    id: `nbnl-capacity-${sample.municipalityCode.toLowerCase()}`,
    geometry: sample.location.geometry,
    properties: {
      municipalityCode: sample.municipalityCode,
      municipalityName: sample.municipalityName,
      samplePostcode: postcode,
      sampleLocationCode: sample.location.properties.locationCode ?? null,
      sampleStatus: 'sampled',
      serviceAreaId,
      serviceAreaName: details.name ?? serviceAreaId,
      regionalGridOperator: details.rnb ?? null,
      existingWithdrawalMw: numericValue(details.existingTransportCapacityWithdrawal),
      requiredWithdrawalMw: numericValue(details.requiredTransportCapacityWithdrawal),
      queueWithdrawalMw: numericValue(details.queueWithdrawal),
      uniqueRequestsWithdrawal: integerValue(details.uniqueRequestsWithdrawal),
      existingInjectionMw: numericValue(details.existingTransportCapacityInjection),
      requiredInjectionMw: numericValue(details.requiredTransportCapacityInjection),
      queueInjectionMw: numericValue(details.queueInjection),
      uniqueRequestsInjection: integerValue(details.uniqueRequestsInjection),
      tennetWithdrawalClass: Number.isFinite(details.tennetWithdrawalMax)
        ? details.tennetWithdrawalMax
        : null,
      tennetInjectionClass: Number.isFinite(details.tennetInjectionMax)
        ? details.tennetInjectionMax
        : null,
      projectCount: Array.isArray(details.projects) ? details.projects.length : 0,
      earliestProjectYear: projectYears.length ? Math.min(...projectYears) : null,
    },
  }
})

features.sort((left, right) =>
  left.properties.municipalityCode.localeCompare(right.properties.municipalityCode),
)
const sampledFeatures = features.filter((feature) => feature.properties.sampleStatus === 'sampled')
if (sampledFeatures.length < 300) {
  throw new Error(
    `Netbeheer Nederland sample coverage changed unexpectedly: ${sampledFeatures.length}/342`,
  )
}
const operators = Object.fromEntries(
  [...new Set(sampledFeatures.map((feature) => feature.properties.regionalGridOperator).filter(Boolean))]
    .sort()
    .map((operator) => [
      operator,
      sampledFeatures.filter(
        (feature) => feature.properties.regionalGridOperator === operator,
      ).length,
    ]),
)

const output = {
  type: 'FeatureCollection',
  evidenceClass: 'official-context',
  affectsSimulation: false,
  retrievedAt,
  counts: {
    municipalities: features.length,
    sampledMunicipalities: sampledFeatures.length,
    noPublishedMatch,
    uniqueServiceAreas: serviceAreaRequests.size,
    regionalGridOperators: operators,
  },
  source: {
    id: 'nbnl-capacity-map-municipality-samples',
    publisher: 'Netbeheer Nederland / Partners in Energie',
    title: 'Landelijke capaciteitskaart elektriciteitsnet',
    mapUrl,
    designUrl,
    apiFindUrl: `${apiRoot}/find`,
    apiGetUrl: `${apiRoot}/get`,
    retrievedAt,
    accessMethod:
      'Deployment snapshot from public capacity-map frontend JSON endpoints; endpoint stability is not contractually documented.',
    license:
      'Netbeheer Nederland design states the capacity-map data product is open data; an exact dataset licence identifier was not found.',
    updateCadence:
      'Capacity and project information at least quarterly; queue information monthly, with major developments potentially updated sooner.',
    coverage:
      'One service-area lookup at a public DUO education postcode in each municipality; this is a sample, not complete municipality or feeder-area coverage.',
    caveat:
      'Planning context for large-user transport capacity and queues. It is not outage telemetry, physical topology, current load, switching state, emergency reserve, damage, restoration progress or a T+72 forecast.',
  },
  sampling: {
    postcodeSource:
      'DUO RIO public education-location snapshot; nearest valid location to the CBS 2025 municipality reference point.',
    lookup:
      'RNB withdrawal lookup; returned service-area details contain both withdrawal and injection planning fields plus summarized TenneT constraint classes.',
    noDataRule:
      'No published match or a null field remains unknown; it is never converted to zero capacity, no queue, normal service or safety.',
    geometrySemantics:
      'Each point locates the public postcode used for the sample. It is not a substation, cable, transformer, customer connection or service-area boundary.',
  },
  features,
}

await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, gzipSync(`${JSON.stringify(output)}\n`, { level: 9 }))
console.log(JSON.stringify({
  outputPath,
  bytes: (await stat(outputPath)).size,
  counts: output.counts,
}, null, 2))
