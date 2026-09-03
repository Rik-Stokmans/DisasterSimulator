import { describe, expect, it } from 'vitest'
import {
  createScenarioConfig,
  hazardDimensionIds,
  historyCoverage,
  municipalityChartSeries,
  nationalChartSeries,
  scenarioPresets,
  simulateCityDetail,
  simulateFrame,
  simulateFrames,
  simulateHistory,
  type LocalRegionDefinition,
  type MunicipalityDefinition,
  type RouteDefinition,
  type ServiceId,
} from './index'

const municipalities: MunicipalityDefinition[] = [
  {
    code: 'GM0772',
    name: 'Eindhoven',
    coordinates: [5.4697, 51.4416],
    population: 249_000,
    density: 2_900,
    age65Pct: 17,
    onePersonHouseholds: 54_000,
    boundaryEdition: 2025,
    statisticsEdition: 2025,
    areaScale: 1,
    seed: 772,
  },
  {
    code: 'GM0855',
    name: 'Tilburg',
    coordinates: [5.0913, 51.5555],
    population: 229_000,
    density: 1_900,
    age65Pct: 18,
    onePersonHouseholds: 46_000,
    boundaryEdition: 2025,
    statisticsEdition: 2025,
    areaScale: 1,
    seed: 855,
  },
]

const network: RouteDefinition[] = [
  {
    id: 'A58-test',
    from: 'GM0772',
    to: 'GM0855',
    coordinates: [municipalities[0].coordinates, municipalities[1].coordinates],
    nominalCapacity: 600,
    mode: 'trunk',
    distanceKm: 34,
  },
]

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

describe('deterministic causal explanations', () => {
  it('publishes a complete additive causal ledger for every municipality and service', () => {
    const frame = simulateFrame(
      municipalities,
      64,
      { selectedLayer: 'overview', scenario: 'compound' },
      network,
    )
    expect(
      Object.values(frame.routesByService).flat().every(
        (route) => route.transferSemantics === 'logical-proxy',
      ),
    ).toBe(true)

    for (const municipality of frame.municipalities) {
      const hazardExplanation = municipality.hazard.explanation
      expect(hazardExplanation.contributions).toHaveLength(hazardDimensionIds.length + 1)
      expect(
        hazardExplanation.contributions.reduce((sum, item) => sum + item.effect, 0),
      ).toBeCloseTo(municipality.hazard.severity, 12)
      expect(hazardExplanation.counterfactuals.map((item) => item.id)).toEqual([
        'hazard:no-event',
        'hazard:reference-climate',
        'hazard:maximum-preparedness',
      ])

      for (const service of serviceIds) {
        const state = municipality.services[service]
        const availabilityLedger = state.explanation.contributions.filter(
          (contribution) => contribution.target === 'service-availability',
        )
        expect(1 + availabilityLedger.reduce((sum, item) => sum + item.effect, 0)).toBeCloseTo(
          state.availability,
          12,
        )
        expect(state.explanation.observedAvailability).toBe(state.availability)
        expect(state.explanation.counterfactuals.some((item) => item.id.endsWith('isolated-network'))).toBe(true)
        expect(state.explanation.dependencyChain.nodes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: `service:${service}` }),
          ]),
        )
        for (const counterfactual of state.explanation.counterfactuals) {
          expect(counterfactual.delta).toBeCloseTo(
            counterfactual.counterfactualValue - counterfactual.observedValue,
            12,
          )
        }
      }

      const pressureLedger = municipality.explanation.contributions.filter(
        (contribution) => contribution.target === 'system-pressure',
      )
      expect(pressureLedger.reduce((sum, item) => sum + item.effect, 0)).toBeCloseTo(
        municipality.systemPressure,
        12,
      )
      expect(municipality.explanation.counterfactuals).toHaveLength(serviceIds.length + 1)
    }
  })

  it('reports exact hazard reruns and the complete power-to-water dependency path', () => {
    const scenario = createScenarioConfig('severe-storm', {
      intensity: 0.95,
      backupMultiplier: 0.25,
    })
    const observed = simulateFrame(municipalities, 64, { selectedLayer: 'water', scenario }, network)
      .municipalities[0]
    const noEvent = simulateFrame(
      municipalities,
      64,
      { selectedLayer: 'water', scenario: createScenarioConfig('severe-storm', { ...scenario, intensity: 0 }) },
      network,
    ).municipalities[0]
    const counterfactual = observed.hazard.explanation.counterfactuals.find(
      (item) => item.id === 'hazard:no-event',
    )!
    expect(counterfactual.counterfactualValue).toBeCloseTo(noEvent.hazard.severity, 12)
    expect(counterfactual.delta).toBeCloseTo(
      counterfactual.counterfactualValue - counterfactual.observedValue,
      12,
    )
    const chain = observed.services.water.explanation.dependencyChain
    expect(chain.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'service:power',
          to: 'service:water',
          mechanism: 'operational-dependency',
        }),
      ]),
    )
    expect(chain.nodes.some((node) => node.id.startsWith('hazard:'))).toBe(true)
  })

  it('is byte-for-byte deterministic, including contribution order and metadata', () => {
    const scenario = createScenarioConfig('cyberattack', {
      startClockHour: 17,
      dayType: 'weekend',
      demandMultiplier: 1.2,
      backupMultiplier: 1.4,
    })
    const first = simulateFrame(municipalities, 100, { selectedLayer: 'telecom', scenario }, network)
    const second = simulateFrame(municipalities, 100, { selectedLayer: 'telecom', scenario }, network)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})

