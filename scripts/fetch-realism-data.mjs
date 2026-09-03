import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import shp from 'shpjs'

const here = dirname(fileURLToPath(import.meta.url))
const publicData = resolve(here, '../apps/web/public/data')
const regionDirectory = resolve(publicData, 'regions')

const CBS_EDITION_INSTANT = '2025-07-01T00:00:00Z'
const CBS_TABLE = '86165NED'
const PDOK_REGIONS = 'https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1'
const PDOK_BAG = 'https://api.pdok.nl/kadaster/bag/ogc/v2'
const PDOK_RAIL = 'https://api.pdok.nl/prorail/spoorwegen/ogc/v1'
const NWB_WFS = 'https://service.pdok.nl/rws/nationaal-wegenbestand-wegen/wfs/v1_0'
const NWB_LIGHT =
  'https://downloads.rijkswaterstaatdata.nl/nwb-wegen/geogegevens/shapefile/NWB-light/01-08-2026.zip'

async function getJson(url, label) {
  const response = await fetch(url, { headers: { accept: 'application/geo+json, application/json' } })
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${await response.text()}`)
  return response.json()
}

async function fetchOgcCollection(url, label) {
  const features = []
  let next = url
  let page = 0
  while (next) {
    const data = await getJson(next, label)
    features.push(...(data.features ?? []))
    next = data.links?.find((link) => link.rel === 'next' && link.type?.includes('json'))?.href
    page += 1
    process.stdout.write(`\r${label}: ${features.length.toLocaleString('en')} features (${page} pages)`)
  }
  process.stdout.write('\n')
  return features
}

function ogcItems(base, collection, parameters = {}) {
  const url = new URL(`${base}/collections/${collection}/items`)
  url.searchParams.set('f', 'json')
  url.searchParams.set('limit', '1000')
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
  return url.toString()
}

function municipalityCode(value) {
  if (value === null || value === undefined || value === '') return null
  const digits = String(value).replace(/^GM/, '').padStart(4, '0')
  return `GM${digits}`
}

function mapBy(items, key) {
  const result = new Map()
  for (const item of items) result.set(key(item), item)
  return result
}

function groupBy(items, key) {
  const result = new Map()
  for (const item of items) {
    const group = key(item)
    if (!group) continue
    if (!result.has(group)) result.set(group, [])
    result.get(group).push(item)
  }
  return result
}

function geometryCenter(geometry) {
  const points = []
  const collect = (value) => {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number' && typeof value[1] === 'number') points.push(value)
    else value.forEach(collect)
  }
  collect(geometry?.coordinates)
  if (!points.length) return null
  const bounds = points.reduce(
    (box, point) => [
      Math.min(box[0], point[0]),
      Math.min(box[1], point[1]),
      Math.max(box[2], point[0]),
      Math.max(box[3], point[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  )
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
}

function pointInRing(point, ring) {
  let inside = false
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]
    const previous = ring[(index + ring.length - 1) % ring.length]
    const crossesLatitude = current[1] > point[1] !== previous[1] > point[1]
    if (!crossesLatitude) continue
    const crossingLongitude =
      ((previous[0] - current[0]) * (point[1] - current[1])) /
        (previous[1] - current[1]) +
      current[0]
    if (point[0] < crossingLongitude) inside = !inside
  }
  return inside
}

function pointInPolygon(point, rings) {
  if (!rings[0] || !pointInRing(point, rings[0])) return false
  return rings.slice(1).every((ring) => !pointInRing(point, ring))
}

function pointInGeometry(point, geometry) {
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates)
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon))
  }
  return false
}

const statisticFields = {
  population: 'AantalInwoners_5',
  men: 'Mannen_6',
  women: 'Vrouwen_7',
  age0To14: 'k_0Tot15Jaar_8',
  age15To24: 'k_15Tot25Jaar_9',
  age25To44: 'k_25Tot45Jaar_10',
  age45To64: 'k_45Tot65Jaar_11',
  age65Plus: 'k_65JaarOfOuder_12',
  households: 'HuishoudensTotaal_29',
  onePersonHouseholds: 'Eenpersoonshuishoudens_30',
  householdsWithoutChildren: 'HuishoudensZonderKinderen_31',
  householdsWithChildren: 'HuishoudensMetKinderen_32',
  averageHouseholdSize: 'GemiddeldeHuishoudensgrootte_33',
  populationDensity: 'Bevolkingsdichtheid_34',
  homes: 'Woningvoorraad_35',
  nonResidentialBuildings: 'NietWoningvoorraad_37',
  averageHomeValueThousands: 'GemiddeldeWOZWaardeVanWoningen_39',
  singleFamilyHomePct: 'PercentageEengezinswoning_40',
  multiFamilyHomePct: 'PercentageMeergezinswoning_45',
  ownerOccupiedPct: 'Koopwoningen_47',
  rentalPct: 'HuurwoningenTotaal_48',
  socialRentalPct: 'InBezitWoningcorporatie_49',
  districtHeatingPct: 'PercentageWoningenMetStadsverwarming_56',
  publicChargingPoints: 'AantalPubliekeLaadpalen_61',
  socialAssistanceRecipients: 'PersonenPerSoortUitkeringBijstand_87',
  disabilityBenefitRecipients: 'PersonenPerSoortUitkeringAO_88',
  oldAgePensionRecipients: 'PersonenPerSoortUitkeringAOW_90',
  businesses: 'BedrijfsvestigingenTotaal_95',
  cars: 'PersonenautoSTotaal_104',
  carsPerHousehold: 'PersonenautoSPerHuishouden_107',
  distanceToDoctorKm: 'AfstandTotHuisartsenpraktijk_110',
  distanceToSupermarketKm: 'AfstandTotGroteSupermarkt_111',
  landAreaHa: 'OppervlakteLand_116',
  waterAreaHa: 'OppervlakteWater_117',
  urbanityClass: 'MateVanStedelijkheid_120',
  addressDensity: 'Omgevingsadressendichtheid_121',
}

async function fetchRegionalStatistics() {
  // CBS refuses OData queries whose result set can exceed 10,000 records. Split
  // on the first two digits of the four-digit municipality code so every query
  // remains bounded while retaining one pinned table edition.
  const prefixes = ['WK', ...Array.from({ length: 20 }, (_, index) => `BU${String(index).padStart(2, '0')}`)]
  const rows = []
  for (const prefix of prefixes) {
    const url = new URL(`https://opendata.cbs.nl/ODataApi/OData/${CBS_TABLE}/TypedDataSet`)
    url.searchParams.set('$filter', `startswith(WijkenEnBuurten,'${prefix}')`)
    url.searchParams.set('$select', ['WijkenEnBuurten', ...Object.values(statisticFields)].join(','))
    const data = await getJson(url, `CBS statistics ${prefix}`)
    rows.push(...data.value)
    process.stdout.write(`\rCBS regional statistics: ${rows.length.toLocaleString('en')} rows`)
  }
  process.stdout.write('\n')
  return mapBy(rows, (row) => row.WijkenEnBuurten.trim())
}

