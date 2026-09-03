import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const allowIncomplete = process.argv.includes('--allow-incomplete')
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const manifest = await readJson(resolve(root, 'audits/manifest.json'))
const collection = await readJson(resolve(root, 'apps/web/public/data/netherlands-municipalities.geojson'))
const expectedCodes = new Set(collection.features.map((feature) => feature.properties.code))
const failures = []
const requiredDataChecks = ['identity', 'geography', 'demography', 'regionalDetail', 'settlements', 'transport', 'emergencyContext']
const requiredModelChecks = ['scenarioMatrix', 'numericalInvariants', 'spatialPlausibility', 'serviceDependencies', 'causalTrace', 'recovery72h']
const presets = ['severe-storm', 'pluvial-flood', 'river-flood', 'coastal-flood', 'heatwave', 'winter-storm', 'cyberattack', 'earthquake', 'wildfire', 'compound']
const services = ['power', 'water', 'drainage', 'gas', 'telecom', 'mobility', 'facilities', 'supply']
const checkpoints = [0, 6, 12, 24, 48, 72]
const uiTracks = ['runtime-map-performance', 'operations-workflow', 'accessibility-mobile-visualization']
const provinceCrossBoundaryTopics = ['water-systems', 'transport', 'safety-regions', 'energy', 'telecom', 'healthcare', 'evacuation', 'hazard-continuity']
const checkStatuses = ['pass', 'warn', 'fail', 'unverified']
const findingSeverities = ['critical', 'high', 'medium', 'low', 'informational']
const findingCategories = ['identity', 'geography', 'demography', 'exposure', 'regional-data', 'hazard', 'service', 'network', 'model', 'explainability', 'ui', 'limitation']
const findingStatuses = ['open', 'fixed', 'accepted-limitation']
const municipalityFindingIds = new Set()
const municipalityVerdicts = new Map()

const sameSet = (actual, expected) =>
  Array.isArray(actual) && actual.length === expected.length && expected.every((item) => actual.includes(item))
const addFailure = (message) => failures.push(message)
const validDateTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const validUri = (value) => {
  if (typeof value !== 'string') return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}
const nonEmptyStrings = (values) =>
  Array.isArray(values) && values.every((value) => typeof value === 'string' && value.length > 0)

if (manifest.municipalities.length !== 342) addFailure(`manifest has ${manifest.municipalities.length} municipalities`)
if (manifest.provinces.length !== 12) addFailure(`manifest has ${manifest.provinces.length} provinces`)
if (new Set(manifest.municipalities.map((entry) => entry.code)).size !== expectedCodes.size) addFailure('municipality codes are not unique and complete')
if (new Set(manifest.municipalities.map((entry) => entry.agentTaskName)).size !== expectedCodes.size) addFailure('municipality agent task names are not unique')