describe('operations-context controls', () => {
  it('normalizes all optional controls to documented safe bounds', () => {
    const scenario = createScenarioConfig('heatwave', {
      startClockHour: 99,
      demandMultiplier: 99,
      backupMultiplier: -2,
      networkCapacityMultiplier: -1,
      repairCapacityMultiplier: 99,
      householdPreparedness: -4,
    })
    expect(scenario.dayType).toBe('weekday')
    expect(scenario.startClockHour).toBe(23)
    expect(scenario.demandMultiplier).toBe(2.5)
    expect(scenario.backupMultiplier).toBe(0.25)
    expect(scenario.networkCapacityMultiplier).toBe(0)
    expect(scenario.repairCapacityMultiplier).toBe(3)
    expect(scenario.householdPreparedness).toBe(0)
  })

  it('applies clock, day type and demand controls without changing physical forcing', () => {
    const weekday = createScenarioConfig('cyberattack', {
      dayType: 'weekday',
      startClockHour: 0,
      demandMultiplier: 1,
    })
    const holidayEvening = createScenarioConfig('cyberattack', {
      dayType: 'holiday',
      startClockHour: 18,
      demandMultiplier: 1.4,
    })
    const first = simulateFrame(municipalities, 24, { selectedLayer: 'supply', scenario: weekday }, [])
      .municipalities[0]
    const second = simulateFrame(
      municipalities,
      24,
      { selectedLayer: 'supply', scenario: holidayEvening },
      [],
    ).municipalities[0]
    expect(second.hazard.cyberDisruption).toBe(first.hazard.cyberDisruption)
    expect(second.services.supply.demand).not.toBe(first.services.supply.demand)
    expect(second.services.supply.explanation.drivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'scenario.startClockHour', value: 18 }),
        expect.objectContaining({ id: 'scenario.dayType', value: 'holiday' }),
        expect.objectContaining({ id: 'scenario.demandMultiplier', value: 1.4 }),
      ]),
    )
  })

  it('keeps household preparedness out of infrastructure fragility', () => {
    const low = createScenarioConfig('compound', { householdPreparedness: 0 })
    const high = createScenarioConfig('compound', { householdPreparedness: 1 })
    const lowState = simulateFrame(municipalities, 80, { selectedLayer: 'supply', scenario: low }, [])
      .municipalities[0]
    const highState = simulateFrame(municipalities, 80, { selectedLayer: 'supply', scenario: high }, [])
      .municipalities[0]
    expect(highState.hazard).toEqual(expect.objectContaining({ severity: lowState.hazard.severity }))
    expect(highState.services.power.availability).toBe(lowState.services.power.availability)
    expect(highState.services.water.availability).toBe(lowState.services.water.availability)
    expect(highState.services.supply.demand).toBeLessThan(lowState.services.supply.demand)
    expect(highState.affectedPopulation).toBeLessThanOrEqual(lowState.affectedPopulation)
  })

  it('applies backup, repair and network-capacity controls to their own stages', () => {
    const shortBackup = createScenarioConfig('severe-storm', {
      backupMultiplier: 0.25,
      repairCapacityMultiplier: 0.25,
    })
    const longBackupFastRepair = createScenarioConfig('severe-storm', {
      backupMultiplier: 3,
      repairCapacityMultiplier: 3,
    })
    const earlyShort = simulateFrame(municipalities, 64, { selectedLayer: 'telecom', scenario: shortBackup }, [])
      .municipalities[0]
    const earlyLong = simulateFrame(
      municipalities,
      64,
      { selectedLayer: 'telecom', scenario: longBackupFastRepair },
      [],
    ).municipalities[0]
    expect(
      earlyLong.services.telecom.explanation.dependencies.find(
        (dependency) => dependency.upstreamService === 'power',
      )!.backupWindowHours,
    ).toBeGreaterThan(
      earlyShort.services.telecom.explanation.dependencies.find(
        (dependency) => dependency.upstreamService === 'power',
      )!.backupWindowHours!,
    )
    const lateShort = simulateFrame(municipalities, 220, { selectedLayer: 'power', scenario: shortBackup }, [])
      .municipalities[0]
    const lateFast = simulateFrame(
      municipalities,
      220,
      { selectedLayer: 'power', scenario: longBackupFastRepair },
      [],
    ).municipalities[0]
    expect(lateFast.services.power.availability).toBeGreaterThanOrEqual(
      lateShort.services.power.availability,
    )
    expect(lateFast.services.power.explanation.recoveryProgress).toBeGreaterThan(
      lateShort.services.power.explanation.recoveryProgress,
    )

    const disconnected = createScenarioConfig('earthquake', { networkCapacityMultiplier: 0 })
    const noCapacity = simulateFrame(
      municipalities,
      1,
      { selectedLayer: 'power', scenario: disconnected },
      network,
    )
    expect(noCapacity.routes.every((route) => route.effectiveCapacity === 0 && route.flow === 0)).toBe(true)
  })

  it('gates intervention effects behind response delay and a bounded dispatch ramp', () => {
    const scenario = createScenarioConfig('cyberattack', { responseDelayHours: 18 })
    const baselineBefore = simulateFrame(
      [municipalities[0]],
      48,
      { selectedLayer: 'telecom', scenario, intervention: 'baseline' },
      [],
    ).municipalities[0].services.telecom
    const interventionBefore = simulateFrame(
      [municipalities[0]],
      48,
      { selectedLayer: 'telecom', scenario, intervention: 'generator-priority' },
      [],
    ).municipalities[0].services.telecom
    expect(interventionBefore.availability).toBe(baselineBefore.availability)

    const baselineAfter = simulateFrame(
      [municipalities[0]],
      96,
      { selectedLayer: 'telecom', scenario, intervention: 'baseline' },
      [],
    ).municipalities[0].services.telecom
    const interventionAfter = simulateFrame(
      [municipalities[0]],
      96,
      { selectedLayer: 'telecom', scenario, intervention: 'generator-priority' },
      [],
    ).municipalities[0].services.telecom
    expect(interventionAfter.availability).toBeGreaterThan(baselineAfter.availability)
    const interventionContribution = interventionAfter.explanation.contributions.find(
      (contribution) => contribution.id === 'telecom:intervention',
    )!
    expect(interventionContribution.effect).toBeGreaterThan(0)
    expect(interventionContribution.description).toMatch(/scenario assumption/)
    expect(interventionAfter.explanation.drivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'intervention', value: 'generator-priority' }),
        expect.objectContaining({
          id: 'service.telecom.interventionDispatchStart',
          value: scenario.startHour + scenario.responseDelayHours + 1,
        }),
      ]),
    )
  })
})