function compactStatistics(row) {
  return Object.fromEntries(
    Object.entries(statisticFields).map(([name, source]) => {
      const value = row?.[source] ?? null
      // CBS uses large negative sentinel values for unknown/suppressed fields.
      return [name, typeof value === 'number' && value < 0 ? null : value]
    }),
  )
}

async function writeRegions(municipalities) {
  const [districts, neighborhoods, neighborhoodLabels, places, statistics] = await Promise.all([
    fetchOgcCollection(
      ogcItems(PDOK_REGIONS, 'wijk_gegeneraliseerd', { datetime: CBS_EDITION_INSTANT }),
      'CBS wijken',
    ),
    fetchOgcCollection(
      ogcItems(PDOK_REGIONS, 'buurt_gegeneraliseerd', { datetime: CBS_EDITION_INSTANT }),
      'CBS buurten',
    ),
    fetchOgcCollection(
      ogcItems(PDOK_REGIONS, 'buurt_labelpoint', { datetime: CBS_EDITION_INSTANT }),
      'CBS buurt label points',
    ),
    fetchOgcCollection(ogcItems(PDOK_BAG, 'woonplaats'), 'BAG woonplaatsen'),
    fetchRegionalStatistics(),
  ])

  const districtNames = mapBy(districts, (feature) => feature.properties.statcode)
  const neighborhoodCenters = mapBy(
    neighborhoodLabels,
    (feature) => feature.properties.statcode,
  )
  const neighborhoodsByMunicipality = groupBy(neighborhoods, (feature) => feature.properties.gm_code)
  const activePlaces = places.filter((feature) => feature.properties.status === 'Woonplaats aangewezen')
  const placesByMunicipality = groupBy(activePlaces, (feature) =>
    municipalityCode(feature.properties.bronhouder_identificatie),
  )

  await mkdir(regionDirectory, { recursive: true })
  const index = {}
  for (const municipality of municipalities.features) {
    const code = municipality.properties.code
    const localNeighborhoods = neighborhoodsByMunicipality.get(code) ?? []
    const localPlaces = placesByMunicipality.get(code) ?? []
    const neighborhoodFeatures = localNeighborhoods.map((feature) => {
      const neighborhoodCode = feature.properties.statcode
      const districtCode = `WK${neighborhoodCode.slice(2, 8)}`
      return {
        type: 'Feature',
        id: neighborhoodCode,
        geometry: feature.geometry,
        properties: {
          id: neighborhoodCode,
          name: feature.properties.statnaam,
          kind: 'buurt',
          municipalityCode: code,
          districtCode,
          districtName: districtNames.get(districtCode)?.properties.statnaam ?? null,
          center:
            neighborhoodCenters.get(neighborhoodCode)?.geometry.coordinates ??
            geometryCenter(feature.geometry),
          statistics: compactStatistics(statistics.get(neighborhoodCode)),
        },
      }
    })
    const placeFeatures = localPlaces.map((feature) => ({
      type: 'Feature',
      id: feature.properties.identificatie,
      geometry: feature.geometry,
      properties: {
        id: feature.properties.identificatie,
        name: feature.properties.woonplaats,
        kind: 'woonplaats',
        municipalityCode: code,
        province: feature.properties.provincie_naam,
        status: feature.properties.status,
        center: geometryCenter(feature.geometry),
      },
    }))
    const bundle = {
      municipalityCode: code,
      municipalityName: municipality.properties.name,
      edition: 2025,
      source: {
        neighborhoods: `${PDOK_REGIONS}/collections/buurt_gegeneraliseerd`,
        places: `${PDOK_BAG}/collections/woonplaats`,
        statistics: `https://opendata.cbs.nl/ODataApi/OData/${CBS_TABLE}`,
        license: 'CC BY 4.0 (CBS); Public Domain Mark 1.0 (BAG/PDOK)',
        retrievedAt: new Date().toISOString(),
      },
      neighborhoods: { type: 'FeatureCollection', features: neighborhoodFeatures },
      places: { type: 'FeatureCollection', features: placeFeatures },
    }
    await writeFile(resolve(regionDirectory, `${code}.json`), `${JSON.stringify(bundle)}\n`)
    index[code] = {
      neighborhoods: neighborhoodFeatures.length,
      places: placeFeatures.length,
    }
  }
  await writeFile(
    resolve(regionDirectory, 'index.json'),
    `${JSON.stringify({ edition: 2025, municipalities: index })}\n`,
  )
  console.log(`Regional bundles: ${Object.keys(index).length} municipalities`)
}

