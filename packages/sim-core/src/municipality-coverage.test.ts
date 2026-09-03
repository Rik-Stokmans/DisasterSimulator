import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bundleToLocalRegions, type MunicipalityRegionBundle } from '../../../apps/web/src/data'
import {
  collectionToMunicipalities,
  scenarioPresetIds,
  simulateCityDetail,
  simulateFrame,
  type Coordinates,
  type MunicipalityCollection,
  type MunicipalityDefinition,
  type RouteDefinition,
  type ServiceId,
} from './index'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const dataDirectory = resolve(root, 'apps/web/public/data')
const collection = JSON.parse(
  readFileSync(resolve(dataDirectory, 'netherlands-municipalities.geojson'), 'utf8'),
) as MunicipalityCollection
const municipalities = collectionToMunicipalities(collection)
const municipalityByCode = new Map(municipalities.map((municipality) => [municipality.code, municipality]))
const transport = JSON.parse(
  readFileSync(resolve(dataDirectory, 'transport-network.json'), 'utf8'),
) as { routes: RouteDefinition[] }
const safetyRegions = JSON.parse(
  readFileSync(resolve(dataDirectory, 'safety-regions.geojson'), 'utf8'),
) as {
  features: Array<{ properties: { name: string; municipalityCodes: string[] } }>
}
const requestedCode = process.env.MUNICIPALITY_AUDIT_CODE
const selectedMunicipalities = requestedCode === 'ALL'
  ? municipalities
  : requestedCode
    ? [municipalityByCode.get(requestedCode)].filter(
        (municipality): municipality is MunicipalityDefinition => Boolean(municipality),
      )
    : []

const checkpointHours = [0, 6, 12, 24, 48, 72] as const
const numericHazardKeys = [
  'rainMmH',
  'floodDepthM',
  'windGustMs',
  'heatC',
  'snowCmH',
  'iceSeverity',
  'coldStress',
  'droughtSeverity',
  'wildfireIntensity',
  'smokeSeverity',
  'groundMotionG',
  'cyberDisruption',
  'climateTemperatureDeltaC',
  'climatePrecipitationMultiplier',
  'climateSeaLevelDeltaM',
] as const
const serviceIds: ServiceId[] = [
  'power',
  'water',
  'drainage',
  'gas',
  'telecom',
  'mobility',
  'facilities',
  'supply',
]
const allowedStatuses = new Set(['operational', 'strained', 'degraded', 'critical', 'failed', 'recovering'])
const expectedStatisticFields = [
  'population', 'men', 'women', 'age0To14', 'age15To24', 'age25To44', 'age45To64', 'age65Plus',
  'households', 'onePersonHouseholds', 'householdsWithoutChildren', 'householdsWithChildren',
  'averageHouseholdSize', 'populationDensity', 'homes', 'nonResidentialBuildings',
  'averageHomeValueThousands', 'singleFamilyHomePct', 'multiFamilyHomePct', 'ownerOccupiedPct',
  'rentalPct', 'socialRentalPct', 'districtHeatingPct', 'publicChargingPoints',
  'socialAssistanceRecipients', 'disabilityBenefitRecipients', 'oldAgePensionRecipients',
  'businesses', 'cars', 'carsPerHousehold', 'distanceToDoctorKm', 'distanceToSupermarketKm',
  'landAreaHa', 'waterAreaHa', 'urbanityClass', 'addressDensity',
] as const

function pointOnSegment(point: Coordinates, start: Coordinates, end: Coordinates) {
  const squaredLength = (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2
  if (squaredLength <= 1e-18) {
    return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2 <= 1e-18
  }
  const cross = (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1])
  if (Math.abs(cross) > 1e-9) return false
  const dot = (point[0] - start[0]) * (end[0] - start[0]) +
    (point[1] - start[1]) * (end[1] - start[1])
  if (dot < 0) return false
  return dot <= squaredLength
}

function pointInRing(point: Coordinates, ring: Coordinates[]) {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous]
    const end = ring[index]
    if (pointOnSegment(point, start, end)) return true
    const crosses = (start[1] > point[1]) !== (end[1] > point[1]) &&
      point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0]
    if (crosses) inside = !inside
  }
  return inside
}

function pointInPolygon(point: Coordinates, coordinates: Coordinates[][]) {
  return pointInRing(point, coordinates[0]) &&
    coordinates.slice(1).every((hole) => !pointInRing(point, hole))
}