describe('service-specific official-region context', () => {
  const polygon = (west: number): GeoJSON.Polygon => ({
    type: 'Polygon',
    coordinates: [[[west, 51.43], [west + 0.02, 51.43], [west + 0.02, 51.45], [west, 51.45], [west, 51.43]]],
  })
  const regions: LocalRegionDefinition[] = [
    {
      id: 'BU-VULNERABLE',
      municipalityId: 'GM0772',
      name: 'Higher aggregate need',
      geometry: polygon(5.42),
      population: 10_000,
      priority: 2,
      isHub: true,
      sourceType: 'official',
      context: {
        age65Share: 0.34,
        onePersonHouseholdShare: 0.62,
        multiFamilyHomeShare: 0.8,
        socialAssistanceShare: 0.13,
        carsPerHousehold: 0.35,
        populationDensityPerKm2: 4_800,
        distanceToDoctorKm: 3.8,
        distanceToSupermarketKm: 4.1,
        landAreaHa: 80,
        waterAreaHa: 20,
        businesses: 145,
        nonResidentialBuildings: 210,
      },
    },
    {
      id: 'BU-BASELINE',
      municipalityId: 'GM0772',
      name: 'Missing context',
      geometry: polygon(5.46),
      population: 10_000,
      priority: 2,
      sourceType: 'official',
    },
    {
      id: 'BU-ZERO',
      municipalityId: 'GM0772',
      name: 'Published zero population',
      geometry: polygon(5.5),
      population: 0,
      priority: 3,
      sourceType: 'official',
    },
    {
      id: 'BU-INDUSTRIAL',
      municipalityId: 'GM0772',
      name: 'Published zero residents with economic activity',
      geometry: polygon(5.54),
      population: 0,
      priority: 2,
      sourceType: 'official',
      context: {
        businesses: 80,
        nonResidentialBuildings: 104,
      },
    },
  ]

  it('weights demand by service and conserves municipal demand and delivery exactly', () => {
    const frame = simulateFrame([municipalities[0]], 72, { selectedLayer: 'supply', scenario: 'compound' }, [])
    const detail = simulateCityDetail(municipalities[0], frame, 'supply', regions)
    const vulnerable = detail.districts.find((district) => district.id === 'BU-VULNERABLE')!
    const baseline = detail.districts.find((district) => district.id === 'BU-BASELINE')!
    expect(vulnerable.demand).toBeGreaterThan(baseline.demand)
    expect(vulnerable.explanation.demandMultiplier).toBeGreaterThan(1)
    expect(vulnerable.explanation.contextCoverage).toBe(1)
    expect(baseline.explanation.demandMultiplier).toBe(1)
    expect(baseline.explanation.contextCoverage).toBe(0)
    const publishedZero = detail.districts.find((district) => district.id === 'BU-ZERO')!
    expect(publishedZero.population).toBe(0)
    expect(publishedZero.demand).toBe(0)
    expect(publishedZero.delivered).toBe(0)
    const noEventFrame = simulateFrame(
      [municipalities[0]],
      0,
      { selectedLayer: 'supply', scenario: createScenarioConfig('compound', { intensity: 0 }) },
      [],
    )
    const noEventZero = simulateCityDetail(
      municipalities[0],
      noEventFrame,
      'supply',
      regions,
    ).districts.find((district) => district.id === 'BU-ZERO')!
    expect(noEventZero.availability).toBeGreaterThan(0)
    expect(noEventZero.status).not.toBe('failed')
    expect(detail.localDemand).toBeCloseTo(frame.municipalities[0].services.supply.demand, 10)
    expect(
      detail.districts.reduce((sum, district) => sum + district.delivered, 0),
    ).toBeCloseTo(detail.inboundSupply, 10)
    expect(detail.reconciliationError).toBeLessThan(1e-8)
  })

  it('preserves non-residential service demand in official zero-resident areas', () => {
    const frame = simulateFrame(
      [municipalities[0]],
      72,
      { selectedLayer: 'overview', scenario: 'compound' },
      [],
    )

    for (const service of serviceIds) {
      const detail = simulateCityDetail(municipalities[0], frame, service, regions)
      const industrial = detail.districts.find((district) => district.id === 'BU-INDUSTRIAL')!
      expect(industrial.population, service).toBe(0)
      expect(industrial.demand, service).toBeGreaterThan(0)
      expect(industrial.explanation.activityDemandWeight, service).toBeGreaterThan(0)
      expect(detail.localDemand, service).toBeCloseTo(
        frame.municipalities[0].services[service].demand,
        10,
      )
      expect(detail.reconciliationError, service).toBeLessThan(1e-8)
    }
  })

  it('uses different context weights for power and emergency supply', () => {
    const frame = simulateFrame([municipalities[0]], 72, { selectedLayer: 'supply', scenario: 'compound' }, [])
    const supply = simulateCityDetail(municipalities[0], frame, 'supply', regions)
    const power = simulateCityDetail(municipalities[0], frame, 'power', regions)
    const supplyMultiplier = supply.districts.find((district) => district.id === 'BU-VULNERABLE')!
      .explanation.demandMultiplier
    const powerMultiplier = power.districts.find((district) => district.id === 'BU-VULNERABLE')!
      .explanation.demandMultiplier
    expect(supplyMultiplier).toBeGreaterThan(powerMultiplier)
  })

  it('keeps physical neighborhood hazard invariant when the service layer changes', () => {
    const frame = simulateFrame([municipalities[0]], 72, { selectedLayer: 'overview', scenario: 'compound' }, [])
    const power = simulateCityDetail(municipalities[0], frame, 'power', regions)
    const mobility = simulateCityDetail(municipalities[0], frame, 'mobility', regions)
    expect(power.districts.map((district) => [district.id, district.hazardSeverity])).toEqual(
      mobility.districts.map((district) => [district.id, district.hazardSeverity]),
    )
  })
})