async function writeSafetyRegions(municipalities) {
  const [regions, labels] = await Promise.all([
    fetchOgcCollection(
      ogcItems(PDOK_REGIONS, 'veiligheidsregio_gegeneraliseerd', {
        datetime: CBS_EDITION_INSTANT,
      }),
      'CBS safety regions',
    ),
    fetchOgcCollection(
      ogcItems(PDOK_REGIONS, 'veiligheidsregio_labelpoint', {
        datetime: CBS_EDITION_INSTANT,
      }),
      'CBS safety-region labels',
    ),
  ])
  const labelByCode = mapBy(labels, (feature) => feature.properties.statcode)
  const membership = new Map(regions.map((feature) => [feature.properties.statcode, []]))

  for (const municipality of municipalities.features) {
    const point = municipality.properties.center ?? geometryCenter(municipality.geometry)
    const matches = regions.filter((region) => pointInGeometry(point, region.geometry))
    if (matches.length !== 1) {
      throw new Error(
        `${municipality.properties.code} matched ${matches.length} safety regions`,
      )
    }
    membership.get(matches[0].properties.statcode).push(municipality.properties.code)
  }

  const source = {
    dataset: 'CBS Gebiedsindelingen 2025',
    collection: `${PDOK_REGIONS}/collections/veiligheidsregio_gegeneraliseerd`,
    labels: `${PDOK_REGIONS}/collections/veiligheidsregio_labelpoint`,
    license: 'CC BY 4.0',
    edition: 2025,
    retrievedAt: new Date().toISOString(),
  }
  const features = regions
    .map((feature) => {
      const code = feature.properties.statcode
      return {
        type: 'Feature',
        id: code,
        geometry: feature.geometry,
        properties: {
          code,
          name: feature.properties.statnaam,
          center:
            labelByCode.get(code)?.geometry.coordinates ?? geometryCenter(feature.geometry),
          municipalityCodes: membership.get(code).sort(),
          edition: 2025,
          source: 'CBS/PDOK',
        },
      }
    })
    .sort((left, right) => left.properties.code.localeCompare(right.properties.code))

  await writeFile(
    resolve(publicData, 'safety-regions.geojson'),
    `${JSON.stringify({ type: 'FeatureCollection', source, features })}\n`,
  )
  console.log(`Safety regions: ${features.length} regions covering ${municipalities.features.length} municipalities`)
}