let completedMunicipalities = 0
for (const entry of manifest.municipalities) {
  if (!expectedCodes.has(entry.code)) addFailure(`${entry.code} is not in the official collection`)
  let audit
  try {
    audit = await readJson(resolve(root, entry.artifact))
  } catch (error) {
    if (error?.code !== 'ENOENT') addFailure(`${entry.code} audit cannot be parsed: ${error}`)
    continue
  }
  completedMunicipalities += 1
  municipalityVerdicts.set(entry.code, audit.verdict)
  if (audit.schemaVersion !== '1.0.0' || audit.kind !== 'municipality-audit') addFailure(`${entry.code} has wrong schema identity`)
  if (audit.municipality?.code !== entry.code || audit.municipality?.name !== entry.name || audit.municipality?.province !== entry.province || audit.municipality?.safetyRegion !== entry.safetyRegion) addFailure(`${entry.code} municipality identity disagrees with manifest`)
  if (audit.agent?.taskName !== entry.agentTaskName || !audit.agent?.agentId) addFailure(`${entry.code} has no matching distinct agent identity`)
  if (!validDateTime(audit.agent?.completedAt)) addFailure(`${entry.code} has invalid agent completion time`)
  if (!['verified', 'verified-with-caveats', 'correction-required', 'blocked'].includes(audit.verdict)) addFailure(`${entry.code} has invalid verdict`)
  if (typeof audit.executiveSummary !== 'string' || audit.executiveSummary.length < 40) addFailure(`${entry.code} lacks an evidence-dense executive summary`)
  if (!Array.isArray(audit.evidenceSources) || audit.evidenceSources.length < 3) addFailure(`${entry.code} cites fewer than three sources`)
  for (const [index, source] of (audit.evidenceSources ?? []).entries()) {
    if (
      !source?.publisher || !source?.title || !validUri(source?.url) ||
      !validDateTime(source?.accessedAt) || !nonEmptyStrings(source?.supports) ||
      source.supports.length === 0
    ) {
      addFailure(`${entry.code} has invalid evidence source ${index + 1}`)
    }
  }
  for (const [group, keys] of [['data', requiredDataChecks], ['model', requiredModelChecks]]) {
    const checks = group === 'data' ? audit.dataChecks : audit.modelChecks
    for (const key of keys) {
      const check = checks?.[key]
      if (!check) {
        addFailure(`${entry.code} lacks ${group} check ${key}`)
      } else if (
        !checkStatuses.includes(check.status) || !check.summary ||
        !Array.isArray(check.evidenceRefs) || !nonEmptyStrings(check.notes)
      ) {
        addFailure(`${entry.code} has invalid ${group} check ${key}`)
      }
    }
  }
  if (!sameSet(audit.scenarioCoverage?.presets, presets)) addFailure(`${entry.code} lacks complete scenario coverage`)
  if (!sameSet(audit.scenarioCoverage?.services, services)) addFailure(`${entry.code} lacks complete service coverage`)
  if (!sameSet(audit.scenarioCoverage?.checkpointsHours, checkpoints)) addFailure(`${entry.code} lacks complete checkpoint coverage`)
  if (!Array.isArray(audit.findings) || !Array.isArray(audit.corrections) || !Array.isArray(audit.residualLimitations) || !Array.isArray(audit.provinceReviewFlags)) addFailure(`${entry.code} lacks result arrays`)
  for (const finding of audit.findings ?? []) {
    if (typeof finding.id !== 'string' || !finding.id.startsWith(`${entry.code}-`)) {
      addFailure(`${entry.code} has an invalid finding identity ${String(finding.id)}`)
    } else if (municipalityFindingIds.has(finding.id)) {
      addFailure(`duplicate municipality finding identity ${finding.id}`)
    } else {
      municipalityFindingIds.add(finding.id)
    }
    if (
      !findingSeverities.includes(finding.severity) ||
      !findingCategories.includes(finding.category) ||
      !findingStatuses.includes(finding.status) ||
      !finding.summary || !finding.evidence || !finding.action
    ) {
      addFailure(`${entry.code} has invalid finding ${String(finding.id)}`)
    }
  }
  for (const [index, correction] of (audit.corrections ?? []).entries()) {
    if (!correction?.summary || !Array.isArray(correction?.files) || !correction?.validation) {
      addFailure(`${entry.code} has invalid correction ${index + 1}`)
    }
  }
  if (!nonEmptyStrings(audit.residualLimitations) || !nonEmptyStrings(audit.provinceReviewFlags)) {
    addFailure(`${entry.code} has invalid limitation or province-review flag entries`)
  }
  if (
    audit.verdict === 'correction-required' &&
    (!(audit.findings ?? []).some((finding) => finding.status === 'open') || (audit.corrections ?? []).length === 0)
  ) {
    addFailure(`${entry.code} is correction-required without an open finding and correction path`)
  }
}

let correctionLedger
try {
  correctionLedger = await readJson(resolve(root, 'audits/correction-ledger.json'))
} catch (error) {
  addFailure(`correction ledger cannot be parsed: ${error}`)
}
if (correctionLedger) {
  if (correctionLedger.schemaVersion !== '1.0.0' || !Array.isArray(correctionLedger.entries)) {
    addFailure('correction ledger has wrong schema identity')
  } else {
    const correctionIds = new Set()
    for (const correction of correctionLedger.entries) {
      if (typeof correction.id !== 'string' || !/^CORR-[0-9]{3}$/.test(correction.id)) {
        addFailure(`invalid correction identity ${String(correction.id)}`)
      } else if (correctionIds.has(correction.id)) {
        addFailure(`duplicate correction identity ${correction.id}`)
      } else {
        correctionIds.add(correction.id)
      }
      if (!['applied', 'interim-mitigation'].includes(correction.status)) {
        addFailure(`${correction.id} has invalid correction status`)
      }
      if (
        !Array.isArray(correction.findingIds) ||
        !Array.isArray(correction.files) ||
        !Array.isArray(correction.validation) ||
        !correction.summary
      ) {
        addFailure(`${correction.id} lacks correction-ledger fields`)
        continue
      }
      for (const findingId of correction.findingIds) {
        if (/^GM[0-9]{4}-/.test(findingId) && !municipalityFindingIds.has(findingId)) {
          addFailure(`${correction.id} references unknown municipality finding ${findingId}`)
        }
      }
    }
  }
}

