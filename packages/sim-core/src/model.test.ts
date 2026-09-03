import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildNationalNetwork,
  collectionToMunicipalities,
  createScenarioConfig,
  createSimulationSession,
  formatSimulationTime,
  orientRouteCoordinates,
  scenarioPresetIds,
  scenarioPresets,
  simulateCityDetail,
  simulateFrame,
  TIMELINE_STEPS,
  type LocalRegionDefinition,
  type MunicipalityDefinition,
  type MunicipalityCollection,
  type RouteDefinition,
} from './index'
import {
  generatedMunicipalityAuditGuardCodes,
  generatedMunicipalityAuditGuardNotes,
} from './audited-municipality-guards.generated'

const cities: MunicipalityDefinition[] = [
  {
    code: 'SIM0772',
    name: 'Eindhoven',
    coordinates: [5.4697, 51.4416],
    population: 249_000,
    density: 2_900,
    age65Pct: 17,
    onePersonHouseholds: 54_000,
    boundaryEdition: 2026,
    statisticsEdition: 2025,
    areaScale: 1,
    seed: 772,
  },
  {
    code: 'SIM0855',
    name: 'Tilburg',
    coordinates: [5.0913, 51.5555],
    population: 229_000,
    density: 1_900,
    age65Pct: 18,
    onePersonHouseholds: 46_000,
    boundaryEdition: 2026,
    statisticsEdition: 2025,
    areaScale: 1,
    seed: 855,
  },
  {
    code: 'SIM0758',
    name: 'Breda',
    coordinates: [4.7683, 51.5719],
    population: 188_000,
    density: 1_500,
    age65Pct: 19,
    onePersonHouseholds: 38_000,
    boundaryEdition: 2026,
    statisticsEdition: 2025,
    areaScale: 1,
    seed: 758,
  },
]