function nwbFilters() {
  const equals = (field, value) =>
    `<fes:PropertyIsEqualTo><fes:ValueReference>${field}</fes:ValueReference><fes:Literal>${value}</fes:Literal></fes:PropertyIsEqualTo>`
  return [
    ['FRC 0', equals('frc', '0')],
    ['FRC 1', equals('frc', '1')],
    ['FRC 2', equals('frc', '2')],
    ['A routes', equals('routeltr', 'A')],
    ['N routes', equals('routeltr', 'N')],
    // Independently audited short boundary continuations can have no route
    // fields and a lower functional class even though they close a selected
    // signed corridor. Keep the exact source section instead of guessing or
    // broadening the national model to every local road.
    ['Audited boundary connectors', equals('wvkId', '311342002')],
  ].map(([label, expression]) => ({
    label,
    filter: `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0">${expression}</fes:Filter>`,
  }))
}

async function fetchNwbRoads() {
  // The WFS advertises a larger `count`, but enforces a 1,000-feature page.
  // Explicit 1,000-feature paging prevents a short first response being mistaken
  // for the complete network.
  const pageSize = 1000
  const featuresById = new Map()
  for (const subset of nwbFilters()) {
    let subsetCount = 0
    for (let startIndex = 0; ; startIndex += pageSize) {
      const url = new URL(NWB_WFS)
      const parameters = {
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        typeNames: 'nwbwegen:wegvakken',
        outputFormat: 'application/json',
        srsName: 'EPSG:4326',
        count: String(pageSize),
        startIndex: String(startIndex),
        sortBy: 'objectid',
        propertyName:
          'wvkId,jteIdBeg,jteIdEnd,wegnummer,wegnrHmp,wegnrAw,bstCode,admrichtng,routeltr,routenr,frc,gmeId,gmeNaam,sttNaam,stLengthshape,geom',
        FILTER: subset.filter,
      }
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
      const data = await getJson(url, `NWB ${subset.label}`)
      subsetCount += data.features.length
      for (const feature of data.features) featuresById.set(feature.properties.wvkId, feature)
      process.stdout.write(
        `\rNWB ${subset.label}: ${subsetCount.toLocaleString('en')} · ${featuresById.size.toLocaleString('en')} unique major sections`,
      )
      if (data.features.length < pageSize) break
    }
  }
  process.stdout.write('\n')
  const features = [...featuresById.values()]
  return features.map((feature) => {
    const properties = feature.properties
    const route = properties.routeltr && properties.routenr
      ? `${properties.routeltr}${properties.routenr}`
      : properties.wegnummer || properties.sttNaam || 'Road'
    return {
      type: 'Feature',
      id: `NWB-${properties.wvkId}`,
      geometry: feature.geometry,
      properties: {
        id: `NWB-${properties.wvkId}`,
        route,
        name: properties.sttNaam || route,
        municipalityCode: municipalityCode(properties.gmeId),
        municipalityName: properties.gmeNaam,
        fromNode: String(properties.jteIdBeg),
        toNode: String(properties.jteIdEnd),
        // `routeltr`/`routenr` may be an international co-designation (E30),
        // while `wegnummer` identifies the physical Dutch corridor (027). Keep
        // both so co-designations cannot become independent model capacity.
        roadNumber: properties.wegnummer == null ? null : String(properties.wegnummer),
        signedRoadNumber: properties.wegnrHmp == null ? null : String(properties.wegnrHmp),
        administrativeRoadNumber: properties.wegnrAw == null ? null : String(properties.wegnrAw),
        roadPartClass: properties.bstCode == null ? null : String(properties.bstCode),
        administrativeDirection: properties.admrichtng == null ? null : String(properties.admrichtng),
        functionalClass: Number(properties.frc),
        lengthM: Math.round(properties.stLengthshape ?? 0),
        source: 'NWB',
      },
    }
  })
}

async function fetchNwbLight() {
  const response = await fetch(NWB_LIGHT)
  if (!response.ok) throw new Error(`NWB-Light returned ${response.status}`)
  const data = await shp(await response.arrayBuffer())
  const collection = Array.isArray(data) ? data[0] : data
  console.log(`NWB-Light: ${collection.features.length} generalized national routes`)
  return collection.features.map((feature, index) => {
    const route = feature.properties.ROUTE_CH || feature.properties.ROUTE || 'Road'
    return {
      type: 'Feature',
      id: `NWB-LIGHT-${index}`,
      geometry: feature.geometry,
      properties: {
        id: `NWB-LIGHT-${index}`,
        route,
        name: route,
        manager: feature.properties.BEHEERDER ?? null,
        sourceSegments: feature.properties.COUNT ?? null,
        functionalClass: route.startsWith('A') ? 0 : route.startsWith('N') ? 1 : 2,
        source: 'NWB-Light',
      },
    }
  })
}

