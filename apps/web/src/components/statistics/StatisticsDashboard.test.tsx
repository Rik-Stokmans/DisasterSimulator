import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SimulationFrame, SimulationHistory } from '@disaster/sim-core'
import type { MunicipalityRegionBundle, RegionalStatistics } from '../../data'
import {
  RegionalStatisticsDashboard,
  SimulationTimelineDashboard,
} from './StatisticsDashboard'
import { REGIONAL_STATISTICS } from './statisticsCatalog'

const completeStatistics = Object.fromEntries(
  REGIONAL_STATISTICS.map((metric, index) => [metric.key, index + 1]),
) as unknown as RegionalStatistics

const bundle = {
  municipalityCode: 'GM0772',
  municipalityName: 'Eindhoven',
  edition: 2025,
  source: {
    statistics: 'https://opendata.cbs.nl/ODataApi/OData/86165NED',
    retrievedAt: '2026-08-31T00:00:00.000Z',
  },
  neighborhoods: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'BU07721110',
        geometry: { type: 'Polygon', coordinates: [] },
        properties: {
          id: 'BU07721110',
          name: 'Binnenstad',
          kind: 'buurt',
          municipalityCode: 'GM0772',
          districtCode: 'WK077211',
          districtName: 'Centrum',
          center: [5.48, 51.44],
          statistics: completeStatistics,
        },
      },
    ],
  },
  places: { type: 'FeatureCollection', features: [] },
  settlements: { type: 'FeatureCollection', features: [] },
} as unknown as MunicipalityRegionBundle

function frame(hour: number, season: 'summer' | 'winter', affectedPopulation: number) {
  const service = {
    availability: 1 - affectedPopulation / 100,
    demand: 100,
    delivered: 100 - affectedPopulation,
    reserveHours: 24 - hour / 4,
  }
  return {
    step: hour * 4,
    hour,
    minute: hour * 60,
    scenario: { season },
    national: {
      population: 100,
      affectedPopulation,
      averageAvailability: service.availability,
      criticalMunicipalities: affectedPopulation > 50 ? 1 : 0,
      activeBottlenecks: 0,
      deprivedPersonHours: affectedPopulation * hour,
    },
    municipalities: [
      {
        id: 'GM0772',
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
          heatC: season === 'summer' ? 34 : -2,
          snowCmH: season === 'winter' ? 1 : 0,
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
        services: {
          power: service,
          water: service,
          drainage: service,
          gas: service,
          telecom: service,
          mobility: service,
          facilities: service,
          supply: service,
        },
      },
    ],
  } as unknown as SimulationFrame
}

function history(season: 'summer' | 'winter'): SimulationHistory {
  const frames = [frame(0, season, 0), frame(1, season, season === 'winter' ? 14 : 8), frame(72, season, season === 'winter' ? 65 : 40)]
  return {
    scenario: frames[0].scenario,
    startStep: 0,
    endStep: 288,
    intervalSteps: 4,
    networkMode: 'isolated',
    points: frames.map(({ step, minute, hour, municipalities, national }) => ({
      step,
      minute,
      hour,
      municipalities,
      national,
    })),
  } as unknown as SimulationHistory
}

describe('StatisticsDashboard server rendering', () => {
  it('renders all 36 official fields as accessible distribution graphs', () => {
    const markup = renderToStaticMarkup(
      <RegionalStatisticsDashboard
        bundle={bundle}
        selectedNeighborhoodId="BU07721110"
      />,
    )

    expect(markup.match(/class="stat-viz-card"/g)).toHaveLength(36)
    expect(markup).toContain('Search all 36 official statistics')
    expect(markup).toContain('Residents distribution')
    expect(markup).toContain('Observed context · not simulation output')
    expect(markup).toContain('CBS table 86165NED')
  })

  it('renders real supplied frame histories with an explicit seasonal comparison', () => {
    const markup = renderToStaticMarkup(
      <SimulationTimelineDashboard
        frames={[frame(0, 'summer', 0), frame(72, 'summer', 40)]}
        municipalityId="GM0772"
        primaryLabel="Summer"
        comparison={{
          label: 'Winter',
          frames: [frame(0, 'winter', 0), frame(72, 'winter', 65)],
        }}
        activeHour={36}
      />,
    )

    expect(markup).toContain('Summer vs Winter')
    expect(markup).toContain('Modeled residents under pressure over the first 72 hours')
    expect(markup).toContain('Accessible data table · 2 timestamps')
    expect(markup).toContain('Graphs use only supplied states')
  })

  it('uses explicit intervention identities even when both histories share a season', () => {
    const markup = renderToStaticMarkup(
      <SimulationTimelineDashboard
        frames={[frame(0, 'summer', 0), frame(72, 'summer', 40)]}
        municipalityId="GM0772"
        primaryLabel="Early municipal mutual aid"
        comparison={{
          label: 'Baseline response',
          frames: [frame(0, 'summer', 0), frame(72, 'summer', 65)],
        }}
      />,
    )

    expect(markup).toContain('Early municipal mutual aid vs Baseline response')
    expect(markup).not.toContain('summer vs summer')
  })

  it('renders compact sim-core history at its actual resolution', () => {
    const markup = renderToStaticMarkup(
      <SimulationTimelineDashboard
        history={history('summer')}
        municipalityId="GM0772"
        primaryLabel="Summer"
        comparison={{ label: 'Winter', history: history('winter') }}
      />,
    )

    expect(markup).toContain('Scenario output · hourly states')
    expect(markup).toContain('3 supplied frames · 0.00–72.00 h')
    expect(markup).toContain('Winter · latest 65 people')
  })
})
