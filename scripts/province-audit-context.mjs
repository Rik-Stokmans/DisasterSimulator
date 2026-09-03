#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const readJson = async (relativePath) => JSON.parse(await readFile(resolve(root, relativePath), 'utf8'))
const normalize = (value) => String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-') .replace(/^-|-$/g, '')

const allowIncomplete = process.argv.includes('--allow-incomplete')
const requested = process.argv.slice(2).filter((argument) => argument !== '--allow-incomplete').join(' ').trim()
if (!requested) {
  throw new Error('Usage: pnpm audit:province-context -- "Province name"')
}

const [manifest, transport, safetyRegions, correctionLedger] = await Promise.all([
  readJson('audits/manifest.json'),
  readJson('apps/web/public/data/transport-network.json'),
  readJson('apps/web/public/data/safety-regions.geojson'),
  readJson('audits/correction-ledger.json'),
])

const requestedKey = normalize(requested.replace(/^province_/, ''))
const province = manifest.provinces.find((entry) =>
  normalize(entry.name) === requestedKey ||
  normalize(entry.agentTaskName.replace(/^province_/, '')) === requestedKey ||
  normalize(entry.artifact.split('/').at(-1)?.replace(/\.json$/, '')) === requestedKey,
)
if (!province) {
  throw new Error(
    `Unknown province ${JSON.stringify(requested)}. Expected one of: ${manifest.provinces.map((entry) => entry.name).join(', ')}`,
  )
}

const missingArtifacts = []
const municipalityAudits = []
for (const code of province.municipalityCodes) {
  try {
    municipalityAudits.push(await readJson(`audits/municipalities/${code}.json`))
  } catch (error) {
    if (error?.code === 'ENOENT') missingArtifacts.push(code)
    else throw error
  }
}
if (missingArtifacts.length && !allowIncomplete) {
  throw new Error(
    `${province.name} is not ready for province review; missing municipality audits: ${missingArtifacts.join(', ')}`,
  )
}

const provinceCodes = new Set(province.municipalityCodes)
const findingIds = new Set(
  municipalityAudits.flatMap((audit) => (audit.findings ?? []).map((finding) => finding.id)),
)
const corrections = correctionLedger.entries
  .filter((entry) => entry.findingIds?.some((findingId) => findingIds.has(findingId)))
  .map((entry) => ({
    id: entry.id,
    status: entry.status,
    findingIds: entry.findingIds.filter((findingId) => findingIds.has(findingId)),
    summary: entry.summary,
  }))

const routeProjection = (route) => ({
  id: route.id,
  name: route.name,
  from: route.from,
  to: route.to,
  mode: route.mode,
  supportedServices: route.supportedServices,
  capacitySemantics: route.capacitySemantics ?? 'scenario-units',
  audit: route.audit ?? null,
})
const internalRoutes = transport.routes
  .filter((route) => provinceCodes.has(route.from) && provinceCodes.has(route.to))
  .map(routeProjection)
const boundaryRoutes = transport.routes
  .filter((route) => provinceCodes.has(route.from) !== provinceCodes.has(route.to))
  .map(routeProjection)

const themes = [
  ['water-systems', /river|coast|flood|water|dike|defence|polder|boezem|drain|sewer|groundwater/i],
  ['transport-access', /road|route|rail|ferry|bridge|tunnel|transport|access|corridor/i],
  ['wildfire-smoke', /wildfire|nature.?fire|fire source|smoke|fuel|containment/i],
  ['seismic-ground', /earthquake|seismic|ground.?motion|subsidence|mine/i],
  ['utilities', /power|electric|gas|telecom|drinking.?water|utility|lifeline/i],
  ['healthcare-evacuation', /care|hospital|medical|evacuat|shelter|support point/i],
  ['spatial-allocation', /spatial|rank|seed|neighbou?rhood|footprint|containment/i],
  ['first-72-hours', /72.?hour|T\+0|T\+24|T\+48|T\+72|recovery|action|resource/i],
  ['unknown-nodata', /unknown|no.?data|zero|all.?clear|missing/i],
]
const openFindings = municipalityAudits.flatMap((audit) =>
  (audit.findings ?? [])
    .filter((finding) => finding.status === 'open')
    .map((finding) => ({ municipalityCode: audit.municipality.code, ...finding })),
)

const output = {
  generatedAt: new Date().toISOString(),
  province: {
    name: province.name,
    taskName: province.agentTaskName,
    artifact: province.artifact,
    municipalityCodes: province.municipalityCodes,
  },
  readiness: {
    municipalityAuditsExpected: province.municipalityCodes.length,
    municipalityAuditsPresent: municipalityAudits.length,
    missingMunicipalities: missingArtifacts,
    allMunicipalitiesPresent: missingArtifacts.length === 0,
  },
  verdictCounts: Object.fromEntries(
    [...new Set(municipalityAudits.map((audit) => audit.verdict))]
      .sort()
      .map((verdict) => [verdict, municipalityAudits.filter((audit) => audit.verdict === verdict).length]),
  ),
  openFindingCounts: {
    total: openFindings.length,
    critical: openFindings.filter((finding) => finding.severity === 'critical').length,
    high: openFindings.filter((finding) => finding.severity === 'high').length,
    medium: openFindings.filter((finding) => finding.severity === 'medium').length,
  },
  themeCounts: Object.fromEntries(
    themes.map(([theme, pattern]) => [
      theme,
      openFindings.filter((finding) => pattern.test(`${finding.summary} ${finding.evidence ?? ''}`)).length,
    ]),
  ),
  municipalities: municipalityAudits.map((audit) => ({
    code: audit.municipality.code,
    name: audit.municipality.name,
    safetyRegion: audit.municipality.safetyRegion,
    verdict: audit.verdict,
    openPriorities: (audit.findings ?? [])
      .filter((finding) => finding.status === 'open' && ['critical', 'high'].includes(finding.severity))
      .map((finding) => ({ id: finding.id, severity: finding.severity, summary: finding.summary })),
    provinceReviewFlags: audit.provinceReviewFlags ?? [],
  })),
  safetyRegions: safetyRegions.features
    .filter((feature) => feature.properties.municipalityCodes.some((code) => provinceCodes.has(code)))
    .map((feature) => ({
      code: feature.properties.code,
      name: feature.properties.name,
      municipalitiesInProvince: feature.properties.municipalityCodes.filter((code) => provinceCodes.has(code)),
      municipalitiesOutsideProvince: feature.properties.municipalityCodes.filter((code) => !provinceCodes.has(code)),
    })),
  transport: {
    internalRouteCount: internalRoutes.length,
    boundaryRouteCount: boundaryRoutes.length,
    internalRoutes,
    boundaryRoutes,
  },
  correctionLedger: corrections,
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