function lineCoordinates(feature) {
  if (feature.geometry.type === 'LineString') return feature.geometry.coordinates
  return feature.geometry.coordinates.reduce(
    (longest, line) => (line.length > longest.length ? line : longest),
    [],
  )
}

function routeMode(features, routeName) {
  // NWB functional classes describe individual sections and may classify a
  // short municipal-boundary connector below the route it belongs to. Preserve
  // the nationally signed road class for A/N routes used by the logical graph.
  if (/^A\d+/i.test(routeName)) return 'trunk'
  if (/^N\d+/i.test(routeName)) return 'regional'
  const bestClass = Math.min(...features.map((feature) => feature.properties.functionalClass))
  return bestClass <= 0 ? 'trunk' : bestClass <= 2 ? 'regional' : 'local'
}

function routeNumber(value) {
  const match = String(value).toUpperCase().match(/^(?:[AN])?0*([0-9]+)$/)
  return match?.[1] ?? null
}

function normalizedRoadNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const match = String(value).match(/[0-9]+/)
  return match ? String(Number(match[0])) : null
}

function candidateRoadNumber(candidate) {
  const numbers = new Set(
    candidate.entries
      .map((entry) => normalizedRoadNumber(entry.feature.properties.roadNumber))
      .filter(Boolean),
  )
  return numbers.size === 1 ? [...numbers][0] : null
}

function candidateSignedRoadNumber(candidate) {
  const signedNumbers = new Set(
    candidate.entries
      .map((entry) => String(entry.feature.properties.signedRoadNumber ?? '').toUpperCase())
      .filter((value) => /^[AN][0-9]+$/.test(value)),
  )
  return signedNumbers.size === 1 ? [...signedNumbers][0] : null
}

