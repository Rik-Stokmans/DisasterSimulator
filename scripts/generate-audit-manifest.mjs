import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dataDirectory = resolve(root, 'apps/web/public/data')
const auditDirectory = resolve(root, 'audits')

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const readAudit = async (path) => {
  try {
    return { status: 'complete', audit: await readJson(path) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'pending', audit: null }
    return { status: 'invalid', audit: null, error: String(error) }
  }
}

const slug = (value) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')

const [municipalityCollection, safetyRegions, transport, settlementManifest] = await Promise.all([
  readJson(resolve(dataDirectory, 'netherlands-municipalities.geojson')),
  readJson(resolve(dataDirectory, 'safety-regions.geojson')),
  readJson(resolve(dataDirectory, 'transport-network.json')),
  readJson(resolve(dataDirectory, 'settlements/manifest.json')),
])

const safetyByMunicipality = new Map()
for (const feature of safetyRegions.features) {
  for (const code of feature.properties.municipalityCodes) {
    if (safetyByMunicipality.has(code)) throw new Error(`${code} occurs in multiple safety regions`)
    safetyByMunicipality.set(code, feature.properties.name)
  }
}
const settlementsByMunicipality = new Map(
  settlementManifest.municipalities.map((entry) => [entry.code, entry]),
)
const routeDegree = new Map(municipalityCollection.features.map((feature) => [feature.properties.code, 0]))
for (const route of transport.routes) {
  routeDegree.set(route.from, (routeDegree.get(route.from) ?? 0) + 1)
  routeDegree.set(route.to, (routeDegree.get(route.to) ?? 0) + 1)
}

const regionBundles = await Promise.all(
  municipalityCollection.features.map((feature) =>
    readJson(resolve(dataDirectory, `regions/${feature.properties.code}.json`)),
  ),
)
const regionByMunicipality = new Map(
  regionBundles.map((bundle) => [bundle.municipalityCode, bundle]),
)

const municipalities = []
for (const feature of municipalityCollection.features) {
  const code = feature.properties.code
  const bundle = regionByMunicipality.get(code)
  if (!bundle) throw new Error(`Missing regional bundle for ${code}`)
  const provinces = [...new Set(bundle.places.features.map((item) => item.properties.province).filter(Boolean))]
  if (provinces.length !== 1) throw new Error(`${code} resolves to ${provinces.length} provinces`)
  const artifact = `audits/municipalities/${code}.json`
  const artifactState = await readAudit(resolve(root, artifact))
  municipalities.push({
    code,
    name: feature.properties.name,
    province: provinces[0],
    safetyRegion: safetyByMunicipality.get(code) ?? null,
    sourceEdition: feature.properties.boundaryEdition,
    neighborhoods: bundle.neighborhoods.features.length,
    places: bundle.places.features.length,
    settlements: settlementsByMunicipality.get(code)?.count ?? 0,
    logicalTransportRouteDegree: routeDegree.get(code) ?? 0,
    agentTaskName: `municipality_${code.toLowerCase()}`,
    artifact,
    status: artifactState.status,
    verdict: artifactState.audit?.verdict ?? null,
    agentId: artifactState.audit?.agent?.agentId ?? null,
    parseError: artifactState.error ?? null,
  })
}
municipalities.sort((left, right) => left.name.localeCompare(right.name, 'nl'))

const provinceNames = [...new Set(municipalities.map((item) => item.province))]
  .sort((left, right) => left.localeCompare(right, 'nl'))
const provinces = []
for (const province of provinceNames) {
  const artifact = `audits/provinces/${slug(province)}.json`
  const artifactState = await readAudit(resolve(root, artifact))
  provinces.push({
    name: province,
    municipalityCodes: municipalities.filter((item) => item.province === province).map((item) => item.code),
    agentTaskName: `province_${slug(province)}`,
    artifact,
    status: artifactState.status,
    verdict: artifactState.audit?.verdict ?? null,
    agentId: artifactState.audit?.agent?.agentId ?? null,
    parseError: artifactState.error ?? null,
  })
}

const manifest = {
  schemaVersion: '1.0.0',
  generatedAt: new Date().toISOString(),
  source: {
    municipalities: municipalityCollection.source,
    safetyRegions: safetyRegions.source,
    transport: transport.source,
    settlements: settlementManifest.dataset,
  },
  counts: {
    municipalities: municipalities.length,
    provinces: provinces.length,
    completedMunicipalityAudits: municipalities.filter((item) => item.status === 'complete').length,
    completedProvinceAudits: provinces.filter((item) => item.status === 'complete').length,
  },
  municipalities,
  provinces,
}

await Promise.all([
  mkdir(resolve(auditDirectory, 'municipalities'), { recursive: true }),
  mkdir(resolve(auditDirectory, 'provinces'), { recursive: true }),
  mkdir(resolve(auditDirectory, 'ui'), { recursive: true }),
])
await writeFile(resolve(auditDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(
  `Audit manifest: ${municipalities.length} municipalities, ${provinces.length} provinces, ` +
  `${manifest.counts.completedMunicipalityAudits} municipality audits complete`,
)