function pointInMunicipality(
  point: Coordinates,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
) {
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates as Coordinates[][])
  return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon as Coordinates[][]))
}

function finiteInRange(
  failures: string[],
  value: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    failures.push(`${label}: expected finite ${minimum}..${maximum}, received ${value}`)
  }
}

function closeTo(failures: string[], actual: number, expected: number, label: string, epsilon = 1e-8) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon) {
    failures.push(`${label}: ${actual} does not reconcile to ${expected}`)
  }
}

describe('municipality audit coverage harness', () => {
  it('uses the complete coherent 2025 municipality collection', () => {
    expect(collection.features).toHaveLength(342)
    expect(new Set(collection.features.map((feature) => feature.properties.code))).toHaveLength(342)
    expect(collection.features.every((feature) => feature.properties.boundaryEdition === 2025)).toBe(true)
    expect(collection.features.every((feature) => feature.properties.statisticsEdition === 2025)).toBe(true)
  })

  it.skipIf(!requestedCode)(
    'validates the requested municipality across all presets, services, and 72-hour checkpoints',
    () => {
      if (requestedCode !== 'ALL' && selectedMunicipalities.length !== 1) {
        throw new Error(`Unknown MUNICIPALITY_AUDIT_CODE=${requestedCode}`)
      }
      const failures: string[] = []
      const selectedCodes = new Set(selectedMunicipalities.map((municipality) => municipality.code))

      for (const city of selectedMunicipalities) {
        const feature = collection.features.find((candidate) => candidate.properties.code === city.code)
        if (!feature) {
          failures.push(`${city.code}: municipality feature is missing`)
          continue
        }
        if (feature.id !== city.code) failures.push(`${city.code}: feature id does not equal code`)
        if (!pointInMunicipality(city.coordinates, feature.geometry)) {
          failures.push(`${city.code}: official label point lies outside its municipality geometry`)
        }
        finiteInRange(failures, city.population, 1, 2_000_000, `${city.code} population`)
        finiteInRange(failures, city.density, 0, 30_000, `${city.code} density`)
        if (city.age65Pct !== null) finiteInRange(failures, city.age65Pct, 0, 100, `${city.code} age65Pct`)
        if (city.onePersonHouseholds !== null) {
          finiteInRange(failures, city.onePersonHouseholds, 0, city.population, `${city.code} one-person households`)
        }
        const safetyMatches = safetyRegions.features.filter((region) =>
          region.properties.municipalityCodes.includes(city.code),
        )
        if (safetyMatches.length !== 1) failures.push(`${city.code}: belongs to ${safetyMatches.length} safety regions`)
      }

      for (const preset of scenarioPresetIds) {
        const previousPersonHours = new Map(selectedMunicipalities.map((city) => [city.code, -1]))
        for (const checkpointHour of checkpointHours) {
          const frame = simulateFrame(
            municipalities,
            checkpointHour * 4,
            { selectedLayer: 'overview', scenario: preset },
            transport.routes,
          )
          for (const city of selectedMunicipalities) {
            const snapshot = frame.municipalities.find((candidate) => candidate.id === city.code)
            if (!snapshot) {
              failures.push(`${city.code}/${preset}/T+${checkpointHour}: snapshot missing`)
              continue
            }
            finiteInRange(failures, snapshot.hazard.severity, 0, 1, `${city.code}/${preset}/T+${checkpointHour} hazard severity`)
            finiteInRange(failures, snapshot.hazard.peakSeverity, 0, 1, `${city.code}/${preset}/T+${checkpointHour} peak severity`)
            for (const metric of numericHazardKeys) {
              const value = snapshot.hazard[metric]
              if (!Number.isFinite(value)) failures.push(`${city.code}/${preset}/T+${checkpointHour}/${metric}: non-finite`)
            }
            if (
              city.code === 'GM1680' &&
              (preset === 'coastal-flood' || preset === 'river-flood') &&
              snapshot.hazard.floodDepthM !== 0
            ) {
              failures.push(`${city.code}/${preset}/T+${checkpointHour}: unsupported direct large-water inundation`)
            }
            if (
              city.code === 'GM0141' &&
              preset === 'river-flood' &&
              snapshot.hazard.floodDepthM !== 0
            ) {
              failures.push(`${city.code}/${preset}/T+${checkpointHour}: unsupported direct Rhine/Meuse/IJssel inundation`)
            }
            if (
              city.code === 'GM1723' &&
              preset === 'river-flood' &&
              snapshot.hazard.floodDepthM !== 0
            ) {
              failures.push(`${city.code}/${preset}/T+${checkpointHour}: unsupported direct Rhine/Meuse/IJssel inundation`)
            }
            if (
              city.code === 'GM0362' &&
              preset === 'river-flood' &&
              snapshot.hazard.floodDepthM !== 0
            ) {
              failures.push(`${city.code}/${preset}/T+${checkpointHour}: unsupported direct Rhine/Meuse/IJssel inundation`)
            }
            if (
              city.code === 'GM0796' &&
              preset === 'coastal-flood' &&
              snapshot.hazard.floodDepthM !== 0
            ) {
              failures.push(`${city.code}/${preset}/T+${checkpointHour}: unsupported direct coastal inundation`)
            }
            if (
              city.code === 'GM0796' &&
              preset === 'river-flood' &&
              checkpointHour === 72 &&
              snapshot.hazard.floodDepthM <= 0
            ) {
              failures.push(`${city.code}/${preset}/T+72: high-water forcing ended inside the 72-hour window`)
            }
            if (
              city.code === 'GM0484' &&
              preset === 'river-flood' &&
              checkpointHour >= 48 &&
              snapshot.status === 'recovering'
            ) {
              failures.push(`${city.code}/${preset}/T+${checkpointHour}: persistent flood disruption mislabeled as recovery`)
            }
            const hazardLedger = snapshot.hazard.explanation.contributions.reduce(
              (sum, contribution) => sum + contribution.effect,
              0,
            )
            closeTo(failures, hazardLedger, snapshot.hazard.severity, `${city.code}/${preset}/T+${checkpointHour} hazard ledger`)
            finiteInRange(failures, snapshot.systemPressure, 0, 1, `${city.code}/${preset}/T+${checkpointHour} system pressure`)
            finiteInRange(failures, snapshot.affectedPopulation, 0, snapshot.population, `${city.code}/${preset}/T+${checkpointHour} modeled population under pressure`)
            if (!Number.isInteger(snapshot.affectedPopulation)) failures.push(`${city.code}/${preset}/T+${checkpointHour}: modeled population under pressure is not integral`)
            const previous = previousPersonHours.get(city.code) ?? -1
            finiteInRange(failures, snapshot.deprivedPersonHours, Math.max(0, previous), Number.MAX_SAFE_INTEGER, `${city.code}/${preset}/T+${checkpointHour} deprived person-hours`)
            previousPersonHours.set(city.code, snapshot.deprivedPersonHours)
            if (!allowedStatuses.has(snapshot.status)) failures.push(`${city.code}/${preset}/T+${checkpointHour}: invalid municipality status ${snapshot.status}`)
            const pressureLedger = snapshot.explanation.contributions
              .filter((contribution) => contribution.target === 'system-pressure')
              .reduce((sum, contribution) => sum + contribution.effect, 0)
            closeTo(failures, pressureLedger, snapshot.systemPressure, `${city.code}/${preset}/T+${checkpointHour} pressure ledger`)

            for (const service of serviceIds) {
              const state = snapshot.services[service]
              finiteInRange(failures, state.availability, 0, 1, `${city.code}/${preset}/T+${checkpointHour}/${service} availability`)
              finiteInRange(failures, state.demand, 0, Number.MAX_SAFE_INTEGER, `${city.code}/${preset}/T+${checkpointHour}/${service} demand`)
              finiteInRange(failures, state.delivered, 0, state.demand + 1e-8, `${city.code}/${preset}/T+${checkpointHour}/${service} delivery`)
              finiteInRange(failures, state.reserveHours, 0, Number.MAX_SAFE_INTEGER, `${city.code}/${preset}/T+${checkpointHour}/${service} reserve`)
              const availabilityLedger = state.explanation.contributions
                .filter((contribution) => contribution.target === 'service-availability')
                .reduce((sum, contribution) => sum + contribution.effect, 1)
              closeTo(failures, availabilityLedger, state.availability, `${city.code}/${preset}/T+${checkpointHour}/${service} ledger`)
              for (const counterfactual of state.explanation.counterfactuals) {
                closeTo(
                  failures,
                  counterfactual.counterfactualValue - counterfactual.observedValue,
                  counterfactual.delta,
                  `${city.code}/${preset}/T+${checkpointHour}/${service}/${counterfactual.id}`,
                )
              }
            }
          }

          for (const service of serviceIds) {
            for (const route of frame.routesByService[service]) {
              if (!selectedCodes.has(route.from) && !selectedCodes.has(route.to)) continue
              if (route.transferSemantics !== 'logical-proxy') failures.push(`${route.id}/${service}: physical semantics leaked`)
              finiteInRange(failures, route.utilization, 0, 1, `${route.id}/${service} utilization`)
              finiteInRange(failures, route.flow, 0, route.effectiveCapacity + 1e-8, `${route.id}/${service} flow`)
            }
          }

          if (checkpointHour === 24) {
            const repeated = simulateFrame(
              municipalities,
              checkpointHour * 4,
              { selectedLayer: 'overview', scenario: preset },
              transport.routes,
            )
            for (const city of selectedMunicipalities) {
              const first = frame.municipalities.find((candidate) => candidate.id === city.code)
              const second = repeated.municipalities.find((candidate) => candidate.id === city.code)
              if (JSON.stringify(first) !== JSON.stringify(second)) {
                failures.push(`${city.code}/${preset}/T+24: simulation is not deterministic`)
              }
            }
          }
        }
      }

      const detailFrame = simulateFrame(
        municipalities,
        96,
        { selectedLayer: 'overview', scenario: 'compound' },
        transport.routes,
      )
      for (const city of selectedMunicipalities) {
        const bundle = JSON.parse(
          readFileSync(resolve(dataDirectory, `regions/${city.code}.json`), 'utf8'),
        ) as Omit<MunicipalityRegionBundle, 'settlements'>
        const settlements = JSON.parse(
          readFileSync(resolve(dataDirectory, `settlements/${city.code}.geojson`), 'utf8'),
        ) as MunicipalityRegionBundle['settlements']
        if (bundle.municipalityCode !== city.code || bundle.municipalityName !== city.name) {
          failures.push(`${city.code}: regional bundle identity mismatch`)
        }
        if (bundle.edition !== 2025) failures.push(`${city.code}: regional bundle edition is ${bundle.edition}`)
        const municipalityFeature = collection.features.find((feature) => feature.properties.code === city.code)
        const placeProvinces = new Set<string>()
        for (const neighborhood of bundle.neighborhoods.features) {
          if (neighborhood.properties.municipalityCode !== city.code) failures.push(`${city.code}: foreign neighborhood ${neighborhood.id}`)
          // CBS also assigns alphanumeric statcodes (notably in Amsterdam), so the
          // official BU/WK widths are invariant but a digits-only suffix is not.
          if (!/^BU[0-9A-Z]{8}$/.test(String(neighborhood.id))) failures.push(`${city.code}: malformed neighborhood id ${neighborhood.id}`)
          if (!/^WK[0-9A-Z]{6}$/.test(neighborhood.properties.districtCode)) failures.push(`${city.code}: malformed district id ${neighborhood.properties.districtCode}`)
          if (!neighborhood.properties.name.trim()) failures.push(`${city.code}: unnamed neighborhood ${neighborhood.id}`)
          if (
            municipalityFeature && neighborhood.properties.center &&
            !pointInMunicipality(neighborhood.properties.center, municipalityFeature.geometry)
          ) failures.push(`${city.code}: neighborhood label point ${neighborhood.id} lies outside municipality geometry`)
          const statistics = neighborhood.properties.statistics
          const keys = Object.keys(statistics).sort()
          if (keys.length !== expectedStatisticFields.length || expectedStatisticFields.some((field) => !keys.includes(field))) {
            failures.push(`${city.code}/${neighborhood.id}: regional statistics do not expose all 36 fields`)
          }
          for (const [field, value] of Object.entries(statistics)) {
            if (value !== null && (!Number.isFinite(value) || value < 0)) {
              failures.push(`${city.code}/${neighborhood.id}/${field}: invalid value ${value}`)
            }
            if (field.endsWith('Pct') && value !== null && value > 100) {
              failures.push(`${city.code}/${neighborhood.id}/${field}: percentage exceeds 100 (${value})`)
            }
          }
          const comparePublishedParts = (parts: Array<number | null>, total: number | null, label: string) => {
            if (total === null || parts.some((part) => part === null)) return
            const difference = Math.abs(parts.reduce<number>((sum, part) => sum + (part ?? 0), 0) - total)
            if (difference > Math.max(20, total * 0.03)) failures.push(`${city.code}/${neighborhood.id}: ${label} differs from total by ${difference}`)
          }
          comparePublishedParts([statistics.men, statistics.women], statistics.population, 'sex counts')
          comparePublishedParts(
            [statistics.age0To14, statistics.age15To24, statistics.age25To44, statistics.age45To64, statistics.age65Plus],
            statistics.population,
            'age counts',
          )
          comparePublishedParts(
            [statistics.onePersonHouseholds, statistics.householdsWithoutChildren, statistics.householdsWithChildren],
            statistics.households,
            'household types',
          )
          // CBS percentage pairs can omit unknown, unclassified, or suppressed
          // dwellings. Validate each published percentage, but do not invent a
          // requirement that the visible pair must sum to exactly 100.
        }
        for (const place of bundle.places.features) {
          if (place.properties.municipalityCode !== city.code) failures.push(`${city.code}: foreign BAG place ${place.id}`)
          if (place.properties.status !== 'Woonplaats aangewezen') failures.push(`${city.code}: inactive BAG place ${place.id}`)
          if (place.properties.province) placeProvinces.add(place.properties.province)
          // BAG woonplaats label points and CBS generalized boundaries use
          // independently versioned/generalized geometries. Boundary mismatches
          // are retained as audit review signals, not treated as corrupt data.
        }
        if (placeProvinces.size !== 1) failures.push(`${city.code}: BAG places resolve to ${placeProvinces.size} provinces`)
        if (bundle.neighborhoods.features.length === 0) failures.push(`${city.code}: no official neighborhoods`)
        if (bundle.places.features.length === 0) failures.push(`${city.code}: no active BAG places`)
        for (const route of transport.routes) {
          if ((route.from === city.code || route.to === city.code) && !municipalityByCode.has(route.from === city.code ? route.to : route.from)) {
            failures.push(`${city.code}: logical route ${route.id} points to an unknown municipality`)
          }
        }
        for (const settlement of settlements.features) {
          if (settlement.properties.municipalityCode !== city.code) failures.push(`${city.code}: foreign settlement ${settlement.id}`)
          if (!['woonkern', 'deelkern', 'gehucht', 'buurtschap'].includes(settlement.properties.settlementType)) {
            failures.push(`${city.code}: invalid settlement type on ${settlement.id}`)
          }
        }
        const localRegions = bundleToLocalRegions({ ...bundle, settlements })
        if (localRegions.length !== bundle.neighborhoods.features.length) failures.push(`${city.code}: local-region conversion lost neighborhoods`)
        if (localRegions.some((region) => region.isHub)) failures.push(`${city.code}: CBS demographics were misrepresented as a physical hub`)
        if (localRegions.some((region) => region.priority !== 2)) failures.push(`${city.code}: CBS demographics were misrepresented as operational priority`)
        for (const service of serviceIds) {
          const detail = simulateCityDetail(city, detailFrame, service, localRegions)
          const snapshot = detailFrame.municipalities.find((candidate) => candidate.id === city.code)
          if (!snapshot) continue
          if (detail.districts.length !== localRegions.length) failures.push(`${city.code}/${service}: detail district count mismatch`)
          const population = detail.districts.reduce((sum, district) => sum + district.population, 0)
          const affected = detail.districts.reduce((sum, district) => sum + district.affectedPopulation, 0)
          const demand = detail.districts.reduce((sum, district) => sum + district.demand, 0)
          const delivered = detail.districts.reduce((sum, district) => sum + district.delivered, 0)
          closeTo(failures, population, snapshot.population, `${city.code}/${service} local population`, 0)
          closeTo(failures, affected, snapshot.affectedPopulation, `${city.code}/${service} local affected population`, 0)
          closeTo(failures, demand, snapshot.services[service].demand, `${city.code}/${service} local demand`, 1e-6)
          closeTo(failures, delivered, detail.inboundSupply, `${city.code}/${service} local delivery`, 1e-6)
          finiteInRange(failures, detail.reconciliationError, 0, 1e-6, `${city.code}/${service} reconciliation error`)
          for (const district of detail.districts) {
            finiteInRange(failures, district.explanation.contextCoverage, 0, 1, `${city.code}/${service}/${district.id} context coverage`)
            if (district.sourceType !== 'official') failures.push(`${city.code}/${service}/${district.id}: fallback district used despite official bundle`)
          }
        }
      }

      expect(failures, failures.join('\n')).toEqual([])
    },
    120_000,
  )
})