function buildRoadConnections(roads, municipalityByCode) {
  const entriesByNode = new Map()
  for (const feature of roads) {
    for (const node of [feature.properties.fromNode, feature.properties.toNode]) {
      if (!entriesByNode.has(node)) entriesByNode.set(node, [])
      entriesByNode.get(node).push({ feature, node })
    }
  }
  const candidates = new Map()
  for (const entries of entriesByNode.values()) {
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const from = entries[left].feature.properties.municipalityCode
        const to = entries[right].feature.properties.municipalityCode
        if (!from || !to || from === to || !municipalityByCode.has(from) || !municipalityByCode.has(to)) continue
        const leftRoadNumber = normalizedRoadNumber(entries[left].feature.properties.roadNumber)
        const rightRoadNumber = normalizedRoadNumber(entries[right].feature.properties.roadNumber)
        // A shared NWB junction is not sufficient evidence that two differently
        // numbered roads form one municipality-border continuation. Without
        // this guard an interchange can copy N506 sections into an N307 edge
        // (and vice versa), creating duplicate provenance and false parallel
        // scenario capacity. Numeric/signed aliases with the same primary
        // wegnummer remain eligible for the normalization below.
        if (leftRoadNumber && rightRoadNumber && leftRoadNumber !== rightRoadNumber) continue
        const routeNames = [entries[left].feature.properties.route, entries[right].feature.properties.route]
        const signedRouteNames = [...new Set(routeNames.filter((name) => /^[AN][0-9]+$/i.test(name)))]
        const routeName = signedRouteNames.length === 1 ? signedRouteNames[0] : routeNames[0]
        const pair = [from, to].sort()
        const score = Math.min(
          entries[left].feature.properties.functionalClass,
          entries[right].feature.properties.functionalClass,
        )
        const proposed = {
          from: pair[0],
          to: pair[1],
          routeName,
          entries: [entries[left], entries[right]],
          score,
          sourceFeatureIds: [entries[left].feature.id, entries[right].feature.id],
          sourceSignedRoadNumbers: [
            entries[left].feature.properties.signedRoadNumber,
            entries[right].feature.properties.signedRoadNumber,
          ].filter(Boolean),
          sourceAdministrativeRoadNumbers: [
            entries[left].feature.properties.administrativeRoadNumber,
            entries[right].feature.properties.administrativeRoadNumber,
          ].filter(Boolean),
          sourceRoadPartClasses: [
            entries[left].feature.properties.roadPartClass,
            entries[right].feature.properties.roadPartClass,
          ].filter(Boolean),
        }
        const physicalRoadNumber = candidateRoadNumber(proposed)
        // Split a route designation at the physical Dutch road identity before
        // deduplication. E30 can otherwise blend A27 and A28 interchange
        // crossings into one artificial municipal edge.
        const key = `${pair.join('--')}--${routeName}--${physicalRoadNumber ?? 'unknown'}`
        const current = candidates.get(key)
        if (!current) candidates.set(key, proposed)
        else {
          const preferred = current.score <= score ? current : proposed
          candidates.set(key, {
            ...preferred,
            sourceFeatureIds: [...new Set([...current.sourceFeatureIds, ...proposed.sourceFeatureIds])].sort(),
            sourceSignedRoadNumbers: [...new Set([...current.sourceSignedRoadNumbers, ...proposed.sourceSignedRoadNumbers])].sort(),
            sourceAdministrativeRoadNumbers: [...new Set([...current.sourceAdministrativeRoadNumbers, ...proposed.sourceAdministrativeRoadNumbers])].sort(),
            sourceRoadPartClasses: [...new Set([...current.sourceRoadPartClasses, ...proposed.sourceRoadPartClasses])].sort(),
          })
        }
      }
    }
  }

  // Some NWB sections expose only `wegnummer` (for example `059`) while an
  // adjoining section exposes the signed `A59`. Resolve a numeric-only alias
  // only when the same municipality pair has exactly one matching A/N route,
  // then deduplicate the logical crossing. This avoids double capacity without
  // guessing between an A-road and N-road that share a number.
  const explicitRoutesByPair = new Map()
  const explicitRoutesByNumber = new Map()
  for (const candidate of candidates.values()) {
    if (!/^[AN][0-9]+$/i.test(candidate.routeName)) continue
    const pair = [candidate.from, candidate.to].sort().join('--')
    if (!explicitRoutesByPair.has(pair)) explicitRoutesByPair.set(pair, new Set())
    const explicitRoute = candidate.routeName.toUpperCase()
    explicitRoutesByPair.get(pair).add(explicitRoute)
    const number = routeNumber(explicitRoute)
    if (!explicitRoutesByNumber.has(number)) explicitRoutesByNumber.set(number, new Set())
    explicitRoutesByNumber.get(number).add(explicitRoute)
  }
  const normalizedCandidates = new Map()
  const signedRoutesByPhysicalCorridor = new Map()
  for (const candidate of candidates.values()) {
    if (!/^[AN][0-9]+$/i.test(candidate.routeName)) continue
    const roadNumber = candidateRoadNumber(candidate)
    if (!roadNumber || routeNumber(candidate.routeName) !== roadNumber) continue
    const pair = [candidate.from, candidate.to].sort().join('--')
    const key = `${pair}--${roadNumber}`
    if (!signedRoutesByPhysicalCorridor.has(key)) signedRoutesByPhysicalCorridor.set(key, new Set())
    signedRoutesByPhysicalCorridor.get(key).add(candidate.routeName.toUpperCase())
  }
  for (const candidate of candidates.values()) {
    const pair = [candidate.from, candidate.to].sort().join('--')
    let routeName = candidate.routeName
    if (/^[0-9]+$/.test(routeName)) {
      // The Eindhoven audit verified these two exact boundary-ramp records
      // against current NWB attributes. Scope the disambiguation to that
      // evidence: other numeric ramp/parallel-road cases still need their own
      // topology review and must not be globally guessed from wegnrHmp alone.
      const signedRoadNumber =
        candidate.sourceFeatureIds.includes('NWB-325158020') &&
        candidate.sourceFeatureIds.includes('NWB-326158032')
          ? candidateSignedRoadNumber(candidate)
          : null
      const aliases = [...(explicitRoutesByPair.get(pair) ?? [])].filter(
        (explicitRoute) => routeNumber(explicitRoute) === routeNumber(routeName),
      )
      const nationalAliases = [...(explicitRoutesByNumber.get(routeNumber(routeName)) ?? [])]
      // A signed route can be absent on a tiny municipality-boundary section.
      // Use the national identity only when that number maps unambiguously to
      // one A/N route; otherwise retain the source value rather than guessing.
      if (signedRoadNumber && aliases.includes(signedRoadNumber)) routeName = signedRoadNumber
      else if (aliases.length === 1) routeName = aliases[0]
      else if (nationalAliases.length === 1) routeName = nationalAliases[0]
    }
    const roadNumber = candidateRoadNumber(candidate)
    const physicalKey = roadNumber ? `${pair}--${roadNumber}` : null
    const localPhysicalAliases = physicalKey
      ? [...(signedRoutesByPhysicalCorridor.get(physicalKey) ?? [])]
      : []
    const nationalPhysicalAliases = roadNumber
      ? [...(explicitRoutesByNumber.get(roadNumber) ?? [])]
      : []
    const physicalAliases = localPhysicalAliases.length === 1
      ? localPhysicalAliases
      : nationalPhysicalAliases.length === 1
        ? nationalPhysicalAliases
        : []
    // Collapse an international or numeric co-designation only when the NWB
    // physical road number maps to exactly one A/N route for this municipality
    // pair. Ambiguous source records remain separate rather than being guessed.
    if (physicalAliases.length === 1) routeName = physicalAliases[0]
    const key = `${pair}--${routeName}`
    const aliases = routeName === candidate.routeName ? [] : [candidate.routeName]
    const corridorIdentityStatus = physicalAliases.length === 1 ? 'resolved' : 'ambiguous'
    const physicalCorridorId = roadNumber
      ? `NWB-road-${roadNumber}${corridorIdentityStatus === 'resolved' ? '' : `--${routeName}`}`
      : null
    const normalized = {
      ...candidate,
      routeName,
      roadNumber,
      aliases,
      physicalCorridorId,
      corridorIdentityStatus,
    }
    const current = normalizedCandidates.get(key)
    if (!current) normalizedCandidates.set(key, normalized)
    else {
      const preferred = current.score <= normalized.score ? current : normalized
      normalizedCandidates.set(key, {
        ...preferred,
        aliases: [...new Set([...current.aliases, ...normalized.aliases])].sort(),
        sourceFeatureIds: [
          ...new Set([...current.sourceFeatureIds, ...normalized.sourceFeatureIds]),
        ].sort(),
        sourceSignedRoadNumbers: [
          ...new Set([...current.sourceSignedRoadNumbers, ...normalized.sourceSignedRoadNumbers]),
        ].sort(),
        sourceAdministrativeRoadNumbers: [
          ...new Set([
            ...current.sourceAdministrativeRoadNumbers,
            ...normalized.sourceAdministrativeRoadNumbers,
          ]),
        ].sort(),
        sourceRoadPartClasses: [
          ...new Set([...current.sourceRoadPartClasses, ...normalized.sourceRoadPartClasses]),
        ].sort(),
      })
    }
  }

  // The same primary NWB section may occur in consecutive series edges at
  // different municipal junctions, but it must not support distinct parallel
  // physical corridors for the same municipality pair. Fail the refresh
  // instead of publishing additive capacity from ambiguous provenance.
  const corridorByPairAndSourceFeature = new Map()
  for (const candidate of normalizedCandidates.values()) {
    const pair = [candidate.from, candidate.to].sort().join('--')
    const corridor = candidate.physicalCorridorId ?? `route:${candidate.routeName}`
    for (const sourceFeatureId of candidate.sourceFeatureIds) {
      const key = `${pair}--${sourceFeatureId}`
      const existing = corridorByPairAndSourceFeature.get(key)
      if (existing && existing !== corridor) {
        throw new Error(
          `NWB source section ${sourceFeatureId} is assigned to parallel corridors ${existing} and ${corridor} for ${pair}`,
        )
      }
      corridorByPairAndSourceFeature.set(key, corridor)
    }
  }

  return [...normalizedCandidates.values()].map((candidate, index) => {
    const fromEntry =
      candidate.entries.find(
        (entry) => entry.feature.properties.municipalityCode === candidate.from,
      ) ?? candidate.entries[0]
    const toEntry = candidate.entries.find((entry) => entry !== fromEntry) ?? candidate.entries[1]
    const first = lineCoordinates(fromEntry.feature)
    const second = lineCoordinates(toEntry.feature)
    const firstTowardNode = fromEntry.node === fromEntry.feature.properties.fromNode
      ? [...first].reverse()
      : first
    const secondAwayFromNode = toEntry.node === toEntry.feature.properties.toNode
      ? [...second].reverse()
      : second
    const coordinates = [...firstTowardNode, ...secondAwayFromNode]
    const sourceFeatures = candidate.entries.map((entry) => entry.feature)
    const mode = routeMode(sourceFeatures, candidate.routeName)
    const lengthM = sourceFeatures.reduce((sum, feature) => sum + feature.properties.lengthM, 0)
    return {
      id: `nwb-link-${index}-${candidate.from}-${candidate.to}`,
      name: candidate.routeName,
      ...(candidate.aliases.length ? { aliases: candidate.aliases } : {}),
      source: 'NWB',
      sourceFeatureIds: candidate.sourceFeatureIds,
      ...(candidate.sourceSignedRoadNumbers.length
        ? { sourceSignedRoadNumbers: [...new Set(candidate.sourceSignedRoadNumbers)].sort() }
        : {}),
      ...(candidate.sourceAdministrativeRoadNumbers.length
        ? {
            sourceAdministrativeRoadNumbers: [
              ...new Set(candidate.sourceAdministrativeRoadNumbers),
            ].sort(),
          }
        : {}),
      ...(candidate.sourceRoadPartClasses.length
        ? { sourceRoadPartClasses: [...new Set(candidate.sourceRoadPartClasses)].sort() }
        : {}),
      ...(candidate.physicalCorridorId
        ? {
            physicalCorridorId: candidate.physicalCorridorId,
            corridorIdentityStatus: candidate.corridorIdentityStatus,
          }
        : {}),
      from: candidate.from,
      to: candidate.to,
      coordinates,
      nominalCapacity: mode === 'trunk' ? 260 : mode === 'regional' ? 150 : 80,
      capacitySemantics: 'scenario-units',
      supportedServices: ['mobility', 'supply'],
      mode,
      distanceKm: Math.max(0.1, lengthM / 1000),
    }
  })
}