let completedProvinces = 0
const provinceAgentTasks = new Set()
for (const entry of manifest.provinces) {
  let audit
  try {
    audit = await readJson(resolve(root, entry.artifact))
  } catch (error) {
    if (error?.code !== 'ENOENT') addFailure(`${entry.name} province audit cannot be parsed: ${error}`)
    continue
  }
  completedProvinces += 1
  if (audit.schemaVersion !== '1.0.0' || audit.kind !== 'province-audit') addFailure(`${entry.name} has wrong province schema identity`)
  if (audit.province !== entry.name || audit.agent?.taskName !== entry.agentTaskName || !audit.agent?.agentId) addFailure(`${entry.name} has mismatched province or agent identity`)
  if (provinceAgentTasks.has(audit.agent?.taskName)) addFailure(`${entry.name} duplicates province agent task ${audit.agent?.taskName}`)
  else provinceAgentTasks.add(audit.agent?.taskName)
  if (!['verified', 'verified-with-caveats', 'correction-required', 'blocked'].includes(audit.verdict)) addFailure(`${entry.name} has invalid province verdict`)
  if (!sameSet(audit.municipalitiesExpected, entry.municipalityCodes)) addFailure(`${entry.name} expected municipality set is wrong`)
  if (!sameSet(audit.municipalitiesReviewed, entry.municipalityCodes) || audit.missingMunicipalities?.length !== 0) addFailure(`${entry.name} has not reconciled every municipality`)
  const checks = Array.isArray(audit.crossBoundaryChecks) ? audit.crossBoundaryChecks : []
  const topics = checks.map((check) => check?.topic)
  if (!sameSet(topics, provinceCrossBoundaryTopics) || new Set(topics).size !== topics.length) {
    addFailure(`${entry.name} lacks one distinct check for every province cross-boundary topic`)
  }
  for (const check of checks) {
    if (!['pass', 'warn', 'fail', 'unverified'].includes(check?.status)) {
      addFailure(`${entry.name} has invalid ${String(check?.topic)} check status`)
    }
    if (!check?.summary || !Array.isArray(check.evidenceUrls) || check.evidenceUrls.length === 0) {
      addFailure(`${entry.name} ${String(check?.topic)} check lacks summary or primary evidence URL`)
      continue
    }
    for (const evidenceUrl of check.evidenceUrls) {
      try {
        new URL(evidenceUrl)
      } catch {
        addFailure(`${entry.name} ${String(check.topic)} check has invalid evidence URL ${String(evidenceUrl)}`)
      }
    }
  }
  const hasUnresolvedMunicipality = entry.municipalityCodes.some((code) =>
    ['correction-required', 'blocked'].includes(municipalityVerdicts.get(code)),
  )
  const hasFailedOrUnverifiedBoundary = checks.some((check) => ['fail', 'unverified'].includes(check?.status))
  if (
    (hasUnresolvedMunicipality || hasFailedOrUnverifiedBoundary) &&
    !['correction-required', 'blocked'].includes(audit.verdict)
  ) {
    addFailure(`${entry.name} overstates its verdict despite unresolved municipal or cross-boundary evidence`)
  }
  if (!Array.isArray(audit.aggregateFindings) || !Array.isArray(audit.residualLimitations)) {
    addFailure(`${entry.name} lacks province result arrays`)
  }
  if (audit.verdict === 'correction-required' && audit.aggregateFindings?.length === 0) {
    addFailure(`${entry.name} is correction-required without an aggregate finding`)
  }
}

if (completedProvinces > 0 && completedMunicipalities !== 342) {
  addFailure('province review artifacts exist before all 342 municipality audits are complete')
}

const uiFiles = (await readdir(resolve(root, 'audits/ui'))).filter((file) => file.endsWith('.json'))
const completedUiTracks = new Set()
const uiAgentTasks = new Set()
for (const file of uiFiles) {
  let audit
  try {
    audit = await readJson(resolve(root, 'audits/ui', file))
  } catch (error) {
    addFailure(`UI audit ${file} cannot be parsed: ${error}`)
    continue
  }
  if (audit.schemaVersion !== '1.0.0' || audit.kind !== 'ui-optimization-audit') addFailure(`${file} has wrong UI schema identity`)
  if (!uiTracks.includes(audit.track)) addFailure(`${file} has invalid UI track`)
  if (completedUiTracks.has(audit.track)) addFailure(`${file} duplicates UI track ${audit.track}`)
  completedUiTracks.add(audit.track)
  if (!audit.agent?.taskName || !audit.agent?.agentId) addFailure(`${file} has no UI agent identity`)
  if (uiAgentTasks.has(audit.agent?.taskName)) addFailure(`${file} duplicates UI agent task ${audit.agent?.taskName}`)
  uiAgentTasks.add(audit.agent?.taskName)
  if (!Array.isArray(audit.methods) || audit.methods.length < 2) addFailure(`${file} lacks reproducible methods`)
  if (!Array.isArray(audit.measurements) || audit.measurements.length < 1) addFailure(`${file} lacks measurements`)
  if (!Array.isArray(audit.findings) || audit.findings.length < 1) addFailure(`${file} lacks findings`)
  if (!Array.isArray(audit.validation) || audit.validation.length < 1) addFailure(`${file} lacks validation`)
  if (!Array.isArray(audit.implementedChanges) || !Array.isArray(audit.rejectedRecommendations) || !Array.isArray(audit.residualLimitations)) addFailure(`${file} lacks result arrays`)
}
if (!allowIncomplete) {
  if (completedMunicipalities !== 342) addFailure(`only ${completedMunicipalities}/342 municipality audits are complete`)
  if (completedProvinces !== 12) addFailure(`only ${completedProvinces}/12 province audits are complete`)
  if (!sameSet([...completedUiTracks], uiTracks)) addFailure(`only ${completedUiTracks.size}/3 independent UI audit tracks are present`)
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}
console.log(
  `Audit status valid: ${completedMunicipalities}/342 municipalities, ` +
  `${completedProvinces}/12 provinces, ${completedUiTracks.size}/3 UI tracks`,
)
