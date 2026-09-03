import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dataDirectory = resolve(root, 'apps/web/public/data')
const code = process.argv.slice(2).find((argument) => /^GM[0-9]{4}$/i.test(argument))?.toUpperCase()
if (!/^GM[0-9]{4}$/.test(code ?? '')) {
  console.error('Usage: pnpm audit:context -- GMxxxx')
  process.exit(1)
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const [collection, bundle, settlements, safetyRegions, transport, stations, transitStops] = await Promise.all([
  readJson(resolve(dataDirectory, 'netherlands-municipalities.geojson')),
  readJson(resolve(dataDirectory, `regions/${code}.json`)),
  readJson(resolve(dataDirectory, `settlements/${code}.geojson`)),
  readJson(resolve(dataDirectory, 'safety-regions.geojson')),
  readJson(resolve(dataDirectory, 'transport-network.json')),
  readJson(resolve(dataDirectory, 'transport-stations.geojson')),
  readJson(resolve(dataDirectory, 'transit/transit-stops.geojson')),
])

const municipality = collection.features.find((feature) => feature.properties.code === code)
if (!municipality) throw new Error(`Unknown municipality ${code}`)

const pointOnSegment = (point, start, end) => {
  const length = (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2
  if (length <= 1e-18) {
    return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2 <= 1e-18
  }
  const cross = (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1])
  if (Math.abs(cross) > 1e-9) return false
  const dot = (point[0] - start[0]) * (end[0] - start[0]) +
    (point[1] - start[1]) * (end[1] - start[1])
  return dot >= 0 && dot <= length
}
const pointInRing = (point, ring) => {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous]
    const end = ring[index]
    if (pointOnSegment(point, start, end)) return true
    if (
      (start[1] > point[1]) !== (end[1] > point[1]) &&
      point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0]
    ) inside = !inside
  }
  return inside
}
const pointInPolygon = (point, polygon) =>
  pointInRing(point, polygon[0]) && polygon.slice(1).every((hole) => !pointInRing(point, hole))
const containsPoint = (point) => municipality.geometry.type === 'Polygon'
  ? pointInPolygon(point, municipality.geometry.coordinates)
  : municipality.geometry.coordinates.some((polygon) => pointInPolygon(point, polygon))

const neighborhoodStatistics = bundle.neighborhoods.features.map((feature) => feature.properties.statistics)
const statisticNames = [...new Set(neighborhoodStatistics.flatMap((statistics) => Object.keys(statistics)))].sort()
const completeness = Object.fromEntries(statisticNames.map((statistic) => {
  const available = neighborhoodStatistics.filter((statistics) => Number.isFinite(statistics[statistic])).length
  return [statistic, {
    available,
    missing: neighborhoodStatistics.length - available,
    coverage: neighborhoodStatistics.length ? Number((available / neighborhoodStatistics.length).toFixed(4)) : 0,
  }]
}))
const sum = (field) => neighborhoodStatistics.reduce(
  (total, statistics) => total + (Number.isFinite(statistics[field]) ? statistics[field] : 0),
  0,
)
const neighborhoodPopulation = sum('population')
const populationDifference = neighborhoodPopulation - municipality.properties.population
const relevantRoutes = transport.routes.filter((route) => route.from === code || route.to === code)
const neighborCodes = [...new Set(relevantRoutes.map((route) => route.from === code ? route.to : route.from))]
const municipalityNames = new Map(collection.features.map((feature) => [feature.properties.code, feature.properties.name]))
const safetyRegion = safetyRegions.features.find((feature) => feature.properties.municipalityCodes.includes(code))
const localStations = stations.features.filter((feature) => containsPoint(feature.geometry.coordinates))
const localTransitStops = transitStops.features.filter((feature) => containsPoint(feature.geometry.coordinates))
const places = bundle.places.features.map((feature) => feature.properties)
const bagPlaceCentersOutsideBoundary = bundle.places.features
  .filter((feature) => feature.properties.center && !containsPoint(feature.properties.center))
  .map((feature) => ({
    id: feature.id,
    name: feature.properties.name,
    center: feature.properties.center,
  }))
const provinces = [...new Set(places.map((place) => place.province).filter(Boolean))]
const settlementTypes = Object.groupBy(settlements.features, (feature) => feature.properties.settlementType)

