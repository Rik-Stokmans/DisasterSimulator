import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(here, '../apps/web/public/data/netherlands-municipalities.geojson')

const pdokUrl = new URL(
  'https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1/collections/gemeente_gegeneraliseerd/items',
)
pdokUrl.searchParams.set('f', 'json')
pdokUrl.searchParams.set('limit', '1000')
pdokUrl.searchParams.set('datetime', '2025-07-01T00:00:00Z')

const labelUrl = new URL(
  'https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1/collections/gemeente_labelpoint/items',
)
labelUrl.searchParams.set('f', 'json')
labelUrl.searchParams.set('limit', '1000')
labelUrl.searchParams.set('datetime', '2025-07-01T00:00:00Z')

const cbsUrl = new URL(
  'https://opendata.cbs.nl/ODataApi/OData/86165NED/TypedDataSet',
)
cbsUrl.searchParams.set('$filter', "startswith(WijkenEnBuurten,'GM')")
cbsUrl.searchParams.set(
  '$select',
  [
    'WijkenEnBuurten',
    'AantalInwoners_5',
    'Bevolkingsdichtheid_34',
    'k_65JaarOfOuder_12',
    'Eenpersoonshuishoudens_30',
  ].join(','),
)

const [pdokResponse, labelResponse, cbsResponse] = await Promise.all([
  fetch(pdokUrl),
  fetch(labelUrl),
  fetch(cbsUrl),
])
if (!pdokResponse.ok) throw new Error(`PDOK request failed: ${pdokResponse.status}`)
if (!labelResponse.ok) throw new Error(`PDOK label request failed: ${labelResponse.status}`)
if (!cbsResponse.ok) throw new Error(`CBS request failed: ${cbsResponse.status}`)

const municipalities = await pdokResponse.json()
const labels = await labelResponse.json()
const cbs = await cbsResponse.json()
const statsByCode = new Map(
  cbs.value.map((row) => [row.WijkenEnBuurten.trim(), row]),
)
const labelsByCode = new Map(
  labels.features.map((feature) => [feature.properties.statcode, feature.geometry.coordinates]),
)

municipalities.name = 'Dutch municipalities — coherent CBS/PDOK 2025 boundary and statistics snapshot'
municipalities.source = {
  boundaries: pdokUrl.toString(),
  statistics: cbsUrl.toString(),
  retrievedAt: new Date().toISOString(),
  boundaryEdition: 2025,
  statisticsEdition: 2025,
}
municipalities.features = municipalities.features.map((feature) => {
  const code = feature.properties.statcode
  const row = statsByCode.get(code)
  const population = row?.AantalInwoners_5 ?? null
  const age65 = row?.k_65JaarOfOuder_12 ?? null
  return {
    type: 'Feature',
    id: code,
    geometry: feature.geometry,
    properties: {
      code,
      name: feature.properties.statnaam,
      center: labelsByCode.get(code) ?? null,
      population,
      density: row?.Bevolkingsdichtheid_34 ?? null,
      age65Pct: population && age65 ? Number(((age65 / population) * 100).toFixed(1)) : null,
      onePersonHouseholds: row?.Eenpersoonshuishoudens_30 ?? null,
      boundaryEdition: 2025,
      statisticsEdition: 2025,
    },
  }
})

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(municipalities)}\n`, 'utf8')
console.log(`Wrote ${municipalities.features.length} municipalities to ${outputPath}`)