async function writeTransport(municipalities) {
  const [roads, visualRoads, railAxes, stations] = await Promise.all([
    fetchNwbRoads(),
    fetchNwbLight(),
    fetchOgcCollection(ogcItems(PDOK_RAIL, 'trace'), 'ProRail traces'),
    fetchOgcCollection(ogcItems(PDOK_RAIL, 'station'), 'ProRail stations'),
  ])
  const municipalityByCode = mapBy(municipalities.features, (feature) => feature.properties.code)
  const roadConnections = buildRoadConnections(roads, municipalityByCode)
  const sources = {
    roads: `${NWB_WFS}?service=WFS&version=2.0.0&request=GetCapabilities`,
    roadGeometry: NWB_LIGHT,
    rail: `${PDOK_RAIL}/collections/trace`,
    stations: `${PDOK_RAIL}/collections/station`,
    license: 'CC0 1.0',
    topologySemantics:
      'NWB junction topology is used only for mobility and explicitly assumed road logistics/supply; it is never power, gas, water, drainage, telecom or facility topology. A/N routes and international/numeric co-designations sharing one unambiguous wegnummer are one physical corridor, not additive capacity. A source section may support consecutive series edges at a municipal junction; those edge ceilings are not parallel capacity and must never be summed as independent corridors.',
    retrievedAt: new Date().toISOString(),
  }
  const normalizedRail = railAxes.map((feature) => ({
    type: 'Feature',
    id: `PRORAIL-${feature.properties.objectid}`,
    geometry: feature.geometry,
    properties: {
      id: `PRORAIL-${feature.properties.objectid}`,
      name: feature.properties.naam ?? feature.properties.kmlint_omschrijving_begin ?? 'Rail',
      status: feature.properties.levenscyclus_status,
      source: 'ProRail',
    },
  }))
  const normalizedStations = stations
    .filter((feature) => {
      const [longitude, latitude] = feature.geometry.coordinates
      return longitude >= 3.1 && longitude <= 7.3 && latitude >= 50.7 && latitude <= 53.7
    })
    .map((feature) => ({
      type: 'Feature',
      id: `STATION-${feature.properties.objectid}`,
      geometry: feature.geometry,
      properties: {
        id: `STATION-${feature.properties.objectid}`,
        name: feature.properties.naam,
        code: feature.properties.afkorting,
        manager: feature.properties.beheerder,
        source: 'ProRail',
      },
    }))
  await Promise.all([
    writeFile(
      resolve(publicData, 'transport-roads.geojson'),
      `${JSON.stringify({ type: 'FeatureCollection', source: sources, features: visualRoads })}\n`,
    ),
    writeFile(
      resolve(publicData, 'transport-rail.geojson'),
      `${JSON.stringify({ type: 'FeatureCollection', source: sources, features: normalizedRail })}\n`,
    ),
    writeFile(
      resolve(publicData, 'transport-stations.geojson'),
      `${JSON.stringify({ type: 'FeatureCollection', source: sources, features: normalizedStations })}\n`,
    ),
    writeFile(
      resolve(publicData, 'transport-network.json'),
      `${JSON.stringify({ source: sources, routes: roadConnections })}\n`,
    ),
  ])
  console.log(
    `Transport: ${roads.length.toLocaleString('en')} topological road sections, ${visualRoads.length} national road routes, ${normalizedRail.length.toLocaleString('en')} rail traces, ${normalizedStations.length} stations, ${roadConnections.length} municipal road connections`,
  )
}

await mkdir(publicData, { recursive: true })
const municipalities = JSON.parse(
  await readFile(resolve(publicData, 'netherlands-municipalities.geojson'), 'utf8'),
)
const transportOnly = process.argv.includes('--transport-only')
const regionsOnly = process.argv.includes('--regions-only')
const contextOnly = process.argv.includes('--context-only')
await Promise.all([
  ...(transportOnly || contextOnly ? [] : [writeRegions(municipalities)]),
  ...(transportOnly ? [] : [writeSafetyRegions(municipalities)]),
  ...(regionsOnly || contextOnly ? [] : [writeTransport(municipalities)]),
])
console.log('Realism datasets complete.')