const report = {
  generatedAt: new Date().toISOString(),
  municipality: municipality.properties,
  identityChecks: {
    featureIdMatchesCode: municipality.id === code,
    bundleCodeMatches: bundle.municipalityCode === code,
    bundleNameMatches: bundle.municipalityName === municipality.properties.name,
    centerInsideBoundary: containsPoint(municipality.properties.center),
    province: provinces.length === 1 ? provinces[0] : provinces,
    safetyRegion: safetyRegion?.properties.name ?? null,
  },
  officialSources: {
    municipality: collection.source,
    regional: bundle.source,
    safetyRegion: safetyRegions.source,
    transport: transport.source,
  },
  regionalData: {
    neighborhoods: bundle.neighborhoods.features.length,
    districts: new Set(bundle.neighborhoods.features.map((feature) => feature.properties.districtCode)).size,
    places: places.length,
    placeNames: places.map((place) => place.name).sort((left, right) => left.localeCompare(right, 'nl')),
    bagPlaceCentersOutsideGeneralizedBoundary: bagPlaceCentersOutsideBoundary,
    statisticFields: statisticNames.length,
    completeness,
    reconciliation: {
      officialMunicipalityPopulation: municipality.properties.population,
      summedPublishedNeighborhoodPopulation: neighborhoodPopulation,
      difference: populationDifference,
      differencePct: municipality.properties.population
        ? Number(((populationDifference / municipality.properties.population) * 100).toFixed(3))
        : null,
      summedHouseholds: sum('households'),
      summedAge65Plus: sum('age65Plus'),
    },
    largestNeighborhoods: bundle.neighborhoods.features
      .map((feature) => ({
        id: feature.properties.id,
        name: feature.properties.name,
        district: feature.properties.districtName,
        population: feature.properties.statistics.population,
      }))
      .sort((left, right) => (right.population ?? -1) - (left.population ?? -1))
      .slice(0, 10),
  },
  settlements: {
    count: settlements.features.length,
    byType: Object.fromEntries(Object.entries(settlementTypes).map(([type, features]) => [type, features.length])),
    sampleNames: settlements.features.map((feature) => feature.properties.name).sort((left, right) => left.localeCompare(right, 'nl')).slice(0, 30),
  },
  transport: {
    logicalRouteDegree: relevantRoutes.length,
    neighbors: neighborCodes.map((neighborCode) => ({ code: neighborCode, name: municipalityNames.get(neighborCode) })),
    routes: relevantRoutes.map((route) => ({
      id: route.id,
      name: route.name,
      source: route.source,
      from: route.from,
      to: route.to,
      mode: route.mode,
      distanceKm: route.distanceKm,
      nominalCapacity: route.nominalCapacity,
      ...(route.physicalCorridorId ? { physicalCorridorId: route.physicalCorridorId } : {}),
      ...(route.sourceFeatureIds ? { sourceFeatureIds: route.sourceFeatureIds } : {}),
      ...(route.auditProvenance ? { auditProvenance: route.auditProvenance } : {}),
    })),
    proRailStationsInsideBoundary: localStations.map((feature) => feature.properties.name),
    transitStopAreasInsideBoundary: localTransitStops.length,
    transitStopSample: localTransitStops.map((feature) => feature.properties.name).slice(0, 30),
  },
  reviewFlags: [
    ...(relevantRoutes.length === 0 ? ['No logical transport edge is attached to the municipality.'] : []),
    ...(localTransitStops.length === 0 ? ['No GTFS stop area falls inside the generalized municipality boundary.'] : []),
    ...(Math.abs(populationDifference) > municipality.properties.population * 0.05
      ? ['Published neighbourhood population sum differs from municipality total by more than 5%; inspect missing/suppressed CBS rows and edition semantics.']
      : []),
    ...(provinces.length !== 1 ? ['BAG woonplaatsen do not resolve to exactly one province.'] : []),
    ...(bagPlaceCentersOutsideBoundary.length > 0
      ? [`${bagPlaceCentersOutsideBoundary.length} BAG woonplaats label point(s) fall outside the independently versioned CBS generalized municipality boundary; review as a geometry-edition/generalization caveat, especially for coastal and island areas.`]
      : []),
  ],
}

console.log(JSON.stringify(report, null, 2))
