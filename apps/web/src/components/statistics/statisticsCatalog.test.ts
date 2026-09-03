import { describe, expect, it } from 'vitest'
import type { SimulationFrame } from '@disaster/sim-core'
import type { RegionalStatistics } from '../../data'
import {
  REGIONAL_STATISTIC_GROUPS,
  REGIONAL_STATISTICS,
  SIMULATION_METRICS,
  buildSimulationTimeline,
  compileSimulationHistory,
  formatStatisticValue,
  splitFiniteRuns,
  summarizeRegionalDistribution,
} from './statisticsCatalog'

const statistics = (population: number | null): RegionalStatistics => ({
  population,
  men: 10,
  women: 11,
  age0To14: 1,
  age15To24: 2,
  age25To44: 3,
  age45To64: 4,
  age65Plus: 5,
  households: 8,
  onePersonHouseholds: 3,
  householdsWithoutChildren: 2,
  householdsWithChildren: 3,
  averageHouseholdSize: 2.1,
  populationDensity: 1_200,
  homes: 9,
  nonResidentialBuildings: 4,
  averageHomeValueThousands: 385,
  singleFamilyHomePct: 60,
  multiFamilyHomePct: 40,
  ownerOccupiedPct: 55,
  rentalPct: 45,
  socialRentalPct: 18,
  districtHeatingPct: null,
  publicChargingPoints: null,
  socialAssistanceRecipients: 1,
  disabilityBenefitRecipients: 2,
  oldAgePensionRecipients: 4,
  businesses: 7,
  cars: 8,
  carsPerHousehold: 1.1,
  distanceToDoctorKm: 1.3,
  distanceToSupermarketKm: 0.8,
  landAreaHa: 44,
  waterAreaHa: 2,
  urbanityClass: 3,
  addressDensity: 1_050,
})

function frame(hour: number, affectedPopulation: number): SimulationFrame {
  return {
    step: Math.round(hour * 4),
    hour,
    minute: hour * 60,
    scenario: { season: 'summer' },
    national: {
      population: 100,
      affectedPopulation,
      averageAvailability: 1 - affectedPopulation / 100,
      criticalMunicipalities: 0,
      activeBottlenecks: 0,
      deprivedPersonHours: affectedPopulation * hour,
    },
    municipalities: [
      {
        id: 'GM0001',
        population: 100,
        affectedPopulation,
        systemPressure: affectedPopulation / 100,
        deprivedPersonHours: affectedPopulation * hour,
        hazard: {
          severity: affectedPopulation / 100,
          peakSeverity: affectedPopulation / 100,
          rainMmH: affectedPopulation,
          floodDepthM: 0,
          windGustMs: 0,
          heatC: 30,
          snowCmH: 0,
          iceSeverity: 0,
          coldStress: 0,
          droughtSeverity: 0,
          wildfireIntensity: 0,
          smokeSeverity: 0,
          groundMotionG: 0,
          cyberDisruption: 0,
          climateTemperatureDeltaC: 0,
          climatePrecipitationMultiplier: 1,
          climateSeaLevelDeltaM: 0,
        },
        services: Object.fromEntries(
          ['power', 'water', 'drainage', 'gas', 'telecom', 'mobility', 'facilities', 'supply'].map(
            (service) => [service, { availability: 1, demand: 10, delivered: 10, reserveHours: 24 }],
          ),
        ),
      },
    ],
  } as unknown as SimulationFrame
}