describe('sampled chart history', () => {
  it('defaults to 73 hourly isolated samples and exposes every numeric metric', () => {
    const history = simulateHistory(
      municipalities,
      { selectedLayer: 'overview', scenario: 'compound' },
      { municipalityIds: ['GM0772'] },
    )
    expect(history.networkMode).toBe('isolated')
    expect(history.aggregateScope).toBe('selected-municipalities')
    expect(history.points).toHaveLength(73)
    expect(history.points[0].step).toBe(0)
    expect(history.points.at(-1)!.step).toBe(288)
    expect(history.points.every((point) => point.municipalities.length === 1)).toBe(true)
    const municipalSeries = municipalityChartSeries(history, 'GM0772')
    expect(municipalSeries).toHaveLength(
      historyCoverage.hazardMetrics +
        historyCoverage.services * historyCoverage.serviceMetricsPerService +
        4,
    )
    expect(municipalSeries.every((series) => series.points.length === 73)).toBe(true)
    expect(nationalChartSeries(history)).toHaveLength(6)
  })

  it('uses cached ascending history while matching independent frames exactly', () => {
    const steps = [288, 0, 64, 64]
    const batch = simulateFrames(municipalities, steps, { selectedLayer: 'water', scenario: 'compound' }, network)
    expect(batch.map((frame) => frame.step)).toEqual([0, 64, 288])
    for (const frame of batch) {
      expect(frame).toEqual(
        simulateFrame(municipalities, frame.step, { selectedLayer: 'water', scenario: 'compound' }, network),
      )
    }
  })

  it('integrates only event-attributable eight-service shortfall at each prior quarter hour', () => {
    const steps = Array.from({ length: 41 }, (_, index) => index)
    const scenario = createScenarioConfig('compound')
    const frames = simulateFrames(
      [municipalities[0]],
      steps,
      { selectedLayer: 'overview', scenario },
      [],
    )
    const noEventFrames = simulateFrames(
      [municipalities[0]],
      steps,
      { selectedLayer: 'overview', scenario: { ...scenario, intensity: 0 } },
      [],
    )
    const expected = frames
      .slice(1)
      .reduce(
        (sum, frame, index) =>
          sum + frame.municipalities[0].population * Math.max(
            0,
            frame.municipalities[0].systemPressure -
              noEventFrames[index + 1].municipalities[0].systemPressure,
          ) * 0.25,
        0,
      )
    const householdImpactMultiplier =
      1 + (0.5 - (scenario.householdPreparedness ?? 0.5)) * 0.24
    expect(frames.at(-1)!.municipalities[0].deprivedPersonHours).toBeCloseTo(
      expected * householdImpactMultiplier,
      7,
    )
    const serviceContributionIds = frames
      .at(-1)!
      .municipalities[0].explanation.contributions.filter(
        (contribution) => contribution.target === 'system-pressure',
      )
      .map((contribution) => contribution.driverId)
    expect(serviceContributionIds).toEqual(serviceIds.map((service) => `service.${service}.availability`))
  })

  it('does not manufacture disaster deprivation from the synthetic resilience prior', () => {
    const noEvent = createScenarioConfig('earthquake', { intensity: 0 })
    const frame = simulateFrame(
      [municipalities[0]],
      288,
      { selectedLayer: 'overview', scenario: noEvent },
      [],
    )
    expect(frame.municipalities[0].deprivedPersonHours).toBe(0)
  })

  it('keeps default river high-water forcing active through the 72-hour window', () => {
    const frame = simulateFrame(
      // Eindhoven has an audited direct-major-river exclusion; Tilburg keeps
      // this test scoped to the preset duration/forcing contract.
      [municipalities[1]],
      288,
      { selectedLayer: 'hazard', scenario: 'river-flood' },
      [],
    )
    expect(scenarioPresets['river-flood'].durationHours).toBeGreaterThan(72)
    expect(frame.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
  })

  it('keeps default heatwave forcing active through the 72-hour window', () => {
    const frame = simulateFrame(
      [municipalities[0]],
      288,
      { selectedLayer: 'hazard', scenario: 'heatwave' },
      [],
    )
    expect(scenarioPresets.heatwave.durationHours).toBe(336)
    expect(frame.municipalities[0].hazard.droughtSeverity).toBeGreaterThan(0)
    expect(frame.municipalities[0].hazard.severity).toBeGreaterThan(0)
  })

  it('makes quarter-hour output explicit instead of the performance-conscious default', () => {
    const hourly = simulateHistory(
      [municipalities[0]],
      { selectedLayer: 'overview', scenario: scenarioPresets.heatwave },
      { municipalityIds: ['GM0772'] },
    )
    const quarterHourly = simulateHistory(
      [municipalities[0]],
      { selectedLayer: 'overview', scenario: scenarioPresets.heatwave },
      { municipalityIds: ['GM0772'], intervalSteps: 1 },
    )
    expect(hourly.points).toHaveLength(73)
    expect(quarterHourly.points).toHaveLength(289)
  })

  it('labels full-network aggregates and validates history selection', () => {
    const history = simulateHistory(
      municipalities,
      { selectedLayer: 'power', scenario: 'earthquake' },
      {
        municipalityIds: ['GM0772'],
        network,
        networkMode: 'full',
        startStep: 0,
        endStep: 13,
        intervalSteps: 5,
      },
    )
    expect(history.aggregateScope).toBe('national-network')
    expect(history.points.map((point) => point.step)).toEqual([0, 5, 10, 13])
    expect(history.points.every((point) => point.national.population === 478_000)).toBe(true)
    expect(() =>
      simulateHistory(municipalities, { selectedLayer: 'overview' }, {
        municipalityIds: ['GM-UNKNOWN'],
      }),
    ).toThrow(/Unknown history municipality/)
    expect(() =>
      simulateHistory(municipalities, { selectedLayer: 'overview' }, {
        startStep: 100,
        endStep: 20,
      }),
    ).toThrow(/start step/)
  })
})