describe('72-hour simulation', () => {
  it('exposes exactly 289 quarter-hour states from T+00 to T+72', () => {
    expect(TIMELINE_STEPS).toBe(289)
    expect(formatSimulationTime(0)).toBe('T+00:00')
    expect(formatSimulationTime(288)).toBe('T+72:00')
  })

  it('is deterministic for the same frame and options', () => {
    const network = buildNationalNetwork(cities)
    const first = simulateFrame(cities, 64, { selectedLayer: 'power' }, network)
    const second = simulateFrame(cities, 64, { selectedLayer: 'power' }, network)
    expect(second).toEqual(first)
  })

  it('keeps compact live frames numerically identical to fully explained frames', () => {
    const network = buildNationalNetwork(cities)
    const scenario = createScenarioConfig('compound')
    const full = simulateFrame(cities, 96, { selectedLayer: 'water', scenario }, network)
    const compact = simulateFrame(cities, 96, {
      selectedLayer: 'water',
      scenario,
      explanationMunicipalityIds: [cities[0].code],
      materializedRouteServices: ['water'],
    }, network)

    expect(compact.national).toEqual(full.national)
    for (const [index, municipality] of compact.municipalities.entries()) {
      const expected = full.municipalities[index]
      expect({ ...municipality.hazard, explanation: undefined }).toEqual({
        ...expected.hazard,
        explanation: undefined,
      })
      for (const service of Object.keys(municipality.services) as Array<keyof typeof municipality.services>) {
        expect({ ...municipality.services[service], explanation: undefined }).toEqual({
          ...expected.services[service],
          explanation: undefined,
        })
      }
    }
    expect(compact.municipalities[0].explanation.contributions.length).toBeGreaterThan(0)
    expect(compact.municipalities[1].explanation.contributions).toEqual([])
    expect(compact.routesByService.water).toEqual(full.routesByService.water)
    expect(compact.routesByService.power).toEqual([])
  })

  it('reuses ascending history in a session without changing deterministic output', () => {
    const network = buildNationalNetwork(cities)
    const scenario = createScenarioConfig('river-flood')
    const session = createSimulationSession(cities, network)
    for (const step of [0, 24, 96, 288]) {
      const options = { selectedLayer: 'supply' as const, scenario }
      expect(session.simulate(step, options)).toEqual(simulateFrame(cities, step, options, network))
    }
  })

  it('treats zero intensity as a no-event counterfactual for every public preset', () => {
    const eventDimensions = [
      'rainMmH',
      'floodDepthM',
      'windGustMs',
      'snowCmH',
      'iceSeverity',
      'coldStress',
      'droughtSeverity',
      'wildfireIntensity',
      'smokeSeverity',
      'groundMotionG',
      'cyberDisruption',
      'severity',
      'peakSeverity',
    ] as const
    for (const preset of scenarioPresetIds) {
      const scenario = createScenarioConfig(preset, { intensity: 0 })
      for (const step of [0, 24, 48, 96, 192, 288]) {
        const frame = simulateFrame(cities, step, { selectedLayer: 'hazard', scenario }, [])
        for (const municipality of frame.municipalities) {
          for (const dimension of eventDimensions) {
            expect(municipality.hazard[dimension], `${preset} ${step} ${dimension}`).toBe(0)
          }
          expect(municipality.affectedPopulation, `${preset} ${step} affected`).toBe(0)
          expect(municipality.deprivedPersonHours, `${preset} ${step} deprivation`).toBe(0)
        }
      }
    }
  })

  it('does not begin generic river-flood restoration while peak forcing persists', () => {
    const riverfront = { ...cities[0], code: 'GM-RIVERFRONT', coordinates: [5.9, 51.84] as [number, number] }
    const scenario = createScenarioConfig('river-flood')
    const frame = simulateFrame([riverfront], 288, { selectedLayer: 'power', scenario }, [])
    const snapshot = frame.municipalities[0]

    expect(snapshot.hazard.floodDepthM).toBeGreaterThan(0)
    for (const service of Object.values(snapshot.services)) {
      expect(service.explanation.recoveryProgress).toBe(0)
    }
  })

  it('pauses compound-event restoration while residual pluvial water remains at T+72', () => {
    const albrandswaard: MunicipalityDefinition = {
      code: 'SIM0613',
      name: 'Albrandswaard',
      coordinates: [4.436464704606055, 51.852135914219744],
      population: 26_707,
      density: 1_233,
      age65Pct: 19.4,
      onePersonHouseholds: 2_950,
      boundaryEdition: 2025,
      statisticsEdition: 2025,
      areaScale: 1,
      seed: 613,
    }
    const frame = simulateFrame(
      [albrandswaard],
      288,
      { selectedLayer: 'water', scenario: createScenarioConfig('compound') },
      [],
    )
    const snapshot = frame.municipalities[0]

    expect(snapshot.hazard.floodDepthM).toBeGreaterThan(0.05)
    for (const service of Object.values(snapshot.services)) {
      expect(service.explanation.recoveryProgress).toBe(0)
      expect(
        service.explanation.drivers.find((driver) =>
          driver.id.endsWith('.repairAccessFloodDepth'),
        )?.value,
      ).toBe(snapshot.hazard.floodDepthM)
    }
  })

  it('keeps canonical service state independent from the selected visual layer', () => {
    const powerView = simulateFrame(cities, 64, { selectedLayer: 'power' })
    const waterView = simulateFrame(cities, 64, { selectedLayer: 'water' })
    expect(waterView.municipalities).toEqual(powerView.municipalities)
    expect(waterView.routesByService).toEqual(powerView.routesByService)
    expect(waterView.national).toEqual(powerView.national)
  })

  it('uses emergency-supply route semantics for overview, hazard, and population projections', () => {
    const network = buildNationalNetwork(cities)
    const supplyRoutes = simulateFrame(cities, 84, { selectedLayer: 'supply' }, network).routes
    for (const selectedLayer of ['overview', 'hazard', 'population'] as const) {
      expect(simulateFrame(cities, 84, { selectedLayer }, network).routes).toEqual(supplyRoutes)
    }
  })

  it('limits a ferry lifeline to its explicitly supported services', () => {
    const ferry: RouteDefinition = {
      id: 'audited-island-ferry',
      from: cities[0].code,
      to: cities[1].code,
      coordinates: [cities[0].coordinates, cities[1].coordinates],
      nominalCapacity: 60,
      mode: 'ferry',
      distanceKm: 30,
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
    }
    const frame = simulateFrame(cities.slice(0, 2), 64, { selectedLayer: 'mobility' }, [ferry])

    expect(frame.routesByService.mobility.map((route) => route.id)).toEqual([ferry.id])
    expect(frame.routesByService.supply.map((route) => route.id)).toEqual([ferry.id])
    for (const service of ['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as const) {
      expect(frame.routesByService[service]).toEqual([])
    }
  })

  it('never treats an unqualified NWB road as physical utility topology', () => {
    const road: RouteDefinition = {
      id: 'nwb-road-only',
      source: 'NWB',
      from: cities[0].code,
      to: cities[1].code,
      coordinates: [cities[0].coordinates, cities[1].coordinates],
      nominalCapacity: 150,
      mode: 'regional',
      distanceKm: 30,
      capacitySemantics: 'scenario-units',
    }
    const frame = simulateFrame(cities.slice(0, 2), 64, { selectedLayer: 'mobility' }, [road])

    expect(frame.routesByService.mobility.map((route) => route.id)).toEqual([road.id])
    expect(frame.routesByService.supply.map((route) => route.id)).toEqual([road.id])
    for (const service of ['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as const) {
      expect(frame.routesByService[service]).toEqual([])
    }
  })

  it('applies official route restrictions only to an explicitly overlapping calendar date', () => {
    const road: RouteDefinition = {
      id: 'n3-papendrechtsebrug',
      source: 'NWB',
      from: cities[0].code,
      to: cities[1].code,
      coordinates: [cities[0].coordinates, cities[1].coordinates],
      nominalCapacity: 150,
      mode: 'regional',
      distanceKm: 1.4,
      capacitySemantics: 'scenario-units',
      operationalRestrictions: [{
        id: 'official-closure',
        state: 'closed',
        simulationEffect: 'close-route',
        validFrom: '2026-07-17',
        validThrough: '2027-04-21',
        affectedServices: ['mobility', 'supply'],
        scope: 'All road traffic in both directions',
        publisher: 'Rijkswaterstaat',
        sourceUrl: 'https://www.rijkswaterstaat.nl/',
        retrievedAt: '2026-09-02T21:49:00Z',
        evidenceClass: 'official-plan',
      }],
    }
    const routeAt = (referenceDate?: string) => simulateFrame(
      cities.slice(0, 2),
      0,
      {
        selectedLayer: 'mobility',
        scenario: createScenarioConfig('severe-storm', { intensity: 0, referenceDate }),
      },
      [road],
    ).routesByService.mobility[0]

    expect(routeAt().activeRestriction).toBeUndefined()
    expect(routeAt().effectiveCapacity).toBeGreaterThan(0)
    expect(routeAt('2026-07-16').activeRestriction).toBeUndefined()
    expect(routeAt('2027-04-22').activeRestriction).toBeUndefined()
    expect(routeAt('2026-07-17')).toMatchObject({
      activeRestriction: { id: 'official-closure' },
      effectiveCapacity: 0,
      health: 0,
      status: 'failed',
    })
    expect(routeAt('2027-04-21').effectiveCapacity).toBe(0)
  })

  it('surfaces a vehicle-class restriction without deleting uncalibrated A27 capacity', () => {
    const road: RouteDefinition = {
      id: 'a27-merwedebrug',
      source: 'NWB',
      from: cities[0].code,
      to: cities[1].code,
      coordinates: [cities[0].coordinates, cities[1].coordinates],
      nominalCapacity: 260,
      mode: 'trunk',
      distanceKm: 1.1,
      capacitySemantics: 'scenario-units',
      operationalRestrictions: [{
        id: 'official-heavy-vehicle-restriction',
        state: 'vehicle-class-restricted',
        simulationEffect: 'context-only',
        validFrom: '2026-07-18',
        validThrough: '2026-09-03',
        affectedServices: ['mobility', 'supply'],
        affectedVehicleClasses: ['trucks', 'touring coaches'],
        unaffectedVehicleClasses: ['passenger cars', 'scheduled buses', 'emergency services'],
        scope: 'Heavy-vehicle classes only',
        publisher: 'Rijkswaterstaat',
        sourceUrl: 'https://www.rijkswaterstaat.nl/wegen/wegenoverzicht/a27/merwedebrug',
        retrievedAt: '2026-09-03T02:25:00Z',
        evidenceClass: 'official-observation',
      }],
    }
    const routeAt = (referenceDate?: string) => simulateFrame(
      cities.slice(0, 2),
      0,
      {
        selectedLayer: 'supply',
        scenario: createScenarioConfig('severe-storm', { intensity: 0, referenceDate }),
      },
      [road],
    ).routesByService.supply[0]

    const unbound = routeAt()
    const aligned = routeAt('2026-09-03')
    expect(unbound.activeRestriction).toBeUndefined()
    expect(aligned.activeRestriction).toMatchObject({
      id: 'official-heavy-vehicle-restriction',
      state: 'vehicle-class-restricted',
      simulationEffect: 'context-only',
    })
    expect(aligned.effectiveCapacity).toBe(unbound.effectiveCapacity)
    expect(aligned.health).toBe(unbound.health)
    expect(routeAt('2026-09-04').activeRestriction).toBeUndefined()
  })

  it('normalizes the optional scenario reference date without inventing one', () => {
    expect(createScenarioConfig('severe-storm').referenceDate).toBeUndefined()
    expect(createScenarioConfig('severe-storm', { referenceDate: '2026-09-03' }).referenceDate)
      .toBe('2026-09-03')
    expect(createScenarioConfig('severe-storm', { referenceDate: '2026-02-31' }).referenceDate)
      .toBeUndefined()
    expect(createScenarioConfig('severe-storm', { referenceDate: '03-09-2026' }).referenceDate)
      .toBeUndefined()
  })

  it('never exceeds route capacity', () => {
    const frame = simulateFrame(cities, 45, { selectedLayer: 'supply' })
    for (const route of frame.routes) {
      expect(route.flow).toBeLessThanOrEqual(route.effectiveCapacity + 1e-9)
      expect(route.utilization).toBeGreaterThanOrEqual(0)
      expect(route.utilization).toBeLessThanOrEqual(1)
    }
  })

  it('creates a detailed, reconciled simulation for any municipality', () => {
    const frame = simulateFrame(cities, 52, { selectedLayer: 'water' })
    for (const city of cities) {
      const detail = simulateCityDetail(city, frame, 'water')
      expect(detail.districts).toHaveLength(6)
      expect(detail.links).toHaveLength(5)
      expect(detail.localDemand).toBeCloseTo(
        frame.municipalities.find((item) => item.id === city.code)!.services.water.demand,
      )
      expect(detail.inboundSupply).toBeGreaterThanOrEqual(0)
      expect(detail.reconciliationError).toBeLessThan(1e-8)
      expect(detail.districts.reduce((sum, district) => sum + district.population, 0)).toBe(
        frame.municipalities.find((item) => item.id === city.code)!.population,
      )
      expect(
        detail.districts.reduce((sum, district) => sum + district.affectedPopulation, 0),
      ).toBe(frame.municipalities.find((item) => item.id === city.code)!.affectedPopulation)
      expect(detail.districts.reduce((sum, district) => sum + district.delivered, 0)).toBeCloseTo(
        detail.inboundSupply,
        8,
      )
      for (const district of detail.districts) {
        expect(district.delivered).toBeLessThanOrEqual(district.demand + 1e-9)
      }
      for (let index = 0; index < detail.links.length; index += 1) {
        expect(detail.districts[index + 1].delivered).toBeLessThanOrEqual(
          detail.links[index].capacity + 1e-9,
        )
      }
    }
  })

  it('redistributes power conservatively and respects zero-capacity routes', () => {
    const noNetwork = simulateFrame(cities, 64, { selectedLayer: 'power' }, [])
    const network = buildNationalNetwork(cities)
    const connected = simulateFrame(cities, 64, { selectedLayer: 'power' }, network)
    const totalPower = (frame: typeof connected) =>
      frame.municipalities.reduce((sum, city) => sum + city.services.power.delivered, 0)
    expect(totalPower(connected)).toBeCloseTo(totalPower(noNetwork), 10)
    for (const route of connected.routes) {
      expect(route.flow).toBeLessThanOrEqual(route.effectiveCapacity + 1e-9)
    }

    const zeroCapacity: RouteDefinition[] = [
      {
        id: 'zero-capacity',
        from: cities[0].code,
        to: cities[1].code,
        coordinates: [cities[0].coordinates, cities[1].coordinates],
        nominalCapacity: 0,
        mode: 'local',
        distanceKm: 1,
      },
    ]
    const zeroFrame = simulateFrame(cities, 64, { selectedLayer: 'power' }, zeroCapacity)
    expect(zeroFrame.municipalities).toEqual(noNetwork.municipalities)
    expect(zeroFrame.routes[0].flow).toBe(0)
  })

  it('does not invent a transfer between equal endpoints', () => {
    const equalCities: MunicipalityDefinition[] = [
      { ...cities[0], code: 'GM-A', name: 'A', coordinates: [5, 52], seed: 42 },
      { ...cities[0], code: 'GM-B', name: 'B', coordinates: [5, 52], seed: 42 },
    ]
    const route: RouteDefinition = {
      id: 'equal-route',
      from: 'GM-A',
      to: 'GM-B',
      coordinates: [equalCities[0].coordinates, equalCities[1].coordinates],
      nominalCapacity: 100,
      mode: 'regional',
      distanceKm: 0,
    }
    const frame = simulateFrame(equalCities, 0, { selectedLayer: 'supply' }, [route])
    expect(frame.routes[0].flow).toBe(0)
    expect(frame.municipalities[0].services).toEqual(frame.municipalities[1].services)
  })

  it('quantizes finite off-grid steps and rejects non-finite values', () => {
    expect(simulateFrame(cities, 0.5, { selectedLayer: 'overview' }).step).toBe(1)
    expect(formatSimulationTime(0.5)).toBe('T+00:15')
    expect(() => simulateFrame(cities, Number.NaN, { selectedLayer: 'overview' })).toThrow(
      RangeError,
    )
  })

  it('keeps accumulated person-hours monotonic and starts at zero', () => {
    let previous = -1
    for (const step of [0, 1, 24, 48, 96, 192, 288]) {
      const frame = simulateFrame(cities, step, { selectedLayer: 'overview' })
      expect(frame.national.deprivedPersonHours).toBeGreaterThanOrEqual(previous)
      previous = frame.national.deprivedPersonHours
    }
    expect(simulateFrame(cities, 0, { selectedLayer: 'overview' }).national.deprivedPersonHours).toBe(0)
  })

  it('propagates a storm into multiple dependent services', () => {
    const calm = simulateFrame(cities, 0, { selectedLayer: 'overview' })
    const storm = simulateFrame(cities, 28, { selectedLayer: 'overview' })
    const calmCity = calm.municipalities[0]
    const stormCity = storm.municipalities[0]
    expect(stormCity.hazard.severity).toBeGreaterThan(calmCity.hazard.severity)
    const changed = ['power', 'water', 'telecom', 'mobility'].filter(
      (service) =>
        stormCity.services[service as keyof typeof stormCity.services].availability <
        calmCity.services[service as keyof typeof calmCity.services].availability,
    )
    expect(changed.length).toBeGreaterThanOrEqual(3)
  })

  it('provides materially different deterministic forcing for every scenario preset', () => {
    const representativeStep = {
      'severe-storm': 40,
      'pluvial-flood': 24,
      'river-flood': 96,
      'coastal-flood': 48,
      heatwave: 120,
      'winter-storm': 48,
      cyberattack: 24,
      earthquake: 12,
      wildfire: 96,
      compound: 48,
    } as const
    const hazards = Object.fromEntries(
      scenarioPresetIds.map((preset) => {
        const frame = simulateFrame(cities, representativeStep[preset], {
          selectedLayer: 'overview',
          scenario: preset,
        })
        return [preset, frame.municipalities[0].hazard]
      }),
    )

    expect(hazards['severe-storm'].windGustMs).toBeGreaterThan(0)
    expect(hazards['pluvial-flood'].rainMmH).toBeGreaterThan(0)
    expect(hazards['river-flood'].floodDepthM).toBeGreaterThan(0)
    expect(hazards['coastal-flood'].windGustMs).toBeGreaterThan(0)
    expect(hazards.heatwave.heatC).toBeGreaterThan(25)
    expect(hazards['winter-storm'].snowCmH).toBeGreaterThan(0)
    expect(hazards.cyberattack.cyberDisruption).toBeGreaterThan(0)
    expect(hazards.earthquake.groundMotionG).toBeGreaterThan(0)
    expect(hazards.wildfire.smokeSeverity).toBeGreaterThan(0)
    expect(hazards.compound.components).toEqual([
      'severe-storm',
      'pluvial-flood',
      'cyberattack',
    ])
  })

  it('keeps a named heatwave active through the 72-hour operations window', () => {
    const scenario = createScenarioConfig('heatwave')
    const hazard = simulateFrame(cities, 288, { selectedLayer: 'hazard', scenario })
      .municipalities[0].hazard

    expect(scenario.durationHours).toBe(336)
    expect(hazard.droughtSeverity).toBeGreaterThan(0)
    expect(hazard.severity).toBeGreaterThan(0)
  })

  it('does not label ordinary seasonal temperature as winter-storm forcing outside its event window', () => {
    const scenario = createScenarioConfig('winter-storm', {
      startHour: 12,
      durationHours: 8,
    })
    const before = simulateFrame(cities, 0, { selectedLayer: 'hazard', scenario })
      .municipalities[0].hazard
    const after = simulateFrame(cities, 120, { selectedLayer: 'hazard', scenario })
      .municipalities[0].hazard

    for (const hazard of [before, after]) {
      expect(hazard.windGustMs).toBe(0)
      expect(hazard.snowCmH).toBe(0)
      expect(hazard.iceSeverity).toBe(0)
      expect(hazard.coldStress).toBe(0)
      expect(hazard.severity).toBe(0)
    }
    expect(after.peakSeverity).toBeGreaterThan(0)
  })

  it('keeps cyberattack forcing digital and geographically non-physical', () => {
    const scenario = createScenarioConfig('cyberattack', {
      targetMunicipalityIds: [cities[1].code],
      responseDelayHours: 12,
    })
    const frame = simulateFrame(cities, 24, { selectedLayer: 'telecom', scenario })
    // Synthetic municipality identifiers keep this generic engine test
    // independent from the growing real-municipality audit guard set.
    const target = frame.municipalities[1]
    const spillover = frame.municipalities[0]
    expect(target.hazard.cyberDisruption).toBeGreaterThan(spillover.hazard.cyberDisruption)
    for (const city of frame.municipalities) {
      expect(city.hazard.rainMmH).toBe(0)
      expect(city.hazard.floodDepthM).toBe(0)
      expect(city.hazard.windGustMs).toBe(0)
      expect(city.hazard.snowCmH).toBe(0)
      expect(city.hazard.groundMotionG).toBe(0)
      expect(city.hazard.wildfireIntensity).toBe(0)
    }
    expect(target.services.telecom.availability).toBeLessThan(target.services.mobility.availability)
  })

  it('does not apply cyber disruption before the configured start hour', () => {
    const scenario = createScenarioConfig('cyberattack', { startHour: 12 })
    const before = simulateFrame(cities, 40, {
      selectedLayer: 'telecom',
      scenario,
    })
    const after = simulateFrame(cities, 56, {
      selectedLayer: 'telecom',
      scenario,
    })
    expect(before.municipalities.every((city) => city.hazard.cyberDisruption === 0)).toBe(true)
    expect(after.municipalities.some((city) => city.hazard.cyberDisruption > 0)).toBe(true)
  })

  it('retains pluvial floodwater after the rain pulse ends', () => {
    const scenario = createScenarioConfig('pluvial-flood', { durationHours: 10 })
    const frame = simulateFrame(cities, 40, {
      selectedLayer: 'drainage',
      scenario,
    })
    expect(frame.municipalities[0].hazard.rainMmH).toBe(0)
    expect(frame.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
  })

  it('changes seasonal demand without changing an identical cyber compromise curve', () => {
    const winterScenario = createScenarioConfig('cyberattack', {
      season: 'winter',
      responseDelayHours: 10,
    })
    const summerScenario = createScenarioConfig('cyberattack', {
      season: 'summer',
      responseDelayHours: 10,
    })
    const winter = simulateFrame(cities, 24, {
      selectedLayer: 'gas',
      scenario: winterScenario,
    }).municipalities[0]
    const summer = simulateFrame(cities, 24, {
      selectedLayer: 'gas',
      scenario: summerScenario,
    }).municipalities[0]
    expect(winter.hazard.cyberDisruption).toBeCloseTo(summer.hazard.cyberDisruption, 12)
    expect(winter.services.gas.demand).toBeGreaterThan(summer.services.gas.demand)
    expect(winter.hazard.heatC).toBeLessThan(summer.hazard.heatC)
  })

  it('applies an explicit KNMI climate path to physical forcing', () => {
    const reference = createScenarioConfig('heatwave', {
      climate: { path: 'reference', horizon: 'current' },
    })
    const future = createScenarioConfig('heatwave', {
      climate: { path: 'Hn', horizon: 2100 },
    })
    const referenceCity = simulateFrame(cities, 96, {
      selectedLayer: 'facilities',
      scenario: reference,
    }).municipalities[0]
    const futureCity = simulateFrame(cities, 96, {
      selectedLayer: 'facilities',
      scenario: future,
    }).municipalities[0]
    expect(futureCity.hazard.climateTemperatureDeltaC).toBeCloseTo(4.7)
    expect(futureCity.hazard.heatC - referenceCity.hazard.heatC).toBeCloseTo(4.7)
    expect(futureCity.services.facilities.demand).toBeGreaterThan(
      referenceCity.services.facilities.demand,
    )
  })

  it('keeps a future path at the current horizon on the reference baseline', () => {
    const reference = createScenarioConfig('heatwave', {
      climate: { path: 'reference', horizon: 'current' },
    })
    const currentHn = createScenarioConfig('heatwave', {
      climate: { path: 'Hn', horizon: 'current' },
    })
    const referenceHazard = simulateFrame(cities, 96, {
      selectedLayer: 'hazard',
      scenario: reference,
    }).municipalities[0].hazard
    const currentHnHazard = simulateFrame(cities, 96, {
      selectedLayer: 'hazard',
      scenario: currentHn,
    }).municipalities[0].hazard
    expect(currentHnHazard.climateTemperatureDeltaC).toBe(0)
    expect(currentHnHazard.climatePrecipitationMultiplier).toBe(1)
    expect(currentHnHazard.heatC).toBeCloseTo(referenceHazard.heatC, 12)
  })

  it('makes intensity, duration, preparedness, and response delay consequential', () => {
    const lightCloudburst = createScenarioConfig('pluvial-flood', {
      intensity: 0.25,
      durationHours: 8,
    })
    const severeCloudburst = createScenarioConfig('pluvial-flood', {
      intensity: 1,
      durationHours: 20,
    })
    const light = simulateFrame(cities, 24, {
      selectedLayer: 'mobility',
      scenario: lightCloudburst,
    }).municipalities[0]
    const severe = simulateFrame(cities, 24, {
      selectedLayer: 'mobility',
      scenario: severeCloudburst,
    }).municipalities[0]
    expect(severe.hazard.rainMmH).toBeGreaterThan(light.hazard.rainMmH)
    expect(severe.hazard.floodDepthM).toBeGreaterThan(light.hazard.floodDepthM)
    expect(severe.services.mobility.availability).toBeLessThan(
      light.services.mobility.availability,
    )

    const unprepared = createScenarioConfig('cyberattack', {
      preparedness: 0.1,
      responseDelayHours: 18,
    })
    const prepared = createScenarioConfig('cyberattack', {
      preparedness: 0.9,
      responseDelayHours: 1,
    })
    const unpreparedCity = simulateFrame(cities, 64, {
      selectedLayer: 'telecom',
      scenario: unprepared,
    }).municipalities[0]
    const preparedCity = simulateFrame(cities, 64, {
      selectedLayer: 'telecom',
      scenario: prepared,
    }).municipalities[0]
    expect(preparedCity.hazard.cyberDisruption).toBeLessThan(
      unpreparedCity.hazard.cyberDisruption,
    )
    expect(preparedCity.services.telecom.availability).toBeGreaterThan(
      unpreparedCity.services.telecom.availability,
    )
  })

  it('keeps all multi-hazard physical and service values bounded', () => {
    for (const preset of scenarioPresetIds) {
      for (const step of [0, 24, 96, 192, 288]) {
        const frame = simulateFrame(cities, step, {
          selectedLayer: 'overview',
          scenario: preset,
        })
        for (const city of frame.municipalities) {
          const hazard = city.hazard
          expect(Number.isFinite(hazard.heatC)).toBe(true)
          expect(Number.isFinite(hazard.climateTemperatureDeltaC)).toBe(true)
          expect(Number.isFinite(hazard.climatePrecipitationMultiplier)).toBe(true)
          expect(Number.isFinite(hazard.climateSeaLevelDeltaM)).toBe(true)
          expect(hazard.rainMmH).toBeGreaterThanOrEqual(0)
          expect(hazard.floodDepthM).toBeGreaterThanOrEqual(0)
          expect(hazard.floodDepthM).toBeLessThanOrEqual(5)
          expect(hazard.windGustMs).toBeGreaterThanOrEqual(0)
          expect(hazard.snowCmH).toBeGreaterThanOrEqual(0)
          expect(hazard.groundMotionG).toBeGreaterThanOrEqual(0)
          expect(hazard.groundMotionG).toBeLessThanOrEqual(0.5)
          for (const index of [
            hazard.iceSeverity,
            hazard.coldStress,
            hazard.droughtSeverity,
            hazard.wildfireIntensity,
            hazard.smokeSeverity,
            hazard.cyberDisruption,
            hazard.severity,
            hazard.peakSeverity,
          ]) {
            expect(index).toBeGreaterThanOrEqual(0)
            expect(index).toBeLessThanOrEqual(1)
          }
          for (const service of Object.values(city.services)) {
            expect(Number.isFinite(service.demand)).toBe(true)
            expect(service.availability).toBeGreaterThanOrEqual(0)
            expect(service.availability).toBeLessThanOrEqual(1)
            expect(service.delivered).toBeGreaterThanOrEqual(0)
            expect(service.delivered).toBeLessThanOrEqual(service.demand + 1e-9)
          }
        }
      }
    }
  })

  it('normalizes malformed optional inputs without leaking non-finite state', () => {
    const scenario = createScenarioConfig('compound', {
      components: [],
      climate: {
        path: 'Hn',
        horizon: 2100,
        temperatureDeltaC: Number.NaN,
        precipitationMultiplier: Number.POSITIVE_INFINITY,
        seaLevelDeltaM: Number.NEGATIVE_INFINITY,
      },
      epicenter: [Number.NaN, 52],
    })
    expect(scenario.components).toEqual(scenarioPresets.compound.components)
    expect(scenario.climate.temperatureDeltaC).toBeUndefined()
    expect(scenario.climate.precipitationMultiplier).toBeUndefined()
    expect(scenario.climate.seaLevelDeltaM).toBeUndefined()
    expect(scenario.epicenter).toBeUndefined()
    const frame = simulateFrame(cities, 48, { selectedLayer: 'overview', scenario })
    expect(frame.municipalities.every((city) => Number.isFinite(city.hazard.severity))).toBe(true)
  })

  it('uses supplied real subregions and reconciles them to the municipality gateway', () => {
    const frame = simulateFrame(cities, 48, {
      selectedLayer: 'water',
      scenario: 'pluvial-flood',
    })
    const regions: LocalRegionDefinition[] = [
      {
        id: 'BU07720001',
        municipalityId: cities[0].code,
        name: 'Binnenstad',
        geometry: {
          type: 'Polygon',
          coordinates: [[[5.46, 51.43], [5.48, 51.43], [5.48, 51.45], [5.46, 51.45], [5.46, 51.43]]],
        },
        population: 80_000,
        priority: 1,
        isHub: true,
        sourceType: 'official',
      },
      {
        id: 'BU07720002',
        municipalityId: cities[0].code,
        name: 'Strijp',
        geometry: {
          type: 'Polygon',
          coordinates: [[[5.42, 51.43], [5.45, 51.43], [5.45, 51.46], [5.42, 51.46], [5.42, 51.43]]],
        },
        population: 55_000,
        priority: 2,
        sourceType: 'official',
      },
    ]
    const detail = simulateCityDetail(cities[0], frame, 'water', regions)
    expect(detail.districts.map((district) => district.id)).toEqual([
      'BU07720001',
      'BU07720002',
    ])
    expect(detail.districts).toHaveLength(2)
    expect(detail.links).toHaveLength(0)
    expect(detail.districts[0].geometry).toEqual(regions[0].geometry)
    expect(detail.districts[0].sourceType).toBe('official')
    expect(detail.districts.reduce((sum, district) => sum + district.population, 0)).toBe(
      cities[0].population,
    )
    expect(detail.reconciliationError).toBeLessThan(1e-8)
  })

  it('does not create city-detail supply for a zero-population definition', () => {
    const emptyCity = { ...cities[0], code: 'GM-EMPTY', population: 0 }
    const frame = simulateFrame([emptyCity], 24, { selectedLayer: 'water' }, [])
    const detail = simulateCityDetail(emptyCity, frame, 'water')
    expect(detail.localDemand).toBe(0)
    expect(detail.inboundSupply).toBe(0)
    expect(detail.districts.reduce((sum, district) => sum + district.delivered, 0)).toBe(0)
    expect(detail.reconciliationError).toBe(0)
  })

  it('reverses every point in a real route path when flow is reversed', () => {
    const path = [
      [4, 52],
      [4.5, 52.2],
      [5, 52],
      [5.5, 51.8],
    ] as const
    expect(orientRouteCoordinates(path, -1)).toEqual([...path].reverse())
    expect(orientRouteCoordinates(path, 1)).toEqual(path)
    expect(path[0]).toEqual([4, 52])
  })

  it('publishes the fully oriented route path on a reverse network transfer', () => {
    const route: RouteDefinition = {
      id: 'multipoint-reverse',
      from: cities[0].code,
      to: cities[1].code,
      coordinates: [cities[0].coordinates, [5.28, 51.5], cities[1].coordinates],
      nominalCapacity: 500,
      mode: 'regional',
      distanceKm: 30,
    }
    const scenario = createScenarioConfig('earthquake', {
      intensity: 1,
      preparedness: 0,
      epicenter: cities[0].coordinates,
    })
    const snapshot = simulateFrame(cities.slice(0, 2), 1, {
      selectedLayer: 'power',
      scenario,
    }, [route]).routes[0]
    expect(snapshot.flowDirection).toBe(-1)
    expect(snapshot.flowCoordinates).toEqual([...route.coordinates].reverse())
    expect(snapshot.coordinates).toEqual(route.coordinates)
  })
})

describe('generated Netherlands dataset', () => {
  const dataUrl = new URL(
    '../../../apps/web/public/data/netherlands-municipalities.geojson',
    import.meta.url,
  )
  const collection = JSON.parse(readFileSync(dataUrl, 'utf8')) as MunicipalityCollection
  const municipalities = collectionToMunicipalities(collection)
  const transportUrl = new URL(
    '../../../apps/web/public/data/transport-network.json',
    import.meta.url,
  )
  const generatedTransport = JSON.parse(readFileSync(transportUrl, 'utf8')) as { routes: RouteDefinition[] }

  it('fails closed for every completed correction-required municipality audit', () => {
    expect(generatedMunicipalityAuditGuardCodes.length).toBeGreaterThan(0)
    expect(new Set(generatedMunicipalityAuditGuardCodes).size).toBe(
      generatedMunicipalityAuditGuardCodes.length,
    )

    const municipalitiesByCode = new Map(municipalities.map((city) => [city.code, city]))
    const scenario = createScenarioConfig('severe-storm')
    for (const code of generatedMunicipalityAuditGuardCodes) {
      const municipality = municipalitiesByCode.get(code)
      expect(municipality, `${code} must exist in the generated CBS municipality dataset`).toBeDefined()
      const frame = simulateFrame([municipality!], 96, {
        selectedLayer: 'hazard',
        scenario,
      }, [])
      expect(frame.municipalities[0].hazard.spatialEvidence, code).toBe('unsupported')
      expect(frame.municipalities[0].hazard.unsupportedDimensions, code).toEqual([
        'wind',
        'rain',
        'flood',
      ])
      expect(frame.municipalities[0].hazard.evidenceNote, code).toBeTruthy()
      expect(frame.unsupportedHazardMunicipalities, code).toEqual([code])
    }

    // Hof van Twente was the first audit intentionally protected by the generated
    // fallback rather than a hand-maintained municipality note.
    expect(generatedMunicipalityAuditGuardNotes.GM1735).toContain(
      "Hof van Twente's independent municipality audit is correction-required",
    )
    const hofVanTwente = municipalitiesByCode.get('GM1735')!
    const fallbackHazard = simulateFrame([hofVanTwente], 96, {
      selectedLayer: 'hazard',
      scenario,
    }, []).municipalities[0].hazard
    expect(fallbackHazard.evidenceNote).toContain('independent municipality audit')
    expect(fallbackHazard.evidenceNote).toContain('Unknown/NoData rather than zero or safe')

    const guarded = simulateFrame([hofVanTwente], 96, {
      selectedLayer: 'water',
      scenario,
    }, []).municipalities[0]
    const noEvent = simulateFrame([hofVanTwente], 96, {
      selectedLayer: 'water',
      scenario: { ...scenario, intensity: 0 },
    }, []).municipalities[0]
    for (const service of Object.keys(guarded.services) as Array<keyof typeof guarded.services>) {
      expect(guarded.services[service].availability, service).toBeCloseTo(
        noEvent.services[service].availability,
        12,
      )
    }
  })

  it('connects Ameland through the audited mobility and supply ferry only', () => {
    const ferry = generatedTransport.routes.find(
      (route) => route.id === 'gtfs-ferry-wpd-holwerd-ameland',
    )
    expect(ferry).toMatchObject({
      from: 'GM1970',
      to: 'GM0060',
      mode: 'ferry',
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
    })
  })

  it('connects Den Helder and Texel through the audited TESO mobility and supply ferry only', () => {
    const ferry = generatedTransport.routes.find(
      (route) => route.id === 'gtfs-ferry-teso-den-helder-texel',
    )
    expect(ferry).toMatchObject({
      from: 'GM0400',
      to: 'GM0448',
      mode: 'ferry',
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
      audit: 'GM0400-FERRY-001',
    })
    expect(ferry?.statusSemantics).toContain('future continuity remain unknown')
  })

  it('connects Kessel and Reuver through the audited mobility and supply ferry only', () => {
    const ferry = generatedTransport.routes.find(
      (route) => route.id === 'audited-ferry-kessel-reuver',
    )
    expect(ferry).toMatchObject({
      from: 'GM1894',
      to: 'GM0889',
      mode: 'ferry',
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
      distanceKm: 0.65,
    })
    expect(ferry?.nominalCapacity).toBe(55)
  })

  it('connects Bergen and Vierlingsbeek through the audited mobility and supply ferry only', () => {
    const ferry = generatedTransport.routes.find(
      (route) => route.id === 'audited-ferry-bergen-vierlingsbeek',
    )
    expect(ferry).toMatchObject({
      from: 'GM0893',
      to: 'GM1982',
      mode: 'ferry',
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
      distanceKm: 0.15,
    })
    expect(ferry?.nominalCapacity).toBe(55)
  })

  it.each([
    {
      id: 'audited-ferry-broekhuizen-arcen',
      sourceFeatureId: 'BRT-TOP10NL-4357b003-a3ef-5b9e-b7e2-b1cb77892f47',
      distanceKm: 0.15,
      loadCapacityTonnes: 80,
      maxVehicleWeightTonnes: 40,
      reason: 'urgent repair',
    },
    {
      id: 'audited-ferry-lottum-lomm',
      sourceFeatureId: 'BRT-TOP10NL-a752514d-4328-5a29-b0a7-972e080eb030',
      distanceKm: 0.16,
      loadCapacityTonnes: 50,
      maxVehicleWeightTonnes: 25,
      reason: 'repair',
    },
    {
      id: 'audited-ferry-velden-grubbenvorst',
      sourceFeatureId: 'BRT-TOP10NL-59dcf3af-5efc-5928-86f7-e724a9760fdb',
      distanceKm: 0.16,
      loadCapacityTonnes: 50,
      maxVehicleWeightTonnes: 25,
      reason: 'technical failure',
    },
  ])('connects the audited Maas vehicle ferry $id without turning a web status into T+72 state', ({
    id,
    sourceFeatureId,
    distanceKm,
    loadCapacityTonnes,
    maxVehicleWeightTonnes,
    reason,
  }) => {
    const ferry = generatedTransport.routes.find((route) => route.id === id)
    expect(ferry).toMatchObject({
      from: 'GM1507',
      to: 'GM0983',
      mode: 'ferry',
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
      nominalCapacity: 55,
      distanceKm,
      sourceFeatureIds: [sourceFeatureId],
      audit: 'GM1507-MAAS-FERRIES-001',
      operatorPhysicalLimits: {
        loadCapacityTonnes,
        maxVehicleWeightTonnes,
        simulationEffect: 'context-only',
      },
      observedOperationalStatus: {
        state: 'reported-temporarily-out-of-service',
        reason,
        issueTime: null,
        validThrough: null,
        machineReadable: false,
        simulationEffect: 'context-only',
      },
      publishedScheduleContext: {
        timeZone: 'Europe/Amsterdam',
        simulationEffect: 'context-only',
      },
    })
    expect(ferry?.operatorPhysicalLimits?.note).toContain('not throughput')
    expect(ferry?.observedOperationalStatus?.temporalSemantics).toContain(
      'scenario-time state are unknown',
    )
    expect(ferry?.operationalRestrictions).toBeUndefined()
  })

  it('uses NWB physical corridor identity for Amsterdam E35 and Bunnik E30 co-designations', () => {
    const routes = generatedTransport.routes.filter(
      (route) =>
        [route.from, route.to].sort().join('--') === ['GM0363', 'GM0437'].sort().join('--') &&
        (route.name === 'A2' || route.name === 'A10' || route.name === 'E35' || route.aliases?.includes('E35')),
    )
    expect(routes).toHaveLength(2)
    expect(routes.find((route) => route.name === 'A2')).toMatchObject({
      name: 'A2',
      mode: 'trunk',
      nominalCapacity: 260,
      physicalCorridorId: 'NWB-road-2',
    })
    expect(routes.find((route) => route.name === 'A10')).toMatchObject({
      name: 'A10',
      mode: 'trunk',
      nominalCapacity: 260,
      aliases: expect.arrayContaining(['E35']),
      physicalCorridorId: 'NWB-road-10',
    })

    const bunnikRoutes = generatedTransport.routes.filter(
      (route) =>
        [route.from, route.to].sort().join('--') === ['GM0312', 'GM0344'].sort().join('--') &&
        ['NWB-road-27', 'NWB-road-28'].includes(route.physicalCorridorId ?? ''),
    )
    expect(bunnikRoutes).toHaveLength(2)
    expect(bunnikRoutes.map((route) => route.name).sort()).toEqual(['A27', 'A28'])
    expect(bunnikRoutes.every((route) => route.aliases?.includes('E30'))).toBe(true)
    expect(bunnikRoutes.every((route) => route.mode === 'trunk' && route.nominalCapacity === 260)).toBe(true)
  })

  it('connects Capelle and Krimpen through the audited N210 Algerabrug for mobility and supply only', () => {
    const algerabrug = generatedTransport.routes.find(
      (route) => route.id === 'audited-road-n210-algerabrug',
    )
    expect(algerabrug).toMatchObject({
      name: 'N210 / Algerabrug',
      from: 'GM0502',
      to: 'GM0542',
      mode: 'regional',
      nominalCapacity: 150,
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
      sourceFeatureIds: ['NWB-198273080', 'NWB-198273045'],
      physicalCorridorId: 'audited-N210-Algerabrug',
      corridorIdentityStatus: 'resolved',
    })
    expect(algerabrug?.statusSemantics).toContain('passability, throughput and bridge state remain unknown')
  })

  it('keeps the N216 Schoonhoven-Gelkenes crossing as a non-causal ferry with unknown capacity', () => {
    const ferry = generatedTransport.routes.find(
      (route) => route.id === 'nwb-link-933-GM1931-GM1978',
    )
    expect(ferry).toMatchObject({
      name: 'N216 / Veerdienst Schoonhoven–Gelkenes',
      from: 'GM1931',
      to: 'GM1978',
      mode: 'ferry',
      nominalCapacity: 0,
      capacitySemantics: 'unknown',
      affectsSimulation: false,
      supportedServices: ['mobility', 'supply'],
      sourceFeatureIds: ['NWB-600441023', 'NWB-600441055'],
      sourceRoadPartClasses: ['VDA'],
      physicalCorridorId: 'audited-N216-Schoonhoven-Gelkenes',
      corridorIdentityStatus: 'resolved',
    })
    expect(ferry?.statusSemantics).toContain('Scenario-time sailing')
    expect(ferry?.publishedScheduleContext?.simulationEffect).toBe('context-only')

    const endpoints = municipalities.filter((city) =>
      ['GM1931', 'GM1978'].includes(city.code),
    )
    expect(endpoints).toHaveLength(2)
    for (const selectedLayer of ['mobility', 'supply'] as const) {
      const frame = simulateFrame(endpoints, 0, { selectedLayer }, [ferry!])
      expect(frame.routes).toEqual([])
      expect(frame.routesByService[selectedLayer]).toEqual([])
    }
  })

  it('keeps the dated Spanjaardsbrug crossing visible as non-causal local context', () => {
    const crossing = generatedTransport.routes.find(
      (route) => route.id === 'audited-road-lage-rijndijk-spanjaardsbrug',
    )
    expect(crossing).toMatchObject({
      name: 'Lage Rijndijk / Spanjaardsbrug',
      from: 'GM0546',
      to: 'GM0547',
      mode: 'local',
      nominalCapacity: 0,
      capacitySemantics: 'unknown',
      affectsSimulation: false,
      supportedServices: ['mobility', 'supply'],
      physicalCorridorId: 'audited-Lage-Rijndijk-Spanjaardsbrug',
      corridorIdentityStatus: 'resolved',
    })
    expect(crossing?.sourceFeatureIds).toEqual(
      expect.arrayContaining(['NWB-190328122', 'NWB-600420705']),
    )
    expect(crossing?.statusSemantics).toContain('excluded from causal transfers')

    const endpoints = municipalities.filter((city) =>
      ['GM0546', 'GM0547'].includes(city.code),
    )
    expect(endpoints).toHaveLength(2)
    for (const selectedLayer of ['mobility', 'supply'] as const) {
      const frame = simulateFrame(endpoints, 0, { selectedLayer }, [crossing!])
      expect(frame.routes).toEqual([])
      expect(frame.routesByService[selectedLayer]).toEqual([])
    }
  })

  it('keeps the dated internal Lingewaard Rijndijk segment non-causal', () => {
    const route = generatedTransport.routes.find(
      (candidate) => candidate.id === 'audited-road-rijndijk-angeren-doornenburg',
    )
    expect(route).toMatchObject({
      name: 'Rijndijk Angeren–Doornenburg',
      from: 'GM1705',
      to: 'GM1705',
      mode: 'local',
      nominalCapacity: 0,
      capacitySemantics: 'unknown',
      affectsSimulation: false,
      supportedServices: ['mobility', 'supply'],
      sourceFeatureIds: ['NWB-389272008', 'NWB-391270006'],
      physicalCorridorId: 'audited-Rijndijk-Angeren-Doornenburg',
      corridorIdentityStatus: 'resolved',
    })
    expect(route?.statusSemantics).toContain('excluded from causal transfers')

    const municipality = municipalities.filter((city) => city.code === 'GM1705')
    expect(municipality).toHaveLength(1)
    for (const selectedLayer of ['mobility', 'supply'] as const) {
      const frame = simulateFrame(municipality, 0, { selectedLayer }, [route!])
      expect(frame.routes).toEqual([])
      expect(frame.routesByService[selectedLayer]).toEqual([])
    }
  })

  it('connects Goirle and Tilburg through the audited N630 crossing without inventing Belgian state', () => {
    const n630 = generatedTransport.routes.find(
      (route) => route.id === 'audited-road-n630-goirle-tilburg',
    )
    expect(n630).toMatchObject({
      name: 'N630',
      from: 'GM0785',
      to: 'GM0855',
      mode: 'regional',
      nominalCapacity: 150,
      supportedServices: ['mobility', 'supply'],
      capacitySemantics: 'scenario-units',
      sourceFeatureIds: ['NWB-600770839', 'NWB-262187028'],
      physicalCorridorId: 'audited-N630-Turnhoutsebaan',
      corridorIdentityStatus: 'resolved',
      audit: 'GM0785-ZERO-TRANSPORT-001',
    })
    expect(n630?.statusSemantics).toContain('Belgian N12/Poppel/Turnhout continuation remain unknown')
    expect(n630?.coordinates).toHaveLength(13)
  })

  it('retains the audited N806 boundary continuation between Bunschoten and Nijkerk', () => {
    const routes = generatedTransport.routes.filter(
      (route) =>
        [route.from, route.to].sort().join('--') === ['GM0313', 'GM0267'].sort().join('--') &&
        (route.name === 'N806' || route.aliases?.includes('N806')),
    )
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      name: 'N806',
      mode: 'regional',
      nominalCapacity: 150,
      physicalCorridorId: 'NWB-road-806',
      sourceFeatureIds: expect.arrayContaining(['NWB-601359433', 'NWB-311342002']),
    })
  })

  it('keeps Deurne N279 shared provenance as two series edges rather than parallel capacity', () => {
    const routes = generatedTransport.routes.filter(
      (route) =>
        route.physicalCorridorId === 'NWB-road-279' &&
        route.sourceFeatureIds?.includes('NWB-357167009'),
    )
    expect(routes).toHaveLength(2)
    expect(routes.map((route) => [route.from, route.to].sort().join('--')).sort()).toEqual([
      ['GM0743', 'GM0762'].sort().join('--'),
      ['GM0762', 'GM0794'].sort().join('--'),
    ].sort())
    expect(routes.every((route) => route.nominalCapacity === 150)).toBe(true)
    expect(routes.every((route) => route.capacitySemantics === 'scenario-units')).toBe(true)
    expect(routes.every(
      (route) => route.sharedSectionProvenance?.relation === 'series-corridor',
    )).toBe(true)
    expect(routes[0].sharedSectionProvenance?.note).toContain('not parallel capacity')
  })

  it('keeps Eindhoven A2 access ramps as provenance rather than a third 002 corridor', () => {
    const routes = generatedTransport.routes.filter(
      (route) =>
        [route.from, route.to].sort().join('--') ===
        ['GM0772', 'GM0866'].sort().join('--'),
    )
    expect(routes.map((route) => route.name).sort()).toEqual(['A2', 'A67', 'N2'])
    expect(routes.find((route) => route.name === '002')).toBeUndefined()

    const a2 = routes.find((route) => route.name === 'A2')
    expect(a2).toMatchObject({
      mode: 'trunk',
      nominalCapacity: 260,
      capacitySemantics: 'scenario-units',
      supportedServices: ['mobility', 'supply'],
      sourceFeatureIds: expect.arrayContaining(['NWB-325158020', 'NWB-326158032']),
      sourceSignedRoadNumbers: ['A2'],
      sourceAdministrativeRoadNumbers: ['RW2'],
      sourceRoadPartClasses: expect.arrayContaining(['HR', 'OPR']),
    })
  })

  it('labels Goeree-Overflakkee eastern crossings by signed A29 while retaining RW4 provenance', () => {
    const expectedPairs = [
      ['GM1924', 'GM1963'].sort().join('--'),
      ['GM1709', 'GM1924'].sort().join('--'),
    ].sort()
    const routes = generatedTransport.routes.filter(
      (route) =>
        expectedPairs.includes([route.from, route.to].sort().join('--')) &&
        route.name === 'A29',
    )
    expect(routes).toHaveLength(2)
    expect(routes.map((route) => [route.from, route.to].sort().join('--')).sort()).toEqual(expectedPairs)
    expect(routes.every((route) => route.aliases?.includes('A4'))).toBe(true)
    expect(routes.every((route) => route.sourceSignedRoadNumbers?.join() === 'A29')).toBe(true)
    expect(routes.every((route) => route.sourceAdministrativeRoadNumbers?.includes('RW4'))).toBe(true)
    expect(routes.every((route) => route.physicalCorridorId === 'NWB-road-4')).toBe(true)
    expect(routes.every((route) => route.mode === 'trunk' && route.nominalCapacity === 260)).toBe(true)
    expect(routes.every((route) => Array.isArray(route.audit) && route.audit.includes('GM1924-ROAD-IDENTITY-001'))).toBe(true)
  })

  it('keeps the Houtribdijk as one N307 corridor rather than three additive names', () => {
    const routes = generatedTransport.routes.filter(
      (route) =>
        [route.from, route.to].sort().join('--') ===
        ['GM0388', 'GM0995'].sort().join('--'),
    )
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      name: 'N307',
      aliases: ['Markermeerdijk', 'Markerwaarddijk'],
      mode: 'regional',
      nominalCapacity: 150,
      capacitySemantics: 'scenario-units',
      supportedServices: ['mobility', 'supply'],
      physicalCorridorId: 'NWB-road-307',
      sourceFeatureIds: expect.arrayContaining([
        'NWB-296445006',
        'NWB-296445012',
        'NWB-600135510',
        'NWB-601298392',
        'NWB-601298394',
        'NWB-601298396',
        'NWB-601645248',
        'NWB-601645557',
      ]),
      sourceRoadPartClasses: ['HR', 'PAR', 'RB'],
      audit: ['GM0388-NETWORK-001'],
    })
  })

  it('never assigns one NWB source section to parallel corridors for the same municipality pair', () => {
    const corridorByPairAndSourceFeature = new Map<string, string>()
    for (const route of generatedTransport.routes) {
      if (route.source !== 'NWB') continue
      const pair = [route.from, route.to].sort().join('--')
      const corridor = route.physicalCorridorId ?? `route:${route.name}`
      for (const sourceFeatureId of route.sourceFeatureIds ?? []) {
        const key = `${pair}--${sourceFeatureId}`
        const existing = corridorByPairAndSourceFeature.get(key)
        expect(
          existing === undefined || existing === corridor,
          `${sourceFeatureId} is assigned to both ${existing} and ${corridor} for ${pair}`,
        ).toBe(true)
        corridorByPairAndSourceFeature.set(key, corridor)
      }
    }
  })

  it('keeps the Drechterland N307 and N506 source sections in their physical corridors', () => {
    const routes = generatedTransport.routes.filter(
      (route) =>
        [route.from, route.to].sort().join('--') === ['GM0498', 'GM0532'].sort().join('--') &&
        (route.name === 'N307' || route.name === 'N506'),
    )
    const n307 = routes.find((route) => route.name === 'N307')
    const n506 = routes.find((route) => route.name === 'N506')
    expect(n307).toMatchObject({ physicalCorridorId: 'NWB-road-307' })
    expect(n506).toMatchObject({
      physicalCorridorId: 'NWB-road-506',
      sourceFeatureIds: expect.arrayContaining(['NWB-285443011', 'NWB-285443014']),
    })
    expect(n307?.sourceFeatureIds).not.toEqual(
      expect.arrayContaining(['NWB-285443011', 'NWB-285443014']),
    )
  })

  it('contains every current municipality and forms one connected national graph', () => {
    expect(municipalities).toHaveLength(342)
    const routes = buildNationalNetwork(municipalities)
    const adjacency = new Map(municipalities.map((city) => [city.code, new Set<string>()]))
    for (const route of routes) {
      adjacency.get(route.from)!.add(route.to)
      adjacency.get(route.to)!.add(route.from)
    }
    const visited = new Set<string>()
    const pending = [municipalities[0].code]
    while (pending.length) {
      const current = pending.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      for (const neighbor of adjacency.get(current) ?? []) pending.push(neighbor)
    }
    expect(visited.size).toBe(municipalities.length)
  })

  it('applies audited direct-hazard exclusions without removing indirect smoke context', () => {
    const aalten = municipalities.find((city) => city.code === 'GM0197')!
    const almelo = municipalities.find((city) => city.code === 'GM0141')!
    const alphenChaam = municipalities.find((city) => city.code === 'GM1723')!
    const amstelveen = municipalities.find((city) => city.code === 'GM0362')!
    const amsterdam = municipalities.find((city) => city.code === 'GM0363')!
    const apeldoorn = municipalities.find((city) => city.code === 'GM0200')!
    const asten = municipalities.find((city) => city.code === 'GM0743')!
    const baarleNassau = municipalities.find((city) => city.code === 'GM0744')!
    const barendrecht = municipalities.find((city) => city.code === 'GM0489')!
    const barneveld = municipalities.find((city) => city.code === 'GM0203')!
    const beek = municipalities.find((city) => city.code === 'GM0888')!
    const beesel = municipalities.find((city) => city.code === 'GM0889')!
    const beekdaelen = municipalities.find((city) => city.code === 'GM1954')!
    const bergeijk = municipalities.find((city) => city.code === 'GM1724')!
    const bergenL = municipalities.find((city) => city.code === 'GM0893')!
    const bergEnDal = municipalities.find((city) => city.code === 'GM1945')!
    const bergenNh = municipalities.find((city) => city.code === 'GM0373')!
    const bernheze = municipalities.find((city) => city.code === 'GM1721')!
    const berkelland = municipalities.find((city) => city.code === 'GM1859')!
    const best = municipalities.find((city) => city.code === 'GM0753')!
    const beuningen = municipalities.find((city) => city.code === 'GM0209')!
    const beverwijk = municipalities.find((city) => city.code === 'GM0375')!
    const bladel = municipalities.find((city) => city.code === 'GM1728')!
    const blaricum = municipalities.find((city) => city.code === 'GM0376')!
    const bodegravenReeuwijk = municipalities.find((city) => city.code === 'GM1901')!
    const boekel = municipalities.find((city) => city.code === 'GM0755')!
    const bloemendaal = municipalities.find((city) => city.code === 'GM0377')!
    const baarn = municipalities.find((city) => city.code === 'GM0308')!
    const achtkarspelen = municipalities.find((city) => city.code === 'GM0059')!
    const aalsmeer = municipalities.find((city) => city.code === 'GM0358')!

    expect(simulateFrame([aalten], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, []).municipalities[0].hazard.floodDepthM).toBe(0)
    expect(simulateFrame([almelo], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, []).municipalities[0].hazard.floodDepthM).toBe(0)
    expect(simulateFrame([alphenChaam], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, []).municipalities[0].hazard.floodDepthM).toBe(0)
    expect(simulateFrame([amstelveen], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, []).municipalities[0].hazard.floodDepthM).toBe(0)
    const amsterdamRiver = simulateFrame([amsterdam], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(amsterdamRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(amsterdamRiver.municipalities[0].hazard.evidenceNote).toContain('unknown, not an all-clear')
    expect(amsterdamRiver.municipalities[0].hazard.explanation.summary).toContain('LIWO')
    expect(amsterdamRiver.unsupportedHazardMunicipalities).toEqual(['GM0363'])
    const apeldoornRiver = simulateFrame([apeldoorn], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(apeldoornRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(apeldoornRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(apeldoornRiver.municipalities[0].hazard.evidenceNote).toContain('unsupported, not a forecast')
    expect(apeldoornRiver.unsupportedHazardMunicipalities).toEqual(['GM0200'])
    const astenRiver = simulateFrame([asten], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(astenRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(astenRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(astenRiver.municipalities[0].hazard.evidenceNote).toContain('spatially unresolved, not safe')
    expect(astenRiver.unsupportedHazardMunicipalities).toEqual(['GM0743'])
    const baarleRiver = simulateFrame([baarleNassau], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(baarleRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(baarleRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(baarleRiver.municipalities[0].hazard.evidenceNote).toContain('cross-border water-system dependencies')
    expect(baarleRiver.unsupportedHazardMunicipalities).toEqual(['GM0744'])
    const barendrechtRiver = simulateFrame([barendrecht], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(barendrechtRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(barendrechtRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(barendrechtRiver.municipalities[0].hazard.evidenceNote).toContain('IJsselmonde compartment')
    const barendrechtCoastal = simulateFrame([barendrecht], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, [])
    expect(barendrechtCoastal.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(barendrechtCoastal.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    const barendrechtPluvial = simulateFrame([barendrecht], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(barendrechtPluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(barendrechtPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(barendrechtPluvial.municipalities[0].hazard.evidenceNote).toContain('Paddewei')
    const barneveldRiver = simulateFrame([barneveld], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(barneveldRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(barneveldRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(barneveldRiver.municipalities[0].hazard.evidenceNote).toContain('location-bound major-river')
    const barneveldWildfire = simulateFrame([barneveld], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire'),
    }, [])
    expect(barneveldWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(barneveldWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(barneveldWildfire.municipalities[0].hazard.evidenceNote).toContain('Buitengebied Kootwijk')
    for (const [city, placeName] of [
      [beek, 'Geleenbeek'],
      [beekdaelen, 'Geleenbeek'],
    ] as const) {
      const river = simulateFrame([city], 288, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig('river-flood'),
      }, [])
      expect(river.municipalities[0].hazard.floodDepthM).toBe(0)
      expect(river.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
      expect(river.municipalities[0].hazard.evidenceNote).toContain(placeName)
      const pluvial = simulateFrame([city], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig('pluvial-flood'),
      }, [])
      expect(pluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
      expect(pluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    }
    const beeselRiver = simulateFrame([beesel], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(beeselRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(beeselRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(beeselRiver.municipalities[0].hazard.evidenceNote).toContain('reinforcement completed in 2022')
    const beeselPluvial = simulateFrame([beesel], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(beeselPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(beeselPluvial.municipalities[0].hazard.evidenceNote).toContain('Schelkensbeek')
    const bergeijkRiver = simulateFrame([bergeijk], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(bergeijkRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(bergeijkRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergeijkRiver.municipalities[0].hazard.evidenceNote).toContain('outside direct sea and large-river influence')
    const bergeijkPluvial = simulateFrame([bergeijk], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(bergeijkPluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bergeijkPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergeijkPluvial.municipalities[0].hazard.evidenceNote).toContain('Weebosch')
    const bergeijkWildfire = simulateFrame([bergeijk], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire', { epicenter: [5.2527, 51.2842] }),
    }, [])
    expect(bergeijkWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(bergeijkWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergeijkWildfire.municipalities[0].hazard.evidenceNote).toContain('De Pielis')
    const bergenRiver = simulateFrame([bergenL], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(bergenRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bergenRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergenRiver.municipalities[0].hazard.evidenceNote).toContain('defence state')
    const bergenPluvial = simulateFrame([bergenL], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(bergenPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    const bergenWildfire = simulateFrame([bergenL], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire'),
    }, [])
    expect(bergenWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergenWildfire.municipalities[0].hazard.evidenceNote).toContain('Maasduinen')
    const bergEnDalRiver = simulateFrame([bergEnDal], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(bergEnDalRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bergEnDalRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergEnDalRiver.municipalities[0].hazard.evidenceNote).toContain('Ooijpolder')
    const bergEnDalPluvial = simulateFrame([bergEnDal], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(bergEnDalPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergEnDalPluvial.municipalities[0].hazard.evidenceNote).toContain('Breedeweg')
    const bergEnDalWildfire = simulateFrame([bergEnDal], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire'),
    }, [])
    expect(bergEnDalWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergEnDalWildfire.municipalities[0].hazard.evidenceNote).toContain('Groesbeek')
    const bergenNhCoastal = simulateFrame([bergenNh], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, [])
    expect(bergenNhCoastal.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bergenNhCoastal.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergenNhCoastal.municipalities[0].hazard.evidenceNote).toContain('failed dune or defence section')
    const bergenNhPluvial = simulateFrame([bergenNh], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(bergenNhPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergenNhPluvial.municipalities[0].hazard.evidenceNote).toContain('Sammerspolder')
    const bergenNhWildfire = simulateFrame([bergenNh], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire', { epicenter: [4.645, 52.7] }),
    }, [])
    expect(bergenNhWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(bergenNhWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bergenNhWildfire.municipalities[0].hazard.evidenceNote).toContain('Schoorl')
    const bernhezeRiver = simulateFrame([bernheze], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(bernhezeRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(bernhezeRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bernhezeRiver.municipalities[0].hazard.evidenceNote).toContain('Aa, Leijgraaf')
    expect(bernhezeRiver.unsupportedHazardMunicipalities).toEqual(['GM1721'])
    const bernhezePluvial = simulateFrame([bernheze], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(bernhezePluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bernhezePluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bernhezePluvial.municipalities[0].hazard.evidenceNote).toContain('Peelland-fault')
    const bernhezeWildfire = simulateFrame([bernheze], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire', { epicenter: [5.552221405163929, 51.72449837556086] }),
    }, [])
    expect(bernhezeWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(bernhezeWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bernhezeWildfire.municipalities[0].hazard.evidenceNote).toContain('Hooge Wijst')
    const berkellandRiver = simulateFrame([berkelland], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(berkellandRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(berkellandRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(berkellandRiver.municipalities[0].hazard.evidenceNote).toContain('probability band')
    const berkellandPluvial = simulateFrame([berkelland], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(berkellandPluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(berkellandPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(berkellandPluvial.municipalities[0].hazard.evidenceNote).toContain('road-passability')
    const berkellandWildfire = simulateFrame([berkelland], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire'),
    }, [])
    expect(berkellandWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(berkellandWildfire.municipalities[0].hazard.evidenceNote).toContain('remote-smoke exercise')
    const bestRiver = simulateFrame([best], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(bestRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(bestRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bestRiver.municipalities[0].hazard.evidenceNote).toContain('blocked southern drainage')
    expect(bestRiver.unsupportedHazardMunicipalities).toEqual(['GM0753'])
    const bestPluvial = simulateFrame([best], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(bestPluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bestPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bestPluvial.municipalities[0].hazard.evidenceNote).toContain('Breeven')
    const bestHeat = simulateFrame([best], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('heatwave'),
    }, [])
    expect(bestHeat.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bestHeat.municipalities[0].hazard.evidenceNote).toContain('hottest areas')
    const bestWildfire = simulateFrame([best], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire', { epicenter: [5.383370097504299, 51.4904495404155] }),
    }, [])
    expect(bestWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(bestWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bestWildfire.municipalities[0].hazard.evidenceNote).toContain('Aarlesche Erven')
    const beuningenRiver = simulateFrame([beuningen], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(beuningenRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(beuningenRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(beuningenRiver.municipalities[0].hazard.evidenceNote).toContain('Zuidelijke Waaldijk')
    expect(beuningenRiver.unsupportedHazardMunicipalities).toEqual(['GM0209'])
    const beuningenPluvial = simulateFrame([beuningen], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(beuningenPluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(beuningenPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(beuningenPluvial.municipalities[0].hazard.evidenceNote).toContain('pressure-sewer')
    const beuningenWildfire = simulateFrame([beuningen], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire', { epicenter: [5.784703235846653, 51.86918500969368] }),
    }, [])
    expect(beuningenWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(beuningenWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(beuningenWildfire.municipalities[0].hazard.evidenceNote).toContain('source containment')
    const bladelRiver = simulateFrame([bladel], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(bladelRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(bladelRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bladelRiver.municipalities[0].hazard.evidenceNote).toContain('blocked southern drainage')
    expect(bladelRiver.unsupportedHazardMunicipalities).toEqual(['GM1728'])
    const bladelPluvial = simulateFrame([bladel], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(bladelPluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bladelPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bladelPluvial.municipalities[0].hazard.evidenceNote).toContain('native versioned stress-test')
    const bladelWildfire = simulateFrame([bladel], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire', { epicenter: [5.223, 51.348] }),
    }, [])
    expect(bladelWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(bladelWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(bladelWildfire.municipalities[0].hazard.evidenceNote).toContain('Ten Vorsel')
    for (const [disaster, evidence] of [
      ['severe-storm', 'shared seed'],
      ['pluvial-flood', 'Wijkermeerpolder'],
      ['coastal-flood', 'Hoogovens'],
      ['heatwave', 'surface-temperature'],
      ['winter-storm', 'tunnel'],
      ['cyberattack', 'declared target'],
      ['wildfire', 'dune-fire'],
    ] as const) {
      const beverwijkHazard = simulateFrame([beverwijk], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, [])
      expect(beverwijkHazard.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
      expect(beverwijkHazard.municipalities[0].hazard.evidenceNote).toContain(evidence)
      expect(beverwijkHazard.unsupportedHazardMunicipalities).toEqual(['GM0375'])
    }
    const beverwijkHeat = simulateFrame([beverwijk], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('heatwave'),
    }, [])
    expect(beverwijkHeat.municipalities[0].hazard.unsupportedDimensions).toEqual(['heat', 'drought'])
    const blaricumRiver = simulateFrame([blaricum], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(blaricumRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(blaricumRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(blaricumRiver.municipalities[0].hazard.evidenceNote).toContain('Eemmeer')
    expect(blaricumRiver.unsupportedHazardMunicipalities).toEqual(['GM0376'])
    const blaricumPluvial = simulateFrame([blaricum], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('pluvial-flood'),
    }, [])
    expect(blaricumPluvial.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(blaricumPluvial.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(blaricumPluvial.municipalities[0].hazard.evidenceNote).toContain('Park Laagwatersloot')
    const blaricumWildfire = simulateFrame([blaricum], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire', { epicenter: [5.21718211689071, 52.27399091655463] }),
    }, [])
    expect(blaricumWildfire.municipalities[0].hazard.wildfireIntensity).toBeGreaterThan(0)
    expect(blaricumWildfire.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(blaricumWildfire.municipalities[0].hazard.evidenceNote).toContain('Blaricummer Heide')
    for (const [disaster, evidence] of [
      ['severe-storm', 'shared seed'],
      ['pluvial-flood', 'polder/boezem'],
      ['river-flood', 'Dijktraject 14/Lek'],
      ['coastal-flood', 'failed primary or regional defence'],
      ['heatwave', 'peat'],
      ['winter-storm', 'A12/N11/rail'],
      ['cyberattack', 'declared target'],
      ['wildfire', 'fiftieth'],
    ] as const) {
      const bodegravenHazard = simulateFrame([bodegravenReeuwijk], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(
          disaster,
          disaster === 'wildfire'
            ? { epicenter: [4.745394594547766, 52.0557267221745] }
            : {},
        ),
      }, [])
      expect(bodegravenHazard.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
      expect(bodegravenHazard.municipalities[0].hazard.evidenceNote).toContain(evidence)
      expect(bodegravenHazard.unsupportedHazardMunicipalities).toEqual(['GM1901'])
    }
    const bodegravenRiver = simulateFrame([bodegravenReeuwijk], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    const bodegravenCoastal = simulateFrame([bodegravenReeuwijk], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, [])
    expect(bodegravenRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bodegravenCoastal.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bodegravenRiver.municipalities[0].hazard.unsupportedDimensions).toEqual(['flood'])
    expect(bodegravenCoastal.municipalities[0].hazard.unsupportedDimensions).toEqual(['flood'])
    const boekelRiver = simulateFrame([boekel], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(boekelRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(boekelRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(boekelRiver.municipalities[0].hazard.evidenceNote).toContain('Leijgraaf')
    expect(boekelRiver.unsupportedHazardMunicipalities).toEqual(['GM0755'])
    for (const [disaster, evidence, config] of [
      ['pluvial-flood', 'Boschberg', {}],
      ['heatwave', 'wet-wijst', {}],
      ['wildfire', '3.409 kilometres', { epicenter: [5.6955, 51.624] }],
    ] as const) {
      const boekelHazard = simulateFrame([boekel], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      expect(boekelHazard.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
      expect(boekelHazard.municipalities[0].hazard.evidenceNote).toContain(evidence)
      expect(boekelHazard.unsupportedHazardMunicipalities).toEqual(['GM0755'])
    }
    for (const [disaster, evidence] of [
      ['coastal-flood', 'Rijnland defence'],
      ['pluvial-flood', 'dune-to-polder'],
      ['heatwave', 'resident/visitor'],
      ['wildfire', '1,699-hectare dune/beach'],
    ] as const) {
      const bloemendaalHazard = simulateFrame([bloemendaal], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, [])
      expect(bloemendaalHazard.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
      expect(bloemendaalHazard.municipalities[0].hazard.evidenceNote).toContain(evidence)
      expect(bloemendaalHazard.unsupportedHazardMunicipalities).toEqual(['GM0377'])
    }
    const bloemendaalCoastal = simulateFrame([bloemendaal], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, [])
    expect(bloemendaalCoastal.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(bloemendaalCoastal.municipalities[0].hazard.unsupportedDimensions).toEqual(['flood'])
    const baarnRiver = simulateFrame([baarn], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(baarnRiver.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(baarnRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(baarnRiver.municipalities[0].hazard.evidenceNote).toContain('unsupported, not an official prediction')
    expect(baarnRiver.unsupportedHazardMunicipalities).toEqual(['GM0308'])
    expect(simulateFrame([achtkarspelen], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, []).municipalities[0].hazard.floodDepthM).toBe(0)

    for (const city of [aalten, achtkarspelen, aalsmeer]) {
      const hazard = simulateFrame([city], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig('wildfire'),
      }, []).municipalities[0].hazard
      expect(hazard.wildfireIntensity).toBe(0)
      expect(hazard.smokeSeverity).toBeGreaterThan(0)
    }

    const arnhem = municipalities.find((city) => city.code === 'GM0202')!
    const arnhemWildfire = simulateFrame([arnhem], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('wildfire'),
    }, []).municipalities[0].hazard
    expect(arnhemWildfire.wildfireIntensity).toBe(0)
    expect(arnhemWildfire.smokeSeverity).toBeGreaterThan(0)
    expect(arnhemWildfire.unsupportedDimensions).toContain('fire')
    expect(arnhemWildfire.evidenceNote).toContain('spatially unresolved, not zero')
  })

  it('applies recent independent municipality audit guards with coherent coastal wind attribution', () => {
    const borne = municipalities.find((city) => city.code === 'GM0147')!
    const borsele = municipalities.find((city) => city.code === 'GM0654')!
    const borgerOdoorn = municipalities.find((city) => city.code === 'GM1681')!
    const boxtel = municipalities.find((city) => city.code === 'GM0757')!
    const bronckhorst = municipalities.find((city) => city.code === 'GM1876')!
    const breda = municipalities.find((city) => city.code === 'GM0758')!
    const brummen = municipalities.find((city) => city.code === 'GM0213')!
    const brunssum = municipalities.find((city) => city.code === 'GM0899')!
    const bunschoten = municipalities.find((city) => city.code === 'GM0313')!
    const buren = municipalities.find((city) => city.code === 'GM0214')!
    const capelle = municipalities.find((city) => city.code === 'GM0502')!
    const castricum = municipalities.find((city) => city.code === 'GM0383')!
    const cranendonck = municipalities.find((city) => city.code === 'GM1706')!
    const culemborg = municipalities.find((city) => city.code === 'GM0216')!
    const dalfsen = municipalities.find((city) => city.code === 'GM0148')!

    const borneRiver = simulateFrame([borne], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(borneRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(borneRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(borneRiver.municipalities[0].hazard.evidenceNote).toContain('Local brook')
    expect(borneRiver.unsupportedHazardMunicipalities).toEqual(['GM0147'])

    for (const [disaster, evidence, config] of [
      ['pluvial-flood', 'Wensink-Zuid', {}],
      ['heatwave', 'surface-temperature', {}],
      ['wildfire', 'BU01470009', { epicenter: [6.719467569482939, 52.30339366660814] }],
    ] as const) {
      const hazard = simulateFrame([borne], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
    }

    const borseleRiver = simulateFrame([borsele], 288, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('river-flood'),
    }, [])
    expect(borseleRiver.municipalities[0].hazard.floodDepthM).toBe(0)
    expect(borseleRiver.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(borseleRiver.municipalities[0].hazard.evidenceNote).toContain('Westerschelde')

    const borseleCoastal = simulateFrame([borsele], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, [])
    expect(borseleCoastal.municipalities[0].hazard.floodDepthM).toBeGreaterThan(0)
    expect(borseleCoastal.municipalities[0].hazard.spatialEvidence).toBe('unsupported')
    expect(borseleCoastal.municipalities[0].hazard.evidenceNote).toContain('future strengthening programme')

    for (const [disaster, evidence] of [
      ['pluvial-flood', 'Scheldestromen'],
      ['heatwave', 'Sloe'],
      ['cyberattack', 'reactor/vital control'],
      ['wildfire', 'authority-reviewed exercise'],
    ] as const) {
      const hazard = simulateFrame([borsele], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
    }

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'Hondsrug', {}],
      ['pluvial-flood', 'Hunze/Veenkoloniën', {}],
      ['heatwave', 'peat/groundwater', {}],
      ['winter-storm', 'N34/access', {}],
      ['cyberattack', 'declared target', {}],
      ['wildfire', 'eleventh', { epicenter: [6.8636904898682, 52.88152595410916] }],
    ] as const) {
      const hazard = simulateFrame([borgerOdoorn], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
    }

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'A2/rail', {}],
      ['pluvial-flood', 'Boxtel Noordwest', {}],
      ['river-flood', 'Maas–Dommel–Essche Stroom', {}],
      ['heatwave', 'surface temperature', {}],
      ['winter-storm', 'bridge or underpass', {}],
      ['cyberattack', 'declared target', {}],
      ['wildfire', 'rank third', { epicenter: boxtel.coordinates }],
    ] as const) {
      const hazard = simulateFrame([boxtel], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }

    for (const [disaster, evidence] of [
      ['river-flood', 'Roode Beek'],
      ['pluvial-flood', 'road-passability'],
      ['heatwave', 'temperature'],
      ['earthquake', 'former-coal-mining'],
      ['wildfire', 'Brunssummerheide'],
    ] as const) {
      const hazard = simulateFrame([brunssum], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
    }

    for (const [disaster, evidence] of [
      ['severe-storm', 'Eemmeer setup'],
      ['pluvial-flood', 'low-polder'],
      ['river-flood', 'Eem inflow'],
      ['coastal-flood', 'Randmeren'],
      ['heatwave', 'resident/visitor'],
      ['winter-storm', 'ferry'],
      ['cyberattack', 'declared target'],
      ['earthquake', 'local soil/site response'],
      ['wildfire', 'remote-smoke exercise'],
    ] as const) {
      const hazard = simulateFrame([bunschoten], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBe(0)
      }
    }

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'dispersed-core', {}],
      ['pluvial-flood', '126 measured-floor ingress buildings', {}],
      ['river-flood', 'retained amplitude is diagnostic only', {}],
      ['coastal-flood', 'Zero direct coastal water is not an all-clear', {}],
      ['heatwave', 'Lienden', {}],
      ['winter-storm', 'dispersed-road', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Buren ground-motion surface', {}],
      ['wildfire', 'BU02140206', { epicenter: [5.444801850736001, 51.93125639622181] }],
    ] as const) {
      const hazard = simulateFrame([buren], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }

    for (const [disaster, evidence] of [
      ['severe-storm', 'high-rise'],
      ['pluvial-flood', '3,063 affected-building polygons'],
      ['river-flood', 'Hollandsche IJsselkering state'],
      ['coastal-flood', 'barrier- and defence-dependent'],
      ['heatwave', 'vulnerable-object layers'],
      ['winter-storm', 'Algerabrug'],
      ['cyberattack', 'declared target'],
      ['earthquake', 'soft-soil/site response'],
      ['wildfire', 'remote-smoke exercise'],
    ] as const) {
      const hazard = simulateFrame([capelle], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBeGreaterThan(0)
      }
    }

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'ferry', {}],
      ['pluvial-flood', 'De Zanderij', {}],
      ['river-flood', 'zero is not an all-clear', {}],
      ['coastal-flood', 'managed dune defence', {}],
      ['heatwave', 'resident/visitor', {}],
      ['winter-storm', 'coastal access', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'dune/polder soil response', {}],
      ['wildfire', 'Limmen Oost 5.218 kilometres away', { epicenter: [4.629051192900515, 52.55316001118619] }],
    ] as const) {
      const hazard = simulateFrame([castricum], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'A2, rail, local-road', {}],
      ['pluvial-flood', 'Grootschoterweg', {}],
      ['river-flood', 'Belgian-fed brook', {}],
      ['coastal-flood', 'Zero direct coastal water is not an all-clear', {}],
      ['heatwave', 'sandy-soil/ecological drought', {}],
      ['winter-storm', 'cross-border', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Cranendonck ground-motion surface', {}],
      ['wildfire', 'rank nineteenth behind Budel', { epicenter: [5.623618463418623, 51.26502712889067] }],
    ] as const) {
      const hazard = simulateFrame([cranendonck], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBe(0)
      }
    }

    for (const [disaster, evidence] of [
      ['severe-storm', 'rail, ferry'],
      ['pluvial-flood', 'Pavijen second-last'],
      ['river-flood', 'non-operational diagnostic only'],
      ['coastal-flood', 'zero direct coastal water'],
      ['heatwave', 'Binnenstad last'],
      ['winter-storm', 'water-level-sensitive ferry'],
      ['cyberattack', 'declared target'],
      ['earthquake', 'Culemborg ground-motion surface'],
      ['wildfire', 'zero local flame'],
    ] as const) {
      const hazard = simulateFrame([culemborg], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'Vecht bridge', {}],
      ['pluvial-flood', 'sewer/catchment', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'zero direct coastal water', {}],
      ['heatwave', 'older-resident', {}],
      ['winter-storm', 'rural-road', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Dalfsen ground-motion surface', {}],
      ['wildfire', 'thirty-second of thirty-six', { epicenter: [6.315564174394882, 52.49855405887393] }],
    ] as const) {
      const hazard = simulateFrame([dalfsen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }

    for (const [disaster, evidence] of [
      ['pluvial-flood', 'WRIJ T100/T1000'],
      ['river-flood', 'Hackfort breach'],
      ['heatwave', 'surface temperature'],
      ['wildfire', 'Wildenborch'],
    ] as const) {
      const hazard = simulateFrame([bronckhorst], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }

    for (const [disaster, evidence] of [
      ['river-flood', 'Bovenmark'],
      ['pluvial-flood', 'road-passability'],
      ['heatwave', 'PET heat surface'],
      ['wildfire', 'forty-eighth'],
    ] as const) {
      const hazard = simulateFrame([breda], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
    }

    for (const [disaster, evidence] of [
      ['severe-storm', 'IJssel crossing'],
      ['pluvial-flood', 'extraction-regime'],
      ['river-flood', '72/48/24-hour'],
      ['coastal-flood', 'zero direct coastal water'],
      ['heatwave', 'surface temperature'],
      ['winter-storm', 'ferry'],
      ['cyberattack', 'declared target'],
      ['earthquake', 'VNOG'],
      ['wildfire', 'twenty-eighth'],
    ] as const) {
      const hazard = simulateFrame([brummen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, []).municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }

    const activeCoastalWind = simulateFrame([borgerOdoorn], 96, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, []).municipalities[0]
    expect(activeCoastalWind.hazard.floodDepthM).toBe(0)
    expect(activeCoastalWind.hazard.windGustMs).toBeGreaterThan(15)
    expect(activeCoastalWind.hazard.severity).toBeGreaterThan(0)
    expect(activeCoastalWind.hazard.explanation.dominantDimension).toBe('wind')
    expect(activeCoastalWind.hazard.spatialEvidence).toBe('unsupported')
    expect(activeCoastalWind.hazard.unsupportedDimensions).toEqual(['flood', 'wind'])
    expect(activeCoastalWind.hazard.explanation.summary).toContain(
      'independent municipality audit is correction-required',
    )
    const coastalNoEvent = simulateFrame([borgerOdoorn], 96, {
      selectedLayer: 'hazard',
      scenario: { ...createScenarioConfig('coastal-flood'), intensity: 0 },
    }, []).municipalities[0]
    for (const service of Object.keys(activeCoastalWind.services) as Array<
      keyof typeof activeCoastalWind.services
    >) {
      expect(activeCoastalWind.services[service].availability, service).toBeCloseTo(
        coastalNoEvent.services[service].availability,
        12,
      )
    }

    const residualCoastalDamage = simulateFrame([borgerOdoorn], 192, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('coastal-flood'),
    }, []).municipalities[0]
    expect(residualCoastalDamage.hazard.windGustMs).toBe(0)
    expect(residualCoastalDamage.hazard.explanation.summary).toContain('previously accumulated service damage')
    expect(residualCoastalDamage.deprivedPersonHours).toBe(0)
  })

  it('keeps Coevorden, De Bilt and Dantumadiel local hazard precision explicitly unsupported', () => {
    const coevorden = municipalities.find((city) => city.code === 'GM0109')!
    const deBilt = municipalities.find((city) => city.code === 'GM0310')!
    const dantumadiel = municipalities.find((city) => city.code === 'GM1891')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'A27/A28/N-road', {}],
      ['pluvial-flood', 'Maartensdijk, De Bilt, Westbroek', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'scoped zero is not an all-clear', {}],
      ['heatwave', 'Province Utrecht diagnostics', {}],
      ['winter-storm', 'bridge/underpass', {}],
      ['cyberattack', 'USPB', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'fourteenth', { epicenter: [5.212449744946065, 52.17325317011313] }],
    ] as const) {
      const frame = simulateFrame([deBilt], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0310'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }

    for (const [disaster, evidence] of [
      ['severe-storm', 'rural road'],
      ['pluvial-flood', 'pressure-sewer/pump'],
      ['river-flood', 'zero is not an all-clear'],
      ['coastal-flood', 'non-operational diagnostic only'],
      ['heatwave', 'salinization'],
      ['winter-storm', 'De Westereen/Feanwâlden'],
      ['cyberattack', 'declared target'],
      ['earthquake', 'observed FDSN origin catalogue'],
      ['wildfire', 'Omission from a planning risk profile'],
    ] as const) {
      const frame = simulateFrame([dantumadiel], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1891'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'cross-border', {}],
      ['pluvial-flood', 'three-waterboard', {}],
      ['river-flood', 'numerically neutral for Coevorden', {}],
      ['coastal-flood', 'scoped zero is not an all-clear', {}],
      ['heatwave', 'peat/groundwater', {}],
      ['winter-storm', 'rail/waterway terminal', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Drenthe induced-seismic context', {}],
      ['wildfire', 'Lootuinen nearly twelve kilometres away', { epicenter: [6.6529, 52.76252] }],
    ] as const) {
      const frame = simulateFrame([coevorden], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0109'])
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBe(0)
      }
    }
  })

  it('keeps De Fryske Marren local flood, fire and shared-seed precision explicitly unsupported', () => {
    const deFryskeMarren = municipalities.find((city) => city.code === 'GM1940')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'IJsselmeer/lake crossing', {}],
      ['pluvial-flood', 'fragmented level-area', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'narrow zero is not an all-clear', {}],
      ['heatwave', 'Annual crop declarations', {}],
      ['winter-storm', 'bridge, lock, waterway', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'observed FDSN origin catalogue', {}],
      ['wildfire', 'fortieth of seventy', { epicenter: [5.5341948109629655, 52.85271909639729] }],
    ] as const) {
      const frame = simulateFrame([deFryskeMarren], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1940'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps De Wolden local water, fire and shared-seed precision explicitly unsupported', () => {
    const deWolden = municipalities.find((city) => city.code === 'GM1690')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'bridge/culvert', {}],
      ['pluvial-flood', 'Julianaweg De Wijk', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'narrow direct-water zero is not an all-clear', {}],
      ['heatwave', 'exactly repeats unrelated flood rankings', {}],
      ['winter-storm', 'A28/N-road', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'local induced-seismic context', {}],
      ['wildfire', '6.553 kilometres away', { epicenter: [6.3885, 52.7291] }],
    ] as const) {
      const frame = simulateFrame([deWolden], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1690'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps De Ronde Venen hydraulic and shared-seed precision explicitly unsupported', () => {
    const deRondeVenen = municipalities.find((city) => city.code === 'GM0736')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'polder, bridge/culvert', {}],
      ['pluvial-flood', 'observed June 2026 event', {}],
      ['river-flood', 'AGV/WMCN-approved', {}],
      ['coastal-flood', 'non-operational diagnostic', {}],
      ['heatwave', 'Mijdrecht Dorp last', {}],
      ['winter-storm', 'Abcoude rail', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Regional omission is not proof', {}],
      ['wildfire', 'twentieth', { epicenter: [4.95, 52.22] }],
    ] as const) {
      const frame = simulateFrame([deRondeVenen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0736'])
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBeGreaterThan(0)
      }
    }
  })

  it('keeps Delft major-river forcing neutral and all local hazard precision unsupported', () => {
    const delft = municipalities.find((city) => city.code === 'GM0503')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'rail/tunnel', {}],
      ['pluvial-flood', '100 mm/two-hour footprint', {}],
      ['river-flood', 'numerically neutral', {}],
      ['coastal-flood', 'non-operational diagnostic only', {}],
      ['heatwave', 'hard-surface temperature', {}],
      ['winter-storm', 'rail tunnel', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'twenty-third of ninety-one', { epicenter: [4.363223588972437, 51.975604296103505] }],
    ] as const) {
      const frame = simulateFrame([delft], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0503'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Den Helder coastal, fire and shared-seed precision explicitly unsupported', () => {
    const denHelder = municipalities.find((city) => city.code === 'GM0400')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'dunes, harbour, ferry', {}],
      ['pluvial-flood', 'Koegraspolder', {}],
      ['river-flood', 'numerically neutral', {}],
      ['coastal-flood', 'HHNK/Rijkswaterstaat-approved', {}],
      ['heatwave', 'salinity, groundwater', {}],
      ['winter-storm', 'Kooybrug, ferry', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'zero local origin-catalogue match', {}],
      ['wildfire', 'thirty-third of sixty-five', { epicenter: [4.7256, 52.9347] }],
    ] as const) {
      const frame = simulateFrame([denHelder], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0400'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('suppresses Deurne major-river forcing and marks peat-fire and shared-seed precision unsupported', () => {
    const deurne = municipalities.find((city) => city.code === 'GM0762')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'A67/N-road', {}],
      ['pluvial-flood', '70 mm/two-hour', {}],
      ['river-flood', 'outside direct sea and large-river influence', {}],
      ['coastal-flood', 'narrow source result', {}],
      ['heatwave', 'peat, groundwater', {}],
      ['winter-storm', 'A67/N270/N279', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'months-long smoke', { epicenter: [5.8921356646208745, 51.398670857783074] }],
    ] as const) {
      const frame = simulateFrame([deurne], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0762'])
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBe(0)
      }
    }
  })

  it('keeps Deventer IJssel, source-focused fire and shared-seed precision explicitly unsupported', () => {
    const deventer = municipalities.find((city) => city.code === 'GM0150')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'IJssel crossing', {}],
      ['pluvial-flood', 'road-usability evidence', {}],
      ['river-flood', '4.50, 6.10 and 6.30 m NAP', {}],
      ['coastal-flood', 'rather than an all-clear', {}],
      ['heatwave', 'warm nights', {}],
      ['winter-storm', 'IJssel bridges or ferry', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'twenty-fifth of sixty-nine', { epicenter: [6.2999058445686495, 52.2797551883567] }],
    ] as const) {
      const frame = simulateFrame([deventer], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0150'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Dijk en Waard coastal, source-focused fire and shared-seed precision explicitly unsupported', () => {
    const dijkEnWaard = municipalities.find((city) => city.code === 'GM1980')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'polder, bridge, rail', {}],
      ['pluvial-flood', 'Zandhorst-Huygendijk', {}],
      ['river-flood', 'numerically neutral', {}],
      ['coastal-flood', 'non-operational diagnostic only', {}],
      ['heatwave', 'peat/soil, groundwater', {}],
      ['winter-storm', 'bridge, rail', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'fiftieth of sixty-nine', { epicenter: [4.836297786729, 52.66060721530275] }],
    ] as const) {
      const frame = simulateFrame([dijkEnWaard], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1980'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Diemen hydraulic, source-focused fire and shared-seed precision explicitly unsupported', () => {
    const diemen = municipalities.find((city) => city.code === 'GM0384')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'rail/metro/tram', {}],
      ['pluvial-flood', 'zero-resident Diemer Vijfhoek', {}],
      ['river-flood', 'Amsterdam-Rijnkanaal', {}],
      ['coastal-flood', 'non-operational diagnostic only', {}],
      ['heatwave', 'official PET context', {}],
      ['winter-storm', 'Gaasperdammertunnel', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'seventeenth of thirty-seven', { epicenter: [4.998458069888085, 52.32777894943194] }],
    ] as const) {
      const frame = simulateFrame([diemen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0384'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Doesburg IJssel, published-rain and source-focused fire precision explicitly unsupported', () => {
    const doesburg = municipalities.find((city) => city.code === 'GM0221')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'historic-centre, bridge', {}],
      ['pluvial-flood', 'Noordelijk and Zuidelijk Molenveld', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'narrow', {}],
      ['heatwave', 'published WRIJ heat geography', {}],
      ['winter-storm', 'bridge, N317/N338', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'eighth of eleven', { epicenter: [6.131079647350572, 51.99801875867161] }],
    ] as const) {
      const frame = simulateFrame([doesburg], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0221'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Dinkelland Dinkel, rain and cross-border precision explicitly unsupported', () => {
    const dinkelland = municipalities.find((city) => city.code === 'GM1774')!

    for (const [disaster, evidence] of [
      ['severe-storm', 'N342/B403'],
      ['pluvial-flood', '70 mm in one hour'],
      ['river-flood', 'cross-border Dinkel'],
      ['coastal-flood', 'narrow direct-water zero'],
      ['heatwave', 'high sandy soils'],
      ['winter-storm', 'narrow Ootmarsum streets'],
      ['cyberattack', 'declared target'],
      ['earthquake', 'selected KNMI event'],
      ['wildfire', 'Breklenkamp source-containment regression'],
    ] as const) {
      const frame = simulateFrame([dinkelland], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1774'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
    }

    const transferredPressure = simulateFrame(municipalities, 48, {
      selectedLayer: 'population',
      scenario: createScenarioConfig('river-flood'),
    }, generatedTransport.routes).municipalities.find((city) => city.id === 'GM1774')!
    expect(transferredPressure.hazard.floodDepthM).toBe(0)
    expect(transferredPressure.deprivedPersonHours).toBe(0)
    expect(transferredPressure.affectedPopulation).toBe(0)

    const nationalFrame = simulateFrame(municipalities, 48, {
      selectedLayer: 'population',
      scenario: createScenarioConfig('river-flood'),
    }, generatedTransport.routes)
    for (const service of ['power', 'water', 'drainage', 'gas', 'telecom', 'facilities'] as const) {
      expect(nationalFrame.routesByService[service]).toEqual([])
    }
  })

  it('keeps Doetinchem Oude IJssel, published-rain and Slangenburg fire precision explicitly unsupported', () => {
    const doetinchem = municipalities.find((city) => city.code === 'GM0222')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'common 84-neighbourhood order', {}],
      ['pluvial-flood', '70 mm/one-hour', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'WRIJ heat/groundwater surfaces', {}],
      ['winter-storm', 'A18/N-road', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Catalogue absence is not zero probability', {}],
      ['wildfire', 'twenty-eighth of 84', { epicenter: [6.364859124839539, 51.95926087155905] }],
    ] as const) {
      const frame = simulateFrame([doetinchem], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0222'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Dordrecht hydraulic, Biesbosch-fire and common-rank precision explicitly unsupported', () => {
    const dordrecht = municipalities.find((city) => city.code === 'GM0505')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'shared 132-neighbourhood seed', {}],
      ['pluvial-flood', '100 mm/two-hour', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'Zero is not an all-clear', {}],
      ['heatwave', 'care dependence', {}],
      ['winter-storm', 'N3/A16 crossing', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Catalogue absence is not zero probability', {}],
      ['wildfire', '130th of 132', { epicenter: [4.6869211427584085, 51.75286293610363] }],
    ] as const) {
      const frame = simulateFrame([dordrecht], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0505'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Dongen rain, river and thermal precision explicitly unsupported', () => {
    const dongen = municipalities.find((city) => city.code === 'GM0766')!

    for (const [disaster, evidence] of [
      ['severe-storm', 'seventeen-neighbourhood seed'],
      ['pluvial-flood', 'ninth through seventeenth'],
      ['river-flood', 'non-operational diagnostic only'],
      ['coastal-flood', 'narrowly scoped'],
      ['heatwave', 'Tichelrijt and Wildert'],
      ['winter-storm', 'N629/N632'],
      ['cyberattack', 'declared target'],
      ['earthquake', 'selected KNMI event'],
      ['wildfire', 'selected local ignition'],
    ] as const) {
      const frame = simulateFrame([dongen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0766'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Drimmelen Amer, partial-rain and Rupsenhoek precision explicitly unsupported', () => {
    const drimmelen = municipalities.find((city) => city.code === 'GM1719')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', '38-neighbourhood seed', {}],
      ['pluvial-flood', 'partial coverage', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'unsupported diagnostic', {}],
      ['heatwave', 'Made/Terheijden', {}],
      ['winter-storm', 'dispersed-road', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'Rupsenhoek/Sluishoek', { epicenter: [4.812900737065559, 51.7457033044792] }],
    ] as const) {
      const frame = simulateFrame([drimmelen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1719'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Druten Waal, Rivierenland-rain and Horssen-fire precision explicitly unsupported', () => {
    const druten = municipalities.find((city) => city.code === 'GM0225')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'shared 26-neighbourhood seed', {}],
      ['pluvial-flood', '60 mm/one-hour', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'shared flood and cyber order', {}],
      ['winter-storm', 'Waal crossing', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'Verspreide huizen Horssen', { epicenter: [5.598234538258141, 51.86579630971909] }],
    ] as const) {
      const frame = simulateFrame([druten], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0225'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Dronten polder, extreme-rain and Roggebotzand precision explicitly unsupported', () => {
    const dronten = municipalities.find((city) => city.code === 'GM0303')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'shared 42-neighbourhood seed', {}],
      ['pluvial-flood', '63.4 mm/hour', {}],
      ['river-flood', 'IJssel, Ketelmeer or Reevediep', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'visitor exposure', {}],
      ['winter-storm', 'scheduled-transit', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'Roggebotzand', { epicenter: [5.747864414524214, 52.52736591372557] }],
    ] as const) {
      const frame = simulateFrame([dronten], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0303'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Drechterland Markermeer, local-rain and Oosterleek precision explicitly unsupported', () => {
    const drechterland = municipalities.find((city) => city.code === 'GM0498')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'shared 27-neighbourhood seed', {}],
      ['pluvial-flood', 'Hoogkarspel, Venhuizen', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'Markermeer level', {}],
      ['heatwave', 'Zuiderkogge', {}],
      ['winter-storm', 'N307/N506', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'Oosterleek', { epicenter: [5.195723717681125, 52.64185686959268] }],
    ] as const) {
      const frame = simulateFrame([drechterland], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0498'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Edam-Volendam Markermeer, Volendam-rain and Warder-fire precision explicitly unsupported', () => {
    const edamVolendam = municipalities.find((city) => city.code === 'GM0385')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'shared 29-neighbourhood seed', {}],
      ['pluvial-flood', 'Volendam, Rokersgracht', {}],
      ['river-flood', 'non-operational diagnostic only', {}],
      ['coastal-flood', 'Markermeer, Slobbeland', {}],
      ['heatwave', 'Broeckgouw, Zeestraat', {}],
      ['winter-storm', 'bridge, local-road', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Warder and Kwadijk', {}],
      ['wildfire', 'fourteenth of 29', { epicenter: [5.045164910719629, 52.52273117103589] }],
    ] as const) {
      const frame = simulateFrame([edamVolendam], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0385'])
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }
  })

  it('keeps Duiven Rhine-system, WRIJ-rain and Loo-fire precision explicitly unsupported', () => {
    const duiven = municipalities.find((city) => city.code === 'GM0226')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'shared 14-neighbourhood seed', {}],
      ['pluvial-flood', 'T100 or T1000', {}],
      ['river-flood', 'Rhine, Pannerdensch Kanaal and IJssel', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'vulnerable-resident', {}],
      ['winter-storm', 'A12, rail', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'eleventh of 14', { epicenter: [5.996655039551414, 51.91486794732262] }],
    ] as const) {
      const frame = simulateFrame([duiven], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0226'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Echt-Susteren Maas/brook, cross-border and woodland precision explicitly unsupported', () => {
    const echtSusteren = municipalities.find((city) => city.code === 'GM1711')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'adjoining-country', {}],
      ['pluvial-flood', 'Geleenbeek and Rode Beek', {}],
      ['river-flood', 'Maas, Geleenbeek and Rode Beek', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'local paving', {}],
      ['winter-storm', 'Dutch, German or Belgian', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'Maria Hoop', {}],
      ['wildfire', 'twelfth of 58', { epicenter: [5.8911, 51.0674] }],
    ] as const) {
      const frame = simulateFrame([echtSusteren], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1711'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Eemnes Eemmeer, cloudburst and Heidehoek precision explicitly unsupported', () => {
    const eemnes = municipalities.find((city) => city.code === 'GM0317')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'same nine-neighbourhood order', {}],
      ['pluvial-flood', '74 mm/hour depth surface', {}],
      ['river-flood', 'Eem, Eemmeer, Randmeren and Eempolder', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'apparent temperature', {}],
      ['winter-storm', 'A1, local-road', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'sixth of nine', { epicenter: [5.226038626212821, 52.225708480879725] }],
    ] as const) {
      const frame = simulateFrame([eemnes], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0317'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Eemsdelta Ems-Dollard, seismic and Woldendorp precision explicitly unsupported', () => {
    const eemsdelta = municipalities.find((city) => city.code === 'GM1979')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'same 92-neighbourhood order', {}],
      ['pluvial-flood', 'duration-specific local rain-depth', {}],
      ['river-flood', 'narrowly scoped', {}],
      ['coastal-flood', 'Ems-Dollard, Eemshaven, Delfzijl and Dollarddijk', {}],
      ['heatwave', 'port workers', {}],
      ['winter-storm', 'dispersed-road, rail, port', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', '0.153 g-class output', {}],
      ['wildfire', 'seventieth of 92', { epicenter: [7.028363162688681, 53.27597167444283] }],
    ] as const) {
      const frame = simulateFrame([eemsdelta], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1979'])
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
    }

    const earthquakePeak = simulateFrame([eemsdelta], 9, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('earthquake'),
    }, []).municipalities[0].hazard
    expect(earthquakePeak.groundMotionG).toBeGreaterThan(0)
    expect(earthquakePeak.spatialEvidence).toBe('unsupported')
  })

  it('keeps Ede river, transient-population and Reemst precision explicitly unsupported', () => {
    const ede = municipalities.find((city) => city.code === 'GM0228')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'same 71-neighbourhood order', {}],
      ['pluvial-flood', 'official pluvial depth', {}],
      ['river-flood', 'persistent Ede water stress', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'transient visitors', {}],
      ['winter-storm', 'Veluwe and local-road access', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'thirty-ninth of 71', { epicenter: [5.798988319575035, 52.07630619528323] }],
    ] as const) {
      const frame = simulateFrame([ede], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0228'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Elburg Randmeren, urban-water and mixed-forest precision explicitly unsupported', () => {
    const elburg = municipalities.find((city) => city.code === 'GM0230')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'same 22-neighbourhood order', {}],
      ['pluvial-flood', 'evolving urban-water system', {}],
      ['river-flood', 'amplitude is suppressed', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'updated regional perceived-temperature', {}],
      ['winter-storm', 'A28/N309', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'regional profile does not expect', {}],
      ['wildfire', 'last of 22', { epicenter: [5.881205806544506, 52.38574541464985] }],
    ] as const) {
      const frame = simulateFrame([elburg], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0230'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Enkhuizen lake, one-hour rain and Enkhuizerzand precision explicitly unsupported', () => {
    const enkhuizen = municipalities.find((city) => city.code === 'GM0388')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'same 19-neighbourhood order', {}],
      ['pluvial-flood', '70 mm in one hour', {}],
      ['river-flood', 'non-operational diagnostic', {}],
      ['coastal-flood', 'not a direct North Sea distance field', {}],
      ['heatwave', 'historic-centre fabric', {}],
      ['winter-storm', 'Houtribdijk/naviduct', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'sixth of 19', { epicenter: [5.286008587114658, 52.71757819175381] }],
    ] as const) {
      const frame = simulateFrame([enkhuizen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0388'])
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBeGreaterThan(0)
      }
    }
  })

  it('keeps Epe IJssel, local-water and Veluwe forest precision explicitly unsupported', () => {
    const epe = municipalities.find((city) => city.code === 'GM0232')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'common 29-neighbourhood order', {}],
      ['pluvial-flood', '74 mm in one hour', {}],
      ['river-flood', 'exact amplitude is suppressed', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'older residents', {}],
      ['winter-storm', 'dispersed settlements', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'twenty-third of 29', { epicenter: [5.881675887977473, 52.30926841411657] }],
    ] as const) {
      const frame = simulateFrame([epe], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0232'])
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBe(0)
      }
    }
  })

  it('keeps Emmen Bargerveen, earthquake and cross-border precision explicitly unsupported', () => {
    const emmen = municipalities.find((city) => city.code === 'GM0114')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'common 83-neighbourhood order', {}],
      ['pluvial-flood', 'Buffer Zuid', {}],
      ['river-flood', 'zero in Emmen only within that direct source scope', {}],
      ['coastal-flood', 'narrow mechanism', {}],
      ['heatwave', 'peat oxidation', {}],
      ['winter-storm', 'A37/B402', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', '0.071 g-class', {}],
      ['wildfire', 'twenty-fourth of 83', { epicenter: [6.934053, 52.677668] }],
    ] as const) {
      const frame = simulateFrame([emmen], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0114'])
      if (disaster === 'river-flood' || disaster === 'coastal-flood') {
        expect(hazard.floodDepthM).toBe(0)
      }
    }

    const earthquakePeak = simulateFrame([emmen], 9, {
      selectedLayer: 'hazard',
      scenario: createScenarioConfig('earthquake'),
    }, []).municipalities[0].hazard
    expect(earthquakePeak.groundMotionG).toBeGreaterThan(0)
    expect(earthquakePeak.spatialEvidence).toBe('unsupported')
  })

  it('keeps Eersel direct-major-river, local-rain and Oeienbos precision explicitly unsupported', () => {
    const eersel = municipalities.find((city) => city.code === 'GM0770')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'same 24-neighbourhood order', {}],
      ['pluvial-flood', 'Eersel-kom en Lindeakkers and Eersel-Zuid', {}],
      ['river-flood', 'amplitude is suppressed', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'Vessem, Knegsel and Wintelre', {}],
      ['winter-storm', 'A67/N397', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', 'last of 24', { epicenter: [5.36276824428771, 51.39447434193721] }],
    ] as const) {
      const frame = simulateFrame([eersel], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0770'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Eijsden-Margraten Maas, cross-border and Savelsbos precision explicitly unsupported', () => {
    const eijsdenMargraten = municipalities.find((city) => city.code === 'GM1903')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'shared 34-neighbourhood order', {}],
      ['pluvial-flood', 'six Noor catchments', {}],
      ['river-flood', 'Belgian/French upstream hydrograph', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'plateau/slope', {}],
      ['winter-storm', 'A2/E25, Eijsden-Visé rail', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'underground-work condition', {}],
      ['wildfire', 'twelfth of 34', { epicenter: [5.757214859121261, 50.780002802415844] }],
    ] as const) {
      const frame = simulateFrame([eijsdenMargraten], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM1903'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBeGreaterThan(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps Eindhoven direct-major-river, local-water and Gennep precision explicitly unsupported', () => {
    const eindhoven = municipalities.find((city) => city.code === 'GM0772')!

    for (const [disaster, evidence, config] of [
      ['severe-storm', 'same 116-neighbourhood order', {}],
      ['pluvial-flood', 'Dommel/Tongelreep/Gender', {}],
      ['river-flood', 'amplitude is suppressed', {}],
      ['coastal-flood', 'narrowly scoped', {}],
      ['heatwave', 'high-rise and event exposure', {}],
      ['winter-storm', 'airport, A2/A67/N2', {}],
      ['cyberattack', 'declared target', {}],
      ['earthquake', 'selected KNMI event', {}],
      ['wildfire', '112th of 116', { epicenter: [5.4746, 51.41974] }],
    ] as const) {
      const frame = simulateFrame([eindhoven], 96, {
        selectedLayer: 'hazard',
        scenario: createScenarioConfig(disaster, config),
      }, [])
      const hazard = frame.municipalities[0].hazard
      expect(hazard.spatialEvidence).toBe('unsupported')
      expect(hazard.evidenceNote).toContain(evidence)
      expect(frame.unsupportedHazardMunicipalities).toEqual(['GM0772'])
      if (disaster === 'river-flood') expect(hazard.floodDepthM).toBe(0)
      if (disaster === 'coastal-flood') expect(hazard.floodDepthM).toBe(0)
    }
  })

  it('keeps the latest audited municipalities unavailable until local evidence is selected', () => {
    const audited = [
      { code: 'GM0153', evidence: 'German continuation', riverSuppressed: true },
      { code: 'GM0233', evidence: 'care-campus continuity', riverSuppressed: true },
      { code: 'GM0777', evidence: 'northern Hollands Diep exposure', riverSuppressed: false },
      { code: 'GM1771', evidence: '87 mm/5 h, 90 mm/1 h and 160 mm/2 h', riverSuppressed: true },
      { code: 'GM1652', evidence: 'Stippelberg geography', riverSuppressed: true },
      { code: 'GM0779', evidence: 'Amercentrale electricity/heat/shipping', riverSuppressed: false },
      { code: 'GM0784', evidence: 'Heiningen nature-fire geography', riverSuppressed: true },
      { code: 'GM0907', evidence: 'German-fed Niers warning chain', riverSuppressed: false },
      { code: 'GM1924', evidence: 'Oosterduinpad dune-fire spread', riverSuppressed: false, coastalRetained: true },
      { code: 'GM0664', evidence: 'Poelbos source-aware fire spread', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0785', evidence: 'De Zeven Vennen fire spread', riverSuppressed: false },
      { code: 'GM1942', evidence: 'Valkeveen fire spread', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0512', evidence: 'Molenvliet fire-source containment', riverSuppressed: false },
      { code: 'GM0513', evidence: 'Kort Haarlem vulnerability', riverSuppressed: false, coastalRetained: true },
      { code: 'GM0014', evidence: 'ShakeMap/site-response', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM1729', evidence: 'Belgian catchment and route continuation', riverSuppressed: true },
      { code: 'GM0392', evidence: 'Haarlemmerhout source-aware fire spread', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0158', evidence: 'Ahaus/Alstätte cross-border response', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0394', evidence: 'Schiphol transient exposure', riverSuppressed: true, coastalRetained: true },
      { code: 'GM1655', evidence: 'Mark, Dintel or Benedenrivieren', riverSuppressed: false },
      { code: 'GM0160', evidence: 'Overijsselse Vecht hydrograph', riverSuppressed: true },
      { code: 'GM0243', evidence: 'Wolderwijd or Veluwemeer Randmeren', riverSuppressed: false },
      { code: 'GM0523', evidence: 'forecast-triggered extra pumps and peil lowering', riverSuppressed: false },
      { code: 'GM0072', evidence: 'Tjerk Hiddessluis collision/failure', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0396', evidence: 'Jan Lagrand cross-municipal drinking-water dependency', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0244', evidence: 'Veessen-Wapenveld high-water-channel', riverSuppressed: false },
      { code: 'GM0397', evidence: 'N201 west/east and N208 north/south continuity', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0246', evidence: '5.65 m+NAP activation', riverSuppressed: false },
      { code: 'GM0074', evidence: 'Boezem Friesland regional-water breach', riverSuppressed: true },
      { code: 'GM0917', evidence: 'Parkstad-Aachen multimodal', riverSuppressed: true },
      { code: 'GM0399', evidence: 'Willibrordus and external Alkmaar care continuity', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0794', evidence: 'BZOB sewer-pump design exceedance', riverSuppressed: true },
      { code: 'GM0163', evidence: '493 m Salland-Twentetunnel', riverSuppressed: true },
      { code: 'GM0531', evidence: 'Noordtunnel/Bridge over the Noord', riverSuppressed: false },
      { code: 'GM0164', evidence: 'Twentekanaal HCH/Nobian/RWZI/heat', riverSuppressed: true },
      { code: 'GM1966', evidence: 'R.J. Clevering discharge windows', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0252', evidence: 'Heumen high-water gate', riverSuppressed: false },
      { code: 'GM0797', evidence: 'A59/N267/Heusdense bridge', riverSuppressed: false },
      { code: 'GM0534', evidence: 'N206/N208 and Ringvaart bridge', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0402', evidence: 'Media Park cyber/power/telecom continuity', riverSuppressed: true },
      { code: 'GM0798', evidence: '60,000–90,000 visitors', riverSuppressed: true },
      { code: 'GM1963', evidence: 'Tiengemeten pont/boat state', riverSuppressed: false, coastalRetained: true },
      { code: 'GM1735', evidence: 'regional limited-overflow context', riverSuppressed: true },
      { code: 'GM1911', evidence: 'Afsluitdijk/Den Oever complex', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0118', evidence: 'direct-flood versus reception/cascade scope', riverSuppressed: true },
      { code: 'GM0405', evidence: 'Markermeer/defence problem', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM1507', evidence: 'Three local Maas vehicle ferries', riverSuppressed: false },
      { code: 'GM0321', evidence: '1.549453 m Lek flood', riverSuppressed: false },
      { code: 'GM0406', evidence: 'Gooimeer high-water', riverSuppressed: true },
      { code: 'GM0677', evidence: 'Westerschelde defence case', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM1884', evidence: 'Oude Rijn/boezem', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0353', evidence: '1.346752 m Lek flood', riverSuppressed: false },
      { code: 'GM0678', evidence: 'Kanaal door Zuid-Beveland', riverSuppressed: true, coastalRetained: true },
      { code: 'GM0166', evidence: 'mobile barrier and volunteer/material', riverSuppressed: false, coastalSuppressed: true },
      { code: 'GM0537', evidence: 'forecast-led coastal evacuation/shelter phase', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0928', evidence: 'official Eygelshoven event analysis', riverSuppressed: true },
      { code: 'GM1598', evidence: 'Markermeer/IJsselmeer, defence or polder case', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0542', evidence: 'current Algerabrug closure', riverSuppressed: false, coastalSuppressed: true },
      { code: 'GM1931', evidence: 'N216 ferry is misclassified', riverSuppressed: false },
      { code: 'GM1659', evidence: 'remote water-control dependency', riverSuppressed: true },
      { code: 'GM1982', evidence: 'does not instantiate EDO 36', riverSuppressed: false },
      { code: 'GM0415', evidence: 'empty logical road graph', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0882', evidence: 'post-coal-mining uplift', riverSuppressed: true },
      { code: 'GM1621', evidence: 'Eendragtspolder and Bergboezem actions', riverSuppressed: false, coastalSuppressed: true },
      { code: 'GM0417', evidence: 'high-area infiltration', riverSuppressed: true },
      { code: 'GM0080', evidence: 'precise catastrophic local result', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0546', evidence: 'managed Oude Rijn/boezem municipality', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0547', evidence: 'primary, regional and polder/boezem pathways', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM1916', evidence: 'Rhine/Vliet/boezem pathway', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0995', evidence: 'IJsselmeer/Markermeer defence breach', riverSuppressed: true },
      { code: 'GM1640', evidence: 'Maas, defence and groundwater pathways', riverSuppressed: false },
      { code: 'GM0327', evidence: 'plausible dike-ring-45 threat', riverSuppressed: false },
      { code: 'GM1705', evidence: 'Waal, Pannerdensch Kanaal or Nederrijn event', riverSuppressed: false },
      { code: 'GM0553', evidence: 'dike-trajectory-14 failure scenario', riverSuppressed: true, coastalSuppressed: true },
      { code: 'GM0262', evidence: 'geographically bounded IJssel defence-failure mechanism', riverSuppressed: false },
      { code: 'GM0809', evidence: 'conditional north-west Loon op Zand Maas-breach case', riverSuppressed: false },
      { code: 'GM0331', evidence: 'locally plausible Lek flood', riverSuppressed: false },
      { code: 'GM0263', evidence: 'physically plausible major-river threat', riverSuppressed: false },
      { code: 'GM0168', evidence: 'without local Rhine, Meuse or IJssel evidence', riverSuppressed: true },
      { code: 'GM1641', evidence: 'Maas/canal boundary, defence-reach or connected-footprint state', riverSuppressed: false },
    ] as const
    const disasters = scenarioPresetIds.filter((disaster) => disaster !== 'compound')

    for (const audit of audited) {
      const municipality = municipalities.find((city) => city.code === audit.code)!
      for (const disaster of disasters) {
        const frame = simulateFrame([municipality], 96, {
          selectedLayer: 'hazard',
          scenario: createScenarioConfig(disaster),
        }, [])
        const hazard = frame.municipalities[0].hazard
        expect(hazard.spatialEvidence).toBe('unsupported')
        expect(hazard.evidenceNote).toContain(audit.evidence)
        expect(hazard.evidenceNote).toContain(`${disaster} municipality result remains Unknown`)
        expect(frame.unsupportedHazardMunicipalities).toEqual([audit.code])
        if (disaster === 'river-flood') {
          expect(hazard.floodDepthM === 0).toBe(audit.riverSuppressed)
        }
        if (disaster === 'coastal-flood' && 'coastalRetained' in audit && audit.coastalRetained) {
          expect(hazard.floodDepthM).toBeGreaterThan(0)
        }
        if (disaster === 'coastal-flood' && 'coastalSuppressed' in audit && audit.coastalSuppressed) {
          expect(hazard.floodDepthM).toBe(0)
        }
      }
    }

    const ettenLeur = municipalities.find((city) => city.code === 'GM0777')!
    const riverScenario = createScenarioConfig('river-flood')
    const diagnostic = simulateFrame([ettenLeur], 96, {
      selectedLayer: 'water',
      scenario: riverScenario,
    }, []).municipalities[0]
    const noEvent = simulateFrame([ettenLeur], 96, {
      selectedLayer: 'water',
      scenario: { ...riverScenario, intensity: 0 },
    }, []).municipalities[0]
    expect(diagnostic.hazard.floodDepthM).toBeGreaterThan(0)
    for (const service of Object.keys(diagnostic.services) as Array<keyof typeof diagnostic.services>) {
      expect(diagnostic.services[service].availability).toBeCloseTo(
        noEvent.services[service].availability,
        12,
      )
    }
    expect(diagnostic.affectedPopulation).toBe(noEvent.affectedPopulation)
  })

  it('does not label persistent Alphen river disruption as recovery by elapsed time alone', () => {
    const alphen = municipalities.find((city) => city.code === 'GM0484')!
    const scenario = createScenarioConfig('river-flood')

    for (const step of [192, 288]) {
      const snapshot = simulateFrame(
        [alphen],
        step,
        { selectedLayer: 'water', scenario },
        [],
      ).municipalities[0]
      expect(snapshot.hazard.floodDepthM).toBeGreaterThan(0.05)
      expect(snapshot.status).not.toBe('recovering')
      for (const service of Object.values(snapshot.services)) {
        expect(service.explanation.recoveryProgress).toBe(0)
        expect(service.status).not.toBe('recovering')
      }
    }
  })

  it('keeps service values bounded at representative moments through T+72', () => {
    const network = buildNationalNetwork(municipalities)
    for (const step of [0, 32, 96, 192, 288]) {
      const frame = simulateFrame(municipalities, step, { selectedLayer: 'supply' }, network)
      expect(frame.municipalities).toHaveLength(342)
      for (const city of frame.municipalities) {
        for (const service of Object.values(city.services)) {
          expect(service.availability).toBeGreaterThanOrEqual(0)
          expect(service.availability).toBeLessThanOrEqual(1)
          expect(service.delivered).toBeLessThanOrEqual(service.demand + 1e-9)
        }
      }
    }
  })
})