describe('regional statistics catalogue', () => {
  it('covers every one of the 36 generated CBS fields exactly once', () => {
    const expectedKeys = Object.keys(statistics(1)).sort()
    const cataloguedKeys = REGIONAL_STATISTICS.map((metric) => metric.key).sort()

    expect(cataloguedKeys).toEqual(expectedKeys)
    expect(new Set(cataloguedKeys)).toHaveLength(36)
    expect(REGIONAL_STATISTIC_GROUPS.reduce((sum, group) => sum + group.metrics.length, 0)).toBe(36)
  })

  it('summarizes an actual peer distribution and preserves missing observations', () => {
    const metric = REGIONAL_STATISTICS.find((candidate) => candidate.key === 'population')!
    const selected = statistics(20)
    const peers = [statistics(10), selected, statistics(null), statistics(30), statistics(40)]
    const summary = summarizeRegionalDistribution(metric, selected, peers, statistics(40), 4)

    expect(summary.observedCount).toBe(4)
    expect(summary.missingCount).toBe(1)
    expect(summary.minimum).toBe(10)
    expect(summary.median).toBe(25)
    expect(summary.maximum).toBe(40)
    expect(summary.selectedPercentile).toBe(37.5)
    expect(summary.comparisonPercentile).toBe(87.5)
    expect(summary.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(4)
  })

  it('formats units and nulls without inventing values', () => {
    expect(formatStatisticValue(null, { format: 'count', unit: 'people' })).toBe('No observation')
    expect(formatStatisticValue(0.763, { format: 'ratio', unit: '%', decimals: 0 })).toBe('76%')
    expect(formatStatisticValue(385, { format: 'currency-thousands', unit: '€ × 1,000' })).toBe('€385k')
    expect(formatStatisticValue(1, { format: 'urbanity', unit: 'class 1–5' })).toBe('Very strongly urban')
  })
})

describe('simulation statistics catalogue', () => {
  it('has stable unique identifiers for all 60 numeric and derived metrics', () => {
    expect(SIMULATION_METRICS).toHaveLength(60)
    expect(new Set(SIMULATION_METRICS.map((metric) => metric.id))).toHaveLength(60)
  })

  it('makes current post-network pressure and cumulative pre-network burden incomparable by design', () => {
    const affected = SIMULATION_METRICS.find(
      (metric) => metric.id === 'municipality.affectedPopulation',
    )!
    const burden = SIMULATION_METRICS.find(
      (metric) => metric.id === 'municipality.deprivedPersonHours',
    )!
    expect(affected.description).toContain('Current post-network')
    expect(affected.description).toContain('logical transfer stage')
    expect(burden.label).toContain('Local pre-network')
    expect(burden.description).toContain('zero here can coexist with a nonzero current post-network pressure count')
  })

  it('sorts supplied engine frames and extracts both national and municipal values', () => {
    const timeline = buildSimulationTimeline([frame(72, 40), frame(0, 0), frame(24, 20)], 'GM0001')

    expect(timeline['national.affectedPopulation'].map((point) => point.hour)).toEqual([0, 24, 72])
    expect(timeline['municipality.affectedShare'].map((point) => point.value)).toEqual([0, 0.2, 0.4])
    expect(timeline['service.power.reserveHours'].map((point) => point.value)).toEqual([24, 24, 24])
  })

  it('keeps missing timeline values as separate finite runs', () => {
    const runs = splitFiniteRuns([
      { step: 0, hour: 0, value: 1 },
      { step: 1, hour: 0.25, value: 0.9 },
      { step: 2, hour: 0.5, value: null },
      { step: 3, hour: 0.75, value: 0.7 },
    ])

    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.length)).toEqual([2, 1])
  })

  it('reads the compact history contract without constructing map frames', () => {
    const frames = [frame(0, 0), frame(1, 25)]
    const compiled = compileSimulationHistory({
      scenario: frames[0].scenario,
      startStep: 0,
      endStep: 4,
      intervalSteps: 4,
      networkMode: 'isolated',
      points: frames.map(({ step, minute, hour, municipalities, national }) => ({
        step,
        minute,
        hour,
        municipalities,
        national,
      })),
    } as unknown as import('@disaster/sim-core').SimulationHistory, 'GM0001')

    expect(compiled.frameCount).toBe(2)
    expect(compiled.intervalMinutes).toBe(60)
    expect(compiled.timeline['municipality.affectedShare'].map((point) => point.value)).toEqual([0, 0.25])
  })
})
